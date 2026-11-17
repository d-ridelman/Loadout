<div align="center">

# Loadout

**A Windows app that shows the plugins, MCP servers, skills and hooks of five AI coding clients in one matrix and edits their configs safely: preview, backup, journal, rollback.**

[English](README.md) · [Русский](README.ru.md)

![Platform](https://img.shields.io/badge/platform-Windows%20x64-blue)
[![Release](https://img.shields.io/github/v/release/d-ridelman/Loadout)](https://github.com/d-ridelman/Loadout/releases/latest)
![Core](https://img.shields.io/badge/core-Rust-orange)
![App](https://img.shields.io/badge/app-Electron%20%2B%20React-47848f)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

![Matrix of entries by client](docs/screenshots/en-matrix.png)

*All screenshots are taken on the test data in `fixtures/`, not on a real profile.*

## Why

Claude Code, Claude Desktop, ChatGPT / Codex, Antigravity and DeepSeek Harness each keep plugins, MCP servers, skills, agents, hooks and commands in their own files and formats (JSON, TOML, YAML). Finding out what is enabled where, or moving a server from one client to another, means editing config files by hand.

Loadout reads all five clients, shows everything in one matrix and changes only the value you touched.

## Features

- **First launch**: a card says what Loadout is, that it writes nothing without a preview and your confirmation, and that the only thing it does online by itself is the update check. Close it once and it does not come back.
- **Matrix** of every entry across the five clients: enabled, disabled, broken, version mismatch. Filters by type and state, search, keyboard navigation, command palette (`Ctrl+K`). "What the marks mean" above the table explains every mark, `+N`, the `Δ` of a fresh change and the FX switch. The inspector on the right shows the file, the key and the contents without secrets.
- **Radar, hooks, doctor.** A per-client overview, the hook pipeline by lifecycle event, and findings: broken entries, version mismatches, the same entry in several scopes, empty marketplaces, broken links to a cleaned cache, piles of third-party backups, MCP configs with secret keys. The Doctor groups findings by severity and says how to fix each one; the "broken: N" counter in the footer opens it.
- **Messages** after an action pop up above the footer in colour (done, error, info) and in full; screen readers announce them.
- **Toggle** an entry that has an on/off flag: plugins, connectors, Codex entries (write level R1). Most MCP servers have no such flag: disabling one **moves it to the Loadout trash**, and enabling puts it back in the same place (R2). **Edit an MCP command, copy it to another client** (R2); JSON, TOML and YAML are translated for you.
- **Add an MCP server** from the window. The `env` values you type go to the core and are not shown in the preview, the journal or the inspector.
- **Install a Claude Code plugin from a marketplace.** Add a marketplace by GitHub `owner/repo`, an `https://` or SSH address, or a local folder, then pick a plugin from its catalog. Before anything runs, the window shows the exact `claude plugin …` command.
- **Install a skill** into `~/.claude/skills` from a GitHub repository or a local folder. The window first says what will be downloaded and where, then shows a plan with the files and a warning when the skill contains code. The installation goes into the journal and can be rolled back.
- **Profiles**: capture the set of enabled plugins and MCP servers, apply it as one batch, roll the whole batch back.
- **Journal** of the writes above: toggles, the trash, MCP edits, copies and additions, profile batches and skill installs. Each one rolls back from the journal after the same preview (file, key, before → after). Before any write the file is copied to a backup. Plugin and marketplace installs run through `claude` itself and are not in the journal (remove a plugin with `claude plugin uninstall`); Context Toolkit has its own rollback.
- **Context Toolkit** built in: preview, apply, roll back, optional policies, and an "Efficiency" report (see below).
- **Russian and English UI**, switched in the header (RU / EN). The first launch follows the system language; core messages follow the choice too.
- **Updates from GitHub releases.** Loadout checks for a new version about 10 seconds after start and once a day (hourly after a failed check), offers it in a small card, downloads it only on "Download" (just the changed blocks) and installs it on "Restart and update" or when you quit after the download. The check goes only to GitHub and carries nothing about you or your configs; turn it off in the update panel (the version button at the right end of the footer). Details: [SECURITY.md](SECURITY.md#network).
- **Client files are read-only by default.** The write level in the header is named in words: "Read-only · R0", "On/off · R1" (toggles by flag), "All edits · R2" (the trash, edits, copies, installs, profiles, Context Toolkit). Raising it needs an OS confirmation dialog. Only one window runs at a time; a second launch brings the first one forward.

### Safe write pipeline

plan → preview → hash lock (`base_sha`) → backup + manifest → temp file + rename → re-read and verify → journal / rollback. If a file changed after the preview, the write is refused. JSON is edited in place, TOML through `toml_edit`, YAML line by line: comments, key order and line endings stay (an MCP server back from the trash goes in front of the key that followed it; one moved out by Loadout 0.0.7 or older goes to the end). Details: [docs/CONCEPT.en.md](docs/CONCEPT.en.md) §5.

### Copies and secrets

Operation backups and the Loadout trash keep client configs **in full and as plain text, including the `env` values of MCP servers (keys and tokens)**. A masked copy could not give an exact rollback. They live in `%APPDATA%\loadout-app\backups` (the folder is named after the package, `loadout-app`), inside your Windows profile; Loadout sets no permissions of its own, so access is the same as for your other profile files. They are never sent anywhere. The dialog that enables writing (R1/R2) says so too.

- The last 100 operations not older than 90 days are kept. Older ones are deleted before a new write, by the "Clean up old copies…" button in the journal, and by `loadout prune` (default folder `%APPDATA%\loadout-app\backups`, another one with `--backups`). Rolling back an operation whose copy was deleted is refused with a clear message.
- The trash (`backups\trash`) is not cleaned automatically: it holds the only copy of a trashed MCP entry, which goes back into the client file when you turn the entry on. Profiles (`backups\profiles.json`) live in the same folder.
- Context Toolkit makes its own backups before it writes: `~/.claude/backups` for Claude Code, next to the changed file for the other clients (usually in a `backups` subfolder). These copies are also full files.

## Screenshots

| Radar | Hooks |
|---|---|
| ![Radar](docs/screenshots/en-radar.png) | ![Hook pipeline](docs/screenshots/en-hooks.png) |

| Doctor | Journal and rollback |
|---|---|
| ![Doctor](docs/screenshots/en-doctor.png) | ![Journal](docs/screenshots/en-journal.png) |

| Add an MCP server | Install a plugin from a marketplace catalog |
|---|---|
| ![Add MCP server](docs/screenshots/en-add-mcp.png) | ![Install plugin](docs/screenshots/en-install-plugin.png) |

| Install a skill | Profiles |
|---|---|
| ![Install skill](docs/screenshots/en-install-skill.png) | ![Profiles](docs/screenshots/en-profiles.png) |

| Context Toolkit: form and policies | Context Toolkit: diagnostics and efficiency |
|---|---|
| ![Context Toolkit form](docs/screenshots/en-context-toolkit.png) | ![Context Toolkit efficiency](docs/screenshots/en-context-toolkit-efficiency.png) |

| Context Toolkit: rollback preview | First launch |
|---|---|
| ![Context Toolkit rollback](docs/screenshots/en-context-toolkit-rollback.png) | ![Welcome card](docs/screenshots/en-welcome.png) |

The screenshots are produced by `npm run docs-shots` in `app/` (window 1920×1080, fixtures only).

## Context Toolkit

[`crates/context-toolkit`](crates/context-toolkit/README.md) is a set of hooks and diagnostics that keeps agent context small: it limits whole-file reads, catches broken escaping, compresses build output and points agents to cheap search and independent review. It was called ctxkit before; the old name is still recognised, and `context-toolkit setup` moves an earlier installation to the new name.

In the app it is the **Context Toolkit** section (key `7`):

- **Preview** (`setup --dry-run`, writes nothing) and **Apply** (needs R2 and a preview with the same settings). **Roll back** is a separate card below: "Show what the rollback removes", then the red button; it removes only what Apply installed and does not restore the model, advisor or effort (the output names the backup to take them from). To turn the policies off and keep the hooks, choose "Turn all off" under Policies and apply.
- Selects for the main model, effort and the advisor model. The default is "Keep as is": nothing is passed and nothing changes.
- Optional **policies** in `context-toolkit.json`, off until you turn them on: commit hygiene (blocks a commit with `Co-Authored-By` / `Generated with`), confirm irreversible commands (asks before `git push`, `reset --hard`, `rm -rf` and the like), stray report files, a parallel build limit. The checkboxes show what is on now; a tick switches the mode to "Turn on the selected" by itself, keeping the policies that are already on.
- **Diagnostics** (`doctor`) and **Efficiency** (`report`): Claude Code turns by model, subagent and advisor calls, blocked reads, by day for 7, 14 or 30 days. A diagnostic fix that is a `context-toolkit setup` command becomes a button that fills the Apply form.

The window starts only the `context-toolkit.exe` shipped with it, never one from `PATH`. Context Toolkit can also be installed on its own, see its README.

## Install

1. Download `Loadout.Setup.<version>.exe` from [Releases](https://github.com/d-ridelman/Loadout/releases/latest) and run it. By default it installs for the current user into `%LOCALAPPDATA%\Programs\Loadout`; the installer also offers an install for all users and another folder (the paths below assume the default).
2. **The installer is not signed.** Windows SmartScreen may warn about an unrecognized app; open the details in its dialog and choose to run the installer anyway. The SHA-256 of the installer is in the release notes.
3. Silent install: `Loadout.Setup.<version>.exe /S`.
4. Starting with 1.0.0, Loadout updates itself from Releases (see Features); 0.0.7 and older have to be replaced by hand once. Updates are not signed either: they are checked by the SHA-512 that the release's `latest.yml` carries ([SECURITY.md](SECURITY.md#updates-and-the-unsigned-installer)).

Installing plugins needs the `claude` CLI (Claude Code); installing skills from GitHub needs `git` in `PATH`.

**Uninstall** through Windows Settings → Apps, or silently: `& "$env:LOCALAPPDATA\Programs\Loadout\Uninstall Loadout.exe" /S`. The uninstaller leaves your data alone. To remove it, close Loadout and delete `%APPDATA%\loadout-app` and `%LOCALAPPDATA%\loadout-app-updater` (where downloaded updates are kept). Deleting only `%APPDATA%\loadout-app\backups` removes the copies, the journal, the trash and the profiles. To trim old copies instead, run `& "$env:LOCALAPPDATA\Programs\Loadout\resources\loadout.exe" prune`.

## Build from source

Requirements: Windows 11 x64 (Windows 10 is not tested), Rust 1.91 or newer with the MSVC toolchain (the minimum comes from `notify-types` in `Cargo.lock`), Node.js 22.12+, 24 or 26+ (vitest does not support 23 and 25), `git`.

```bash
git clone https://github.com/d-ridelman/Loadout.git
cd Loadout
cargo build --release          # core (loadout.exe) and context-toolkit.exe in target/release
cargo test                     # Rust tests
cd app
npm ci
npm run dev                    # the window in development mode
npm test                       # unit tests (vitest)
npm run e2e                    # builds everything and drives the real window on fixtures
npm run dist                   # NSIS installer in app/dist (unsigned)
```

`npm run e2e`, `npm run dist` and `npm run docs-shots` build the core and copy `context-toolkit.exe` into `app/build` themselves (`npm run bundle:context-toolkit`). A release needs three files from `app/dist` uploaded as they are: `Loadout.Setup.<version>.exe`, its `.blockmap` and `latest.yml` (without `latest.yml` installed copies do not see the release; the release must not be a draft or a pre-release). More checks and the rules for changes: [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository layout

| Path | What it is |
|---|---|
| `app/` | Desktop app (Electron + React + TypeScript) |
| `crates/loadout-core`, `crates/loadoutd` | Rust core: scan, write pipeline, file watcher; `loadout.exe` (CLI and the window's sidecar process) |
| `crates/context-toolkit` | Context Toolkit, in the same Cargo workspace |
| `docs/CONCEPT.en.md`, `docs/CONCEPT.md` | Design, decisions, milestone and audit notes (English, Russian) |
| `docs/screenshots/` | Screenshots for the READMEs (`npm run docs-shots`) |
| `fixtures/` | Synthetic client configs for tests and screenshots |
| `state/` | Window snapshots from the e2e scenarios |
| `mockup/` | The clickable mockup of the initial concept (historical) |

## Status

Version 0.0.7, Windows only. Milestones M0–M5 and the built-in Context Toolkit are done (see [docs/CONCEPT.en.md](docs/CONCEPT.en.md) §10).

Known limitations:

- code signing (it needs a code-signing certificate): updates are verified by SHA-512 only;
- macOS and Linux;
- project-level settings (`.claude/settings.json` in a project, `.mcp.json`): plugins enabled only there show as "unknown";
- the MCP check that starts a server and asks for its tools;
- a Claude Code profile other than `~/.claude` (`CLAUDE_CONFIG_DIR`) is not read.

Open work is in [TODO.md](TODO.md): one dated item, comparing advisor and `checker` calls by day after 22.11.2026.

## Security

How to report a vulnerability and what the app reads and writes: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). See also [CONTRIBUTING.md](CONTRIBUTING.md).
