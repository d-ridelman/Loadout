// The verify engine (tools/verify.mjs), on a config of its own: the project's rules are tested next to its config.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stale } from './gate.mjs';
import { before, changed, everything, history, needs, passGates, pick, problems } from './verify.mjs';

const cfg = {
  steps: [{ name: 'lint', cmd: 'x' }, { name: 'unit', cmd: 'x' }, { name: 'e2e', cmd: 'x' }],
  release: { replace: 'e2e', steps: [{ name: 'shots', cmd: 'x' }, { name: 'dist', cmd: 'x' }] },
  rules: [
    { files: '^docs/|[.]md$', run: [] },
    { files: '^src/ui/', run: ['unit', 'e2e'] },
    { files: '^src/', run: ['lint', 'unit'] },
    { files: '^ci/', run: 'all' },
  ],
};
const names = (paths) => pick(paths, cfg).map((s) => s.name);
const git = (root, ...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });

test('the first matching rule decides; no match or "all" means every step', () => {
  assert.deepEqual(needs('src/ui/a.tsx', cfg), ['unit', 'e2e'], 'the first rule wins over a wider one below');
  assert.deepEqual(needs('src/core.ts', cfg), ['lint', 'unit']);
  assert.deepEqual(needs('README.md', cfg), []);
  assert.deepEqual(needs('ci/build.yml', cfg), ['lint', 'unit', 'e2e']);
  assert.deepEqual(needs('somewhere/new.file', cfg), ['lint', 'unit', 'e2e'], 'unknown paths get everything');
  assert.deepEqual(needs('src\\ui\\a.tsx', cfg), ['unit', 'e2e'], 'Windows separators');
});

test('config mistakes that would quietly run less are refused', () => {
  assert.deepEqual(problems(cfg), []);
  const bad = problems({ ...cfg, rules: [{ files: '^src/', run: ['Unit', 'e2e'] }, { files: '(', run: [] }, { files: 'x', run: 'some' }], release: { replace: 'E2E', steps: [] } });
  assert.ok(bad.some((p) => p.includes('no step named "Unit"')), 'a typo in a step name');
  assert.ok(bad.some((p) => p.includes('not a regex')), 'a broken regex');
  assert.ok(bad.some((p) => p.includes('run must be')), 'run is neither a list nor "all"');
  assert.ok(bad.some((p) => p.includes('release.replace')), 'a release that replaces nothing');
  const empty = problems({ ...cfg, rules: [{ run: ['unit'] }], release: { steps: [{ cmd: 'x' }] } });
  assert.ok(empty.some((p) => p.includes('without "files"')), 'a rule without files would match everything');
  assert.ok(empty.some((p) => p.includes('without a name')), 'a release step without a name');
});

test('steps run in config order, each once', () => {
  assert.deepEqual(names(['src/ui/a.tsx', 'src/core.ts', 'docs/a.md']), ['lint', 'unit', 'e2e']);
  assert.deepEqual(names(['docs/a.md']), []);
});

test('--release puts its steps in place of the one it replaces', () => {
  assert.deepEqual(everything(cfg, true).map((s) => s.name), ['lint', 'unit', 'shots', 'dist']);
  assert.deepEqual(everything(cfg, false).map((s) => s.name), ['lint', 'unit', 'e2e']);
  assert.deepEqual(everything({ ...cfg, release: { steps: [{ name: 'dist', cmd: 'x' }] } }, true).map((s) => s.name), ['lint', 'unit', 'e2e', 'dist'], 'nothing to replace: appended');
});

test('changed files: the working tree, then the last commit; the first commit and a merge too', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verify-'));
  try {
    git(root, 'init', '-q'); git(root, 'config', 'user.email', 't@t'); git(root, 'config', 'user.name', 't');
    await writeFile(join(root, 'a.txt'), '1'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'one');
    assert.deepEqual(changed(root), ['a.txt'], 'the very first commit, no base branch');
    await writeFile(join(root, 'b.txt'), '1');
    assert.deepEqual(changed(root), ['b.txt'], 'a new file in the tree');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'two');
    git(root, 'checkout', '-qb', 'side'); await writeFile(join(root, 'c.txt'), '1'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'three');
    git(root, 'checkout', '-q', '-'); git(root, 'merge', '-q', '--no-ff', '-m', 'merge', 'side');
    assert.deepEqual(changed(root), ['c.txt'], 'a merge against its first parent');
    assert.deepEqual(history(root, { ...cfg, rules: [{ files: '[.]txt$', run: [] }] }, 10), { none: 3, part: 0, all: 0 }, 'history leaves merges out');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a package of a monorepo sees only its own files, from its own root', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'verify-'));
  try {
    git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    await mkdir(join(repo, 'pkg', 'src'), { recursive: true }); await mkdir(join(repo, 'other'));
    await writeFile(join(repo, 'pkg', 'src', 'a.js'), '1'); await writeFile(join(repo, 'other', 'b.js'), '1');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'one');
    await writeFile(join(repo, 'pkg', 'src', 'a.js'), '2'); await writeFile(join(repo, 'other', 'b.js'), '2'); await writeFile(join(repo, 'pkg', 'new.js'), '1');
    assert.deepEqual(changed(join(repo, 'pkg'), 'HEAD'), ['new.js', 'src/a.js'], 'paths from the package root, the neighbour left out');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('a green verify passes the change gate, unless its files changed during the run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verify-'));
  try {
    git(root, 'init', '-q');
    await mkdir(join(root, '.claude')); await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.rs'), 'fn a() {}');
    await writeFile(join(root, '.claude', 'gates.json'), JSON.stringify({ gates: [{ name: 'verify', files: '^src/', run: 'node tools/verify.mjs' }, { name: 'ui', files: '^src/', run: 'node tools/qa-ui.mjs' }] }));
    let sigs = before(root);
    assert.deepEqual(passGates(root, sigs), ['verify'], 'only the gates that run verify');
    assert.deepEqual(stale(root).map((g) => g.name), ['ui'], 'a gate with its own check is not passed by verify');
    sigs = before(root);
    await writeFile(join(root, 'src', 'a.rs'), 'fn a() { 1; }');
    assert.deepEqual(passGates(root, sigs), [], 'an edit during the run: no mark');
    assert.deepEqual(stale(root).map((g) => g.name), ['verify', 'ui']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
