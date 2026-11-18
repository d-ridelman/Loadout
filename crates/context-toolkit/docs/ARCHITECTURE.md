# Architecture of Context Toolkit

<p><strong>English</strong> | <a href="ARCHITECTURE.ru.md">Русский</a></p>

Context Toolkit (formerly ctxkit) compiles to a single native Rust binary, `context-toolkit`, with zero runtime dependencies (average `PreToolUse` latency is `9-14 ms`). It works uniformly across TypeScript/JS, Python, Go, Rust, C++, and other stacks.

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
- On `PostToolUse` (Claude Code `Edit|Write|MultiEdit`, DeepSeek Harness `write|edit|apply_patch`), validates `.json` via `serde_json` (exempting JSONC files such as `tsconfig*`, `jsconfig*`, `.eslintrc*`, `devcontainer.json`, `.code-workspace`, `.vscode/`, and `.devcontainer/`; other files that fail strict parsing are retried as JSONC, with comments and trailing commas blanked out, and blocked only if that fails too), `.js/.mjs/.cjs` via `node --check`, and `.py` via `python -I` running `ast.parse` (with `cwd` support). For `apply_patch`, all modified and added files in the patch are checked.

### 3. `check.rs`: compact build and test output (`context-toolkit check <cmd>`)

- For `cargo check`, `cargo clippy`, and `cargo build`, automatically injects `--message-format=json --quiet`, deduplicates diagnostics, and prints up to `3` unique root causes (`file:line:col [code] - message (label)`), dropping cascade noise.
- For all other commands (`tsc`, `npm run typecheck`, `npm test`, `node --test`, `pytest`, `go test`), passing runs print `OK (<ms>)` plus a brief pass summary, while failing runs print up to `30` key lines and write the full log to `%TEMP%/last-check-<pid>.log` (`/tmp/...` on Unix; one file per run, so concurrent sessions do not overwrite each other, and logs older than a day are deleted on the next write).

### 4. `setup.rs`: idempotent setup and config audit (`context-toolkit setup`)

- Writes a timestamped backup under `backups/<name>.<unix_ts>.bak` before modifying any file (`settings.json`, `CLAUDE.md`, `ccd-session-presets.json`, `hooks.json`, `cordis.patch.yml`), without polluting config directories, and skips backups when contents already match.
- Merges into existing JSON instead of overwriting: preserves user `env`, `permissions`, `enabledPlugins`, and third-party hooks, while upgrading legacy `no-inline-backslash` hooks, old `claude-guard` and `ctxkit` entries, and marker blocks (`<!-- claude-guard:start/end -->`, `<!-- ctxkit:start/end -->` or `<!-- context-toolkit:start/end -->`).
- Moves an installation from the former name (ctxkit). Hooks that run `ctxkit.exe` (and `claude-guard` / `no-inline-backslash`) count as ours and get the command `.../hooks/context-toolkit.exe`; other people's hooks are not touched. `env.CTXKIT_LANG` becomes `CONTEXT_TOOLKIT_LANG`. The old rules-block markers are always recognised, and `--with-rules` moves the block to `<!-- context-toolkit:start -->` / `<!-- context-toolkit:end -->`. When only `ctxkit.json` exists, it is copied to `context-toolkit.json`; the old file that setup created is deleted at the end of the run unless the old hook binary stays for a client (it reads only that file), one the owner wrote stays but is no longer read. With `--antigravity` the `ctxkit` key in `hooks.json` becomes `context-toolkit`; with `--dsh` the old block in `cordis.patch.yml` is replaced by the new one. The old `hooks/ctxkit.exe` is deleted only after `settings.json` has been written. Details: README, "Moving from ctxkit".
- Supports `--dry-run` to preview every change before touching disk.
- Runs config diagnostics: checks `claude --version < 2.1.321` when `advisor` is `fable`, more than `8` enabled global plugins, `CLAUDE.md` exceeding `200` lines or `8 KB`, and more than `2` global MCP servers in `~/.claude.json`. With `--antigravity`, also audits `agy` CLI model, enabled global plugins in `~/.gemini/config/plugins/` (`> 6`), active MCP servers across `mcp_config.json` and plugins (`> 4`), and plugin rule sizes (`24 KB` cap). With `--dsh`, audits `AGENTS.md`, global MCP servers in `cordis.patch.yml`, and installed skills in `~/.dsh/skills/`. Supports adding rules with `--with-rules` into `~/.dsh/AGENTS.md`.

## Hook Protocol Contracts

| Aspect | Claude Code | Antigravity |
|---|---|---|
| Config file | `~/.claude/settings.json` | `~/.gemini/config/hooks.json` (or `.agents/hooks.json`) |
| Tools | `Read`, `Write`, `Edit`, `MultiEdit`, `Bash`, `PowerShell` | the matcher lists `run_command` and the older names `read_file`, `write_file`, `edit_file`; current builds call the file tools `view_file`, `write_to_file`, `replace_file_content` (see below) |
| `PreToolUse` deny | `hookSpecificOutput.permissionDecision = "deny"` | `{"decision": "deny", "reason": "..."}` |
| `PreToolUse` allow | Empty `stdout` | `{"decision": "ask"}` |
| `PreToolUse` ask (policies `confirm_irreversible`, `stray_files`, see the README) | `hookSpecificOutput.permissionDecision = "ask"` + `permissionDecisionReason` | `{"decision": "ask", "reason": "..."}` |
| `PostToolUse` | Syntax validation and `{"decision": "block"}` | Returns `{}` only (post-write blocking not supported) |

In Antigravity's hook contract, `"decision": "allow"` auto-approves tool execution and bypasses user confirmation policies. On clean checks, `context-toolkit` always emits `{"decision": "ask"}` so Antigravity enforces its own built-in security policy.

Antigravity's own hook documentation (`agy-customizations/docs/hooks.md`, shipped in `~/.gemini/antigravity-cli/builtin/skills/`, read 2026-11-16) says hooks "must output their result as a JSON object on stdout" and marks `decision` of `PreToolUse` as required (`allow`, `deny`, `ask`, `force_ask`). So an empty answer is not a documented "no opinion". In `--agy` mode (the flag `context-toolkit setup --antigravity` puts into the hook command) the "no decision" cases therefore print the same `{"decision": "ask"}` as a clean check: unreadable or oversized input, a panic, and `CONTEXT_TOOLKIT_GUARD=0` (for a `PostToolUse` call it is `{}`). Without `--agy` an unreadable payload cannot be told from Claude Code's, which must stay silent, so it prints nothing; an Antigravity payload that parses (it has `toolCall`) is recognised either way. Not verified live: what Antigravity itself does with an empty answer (the documentation does not say); the explicit answer avoids depending on it.

**Two versions of the Antigravity documentation (checked 2026-11-17).** The web page `antigravity.google/docs/hooks.md` names the file tools `view_file` (`AbsolutePath`, `StartLine`, `EndLine`), `write_to_file` (`TargetFile`, `CodeContent`), `replace_file_content` and `multi_replace_file_content`, says the payload has no `cwd` (a command has its own `Cwd`, the session has `workspacePaths`), and defines `allow` as "proceed, delegating to the next hook or default policy" with a separate `auto_approve`. The copy shipped with the installed CLI (dated 2026-11-13) still says `allow` "automatically allows the tool execution". Since "pass" means different things in the two, the matcher is not extended to `view_file` or the edit tools: with `ask` as the pass, every file read would wait for the user. So in Antigravity only `run_command` is checked (and the old tool names, if an older build sends them). The hook takes the working directory from `cwd`, else the command's `Cwd`, else the first `workspacePaths` entry. Deny hints name the current tool names. Reads and edits stay "in progress" until a live run settles what `allow` does.

### Codex

Codex (`learn.chatgpt.com/docs/hooks`, stable since 0.124.0) reads Claude-shaped hooks from `<CODEX_HOME>/hooks.json` (default `~/.codex`). The payload and the `PreToolUse` deny answer (`hookSpecificOutput.permissionDecision = "deny"`) follow the Claude Code column, so `--codex` reuses that handler with three differences:

- The shell tool is `Bash` on every system, and Codex runs it through PowerShell on Windows, so it is checked in both dialects, like Antigravity's `run_command`.
- Edits are `apply_patch` with the patch text in `tool_input.command`. The hook reads that text as file content (backslash check before, syntax check of the touched files after), never as a shell command. Codex has no read tool, so deny hints name shell slices (`rg -n`, `sed -n`, `Get-Content | Select-Object`).
- Codex parses `permissionDecision: "ask"` but does not support it: the hook run counts as failed and the call proceeds. The asking policies (`confirm_irreversible`, `stray_files`) therefore stay silent under `--codex`; deny policies (`commit_hygiene`) work.

Codex runs hook commands through `cmd /C "<command>"` on Windows (`codex-rs/hooks/src/engine/command_runner.rs`), so the quoted path form of Claude Code works. `setup --codex` writes `PreToolUse` (`Bash|apply_patch`) and `PostToolUse` (`apply_patch`) groups, no `Stop` (the gate reads Claude Code transcripts), and no `onFailure` (a Claude Code field). A non-managed hook runs only after the user trusts it in `/hooks` (the trust is a hash in `config.toml`): setup prints that step and writes no trust record. `[features] hooks = false` in `config.toml` gets a warning. Not verified in a live Codex: only against the documentation, the Codex source and fixture runs.

### OpenCode

OpenCode 2 (checked against the sources at tag `v2.3.0`, 2026-11-18) has no command hooks, so `setup --opencode` writes a V2 plugin, `<config>/plugins/loadout-context-toolkit/index.js` (text in `src/setup/opencode-plugin.js`; `<config>` is `--opencode-home`, else `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME/opencode`, `~/.config/opencode`). OpenCode loads plugin folders there by itself, at start. On `tool.hook("execute.before")` the plugin sends `{hook_event_name: "PreToolUse", tool_name, tool_input, cwd}` with OpenCode's names and fields as they are to `context-toolkit --opencode` (no shell, stdin, 15 s timeout):

- `read`, `write`, `edit`, `patch` (`apply_patch`) and `shell` become `Read`, `Write`, `Edit`, `apply_patch` and `run_command`; `path`/`filePath`, `newString` and `patchText` become `file_path`, `new_string` and `patch`. The shell is checked in both dialects: OpenCode on Windows picks the shell itself. Deny hints name `read`, `grep`, `edit` and `write`.
- A `deny` is thrown as an `Error` with the reason: the promise-plugin adapter turns it into a `Tool.Error`, the call does not run and the model sees the reason.
- An `ask` goes through `ctx.permission.assert` with the action `context-toolkit`. OpenCode's base policy allows every action (`*` → `allow`), so the plugin's `permission.hook("evaluate")` raises its own action to `ask` with the reason as `message`. No prompt shown (no API, or the evaluation passed without the hook) means a refusal that says a person has to confirm. A plain "no" (`Permission.DeclinedError`) is rethrown as it is, so OpenCode ends the step as with its own prompts; a "no" with feedback or an agent's deny rule reaches the model with our reason.
- A hook that fails, hangs or prints nothing passes the call, as everywhere.

No Stop gate (it reads Claude Code transcripts; OpenCode's `session.hook("experimental.idle")` is unused) and no syntax check after an edit yet (`execute.after` cannot refuse, but could rewrite `result`). OpenCode takes the first existing file of `<config>/AGENTS.md` and, from 2.3.1, `~/.claude/CLAUDE.md` (`packages/core/src/config/plugin/instruction.ts`), so setup writes the rules block only into an `AGENTS.md` that is already there: creating one would cut off the owner's `CLAUDE.md`. `doctor` reports the plugin as current, edited or foreign. Not verified in a live OpenCode: against the sources, and the plugin run under Node and under Bun 1.4.4 (OpenCode's runtime) with a stand-in context.

### DeepSeek Harness Desktop

DeepSeek Harness has no hook config of its own: the `@deepseek-ai/dsh-hooks-claude-code` plugin replays a Claude Code `hooks.json` on its `tools/pre-execute` and `tools/post-execute` seams. The stdin payload and the accepted responses follow the Claude Code column above, so `context-toolkit` reuses that handler; only the tool names differ (`read`, `write`, `edit`, `apply_patch`, `bash`, `pwsh`) and deny hints name those tools instead of `Grep`/`Explore`. The client is selected by `--dsh` or detected from a lowercase `tool_name` or `apply_patch`.

`context-toolkit setup --dsh` writes `~/.dsh/context-toolkit-hooks.json` (`PreToolUse`: `read|write|edit|apply_patch|bash|pwsh`, `PostToolUse`: `write|edit|apply_patch`) and appends a marker-delimited `insert` entry (`id: context-toolkit-hooks`) to `~/.dsh/profiles/desktop/cordis.patch.yml`, leaving other entries untouched. The hook command is written for the shell the harness uses (`pwsh -Command` on Windows, `bash -c` elsewhere). The bridge package is not bundled with the desktop app and the config is read once at startup, so setup warns when the package is missing from the profile's `node_modules` and the app must be restarted after either change.

## Localization (`CONTEXT_TOOLKIT_LANG`)

Hook responses (`guard.rs`, `backslash.rs`, and `PostToolUse` in `main.rs`) default to English (`en`) and switch to Russian (`ru`) via `CONTEXT_TOOLKIT_LANG=ru` or `--lang ru`. Running `context-toolkit setup --lang ru` writes `CONTEXT_TOOLKIT_LANG=ru` into Claude Code's `settings.json` `env` block and appends `--lang ru` to the hook command for Antigravity and DeepSeek Harness. The old variable name `CTXKIT_LANG` is still supported (as are `CTXKIT_GUARD` and `CTXKIT_GATE`); when both are set, the new one wins.

## `toMcp` Projection for Custom MCP Servers

When writing your own MCP tools, split UI/REST responses from agent responses with a `toMcp` mapper. Web dashboards continue receiving full payloads (history arrays, UI metadata, action buttons), while the MCP handler serializes compact JSON without whitespace, strips UI-only fields, and summarizes long arrays into `count` plus the first few failing items with `id` handles for drill-down.
