// The change gate: files of a kind are «checked» only after the gate's own command ended green on exactly those files.
// The Stop hook (tools/claude-stop-gate.mjs) does not let an agent's turn end while a gate it touched is not passed.
// The gates are in .claude/gates.json, the marks in the git directory (never committed, per working copy).
//   .claude/gates.json   { "mode": "observe" | "enforce", "gates": [{ "name": "verify", "files": "^crates/", "run": "node tools/verify.mjs", "why": "…" }] }
//   node tools/gate.mjs run <name>…   runs the gates' commands one after another; green and the files untouched meanwhile — passed
//   node tools/gate.mjs status        which gates are passed for the files as they are now
// Mode "observe" (the default for a new gate): the hook only logs what it would have blocked to <git-dir>/gates/observe.log.
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const config = (root) => { try { return JSON.parse(readFileSync(join(root, '.claude', 'gates.json'), 'utf8')); } catch { return {}; } };
export const load = (root) => config(root).gates ?? [];
/** "enforce" blocks the turn; anything else only observes. */
export const mode = (root) => (config(root).mode === 'enforce' ? 'enforce' : 'observe');
export const marks = (root) => { const dir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' }).trim(); return join(isAbsolute(dir) ? dir : resolve(root, dir), 'gates'); };
/** The gate's files as they are now: tracked and new ones (ignored ones are not the project's), each with its size and time of change. */
export function signature(root, gate) {
  const rule = new RegExp(gate.files); const sum = createHash('sha1');
  const files = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter((name) => name && rule.test(name)).sort();
  for (const name of files) { try { const s = statSync(join(root, name)); sum.update(`${name}\0${s.size}\0${Math.round(s.mtimeMs)}\n`); } catch { /* listed by git, gone from the disk: not there */ } }
  return sum.digest('hex');
}
export function stamp(root, gate, sig) { mkdirSync(marks(root), { recursive: true }); writeFileSync(join(marks(root), gate.name + '.json'), JSON.stringify({ sig, at: new Date().toISOString(), run: gate.run })); }
const passed = (root, gate) => { try { return JSON.parse(readFileSync(join(marks(root), gate.name + '.json'), 'utf8')); } catch { return null; } };
/** The gates not passed for the files as they are now. */
export const stale = (root, gates = load(root)) => gates.filter((gate) => passed(root, gate)?.sig !== signature(root, gate));
/** A check of the gate is under way (started within the last hour): the turn may end to wait for it. */
export const running = (root, gates = load(root)) => new Set(gates.filter((gate) => { try { return Date.now() - statSync(join(marks(root), gate.name + '.running')).mtimeMs < 3600_000; } catch { return false; } }).map((gate) => gate.name));

/** The newest change time among the gate's files (0 when it has none). */
export function newest(root, gate) {
  const rule = new RegExp(gate.files); let top = 0;
  const files = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter((name) => name && rule.test(name));
  // a tracked file gone from the disk was deleted or moved: that is a change, and it happened now
  for (const name of files) { try { top = Math.max(top, statSync(join(root, name)).mtimeMs); } catch { return Infinity; } }
  // shortcut: a copy or `git mv` that keeps the old mtime is not seen; compare signatures from the session start if it matters
  return top;
}
/** Did this session change a file of the gate. Edit and Write: by their path. A shell command cannot be read reliably (a script, a
 *  formatter or a codemod names no target, a `grep` names one and changes nothing), so after any shell command the gate counts as
 *  touched only if one of its files changed after the session began (`since`, ms). */
export function touched(lines, gate, root, since = Infinity) {
  const rule = new RegExp(gate.files); const base = resolve(root).replace(/\\/g, '/').toLowerCase() + '/';
  const local = (path) => { const p = String(path).replace(/\\/g, '/'); if (!/^([a-z]:)?\//i.test(p)) return p.replace(/^\.\//, ''); return p.toLowerCase().startsWith(base) ? p.slice(base.length) : null; };
  let shell = false;
  for (const line of lines) {
    if (!line.includes('"tool_use"')) continue; let row; try { row = JSON.parse(line); } catch { continue; }
    for (const part of row.message?.content ?? []) {
      if (part.type !== 'tool_use') continue; const input = part.input ?? {};
      if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(part.name)) { const name = local(input.file_path ?? input.notebook_path ?? ''); if (name && rule.test(name)) return true; }
      else if (/^(Bash|PowerShell)$/.test(part.name)) shell = true;
    }
  }
  return shell && newest(root, gate) > since;
}
/** What the Stop hook answers. again: the turn was already sent back once for this stop. */
export function verdict({ stale, touched, running, again }) {
  const open = stale.filter((gate) => touched.has(gate.name) && !running.has(gate.name)); if (!open.length || again) return null;
  return { decision: 'block', reason: 'Change gate: files changed in this session, and their check has not passed green since the last edit.\n'
    + open.map((gate) => `- "${gate.name}": ${gate.why ?? 'check of ' + gate.files}. Run: node tools/gate.mjs run ${gate.name}`).join('\n')
    + '\nRed: fix the cause and repeat (never weaken the check). A long check may run in the background: the turn may end while it runs. A defect a person found: first a general check of its class, then the fix.' };
}
/** Observe mode: log what would have been blocked, block nothing. */
export function observe(root, out) {
  if (!out) return;
  mkdirSync(marks(root), { recursive: true });
  appendFileSync(join(marks(root), 'observe.log'), `${new Date().toISOString()} would block: ${out.reason.split('\n').slice(1, -1).join(' ')}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd(); const [command] = process.argv.slice(2); const gates = load(root);
  if (command === 'status') { const open = new Set(stale(root, gates).map((g) => g.name)); for (const gate of gates) console.log(`${open.has(gate.name) ? 'not passed' : 'passed    '}  ${gate.name}  ${gate.run}`); console.log(`mode: ${mode(root)}`); process.exit(open.size ? 1 : 0); }
  const chosen = process.argv.slice(3).map((n) => gates.find((g) => g.name === n));
  if (command !== 'run' || !chosen.length || chosen.some((g) => !g)) { console.error(`node tools/gate.mjs run <${gates.map((g) => g.name).join('|') || 'name'}> | status`); process.exit(2); }
  mkdirSync(marks(root), { recursive: true }); const flag = (gate) => join(marks(root), gate.name + '.running');
  // Every chosen gate is «running» from the start: one waiting for its turn must not hold the agent's stop.
  for (const gate of chosen) writeFileSync(flag(gate), String(process.pid));
  let failed = 0;
  try {
    for (const gate of chosen) {
      const before = signature(root, gate); let code = 1;
      try { code = spawnSync(gate.run, { cwd: root, shell: true, stdio: 'inherit' }).status ?? 1; } finally { rmSync(flag(gate), { force: true }); }
      if (code !== 0) { console.error(`Gate "${gate.name}" not passed: the check ended with code ${code}.`); failed = code; continue; }
      // Files changed while the check ran: it checked something else.
      if (signature(root, gate) !== before) { console.error(`Gate "${gate.name}" not passed: files changed while the check ran. Repeat it.`); failed = 4; continue; }
      stamp(root, gate, before); console.log(`Gate "${gate.name}" passed.`);
    }
  } finally { for (const gate of chosen) rmSync(flag(gate), { force: true }); }
  process.exit(failed);
}
