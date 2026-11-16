# Security policy

[English](SECURITY.md) · [Русский](SECURITY.ru.md)

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the [Security tab](https://github.com/d-ridelman/Loadout/security) of the repository and click **Report a vulnerability**. Do not open a public issue for a security problem.

Include the Loadout version, the client involved, the steps to reproduce and what happened. Do not attach real config files or backups: they may contain tokens. Key and entry names are enough.

## Supported versions

Only the latest release is supported. Fixes go into a new release; older versions are not patched.

| Version | Supported |
|---|---|
| latest release | yes |
| older releases | no |

## What Loadout reads

- The config files of the five clients in your Windows profile: `~/.claude.json`, `~/.claude/settings.json`, `~/.claude/plugins/installed_plugins.json` and `known_marketplaces.json`, `~/.claude/skills`, agents and commands; `%APPDATA%\Claude\claude_desktop_config.json`; `~/.codex/config.toml`, `~/.codex/hooks.json`, `~/.codex/skills`; `~/.gemini/config/` (`mcp_config.json`, `hooks.json`, `plugins/`, `skills/`); `~/.dsh/cordis.patch.yml`, `~/.dsh/profiles/*/cordis.patch.yml`, `~/.dsh/skills`.
- The core keeps the values of `env` and MCP headers to itself: the window, plans, the journal and error messages get only key names, and the other strings are masked (see [docs/CONCEPT.en.md](docs/CONCEPT.en.md) §5). Credential files of the clients (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.dsh/.credentials.yaml` and the like) are not read.
- The Context Toolkit section runs the bundled `context-toolkit.exe`, which reads the same Claude Code files and, for the "Efficiency" report, Claude Code transcripts (`~/.claude/projects/**/*.jsonl`). The report contains only counters, no text or paths.

## What Loadout writes

Nothing is written at the default level R0. Writing starts only after you raise the level (R1 or R2, confirmed by an OS dialog) and confirm a preview.

- **Client config files**, only the value an operation changes (toggle, trash, edit, copy, add an MCP server, apply a profile).
- **`~/.claude/skills/<name>`** when you install a skill.
- **Claude Code plugins** are installed by the `claude` CLI itself (`claude plugin marketplace add`, `claude plugin install`); the window shows the exact command first.
- **Context Toolkit** (`setup`, only on "Apply" or "Roll back"): Claude Code `settings.json`, `CLAUDE.md`, `~/.claude/hooks/context-toolkit.exe`, `~/.local/bin/context-toolkit.exe`, the `Explore` and `checker` agents, `context-toolkit.json`; with the matching checkbox also the Claude Desktop presets, Antigravity `hooks.json` and the DeepSeek Harness files.
- **Its own data** in `%APPDATA%\loadout-app`: `settings.json` (language and write level), `backups\` (operation backups with manifests, from which the journal is built, the trash, `profiles.json`) and Electron's own browser data (the effects setting is kept in its local storage).

## Copies contain secrets

Operation backups and the trash keep client files **in full and as plain text, including MCP `env` values (keys and tokens)**; an exact rollback needs them. Context Toolkit backups (`~/.claude/backups`, or a `backups` folder next to the file for other clients) are full files too. Loadout does not encrypt them and sets no permissions of its own: access is that of your Windows profile. The last 100 operations not older than 90 days are kept; the trash is not cleaned automatically. How to delete the data: [README.md](README.md#install).

## Network

Loadout has no telemetry, no update check and no network code of its own. Network access happens only on explicit actions:

- installing a plugin or adding a marketplace runs `claude`, which downloads from the source you entered;
- installing a skill from GitHub runs `git ls-remote` and `git clone` against the repository you entered (a local folder needs no network).

## Processes Loadout starts

`loadout.exe` (the core, from the app folder), the bundled `context-toolkit.exe`, `tasklist` (to warn when a client whose file is about to change is running), and, on the actions above, `claude` and `git` from `PATH`. They are started without a shell, with fixed flags; the arguments built from your input are checked first (a source can never become a flag or a second command). Commands of MCP servers from the configs are never run.

## Known limits

- The installer and the app are not code-signed.
- A secret written in a skill description as ordinary words (not shaped like a token) is not masked.
- Windows only; the app was tested on Windows 11.
