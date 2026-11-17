// The change gate (tools/gate.mjs, tools/claude-stop-gate.mjs): a turn that changed files of a gate does not end until the gate's checks
// passed on those very files; in observe mode the hook only logs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { marks, signature, stamp, stale, touched, verdict } from './gate.mjs';

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
    await writeFile(join(root, '.claude', 'gates.json'), JSON.stringify({ gates: [ui] }));
    assert.equal(run(), '', 'observe (the default) prints nothing');
    const log = join(marks(root), 'observe.log');
    assert.ok(existsSync(log) && readFileSync(log, 'utf8').includes('"ui"'), 'and logs what it would have blocked');
  } finally { await rm(root, { recursive: true, force: true }); }
});
