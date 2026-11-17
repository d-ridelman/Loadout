// The change gate (tools/gate.mjs, tools/claude-stop-gate.mjs): a turn that changed files of a gate does not end until the gate's checks
// passed on those very files; in observe mode the hook only logs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { marks, projectRoot, running, runsVerify, signature, stamp, stale, touched, verdict } from './gate.mjs';

const repo = async () => {
  const root = await mkdtemp(join(tmpdir(), 'gate-')); execFileSync('git', ['init', '-q'], { cwd: root });
  await mkdir(join(root, 'app')); await mkdir(join(root, 'src')); await writeFile(join(root, 'app', 'a.css'), 'a{}'); await writeFile(join(root, 'src', 'x.ts'), 'export {}');
  return root;
};
const ui = { name: 'ui', files: '^app/.*[.](css|tsx)$', run: 'node -e 0' };
/** A Windows path as Claude Code writes it into the transcript. */
const win = (path) => path.replaceAll('/', String.fromCharCode(92));
const use = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

test('the signature changes with an edit of a gate file and not with a foreign one', async () => {
  const root = await repo();
  try {
    const before = signature(root, ui);
    await writeFile(join(root, 'src', 'x.ts'), 'export const a = 1'); assert.equal(signature(root, ui), before, 'a foreign file leaves it');
    await writeFile(join(root, 'app', 'a.css'), 'a{color:red}'); assert.notEqual(signature(root, ui), before, 'an edit of a gate file changes it');
    await writeFile(join(root, 'app', 'new.tsx'), ''); const withNew = signature(root, ui); await rm(join(root, 'app', 'new.tsx')); assert.notEqual(signature(root, ui), withNew, 'new and removed files too');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a gate is fresh only after a green check of the same files', async () => {
  const root = await repo();
  try {
    assert.deepEqual(stale(root, [ui]).map((g) => g.name), ['ui'], 'no mark: not passed');
    stamp(root, ui, signature(root, ui)); assert.deepEqual(stale(root, [ui]), [], 'a mark on the same files: passed');
    await writeFile(join(root, 'app', 'a.css'), 'a{color:blue}'); const later = new Date(Date.now() + 5000); await utimes(join(root, 'app', 'a.css'), later, later);
    assert.deepEqual(stale(root, [ui]).map((g) => g.name), ['ui'], 'an edit after the check closes the gate again');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the session touched a gate: Edit, Write and a shell edit; a read and foreign files do not count', () => {
  const root = win('D:/Data/Proj');
  assert.equal(touched([use('Edit', { file_path: win('D:/Data/Proj/app/a.css') })], ui, root), true);
  assert.equal(touched([use('Write', { file_path: 'D:/Data/Proj/app/sub/B.tsx' })], ui, root), true);
  assert.equal(touched([use('Read', { file_path: win('D:/Data/Proj/app/a.css') })], ui, root), false, 'a read is not an edit');
  assert.equal(touched([use('Edit', { file_path: win('D:/Data/Proj/src/x.ts') })], ui, root), false);
  assert.equal(touched([use('Edit', { file_path: win('D:/Other/app/a.css') })], ui, root), false, 'a file of another project');
  assert.equal(touched(['not json', ''], ui, root), false);
});

test('after a shell command the gate is touched only if its files changed during the session', async () => {
  const root = await repo();
  try {
    const shell = [use('Bash', { command: 'grep -n x app/a.css' })];
    const past = new Date(Date.now() - 60_000); await utimes(join(root, 'app', 'a.css'), past, past);
    assert.equal(touched(shell, ui, root, Date.now() - 1000), false, 'a read during the session changes no file');
    await writeFile(join(root, 'app', 'a.css'), 'a{color:green}');
    assert.equal(touched(shell, ui, root, Date.now() - 1000), true, 'a script or formatter that rewrote a file');
    await utimes(join(root, 'app', 'a.css'), past, past); execFileSync('git', ['add', '-A'], { cwd: root }); await rm(join(root, 'app', 'a.css'));
    assert.equal(touched(shell, ui, root, Date.now() - 1000), true, 'a tracked file deleted from the shell');
    assert.equal(touched([use('Read', { file_path: join(root, 'app', 'a.css') })], ui, root, Date.now() - 1000), false, 'no shell command, no edit tool: not this session');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the verdict: a touched stale gate blocks; a running check and a repeated stop let the turn end', () => {
  const block = verdict({ stale: [ui], touched: new Set(['ui']), running: new Set(), again: false });
  assert.equal(block?.decision, 'block'); assert.match(block.reason, /node tools\/gate\.mjs run ui/);
  assert.equal(verdict({ stale: [ui], touched: new Set(), running: new Set(), again: false }), null, 'the session did not touch the gate');
  assert.equal(verdict({ stale: [], touched: new Set(['ui']), running: new Set(), again: false }), null, 'the check is green on these files');
  assert.equal(verdict({ stale: [ui], touched: new Set(['ui']), running: new Set(['ui']), again: false }), null, 'the check is running now');
  assert.equal(verdict({ stale: [ui], touched: new Set(['ui']), running: new Set(), again: true }), null, 'not twice in a row, or the turn could never end');
});

test('the hook blocks in enforce mode and only logs in observe mode', async () => {
  const root = await repo();
  const hook = join(import.meta.dirname, 'claude-stop-gate.mjs');
  const transcript = join(root, 't.jsonl');
  try {
    await writeFile(transcript, use('Edit', { file_path: join(root, 'app', 'a.css') }) + '\n');
    const run = () => spawnSync(process.execPath, [hook], { input: JSON.stringify({ transcript_path: transcript, cwd: root }), env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8' }).stdout;
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude', 'gates.json'), JSON.stringify({ mode: 'enforce', gates: [ui] }));
    assert.match(run(), /"decision":"block"/, 'enforce blocks');
    const sub = join(root, 'app');
    const fromSub = spawnSync(process.execPath, [hook], { input: JSON.stringify({ transcript_path: transcript, cwd: sub }), env: { ...process.env, CLAUDE_PROJECT_DIR: tmpdir() }, encoding: 'utf8' }).stdout;
    assert.match(fromSub, /"decision":"block"/, 'the working copy is found from the session cwd, not from CLAUDE_PROJECT_DIR');
    const away = spawnSync(process.execPath, [hook], { input: JSON.stringify({ transcript_path: transcript, cwd: tmpdir() }), env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8' }).stdout;
    assert.match(away, /"decision":"block"/, 'a session that went elsewhere falls back to the project it started in');
    await writeFile(join(root, '.claude', 'gates.json'), JSON.stringify({ gates: [ui] }));
    assert.equal(run(), '', 'observe (the default) prints nothing');
    const log = join(marks(root), 'observe.log');
    assert.ok(existsSync(log) && readFileSync(log, 'utf8').includes('"ui"'), 'and logs what it would have blocked');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('only verify alone marks its own gate; a compound command is an ordinary gate', () => {
  assert.equal(runsVerify({ run: 'node tools/verify.mjs' }), true);
  assert.equal(runsVerify({ run: 'node tools/verify.mjs --all' }), true);
  assert.equal(runsVerify({ run: 'node tools/verify.mjs && node -e process.exit(5)' }), false);
  assert.equal(runsVerify({ run: 'npm test' }), false);
  assert.equal(runsVerify({ run: 'node ../tools/verify.mjs' }), false, "another project's verify does not mark this gate");
});

test('a check is running only while its process is alive', async () => {
  const root = await repo();
  try {
    await mkdir(marks(root), { recursive: true });
    await writeFile(join(marks(root), 'ui.running'), String(process.pid));
    assert.deepEqual([...running(root, [ui])], ['ui'], 'a live pid');
    await writeFile(join(marks(root), 'ui.running'), '999999');
    assert.deepEqual([...running(root, [ui])], [], 'a killed run leaves a dead pid');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the project is never looked for above its repository', async () => {
  const outer = await repo();
  try {
    await mkdir(join(outer, '.claude')); await writeFile(join(outer, '.claude', 'gates.json'), JSON.stringify({ gates: [ui] }));
    const inner = join(outer, 'nested'); await mkdir(inner); execFileSync('git', ['init', '-q'], { cwd: inner });
    assert.equal(projectRoot(inner), null, 'a repository nested in another checkout does not borrow its gates');
    assert.equal(projectRoot(join(outer, 'app')), outer);
  } finally { await rm(outer, { recursive: true, force: true }); }
});

test('the message names the gate tool by its full path when the root is known', () => {
  const out = verdict({ stale: [ui], touched: new Set(['ui']), running: new Set(), again: false, root: join('D:', 'mono', 'pkg') });
  assert.match(out.reason, /node "D:\/mono\/pkg\/tools\/gate\.mjs" run ui/);
});

test('a package of a monorepo is its own project, with its own marks', async () => {
  const mono = await repo();
  try {
    const pkg = join(mono, 'pkg');
    await mkdir(join(pkg, '.claude'), { recursive: true }); await mkdir(join(pkg, 'app'));
    await writeFile(join(pkg, 'app', 'a.css'), 'a{}');
    await writeFile(join(pkg, '.claude', 'gates.json'), JSON.stringify({ mode: 'enforce', gates: [ui] }));
    assert.equal(projectRoot(join(pkg, 'app')), pkg, 'the nearest .claude/gates.json up');
    assert.equal(projectRoot(join(mono, 'src')), null, 'no project for the rest of the repository');
    assert.notEqual(marks(pkg), marks(mono), 'marks of a package do not mix with the repository root');
    const transcript = join(mono, 't.jsonl'); await writeFile(transcript, use('Edit', { file_path: join(pkg, 'app', 'a.css') }) + '\n');
    const out = spawnSync(process.execPath, [join(import.meta.dirname, 'claude-stop-gate.mjs')], { input: JSON.stringify({ transcript_path: transcript, cwd: join(pkg, 'app') }), encoding: 'utf8' }).stdout;
    assert.match(out, /"decision":"block"/, 'the hook checks the package from inside it');
  } finally { await rm(mono, { recursive: true, force: true }); }
});
