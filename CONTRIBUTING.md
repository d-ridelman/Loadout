# Contributing to Loadout

[English](CONTRIBUTING.md) · [Русский](CONTRIBUTING.ru.md)

Thanks for looking. Loadout writes into the config files of other programs, so the bar for changes is "does not lose or leak user data". Please read this page before opening a pull request.

## Set up

Requirements: Windows 11 x64 (Windows 10 is not tested), Rust 1.91 or newer with the MSVC toolchain (the minimum comes from `notify-types` in `Cargo.lock`), Node.js 22.12+, 24 or 26+ (vitest does not support 23 and 25), `git`.

```bash
git clone https://github.com/d-ridelman/Loadout.git
cd Loadout
cargo build --release
cd app && npm ci
```

If `app/node_modules/electron/dist/electron.exe` is missing after `npm ci` (npm did not run the package install scripts), download it with `node node_modules/electron/install.js`.

`npm run dev` opens the window in development mode. It reads your real configs and keeps its data in `%APPDATA%\loadout-app`, like an installed copy. To work on a copy, set `LOADOUT_HOME` (a home folder with client configs) and `LOADOUT_USER_DATA` (the window's data folder); the installed build ignores these variables.

## Before you push

The quick way: `node tools/verify.mjs` runs only the checks your changed files need, cheapest first, and stops at the first red one (`--dry` shows the plan, `--all` runs everything, `--release` adds the screenshots, the installer and its check). The rules are in `tools/verify.mjs` and tested in `tools/verify.test.mjs`.

All of these must pass:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cd app
npm run typecheck
npx vitest run
npm run e2e          # builds the core, context-toolkit.exe and the window, drives the real app on fixtures (about 2 minutes)
```

`crates/context-toolkit` also has `node crates/context-toolkit/tests/guard.test.mjs` (needs `cargo build --release` first). To check the packaged build: `npm run pack`, then `npm run pack:check` (it reads your real configs, read-only, level R0).

The e2e run opens app windows and takes screenshots, so run it when the machine is idle. The screenshots go to a temporary directory that the run prints at the end, so the tree stays clean; `E2E_UPDATE_SHOTS=1 npm run e2e` (or `node tools/verify.mjs --release`) refreshes the committed ones in `state/` when the window really changed. Waits in the scenarios wait for a condition the app shows, not for a fixed time.

## Rules that matter

- **Never write to a real profile in tests.** Tests and the e2e scenarios run on copies of `fixtures/` in a temporary directory (`LOADOUT_HOME`, `LOADOUT_USER_DATA`). Real config files of the developer must not change; the e2e run compares hashes of the real files before and after.
- **Writes go through the pipeline** described in [docs/CONCEPT.en.md](docs/CONCEPT.en.md) §5: plan, preview, hash lock, backup, atomic write, verify, journal, rollback. New write operations get a level (R1 for plain flags, R2 for everything else), a rollback and a test of the rollback (byte-identical file).
- **Edit surgically.** JSON by AST, TOML by `toml_edit`, YAML by lines: only the touched value changes, comments, key order and line endings stay.
- **Secrets stay in the core.** Environment values and headers must not appear in a plan, a journal entry, an error message or the window. Names of keys are fine, values are not. A new field that could carry a value needs a masking test.
- **Logic changes come with a test** that fails before the change and passes after it. Extra code that nobody asked for is a reason to push back.
- **README screenshots** (`docs/screenshots/`) are made by `npm run docs-shots` in `app/`: a 1920×1080 window on fixtures, in Russian and English. The script checks that the window shows neither the user name nor the real home path, but look at every screenshot yourself before committing it. Refresh them when the UI changes visibly.
- **Vulnerabilities** are not discussed in issues: see [SECURITY.md](SECURITY.md).
- No GitHub Actions or Dependabot are configured on purpose.

## Pull requests

- One topic per pull request, a short description of what changes and why, and what you ran.
- Commit messages: imperative or descriptive, the history is mostly in Russian, English is fine.
- A change that touches the write path or masking is reviewed against the notes in [docs/CONCEPT.en.md](docs/CONCEPT.en.md) §10.5 (audits and known limits).

## Reporting a problem

Open an issue with the client and its version, what you did, what you expected and what happened. Do not paste config files: they may contain tokens. The names of keys and entries are enough.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
