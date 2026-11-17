---
name: verify
description: Verify a change to Loadout before calling it done or committing it. Runs only the checks the changed files need (Rust, types, unit tests, the window end to end), cheapest first. Use it after every code change, before a commit, and with --release before building an installer.
---

# Verify a change

```bash
node tools/verify.mjs            # the checks the changed files need, cheapest first, stops at the first red one
node tools/verify.mjs --dry      # only print what would run and why
node tools/verify.mjs --all      # every check except packaging
node tools/verify.mjs --release  # everything, plus state/ screenshots, README screenshots, the installer and pack:check
```

What runs for which files (`tools/verify.mjs`, rules tested in `tools/verify.test.mjs`):

| Changed | Checks |
|---|---|
| `crates/`, `Cargo.*` | rustfmt, cargo test, clippy, then e2e (the window runs the core) |
| `crates/context-toolkit/` | the same, plus the hook binary end to end (`tests/guard.test.mjs`) |
| `fixtures/` | cargo test, e2e |
| `app/src`, `app/e2e`, `app/scripts`, app config | typecheck, vitest, e2e |
| `tools/`, `.claude/gates.json` | `node --test` of tools |
| docs, `*.md`, `state/`, `mockup/` | nothing |
| anything else | everything |

The end-to-end run (`app/e2e/run.mjs`, about 100 s) drives the real window on a throwaway profile and fixture home. Its screenshots go
to a temporary directory and the run prints where; look at the screens you changed. `E2E_UPDATE_SHOTS=1` (and `--release`) refreshes
the committed ones in `state/`.

## Rules

- **Done means verified.** Report the table `verify` prints. A change that skipped it is not done.
- **A change never weakens its own check.** Do not edit a test, a threshold or a gate in the same change to make it pass, unless the
  change is about that check; then say so and why.
- **Flaky is a bug.** Never add a `waitForTimeout`, a sleep or a retry to make a test pass: wait for a condition the app shows. The
  short pauses already in `run.mjs` are deliberate (a section or the layout settling before a screenshot, a layout or accessibility
  measurement or the English text check; a negative check). If the cause of a flake cannot be found, delete the test and write down why in the commit message.
- **Three rounds, then a person.** The same failure after three attempts: stop and report what you tried.
- **A defect found by hand becomes a check of its class** (a property, an e2e assertion, a Doctor rule), shown red before the fix.
- **Properties for promises.** Core promises (a toggle and its rollback keep every byte) are property tests (`proptest`,
  `crates/loadout-core/tests/write_props.rs`); keep the case count modest and commit `*.proptest-regressions`.

## Traps

- After `npm ci` in `app/`, install the Electron binary: `node node_modules/electron/install.js` (its install script may not run).
- One run at a time: `verify` holds a lock in the git directory and refuses a second run (exit 3). A killed e2e can leave its
  processes holding `app/build/context-toolkit.exe`; the next run then fails with `EBUSY`. Stop them first.
- `cargo fmt --all -- --check` fails on code no one formatted: run `cargo fmt --all`, never skip the check.

## The change gate

`.claude/gates.json` and the Stop hook in `.claude/settings.json` watch the files above. The gate is in **observe** mode: it only logs
to `<git-dir>/gates/observe.log` what it would have blocked. Switch `"mode"` to `"enforce"` once the log shows no false alarms.
A green `node tools/verify.mjs` marks the gate passed for the files as they are (unless they changed during the run);
`node tools/gate.mjs status` shows whether they did.
