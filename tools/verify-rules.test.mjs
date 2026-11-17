// Loadout's rules in .claude/verify.json: wrong in the cheap direction means a defect slips through.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { config, needs, pick } from './verify.mjs';

const root = join(import.meta.dirname, '..');
const cfg = config(root);
const names = (paths) => pick(paths, cfg).map((s) => s.name);

test('docs and committed screenshots need no checks; markdown in fixtures is test data', () => {
  assert.deepEqual(names(['README.md', 'docs/CONCEPT.md', 'state/m1-matrix-1280.png', 'TODO.md', 'app/README.md', 'crates/context-toolkit/README.md']), []);
  assert.deepEqual(names(['fixtures/home/.claude/skills/demo-skill/SKILL.md']), ['rust-test', 'e2e']);
});

test('the core needs the Rust checks and the window; the window code needs no Rust', () => {
  assert.deepEqual(names(['crates/loadout-core/src/lib.rs']), ['rust-fmt', 'rust-test', 'clippy', 'e2e']);
  assert.deepEqual(names(['app/src/renderer/doctor.ts']), ['typecheck', 'unit', 'e2e']);
  assert.deepEqual(names(['crates/context-toolkit/src/main.rs']), ['rust-fmt', 'rust-test', 'clippy', 'ctk-guard', 'e2e']);
  assert.deepEqual(names(['Cargo.lock']), ['rust-fmt', 'rust-test', 'clippy', 'ctk-guard', 'e2e'], 'a dependency update reaches the hook binary');
  assert.deepEqual(names(['tools/gate.mjs', '.claude/verify.json']), ['tools']);
});

test('the change gate watches exactly the files that need a check', () => {
  const gate = JSON.parse(readFileSync(join(root, '.claude', 'gates.json'), 'utf8')).gates[0];
  const rule = new RegExp(gate.files);
  for (const p of ['app/package.json', 'app/tsconfig.json', 'crates/loadoutd/src/main.rs', 'fixtures/home/.claude/skills/demo-skill/SKILL.md', 'tools/verify.mjs', '.claude/gates.json', '.claude/verify.json', 'Cargo.lock', 'somewhere/new.file', 'README.md', 'docs/CONCEPT.md', 'state/a.png', 'crates/context-toolkit/README.md'])
    assert.equal(rule.test(p), needs(p, cfg).length > 0, p);
});
