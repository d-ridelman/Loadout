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

- The config files of the six clients in your Windows profile, mainly: `~/.claude.json`, `~/.claude/settings.json`, `~/.claude/plugins/installed_plugins.json` and `known_marketplaces.json`, `~/.claude/skills`, agents and commands; `%APPDATA%\Claude\claude_desktop_config.json`; `~/.codex/config.toml`, `~/.codex/hooks.json`, `~/.codex/skills`; `~/.gemini/config/` (`mcp_config.json`, `hooks.json`, `plugins/`, `skills/`); `~/.dsh/cordis.patch.yml`, `~/.dsh/profiles/*/cordis.patch.yml`, `~/.dsh/skills`; `~/.config/opencode/` (`opencode.json`, `opencode.jsonc`, `agent(s)/`, `command(s)/`, `plugin(s)/`, `skill(s)/`); outside your profile, the OpenCode system config `%ProgramData%\opencode\opencode.json(c)`, read only. Also the plugin caches and built-in skill folders of these clients, the catalogs (`marketplace.json`) of added Claude Code marketplaces, and the names of backup files in the client folders (the Doctor counts them).
- The core keeps the values of `env` and MCP headers to itself: the window, plans, the journal and error messages get only key names, and the other strings are masked (see [docs/CONCEPT.en.md](docs/CONCEPT.en.md) §5). Credential files of the clients (`~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.dsh/.credentials.yaml` and the like) are not read.
- The Context Toolkit section runs the bundled `context-toolkit.exe`, which reads the same Claude Code files and, for the "Efficiency" report, Claude Code transcripts (`~/.claude/projects/**/*.jsonl`). The report contains only counters, no text or paths.

## What Loadout writes

At the default level R0 no client file is written. Client files change only after you raise the level (R1 or R2, confirmed in a separate window that the main process draws and listens to; the page cannot reach it or press it for you) and confirm a preview. Loadout's own data (settings, profiles, cleanup of its own old copies after a confirmation in the same separate window) is written at any level.

- **Client config files**, only the value an operation changes (toggle, trash, edit, copy, add an MCP server, apply a profile).
- **`~/.claude/skills/<name>`** when you install a skill.
- **Claude Code plugins** are installed by the `claude` CLI itself (`claude plugin marketplace add`, `claude plugin install`); the window shows the exact command first.
- **Context Toolkit** (`setup`, only on "Apply" or "Roll back"): Claude Code `settings.json`, `CLAUDE.md`, `~/.claude/hooks/context-toolkit.exe`, `~/.local/bin/context-toolkit.exe`, the `Explore` and `checker` agents, `context-toolkit.json`; with the matching checkbox also the Claude Desktop presets, Antigravity `hooks.json` and the DeepSeek Harness files.
- **Its own data** in `%APPDATA%\loadout-app`: `settings.json` (language, write level and the automatic update check), `.updaterId` (a random id electron-updater creates for staged rollouts; Loadout sends a fixed all-zero value in its place, so it never leaves the machine), `backups\` (operation backups with manifests, from which the journal is built, the trash, `profiles.json`, and `staging\`, where a downloaded skill waits for your confirmation), `models\` (the model of "Similar skills", only if you downloaded it) and Electron's own browser data (the effects setting is kept in its local storage). A downloaded update waits in `%LOCALAPPDATA%\loadout-app-updater`.

## Copies contain secrets

Operation backups and the trash keep client files **in full and as plain text, including MCP `env` values (keys and tokens)**; an exact rollback needs them. Context Toolkit backups (`~/.claude/backups` for Claude Code, next to the changed file for other clients) are full files too. Loadout does not encrypt them and sets no permissions of its own: access is that of your Windows profile. The last 100 operations not older than 90 days are kept; the trash is not cleaned automatically. How to delete the data: [README.md](README.md#install).

## Network

Loadout has no telemetry. On its own it goes online for one thing only, the update check; everything else needs an explicit action:

- **the update check** (on by default; the version button at the right end of the footer opens the panel with the "Check for updates automatically" checkbox and "Check now"). About 10 seconds after start and then once a day while the window is open (after a failed check, once an hour until one succeeds), electron-updater in the main process asks GitHub for the latest release of this repository: `github.com/d-ridelman/Loadout/releases.atom`, `…/releases/latest` and that release's `latest.yml`. Downloads go from `github.com` to GitHub's file server (`release-assets.githubusercontent.com` at the time of writing). `api.github.com` is not used. The requests carry nothing about you, your clients or your settings: the User-Agent is the generic `electron-builder`, the `x-user-staging-id` header is a fixed all-zero value. GitHub sees what any request shows: the IP address, the time and the system language (`Accept-Language`). With the checkbox off there are no automatic requests; "Check now" still works on click;
- downloading an update starts only on "Download" (`.blockmap` lets it fetch only the changed blocks), installing only on "Restart and update" or when you quit Loadout after the download;
- installing a plugin or adding a marketplace runs `claude`, which downloads from the source you entered;
- installing a skill from GitHub runs `git ls-remote` and `git clone` against the repository you entered (a local folder needs no network);
- "Similar skills" in the inspector downloads its model only on "Download the model": two files of `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` at a fixed revision from `huggingface.co` (it redirects to its file server, `us.aws.cdn.hf.co` at the time of writing), about 128 MB in all, into `%APPDATA%\loadout-app\models\`. Each file is used only if its size and sha256 match the values built into Loadout. The model runs on this computer in the bundled `loadout-ml.exe`, started only while the feature looks for similar skills; skill descriptions are never sent anywhere. `loadout-ml.exe` links ONNX Runtime 1.31.0 statically: the build of pyke.io that the `ort` crate downloads from `cdn.pyke.io` when Loadout is compiled, accepted only if its sha256 matches the one pinned in `ort-sys` (licenses: `licenses/` in the repository and in the installed app's `resources`).

## Updates and the unsigned installer

The installer and the app are not code-signed, so updates cannot rely on a signature. This is what checks them instead:

- electron-updater checks the Authenticode signature of a downloaded update only when the build's `resources/app-update.yml` has a `publisherName`. Loadout's build has none (the packaged-build check verifies that), so the check is skipped rather than rejecting every update of an unsigned build.
- `latest.yml` comes over HTTPS from the GitHub release of this repository and carries the SHA-512 and size of the installer. The downloaded file, whether whole or assembled from the changed blocks, must match that SHA-512, otherwise it is deleted and nothing is installed. Only the full installer named there is accepted (the web installer is turned off).
- The installer runs silently (`/S --updated`) into the folder of the current installation; after "Restart and update" it starts the new version, after an install on quit it does not. `%APPDATA%\loadout-app` stays.

What this does not protect against: whoever can publish a release in this repository (for example with a stolen GitHub account of the owner) can ship any code, exactly as with an installer downloaded by hand from Releases. A code signature would add a second, independent key; there is none yet.

Versions 0.0.7 and older have no updater: install 1.0.0 by hand once.

## Processes Loadout starts

The window starts `loadout.exe` (the core, from the app folder), the bundled `context-toolkit.exe`, `tasklist` (to warn when a client whose file is about to change is running), and, on the actions above, `claude` and `git` from `PATH`. It starts them without a shell, with fixed flags; the arguments built from your input are checked first (a source can never become a flag or a second command). Commands of MCP servers from the configs are never run. To install an update, electron-updater starts the downloaded and verified installer from `%LOCALAPPDATA%\loadout-app-updater`: on "Restart and update" with `/S --updated --force-run`, and Loadout quits right after; on quit after a download with `/S --updated`, without starting the new version. If the installer cannot be started directly, electron-updater tries `elevate.exe` from the app folder, or opens the installer with its usual window.

`context-toolkit.exe` starts a few processes of its own: `claude --version` through `cmd.exe` on a preview (to check the Claude Code version), `powershell.exe Get-Process` when the Claude Desktop checkbox is on (Desktop must be closed), and `--version` of an old `ctxkit.exe` when it moves an earlier installation (to make sure the file is ours before deleting it).

## Known limits

- The installer and the app are not code-signed; updates are checked by the SHA-512 in `latest.yml` (see above).
- A secret written in a skill description as ordinary words (not shaped like a token) is not masked.
- Windows only; the app was tested on Windows 11.
