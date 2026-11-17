// Verify a change: run only the checks the changed files need, cheapest first, stop at the first red one.
// Knows nothing of the project: the checks and the rules are in .claude/verify.json.
//   node tools/verify.mjs            checks picked by the files changed against the base branch (or the last commit when the tree is clean)
//   node tools/verify.mjs --all      every check
//   node tools/verify.mjs --release  every check, with the release steps
//   node tools/verify.mjs --dry      print what would run and why
//   node tools/verify.mjs --history 100   how the rules treat the last 100 commits: {"none","part","all"}
// Needs Node.js 22 or newer.
// One run at a time per working copy (exit 3 otherwise). A green run marks the change gates passed (tools/gate.mjs).
//
// .claude/verify.json
//   { "base": "origin/main",
//     "steps":   [{ "name": "unit", "cmd": "npm test", "cwd": "app", "env": { "X": "1" } }, …],   in run order, cheapest first
//     "release": { "replace": "e2e", "steps": [ … ] },                                           optional: what --release adds
//     "rules":   [{ "files": "^docs/|[.]md$", "run": [] }, { "files": "^src/", "run": ["unit", "e2e"] }, …] }
//   The first rule whose regex matches a path decides; "run": "all" means every step; a path no rule matches gets every step.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, marks, runsVerify, signature, stamp } from './gate.mjs';

export const config = (root) => JSON.parse(readFileSync(join(root, '.claude', 'verify.json'), 'utf8'));

/** Mistakes in the config that would quietly run less: an unknown step name, a release that replaces nothing, a bad regex. */
export function problems(cfg) {
  const out = []; const names = new Set((cfg.steps ?? []).map((s) => s.name));
  if (!names.size) out.push('no steps');
  for (const s of [...(cfg.steps ?? []), ...(cfg.release?.steps ?? [])]) if (!s.name || !s.cmd) out.push(`a step without a name or a cmd: ${JSON.stringify(s)}`);
  for (const r of cfg.rules ?? []) {
    if (typeof r.files !== 'string' || !r.files) { out.push(`a rule without "files": ${JSON.stringify(r)}`); continue; }
    try { new RegExp(r.files); } catch { out.push(`rule "${r.files}": not a regex`); }
    if (r.run !== 'all' && !Array.isArray(r.run)) out.push(`rule "${r.files}": run must be a list of step names or "all"`);
    for (const n of Array.isArray(r.run) ? r.run : []) if (!names.has(n)) out.push(`rule "${r.files}": no step named "${n}"`);
  }
  if (cfg.release?.replace && !names.has(cfg.release.replace)) out.push(`release.replace: no step named "${cfg.release.replace}"`);
  return out;
}

/** The step names a changed path needs under the config's rules. */
export function needs(path, cfg) {
  const p = path.replace(/\\/g, '/');
  const rule = (cfg.rules ?? []).find((r) => new RegExp(r.files).test(p));
  const all = cfg.steps.map((s) => s.name);
  return !rule || rule.run === 'all' ? all : rule.run;
}

/** The steps for a set of changed paths, in run order, each once. */
export const pick = (paths, cfg) => {
  const want = new Set(paths.flatMap((p) => needs(p, cfg)));
  return cfg.steps.filter((s) => want.has(s.name));
};

/** Every step, with the release steps when asked: they replace the step named in `release.replace`, or go last. */
export function everything(cfg, release) {
  const steps = [...cfg.steps];
  if (!release || !cfg.release) return steps;
  const at = steps.findIndex((s) => s.name === cfg.release.replace);
  if (at < 0) steps.push(...cfg.release.steps); else steps.splice(at, 1, ...cfg.release.steps);
  return steps;
}

const git = (root, args) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
const tryGit = (root, args) => { try { return git(root, args); } catch { return []; } };

/** Files changed against the base: committed on this branch, staged, unstaged and new; on a clean tree that matches the base, the last commit. */
export function changed(root, base = 'origin/main') {
  const from = tryGit(root, ['merge-base', 'HEAD', base])[0] ?? 'HEAD';
  // `--relative`: paths from the project root, and only the project's own, when it is a package of a monorepo
  const files = new Set([...tryGit(root, ['diff', '--name-only', '--relative', from]), ...tryGit(root, ['ls-files', '-o', '--exclude-standard'])]);
  // the last commit against its first parent (a merge too); the very first commit has none, so it is shown against nothing
  if (!files.size) for (const f of tryGit(root, ['rev-parse', '-q', '--verify', 'HEAD~1']).length ? tryGit(root, ['diff', '--name-only', '--relative', 'HEAD~1', 'HEAD']) : tryGit(root, ['show', '--name-only', '--relative', '--format=', 'HEAD'])) files.add(f);
  return [...files].sort();
}

/** How the rules would have treated the last `n` commits (merges left out): how many need nothing, some checks, or all. */
export function history(root, cfg, n = 100) {
  const tally = { none: 0, part: 0, all: 0 };
  for (const sha of tryGit(root, ['log', '--no-merges', `-${n}`, '--format=%h', '--relative', '--', '.'])) {
    const k = pick(tryGit(root, ['show', '--name-only', '--relative', '--format=', sha]), cfg).length;
    tally[k === 0 ? 'none' : k === cfg.steps.length ? 'all' : 'part']++;
  }
  return tally;
}

/** Signatures of the change gates that run verify, before a run: a green run marks them passed. */
export const before = (root) => load(root).filter(runsVerify).map((gate) => ({ gate, sig: signature(root, gate) }));
/** Mark the gates whose files did not change during the run; returns the names marked. */
export const passGates = (root, sigs) => sigs.filter(({ gate, sig }) => signature(root, gate) === sig).map(({ gate, sig }) => (stamp(root, gate, sig), gate.name));

const gitDir = (root) => { const d = git(root, ['rev-parse', '--git-dir'])[0]; return isAbsolute(d) ? d : resolve(root, d); };
/** The lock's run is still going: a real pid (not 0, not empty) that answers, written after this boot. */
const held = (lock) => {
  try {
    const text = readFileSync(lock, 'utf8'); const age = Date.now() - statSync(lock).mtimeMs;
    // created with `wx` and not yet written: another run is starting right now
    if (!text && age < 10_000) return true;
    const pid = Number(text);
    if (!(pid > 0) || age > uptime() * 1000) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..');
  const cfg = config(root);
  const base = cfg.base ?? 'origin/main';
  const args = process.argv.slice(2); const flags = new Set(args);
  const bad = problems(cfg);
  if (bad.length) { console.error(`.claude/verify.json:\n- ${bad.join('\n- ')}`); process.exit(2); }
  if (flags.has('--history')) { console.log(JSON.stringify(history(root, cfg, Number(args[args.indexOf('--history') + 1]) || 100))); process.exit(0); }
  const full = flags.has('--all') || flags.has('--release');
  // signatures first: a file edited while the checks are being picked must not be marked as checked
  const sigs = flags.has('--dry') ? [] : before(root);
  const files = changed(root, base);
  // without the base branch the branch's own commits are not in `files`: only a full run may mark the gate then
  const mayPass = full || tryGit(root, ['rev-parse', '-q', '--verify', base]).length > 0;
  const steps = full ? everything(cfg, flags.has('--release')) : pick(files, cfg);
  console.log(`changed files: ${files.length}${files.length ? ` (${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''})` : ''}`);
  console.log(`checks: ${steps.map((s) => s.name).join(', ') || 'none needed'}`);
  if (flags.has('--dry')) process.exit(0);
  const say = (marked) => (!sigs.length ? '' : marked.length ? ` (gate passed: ${marked.join(', ')})` : mayPass ? '; files changed during the run, run it again to pass the gate' : `; no ${base}, so the gate is passed only by --all`);
  if (!steps.length) { console.log(`OK: nothing to check${say(mayPass ? passGates(root, sigs) : [])}`); process.exit(0); }

  const lock = join(gitDir(root), 'verify.lock');
  if (existsSync(lock) && !held(lock)) rmSync(lock, { force: true });
  // `wx` creates the lock only if there is none: two runs started at once cannot both pass
  try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch {
    console.error(`another verify run is in progress (${lock}); wait for it, or stop it and delete the lock`);
    process.exit(3);
  }
  // the gates' checks are «running» meanwhile: the Stop hook lets a turn end while verify works in the background
  const flag = (gate) => join(marks(root), gate.name + '.running');
  for (const { gate } of sigs) { mkdirSync(marks(root), { recursive: true }); writeFileSync(flag(gate), String(process.pid)); }
  const rows = [];
  let code = 0;
  try {
    for (const s of steps) {
      const started = Date.now();
      const r = spawnSync(s.cmd, { cwd: join(root, s.cwd ?? '.'), shell: true, stdio: 'inherit', env: { ...process.env, ...s.env } });
      const rc = r.status ?? 1;
      rows.push(`${s.name.padEnd(12)} ${String(Math.round((Date.now() - started) / 1000)).padStart(4)} s  ${rc === 0 ? 'ok' : `FAILED (${rc})`}`);
      if (rc !== 0) { code = rc; break; }
    }
  } finally {
    rmSync(lock, { force: true });
    for (const { gate } of sigs) rmSync(flag(gate), { force: true });
  }
  console.log(`\n${rows.join('\n')}`);
  if (code) console.log('\nFAILED: fix the cause, not the check; after 3 rounds on the same failure, stop and ask a person.');
  else console.log(`\nOK: verified${say(mayPass ? passGates(root, sigs) : [])}`);
  process.exit(code);
}
