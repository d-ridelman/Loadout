# Architecture of `ctxkit`

<p><strong>English</strong> | <a href="ARCHITECTURE.ru.md">Русский</a></p>

`ctxkit` compiles to a single native Rust binary with zero runtime dependencies (average `PreToolUse` latency is `9-14 ms`). It works uniformly across TypeScript/JS, Python, Go, Rust, C++, and other stacks.

## Four Operating Modes

```text
CLI args / stdin JSON
   │
   ├─ argv[1] == "setup"       ──▶ setup::run_setup()   (profile automation and config audit)
   │
   ├─ argv[1] == "check"       ──▶ check::run_check()   (compact compiler and test runner)
   │
   ├─ stdin has toolCall       ──▶ Antigravity hook     (read_file / write_file / run_command)
   │
   ├─ --dsh or DSH tool_name   ──▶ DeepSeek Harness     (read / write / edit / bash / pwsh)
   │
   └─ otherwise                ──▶ Claude Code hook     (PreToolUse / PostToolUse)
```

### 1. `guard.rs`: bounded reads and search discipline

- `Read` (Claude Code), `read` (DeepSeek Harness), and `read_file` (Antigravity) use `MAX_READ_BYTES = 28_000`, `MAX_READ_LINES = 450`, and `MAX_HUGE_BYTES = 250_000`. Bounded slices (`limit <= 450` or `EndLine - StartLine + 1 <= 450`), as well as binary images, video, audio, and PDF files, pass without delay. Inverted ranges (`EndLine < StartLine`) are denied with explanation. Whole-file reads of large text files are denied with a client-specific hint to locate targets via `Grep`/LSP or delegate to a subagent (`Explore` / `subagent`). A read from an offset with no limit (or a limit above the cap) passes only when the remaining tail fits both the line and the byte cap; an offset of `1` counts as a whole-file read, and files above `MAX_HUGE_BYTES` need both an offset and a limit. All paths are resolved against provided `cwd` or `workdir`.
- `shell_read_guard` blocks bare `cat` (`> 12 KB` or `> 200` lines), PowerShell `Get-Content` / `gc` / `type` / `cat` (also with `-Raw`, `-Path`, `-Encoding`), and unfiltered recursive `grep -r` / `rg` in both shells. The command is split into words first, so a flag is only a flag when it is its own unquoted word. For chained commands (`&&`, `;`, `\n`), each sub-command is validated individually while tracking directory changes via `cd`. Sub-commands containing pipes (`|`), redirections (`>`), heredocs, narrowing flags (`-l`, `-c`, `-m N`, `--max-count`), `rg --version` / `--files` / `--help`, or exactly one path that is a file are never interrupted.

### 2. `backslash.rs`: escape integrity and post-edit syntax

- On `PreToolUse` (`Bash`, `PowerShell`, `Write`, `Edit`, `MultiEdit`, `apply_patch`, Antigravity `run_command`/`write_file`/`edit_file`), catches inline invocations, `sed -i`, bash heredocs, PowerShell here-strings, and throwaway patch scripts carrying `\` where shell or CLI argument parsing corrupts escape sequences. Each interpreter has its own "code follows" flags (`node -e/-p/--eval`, `python -c`, `perl -e`, `ruby -e`, `php -r`, `bash -c`, `pwsh -Command`), so `node -c file` or `bash -e script` with a Windows path is not mistaken for inline code. `printf`/`echo`/`awk` are blocked only when they write to a file: a `>` inside quotes is text, `2>` is stderr.
- On `PostToolUse` (Claude Code `Edit|Write|MultiEdit`, DeepSeek Harness `write|edit|apply_patch`), validates `.json` via `serde_json` (exempting JSONC files such as `tsconfig*`, `jsconfig*`, `.eslintrc*`, `devcontainer.json`, `.code-workspace`, `.vscode/`, and `.devcontainer/`), `.js/.mjs/.cjs` via `node --check`, and `.py` via `python -I` running `ast.parse` (with `cwd` support). For `apply_patch`, all modified and added files in the patch are checked.

### 3. `check.rs`: compact build and test output (`ctxkit check <cmd>`)

- For `cargo check`, `cargo clippy`, and `cargo build`, automatically injects `--message-format=json --quiet`, deduplicates diagnostics, and prints up to `3` unique root causes (`file:line:col [code] - message (label)`), dropping cascade noise.
- For all other commands (`tsc`, `npm run typecheck`, `npm test`, `node --test`, `pytest`, `go test`), passing runs print `OK (<ms>)` plus a brief pass summary, while failing runs print up to `30` key lines and write full logs to `%TEMP%/last-check-<pid>.log` and `%TEMP%/last-check.log` (`/tmp/...` on Unix), avoiding race conditions between concurrent sessions.

### 4. `setup.rs`: idempotent setup and config audit (`ctxkit setup`)

- Writes a timestamped backup under `backups/<name>.<unix_ts>.bak` before modifying any file (`settings.json`, `CLAUDE.md`, `ccd-session-presets.json`, `hooks.json`, `cordis.patch.yml`), without polluting config directories, and skips backups when contents already match.
- Merges into existing JSON instead of overwriting: preserves user `env`, `permissions`, `enabledPlugins`, and third-party hooks, while upgrading legacy `no-inline-backslash` hooks, old `claude-guard` entries, and marker blocks (`<!-- claude-guard:start/end -->` or `<!-- ctxkit:start/end -->`).
- Supports `--dry-run` to preview every change before touching disk.
- Runs config diagnostics: checks `claude --version < 2.1.321` when `advisor` is `fable`, more than `8` enabled global plugins, `CLAUDE.md` exceeding `200` lines or `8 KB`, and more than `2` global MCP servers in `~/.claude.json`. With `--antigravity`, also audits `agy` CLI model, enabled global plugins in `~/.gemini/config/plugins/` (`> 6`), active MCP servers across `mcp_config.json` and plugins (`> 4`), and plugin rule sizes (`24 KB` cap). With `--dsh`, audits `AGENTS.md`, global MCP servers in `cordis.patch.yml`, and installed skills in `~/.dsh/skills/`. Supports adding rules with `--with-rules` into `~/.dsh/AGENTS.md`.

## Hook Protocol Contracts

| Aspect | Claude Code | Antigravity |
|---|---|---|
| Config file | `~/.claude/settings.json` | `~/.gemini/config/hooks.json` (or `.agents/hooks.json`) |
| Tools | `Read`, `Write`, `Edit`, `MultiEdit`, `Bash`, `PowerShell` | `read_file`, `write_file`, `edit_file`, `run_command` |
| `PreToolUse` deny | `hookSpecificOutput.permissionDecision = "deny"` | `{"decision": "deny", "reason": "..."}` |
| `PreToolUse` allow | Empty `stdout` | `{"decision": "ask"}` |
| `PostToolUse` | Syntax validation and `{"decision": "block"}` | Returns `{}` only (post-write blocking not supported) |

In Antigravity's hook contract, `"decision": "allow"` auto-approves tool execution and bypasses user confirmation policies. On clean checks, `ctxkit` always emits `{"decision": "ask"}` so Antigravity enforces its own built-in security policy.

### DeepSeek Harness Desktop

DeepSeek Harness has no hook config of its own: the `@deepseek-ai/dsh-hooks-claude-code` plugin replays a Claude Code `hooks.json` on its `tools/pre-execute` and `tools/post-execute` seams. The stdin payload and the accepted responses follow the Claude Code column above, so `ctxkit` reuses that handler; only the tool names differ (`read`, `write`, `edit`, `apply_patch`, `bash`, `pwsh`) and deny hints name those tools instead of `Grep`/`Explore`. The client is selected by `--dsh` or detected from a lowercase `tool_name` or `apply_patch`.

`ctxkit setup --dsh` writes `~/.dsh/ctxkit-hooks.json` (`PreToolUse`: `read|write|edit|apply_patch|bash|pwsh`, `PostToolUse`: `write|edit|apply_patch`) and appends a marker-delimited `insert` entry (`id: ctxkit-hooks`) to `~/.dsh/profiles/desktop/cordis.patch.yml`, leaving other entries untouched. The hook command is written for the shell the harness uses (`pwsh -Command` on Windows, `bash -c` elsewhere). The bridge package is not bundled with the desktop app and the config is read once at startup, so setup warns when the package is missing from the profile's `node_modules` and the app must be restarted after either change.

## Localization (`CTXKIT_LANG`)

Hook responses (`guard.rs`, `backslash.rs`, and `PostToolUse` in `main.rs`) default to English (`en`) and switch to Russian (`ru`) via `CTXKIT_LANG=ru` or `--lang ru`. Running `ctxkit setup --lang ru` writes `CTXKIT_LANG=ru` into Claude Code's `settings.json` `env` block and appends `--lang ru` to the hook command for Antigravity and DeepSeek Harness.

## `toMcp` Projection for Custom MCP Servers

When writing your own MCP tools, split UI/REST responses from agent responses with a `toMcp` mapper. Web dashboards continue receiving full payloads (history arrays, UI metadata, action buttons), while the MCP handler serializes compact JSON without whitespace, strips UI-only fields, and summarizes long arrays into `count` plus the first few failing items with `id` handles for drill-down.
