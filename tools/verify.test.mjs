// The rules that pick checks by changed files: wrong in the cheap direction means a defect slips through.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { needs, pick, STEPS } from './verify.mjs';

const names = (paths) => pick(paths).map((s) => s.name);

test('docs and committed screenshots need no checks', () => {
  assert.deepEqual(names(['README.md', 'docs/CONCEPT.md', 'state/m1-matrix-1280.png', 'TODO.md']), []);
});

test('the core needs the Rust checks and the window, the window code needs no Rust', () => {
  assert.deepEqual(names(['crates/loadout-core/src/lib.rs']), ['rust-fmt', 'rust-test', 'clippy', 'e2e']);
  assert.deepEqual(names(['app/src/renderer/doctor.ts']), ['typecheck', 'unit', 'e2e']);
  assert.deepEqual(names(['fixtures/home/.codex/config.toml']), ['rust-test', 'e2e']);
  assert.deepEqual(names(['fixtures/home/.claude/skills/demo-skill/SKILL.md']), ['rust-test', 'e2e'], 'markdown in fixtures is test data');
});

test('checks run cheapest first and each once', () => {
  assert.deepEqual(names(['app/src/main/index.ts', 'crates/loadoutd/src/main.rs', 'tools/gate.mjs']), ['tools', 'rust-fmt', 'typecheck', 'unit', 'rust-test', 'clippy', 'e2e']);
});

test('the Context Toolkit also runs its hook binary end to end', () => {
  assert.deepEqual(names(['crates/context-toolkit/src/main.rs']), ['rust-fmt', 'rust-test', 'clippy', 'ctk-guard', 'e2e']);
});

test('an unknown path gets every check', () => {
  assert.equal(needs('somewhere/new.file').length, STEPS.length);
  assert.equal(needs('app/README.md').length, 0, 'markdown is docs wherever it is');
});

test('the change gate watches exactly the files that need a check', () => {
  const gate = JSON.parse(readFileSync(join(import.meta.dirname, '..', '.claude', 'gates.json'), 'utf8')).gates[0];
  const rule = new RegExp(gate.files);
  for (const p of ['app/package.json', 'app/tsconfig.json', 'crates/loadoutd/src/main.rs', 'fixtures/home/.claude/skills/demo-skill/SKILL.md', 'tools/verify.mjs', '.claude/gates.json', 'Cargo.lock', 'somewhere/new.file', 'README.md', 'docs/CONCEPT.md', 'state/a.png', 'crates/context-toolkit/README.md'])
    assert.equal(rule.test(p), needs(p).length > 0, p);
});
