// Verify a change: run only the checks the changed files need, cheapest first, stop at the first red one.
//   node tools/verify.mjs            checks picked by the files changed against origin/main (or the last commit when the tree is clean)
//   node tools/verify.mjs --all      every check except packaging
//   node tools/verify.mjs --release  everything, plus the committed screenshots, the README screenshots, the installer and its check
//   node tools/verify.mjs --dry      print what would run and why
// One run at a time per working copy: a second one exits with code 3 (two e2e runs share a profile and lock the bundled binaries).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { load, signature, stamp } from './gate.mjs';

/** Signatures of the change gates before a run (tools/gate.mjs): a green run marks them passed, as `gate.mjs run` would. */
export const before = (root) => load(root).map((gate) => ({ gate, sig: signature(root, gate) }));
/** Mark the gates whose files did not change during the run; returns the names marked. */
export const passGates = (root, sigs) => sigs.filter(({ gate, sig }) => signature(root, gate) === sig).map(({ gate, sig }) => (stamp(root, gate, sig), gate.name));
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The checks in the order they run: cheap ones first, so a typo never waits for the window. */
export const STEPS = [
  { name: 'tools', cmd: 'node --test "tools/*.test.mjs"' },
  { name: 'rust-fmt', cmd: 'cargo fmt --all -- --check' },
  { name: 'typecheck', cmd: 'npm run typecheck', cwd: 'app' },
  { name: 'unit', cmd: 'npx vitest run', cwd: 'app' },
  { name: 'rust-test', cmd: 'cargo test -j 2 --workspace' },
  { name: 'clippy', cmd: 'cargo clippy -j 2 --workspace --all-targets -- -D warnings' },
  // the hook binary end to end, on a release build of its own
  { name: 'ctk-guard', cmd: 'cargo build -j 2 --release -p context-toolkit && node crates/context-toolkit/tests/guard.test.mjs' },
  { name: 'e2e', cmd: 'npm run e2e', cwd: 'app' },
];
const RELEASE = [
  { name: 'state-shots', cmd: 'npm run e2e', cwd: 'app', env: { E2E_UPDATE_SHOTS: '1' } },
  { name: 'docs-shots', cmd: 'node e2e/docs-shots.mjs', cwd: 'app' },
  { name: 'dist', cmd: 'npm run dist', cwd: 'app' },
  { name: 'pack-check', cmd: 'npm run pack:check', cwd: 'app' },
];
const ALL = STEPS.map((s) => s.name);
const RUST = ['rust-fmt', 'rust-test', 'clippy'];
const WINDOW = ['typecheck', 'unit', 'e2e'];

/** Which checks a changed path needs. Unknown paths get everything: the rules err on the side of more. */
export function needs(path) {
  const p = path.replace(/\\/g, '/');
  // fixtures first: their .md files (agents, skills) are test data, not docs
  if (/^fixtures\//.test(p)) return ['rust-test', 'e2e'];
  if (/^(docs\/|state\/|mockup\/)|\.md$|^LICENSE|^\.gitignore$/.test(p)) return [];
  if (/^tools\//.test(p) || p === '.claude/gates.json' || p === '.claude/settings.json') return ['tools'];
  // the window runs the core and reads the fixtures, so the core and the fixtures need the window checks too
  // a dependency update (root Cargo.*) reaches the hook binary too
  if (/^(crates\/context-toolkit\/|Cargo\.(toml|lock)$)/.test(p)) return [...RUST, 'ctk-guard', 'e2e'];
  if (/^(crates\/|Cargo\.(toml|lock)$)/.test(p)) return [...RUST, 'e2e'];
  if (/^app\/(src|e2e|scripts|build)\//.test(p) || /^app\/(package(-lock)?\.json|tsconfig\.json|electron\.vite\.config\.ts)$/.test(p)) return WINDOW;
  return ALL;
}

/** The checks for a set of changed paths, in run order. */
export const pick = (paths) => {
  const want = new Set(paths.flatMap(needs));
  return STEPS.filter((s) => want.has(s.name));
};

const git = (root, args) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
const tryGit = (root, args) => { try { return git(root, args); } catch { return []; } };

/** Files changed against origin/main: committed on this branch, staged, unstaged and new; on a clean tree that matches main, the last commit. */
export function changed(root) {
  const base = tryGit(root, ['merge-base', 'HEAD', 'origin/main'])[0] ?? 'HEAD';
  const files = new Set([...tryGit(root, ['diff', '--name-only', base]), ...tryGit(root, ['ls-files', '-o', '--exclude-standard'])]);
  // the last commit against its first parent (a merge too); the very first commit has none, so it is shown against nothing
  if (!files.size) for (const f of tryGit(root, ['rev-parse', '-q', '--verify', 'HEAD~1']).length ? tryGit(root, ['diff', '--name-only', 'HEAD~1', 'HEAD']) : tryGit(root, ['show', '--name-only', '--format=', 'HEAD'])) files.add(f);
  return [...files].sort();
}

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
  const flags = new Set(process.argv.slice(2));
  const files = changed(root);
  const steps = flags.has('--all') || flags.has('--release') ? [...STEPS] : pick(files);
  // the release refreshes state/ with its own e2e run: one run is enough
  if (flags.has('--release')) steps.splice(steps.findIndex((s) => s.name === 'e2e'), 1, ...RELEASE);
  console.log(`changed files: ${files.length}${files.length ? ` (${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''})` : ''}`);
  console.log(`checks: ${steps.map((s) => s.name).join(', ') || 'none needed'}`);
  if (flags.has('--dry')) process.exit(0);
  const sigs = before(root);
  if (!steps.length) { passGates(root, sigs); process.exit(0); }

  const lock = join(gitDir(root), 'verify.lock');
  if (existsSync(lock) && !held(lock)) rmSync(lock, { force: true });
  // `wx` creates the lock only if there is none: two runs started at once cannot both pass
  try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch {
    console.error(`another verify run is in progress (${lock}); wait for it, or stop it and delete the lock`);
    process.exit(3);
  }
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
  } finally { rmSync(lock, { force: true }); }
  console.log(`\n${rows.join('\n')}`);
  if (code) console.log(`\nFAILED: fix the cause, not the check; after 3 rounds on the same failure, stop and ask a person.`);
  else {
    const marked = passGates(root, sigs);
    console.log(`\nOK: verified${marked.length ? ` (gate passed: ${marked.join(', ')})` : '; files changed during the run, run it again to pass the gate'}`);
  }
  process.exit(code);
}
