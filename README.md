<div align="center">

# Loadout

**One screen for the plugins, MCP servers, skills and hooks of all your AI coding clients.**

[English](README.md) · [Русский](README.ru.md)

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Core](https://img.shields.io/badge/core-Rust-orange)
![App](https://img.shields.io/badge/app-Electron%20%2B%20React-47848f)
![Status](https://img.shields.io/badge/status-pre--release-yellow)

</div>

![Matrix of entries by client](docs/screenshots/en-matrix.png)

*Screenshots show test data from `fixtures/`, not a real profile.*

## Why

Claude Code, Claude Desktop, Codex, Antigravity and DeepSeek Harness each keep plugins, MCP servers, skills, agents, hooks and commands in their own files and formats (JSON, TOML, YAML). Finding out what is enabled where, or moving a server from one client to another, means editing config files by hand.

Loadout reads all five clients, shows everything in one matrix and changes it **surgically and safely**.

## Features

- **Matrix** of every entry across the five clients: enabled, disabled, broken, version drift. Plugins and MCP servers are separate groups. Inspector on the right.
- **Toggle** an entry (level R1). **Trash an MCP server, edit its command, copy it to another client** (level R2); JSON ⇄ TOML ⇄ YAML is translated for you.
- **Add an MCP server** from the window. Environment values are never shown in the window, the preview or the journal.
- **Install a Claude Code plugin from a marketplace.** You add a marketplace by GitHub `owner/repo`, an `https://` address or a folder. You pick the plugin from the marketplace catalog, with descriptions. Before `claude` runs, the window shows the exact command and what it will write.
- **Install a skill** from a GitHub repository or a folder into `~/.claude/skills`. The window first tells you what will be downloaded and where. Then it shows a plan with the files and a warning about code. The installation goes into the journal and can be rolled back.
- **Profiles**: snapshot a set of enabled entries, apply it as one batch, roll the whole batch back.
- **Journal** of every write with one-click rollback. Before any write the file is copied to a backup.
- **Doctor** finds broken links, drift, duplicates and stray backups.
- **ctxkit** built in: install, apply and see its effect (see below).
- **Russian and English UI**, switched in the header (RU / EN). The first launch follows the system language; messages of the core follow the choice too.
- Read-only by default (R0). Raising the write level needs an OS confirmation dialog.

### Safe write pipeline

plan → preview → hash lock (`base_sha`) → backup + manifest → temp file + rename → re-read and verify → journal / rollback. If a file changed after the preview, the write is refused. Details: [docs/CONCEPT.en.md](docs/CONCEPT.en.md) §5.

### Copies and secrets

Operation backups and the Loadout trash keep client configs **in full and as plain text, including the `env` values of MCP servers (keys and tokens)**. They live in `%APPDATA%\loadout-app\backups` (the app's data folder is named after the package, `loadout-app`; inside the Windows profile; Loadout sets no permissions of its own, access is inherited from the user profile) and are never sent anywhere. The dialog that enables writing (R1/R2) says so too.

- The last 100 operations not older than 90 days are kept. Older ones are deleted before a new write, by the “Clean up old copies” button in the journal and by the `loadout prune` command (defaults to `%APPDATA%\loadout-app\backups`, another directory: `--backups`). Rolling back an already deleted operation is refused with a clear message.
- The trash (`backups\trash`) is not cleaned by itself: it holds the only copy of a trashed MCP entry, which returns to the client file when turned on.
- The uninstaller leaves the data alone. To remove everything, close Loadout and delete the `%APPDATA%\loadout-app` folder (or just `%APPDATA%\loadout-app\backups`). The cleanup command sits next to the app: `& "$env:LOCALAPPDATA\Programs\Loadout\resources\loadout.exe" prune`.

| Add an MCP server | Install a plugin |
|---|---|
| ![Add MCP](docs/screenshots/en-add-mcp.png) | ![Install plugin](docs/screenshots/en-install-plugin.png) |

| Journal and rollback | Doctor |
|---|---|
| ![Journal](docs/screenshots/en-journal.png) | ![Doctor](docs/screenshots/en-doctor.png) |

## ctxkit

[`crates/ctxkit`](crates/ctxkit/README.md) is a toolkit of hooks and diagnostics that keeps agent context small: it limits whole-file reads, catches broken escaping, compresses build output and points agents to cheap search and independent review (model, advisor and effort change only on explicit flags or an explicit choice in the form). It is built into the app (the **ctxkit** section: preview, apply, roll back) and can also be installed on its own.

![ctxkit in the app](docs/screenshots/en-ctxkit.png)

## Repository layout

| Path | What it is |
|---|---|
| `app/` | Desktop app (Electron + React, Windows) |
| `crates/loadout-core`, `crates/loadoutd` | Rust core: scan, write pipeline, file watcher, sidecar process for the window |
| `crates/ctxkit` | ctxkit, built in the same Cargo workspace |
| `docs/CONCEPT.en.md`, `docs/CONCEPT.md` | Design, decisions, milestone and audit notes (English, Russian) |
| `docs/screenshots/` | Screenshots used in this README |
| `fixtures/`, `state/` | Test data and window snapshots produced by the e2e scenarios |

## Build and test

Requirements: Rust (MSVC toolchain), Node.js, Windows 10/11.

```bash
cargo build --release          # core and ctxkit (binaries in target/release)
cargo test                     # Rust tests
cd app && npm install
npm run e2e                    # build and drive the real window
npm run dist                   # installer (NSIS, unsigned)
```

`ctxkit.exe` for the app is built from `crates/ctxkit` (`npm run bundle:ctxkit`).

## Status

Pre-release. Milestones M0–M5 are done (see [docs/CONCEPT.en.md](docs/CONCEPT.en.md) §10). Code signing and auto-update are intentionally not done: they need a code-signing certificate and a publishing address, and the app works fully offline.

## License

[MIT](LICENSE). See also [CONTRIBUTING.md](CONTRIBUTING.md).
