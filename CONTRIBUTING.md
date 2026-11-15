# Contributing to Loadout

[English](CONTRIBUTING.md) · [Русский](CONTRIBUTING.ru.md)

Thanks for looking. Loadout writes into the config files of other programs, so the bar for changes is "does not lose or leak user data". Please read this page before opening a pull request.

## Set up

Requirements: Windows 10/11, Rust (MSVC toolchain), Node.js.

```bash
git clone https://github.com/d-ridelman/Loadout.git
cd Loadout
cargo build --release
cd app && npm install
```

## Before you push

All of these must pass:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cd app
npm run typecheck
npx vitest run
npm run e2e          # builds the core and the window, drives the real app on fixtures
```

`crates/ctxkit` also has `node crates/ctxkit/tests/guard.test.mjs` (needs `cargo build --release` first).

## Rules that matter

- **Never write to a real profile in tests.** Tests and the e2e scenarios run on copies of `fixtures/` in a temporary directory (`LOADOUT_HOME`, `LOADOUT_USER_DATA`). Real config files of the developer must not change; the e2e run compares hashes of the real files before and after.
- **Writes go through the pipeline** described in [docs/CONCEPT.en.md](docs/CONCEPT.en.md) §5: plan, preview, hash lock, backup, atomic write, verify, journal, rollback. New write operations get a level (R1 for plain flags, R2 for everything else), a rollback and a test of the rollback (byte-identical file).
- **Edit surgically.** JSON by AST, TOML by `toml_edit`, YAML by lines: only the touched value changes, comments, key order and line endings stay.
- **Secrets stay in the core.** Environment values and headers must not appear in a plan, a journal entry, an error message or the window. Names of keys are fine, values are not. A new field that could carry a value needs a masking test.
- **Logic changes come with a test** that fails before the change and passes after it. Extra code that nobody asked for is a reason to push back.
- **Screenshots**: `docs/screenshots/` are copies of e2e snapshots from `state/`. Refresh them when the UI changes visibly.
- No GitHub Actions or Dependabot are configured on purpose.

## Pull requests

- One topic per pull request, a short description of what changes and why, and what you ran.
- Commit messages: imperative or descriptive, the history is mostly in Russian, English is fine.
- A change that touches the write path or masking is reviewed against the notes in [docs/CONCEPT.en.md](docs/CONCEPT.en.md) §10.5 (audits and known limits).

## Reporting a problem

Open an issue with the client and its version, what you did, what you expected and what happened. Do not paste config files: they may contain tokens. The names of keys and entries are enough.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
