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
   └─ otherwise                ──▶ Claude Code hook     (PreToolUse / PostToolUse)
```

### 1. `guard.rs`: bounded reads and search discipline

- `Read` (Claude Code) and `read_file` (Antigravity) use `MAX_READ_BYTES = 28_000`, `MAX_READ_LINES = 450`, and `MAX_HUGE_BYTES = 250_000`. Bounded slices (`limit <= 450` or `EndLine - StartLine + 1 <= 450`), as well as binary images, video, audio, and PDF files, pass without delay. Whole-file reads of large text files are denied with a client-specific hint to locate targets via `Grep`/LSP or delegate to `Explore`.
- `shell_read_guard` blocks bare `cat` (`> 12 KB` or `> 200` lines), PowerShell `Get-Content` / `gc` / `type`, and unfiltered recursive `grep -r` / `rg`. Commands containing pipes (`|`), redirections (`>`), `&&`, `;`, heredocs, or narrowing flags (`-l`, `-c`, `-m`) are never interrupted.

### 2. `backslash.rs`: escape integrity and post-edit syntax

- On `PreToolUse` (`Bash`, `PowerShell`, `Write`, Antigravity `run_command`/`write_file`), catches inline invocations (`node -e`, `python -c`, `sed -i`), bash heredocs, PowerShell here-strings, and throwaway patch scripts carrying `\` where shell or CLI argument parsing corrupts escape sequences.
- On `PostToolUse` (Claude Code `Edit|Write`), validates `.json` via `serde_json` (exempting JSONC files such as `tsconfig*`, `jsconfig*`, `.eslintrc*`, `.code-workspace`, and `.vscode/`), `.js/.mjs/.cjs` via `node --check`, and `.py` via `python -I` running `ast.parse`.

### 3. `check.rs`: compact build and test output (`ctxkit check <cmd>`)

- For `cargo check`, `cargo clippy`, and `cargo build`, automatically injects `--message-format=json --quiet`, deduplicates diagnostics, and prints up to `3` unique root causes (`file:line:col [code] - message (label)`), dropping cascade noise.
- For all other commands (`tsc`, `npm run typecheck`, `npm test`, `node --test`, `pytest`, `go test`), passing runs print `OK (<ms>)` plus a brief pass summary, while failing runs print up to `30` key lines and write full logs to `%TEMP%/last-check.log` (`/tmp/last-check.log` on Unix).

### 4. `setup.rs`: idempotent setup and config audit (`ctxkit setup`)

- Writes a timestamped backup under `backups/<name>.<unix_ts>.bak` before modifying any file (`settings.json`, `CLAUDE.md`, `ccd-session-presets.json`, `hooks.json`), and skips backups when contents already match.
- Merges into existing JSON instead of overwriting: preserves user `env`, `permissions`, `enabledPlugins`, and third-party hooks, while upgrading legacy `no-inline-backslash` hooks, old `claude-guard` entries, and marker blocks (`<!-- claude-guard:start/end -->` or `<!-- ctxkit:start/end -->`).
- Supports `--dry-run` to preview every change before touching disk.
- Runs config diagnostics: warns on `claude --version < 2.1.321` when `advisor` is `fable`, more than `8` enabled global plugins, `CLAUDE.md` exceeding `200` lines or `8 KB`, and more than `2` global MCP servers in `~/.claude.json`.

## Hook Protocol Contracts

| Aspect | Claude Code | Antigravity |
|---|---|---|
| Config file | `~/.claude/settings.json` | `~/.gemini/config/hooks.json` (or `.agents/hooks.json`) |
| Tools | `Read`, `Write`, `Edit`, `Bash`, `PowerShell` | `read_file`, `write_file`, `run_command` |
| `PreToolUse` deny | `hookSpecificOutput.permissionDecision = "deny"` | `{"decision": "deny", "reason": "..."}` |
| `PreToolUse` allow | Empty `stdout` | `{"decision": "ask"}` |
| `PostToolUse` | Syntax validation and `{"decision": "block"}` | Returns `{}` only (post-write blocking not supported) |

In Antigravity's hook contract, `"decision": "allow"` auto-approves tool execution and bypasses user confirmation policies. On clean checks, `ctxkit` always emits `{"decision": "ask"}` so Antigravity enforces its own built-in security policy.

## Localization (`CTXKIT_LANG`)

Hook responses (`guard.rs`, `backslash.rs`, and `PostToolUse` in `main.rs`) default to English (`en`) and switch to Russian (`ru`) via `CTXKIT_LANG=ru` or `--lang ru`. Running `ctxkit setup --lang ru` writes `CTXKIT_LANG=ru` into Claude Code's `settings.json` `env` block.

## `toMcp` Projection for Custom MCP Servers

When writing your own MCP tools, split UI/REST responses from agent responses with a `toMcp` mapper. Web dashboards continue receiving full payloads (history arrays, UI metadata, action buttons), while the MCP handler serializes compact JSON without whitespace, strips UI-only fields, and summarizes long arrays into `count` plus the first few failing items with `id` handles for drill-down.
