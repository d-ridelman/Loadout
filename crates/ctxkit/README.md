<p align="center">
  <img src="assets/cover.jpg" alt="ctxkit: Surgical Context & Token Toolkit" width="100%" />
</p>

<p align="center">
  <strong>English</strong> | <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#whats-inside">Modules</a> ·
  <a href="#setup-flags">Setup Flags</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/RESEARCH.md">Research (30 Sessions)</a>
</p>

`ctxkit` is a single native Rust binary for **Claude Code**, **Claude Desktop**, **Antigravity**, and **DeepSeek Harness Desktop**. It stops agents from dumping whole files and raw compiler logs into context, blocks shell commands that mangle backslashes, and configures a low-waste model setup with one command.

Rust is only the runtime choice for fast startup (`9-14 ms` per hook call without spawning Node or Python). The toolkit targets **any project stack** (TypeScript/JS, Python, Go, Rust, config repositories): in an audit of 30 sessions, `60.5%` of incoming bloat came from reading large source files whole and running unfiltered grep in the shell.

## Where Limits Go

Findings from 30 recorded sessions (`26,256` turns; full breakdown in [the research note](docs/RESEARCH.md)):

| Baseline leak | How `ctxkit` addresses it |
|---|---|
| `95.3%` of turns ran on `Opus` or `Fable` (including Desktop presets and search) | `ctxkit setup --main-model sonnet --advisor fable` moves routine work to `Sonnet` and keeps `Fable` for escalations; setup also adds search on `Haiku` (`Explore`) and `Opus` for `checker` |
| `60.5%` of `tool_result` chars came from full-file reads and unfiltered `rg`/`cat` | `PreToolUse` hook permits bounded slices (`<= 450` lines) and steers full reads to `Grep`, LSP, or `Explore` |
| `11.2%` came from verbose compiler and test runner logs | `ctxkit check <cmd>` collapses passing runs to `OK (<ms>)` and extracts root causes on failure |
| Mangled `\` escapes in inline one-liners triggered extra rewrite loops | Blocks backslash-bearing `node -e`, `python -c`, heredocs, and here-strings before execution; validates edited files on `PostToolUse` |

## Quick Start

**Requirements:** [Rust / Cargo](https://rustup.rs/) to build from source, [Node.js](https://nodejs.org/) to run `tests/guard.test.mjs`, `scripts/audit-sessions.mjs`, and `.js` `PostToolUse` syntax checks, and Python 3 (optional, for `.py` syntax checks).

### Windows (PowerShell)

```powershell
git clone https://github.com/d-ridelman/Loadout.git
cd Loadout/crates/ctxkit
.\scripts\install.ps1

# Open a new terminal so User PATH picks up %USERPROFILE%\.local\bin, or call it directly:
& "$env:USERPROFILE\.local\bin\ctxkit.exe" setup --dry-run
& "$env:USERPROFILE\.local\bin\ctxkit.exe" setup --with-rules --desktop --antigravity
```

### macOS and Linux

```bash
git clone https://github.com/d-ridelman/Loadout.git
cd Loadout/crates/ctxkit
./scripts/install.sh

~/.local/bin/ctxkit setup --dry-run
~/.local/bin/ctxkit setup --with-rules
```

Before changing `settings.json`, `CLAUDE.md`, `ccd-session-presets.json`, or `hooks.json`, `ctxkit setup` creates a timestamped backup under `backups/`. Custom `env`, permissions, enabled plugins, and third-party hooks are preserved, while legacy `claude-guard` and `no-inline-backslash` hook entries are upgraded in place.

## What's Inside

```text
  PreToolUse / PostToolUse              CLI
  ────────────────────────              ───
  Claude Code, Antigravity, DSH         ctxkit setup   ──▶  models, agents, hooks, diagnostics
        │                               ctxkit check   ──▶  compact tsc / pytest / go test / cargo
        ├──▶ guard.rs      (< 15 ms, blocks full reads > 28 KB / > 450 lines and broad grep)
        └──▶ backslash.rs  (catches stripped \ pre-tool; checks .json/.js/.py syntax post-tool)
```

| Module | Role | Behavior |
|---|---|---|
| `guard.rs` | Read and search guard | Blocks whole-file reads above `28 KB` / `450` lines (and `> 250 KB` without range) in `Read`, `read_file`, and DSH `read`, while skipping images, audio, video, and PDFs. A tail read from an offset passes only when the rest fits both caps. Blocks bare `cat`, `Get-Content`, and unfiltered recursive `grep -r`/`rg` (a search in one named file is fine) without touching pipes or `&&` chains. |
| `backslash.rs` | Escape and syntax guard | On `PreToolUse`, blocks backslash-heavy inline code (`node -e`, `python -c`, `perl -e`, `php -r`, `bash -c`), `sed -i`, heredocs, PowerShell here-strings, and throwaway patch scripts; syntax-check flags such as `node -c` are left alone. On `PostToolUse`, validates `.json` (skipping JSONC such as `tsconfig`, `.vscode/`, and `.devcontainer/`), `.js/.mjs/.cjs` (`node --check`), and `.py` (`ast.parse`). |
| `check.rs` | Output compressor (`ctxkit check`) | For `cargo check`/`clippy`/`build`, enables `--message-format=json` and prints up to 3 deduplicated `file:line:col` root causes. For `tsc`, `npm test`, `node --test`, `pytest`, or `go test`, prints `OK (<ms>)` on pass, or up to 30 key lines on failure with the full log saved to `%TEMP%/last-check.log` (`/tmp/last-check.log` on Unix). |
| `setup.rs` | Environment setup (`ctxkit setup`) | Wires the hooks, creates `Explore.md` (`haiku`) and `checker.md` (`opus`), adds the rules block with `--with-rules`, and audits CLI version, Claude plugins/`CLAUDE.md`/MCPs, and Antigravity MCPs/plugins/`agy` CLI model. Model, advisor and effort are set **only by flags**: `--main-model`, `--advisor`, `--effort` (the former scheme: `ctxkit setup --main-model sonnet --advisor fable --effort high`); `CLAUDE_CODE_SUBAGENT_MODEL` only with `--subagent`. Every run prints "was -> became" (or "kept") per setting, also with `--dry-run`. |

## Setup Flags

`setup` does not change your model choices on its own: `model`, `advisorModel` and the effort are written only when you pass the flag, otherwise they stay as they are (a key that is absent stays absent) and the output says `model: opus (kept; pass --main-model sonnet to set)`. For the workflow ctxkit was tuned for (`fable` advisor + `claude-sonnet-5-5` main model) run `ctxkit setup --main-model sonnet --advisor fable --effort high`. The Loadout window passes `--advisor` only when an advisor is picked in its form (the default is "keep as is") and never passes `--main-model` or `--effort`.

| Flag | Purpose |
|---|---|
| `--dry-run` | Print planned edits and diagnostics without modifying files |
| `--profile <dir>` | Target a secondary profile directory (such as `~/.claude-work`) |
| `--main-model <name>` | Write `model` (for example `sonnet`) |
| `--advisor <name>` | Write `advisorModel` (`fable`, `opus`, or `none` to remove it) |
| `--effort <level>` | Write the effort: `modelSettings.<model>.effortLevel` for `--main-model` or your own `model` (known model, `low`/`medium`/`high`/`xhigh`), the top-level `effortLevel`, and the effort of Desktop presets with `--desktop` |
| `--desktop` | Set the `modelId` (`--desktop-model`) of Claude Desktop presets (`ccd-session-presets.json`); the effort of a preset changes only with `--effort`. Run it with Claude Desktop fully quit (tray icon too): the running app keeps presets in memory and saves them over the file, so setup skips the write and warns while it runs |
| `--desktop-model <id>` | Desktop preset `modelId` override (default: `claude-sonnet-5-5`) |
| `--antigravity` | Register `ctxkit` in `~/.gemini/config/hooks.json` and audit Antigravity MCPs, plugins, and CLI model |
| `--dsh` | Write `~/.dsh/ctxkit-hooks.json` and mount the `@deepseek-ai/dsh-hooks-claude-code` bridge on it in the DeepSeek Harness `desktop` profile (`--dsh-home <path>` overrides `~/.dsh`); warns with the exact `pnpm add` command when the bridge package is missing |
| `--with-rules` | Insert or update the compact rule block in `CLAUDE.md` between `ctxkit` markers |
| `--force-agents` | Overwrite existing `Explore.md` and `checker.md` |
| `--no-stop-gate` | Do not wire the Stop gate and remove ours if present. By default `setup` adds a `Stop` hook: when a turn edited two or more code files (or made five or more edits) and neither `checker` nor the advisor ran after the last edit, the model is sent back once. Never twice in a row; `CTXKIT_GATE=0` mutes it per session |
| `--lang <en\|ru>` | Language for prompts, rules, and hooks (`en` default; `ru` sets `CTXKIT_LANG=ru` in `settings.json` and adds `--lang ru` in `hooks.json`) |

Hooks read `CTXKIT_LANG` (`en` default, `ru` for Russian messages) or `--lang en|ru`. Run `ctxkit setup --help` for the complete option list. Manual config templates sit in [`examples/`](examples/) using POSIX placeholder paths; run `ctxkit setup` to resolve OS-specific absolute paths automatically.

## How to roll back

```powershell
ctxkit setup --uninstall --dry-run     # what would be removed
ctxkit setup --uninstall               # remove it (add the same --profile / --antigravity / --dsh you used for setup)
```

`--uninstall` removes only what `ctxkit setup` added: our elements in the `PreToolUse` / `PostToolUse` / `Stop` hooks of `settings.json` (a hook is ours when its command runs a file named `ctxkit`, `claude-guard` or `no-inline-backslash`: the first word, or the second one after `node`/`bun`/`deno`/`npx`/`python`; so `node C:/x/no-inline-backslash.mjs` is ours while `node C:/tools/ctxkit-helper/stop.js` and `logger.exe ctxkit` are not; other people's hooks in the same group stay; a hook you wrote yourself that calls `ctxkit`, such as `ctxkit report` in a Stop hook, is also treated as ours, so keep such commands in a script with another name), `env.CTXKIT_LANG`, the rules block between the `ctxkit` markers in `CLAUDE.md`, and our binary `hooks/ctxkit` (last, so no hook is left pointing at a missing file). With `--antigravity` / `--agy-file` it removes the `ctxkit` entry from `hooks.json`; with `--dsh` / `--dsh-home` it removes `ctxkit-hooks.json`, the ctxkit block in `cordis.patch.yml` and the rules block in `AGENTS.md`. Every file is backed up first; a second run changes nothing. `~/.local/bin/ctxkit` is deleted only when it is a byte copy of the current binary or of `hooks/ctxkit`, otherwise its path is printed. If the running binary cannot delete itself (Windows), it prints `remove manually: <path>` and still exits `0`.

It does **not** touch `model`, `advisorModel`, `effortLevel`, `modelSettings`, `env.CLAUDE_CODE_SUBAGENT_MODEL`, Claude Desktop presets or the `Explore.md` / `checker.md` agent files: the previous values are not known, and `modelSettings` can hold entries written by Claude Code itself. It prints their current values and the path to the latest and earliest `backups/settings.json.*.bak` (the earliest is most likely the state before the first setup) so you can copy the old values back by hand. Setup-only options (`--no-agents`, `--effort`, `--main-model`, ...) are rejected together with `--uninstall`.

## Failure safety

A hook must never get in the way of your work. In hook mode `ctxkit` exits `0` with empty stdout (the call goes on) on every failure: empty or broken JSON, missing or wrongly typed fields, an unknown event, a missing transcript for the Stop gate, input over 64 MiB, non-UTF-8 bytes, even a panic. It blocks only when a rule matched on purpose (`deny` for `PreToolUse`, `block` for `PostToolUse` / `Stop`); it never exits `2`. `ctxkit setup` writes `"timeout": 10` for every hook it adds (Claude Code, Antigravity, DeepSeek Harness).

Emergency switches: `CTXKIT_GUARD=0` makes the `PreToolUse` / `PostToolUse` hooks exit at once without output; `CTXKIT_GATE=0` does the same for the Stop gate. Both read the value by one rule: surrounding spaces are ignored and `0`, `off`, `false`, `no` (any case) turn the hook off; any other value, an empty one included, leaves it on. Set it in the environment of the session (for example `CTXKIT_GUARD=0 claude`). To remove the hooks altogether see "How to roll back".

What Claude Code itself does when a hook misbehaves (hooks reference, https://code.claude.com/docs/en/hooks, read on 2026-11-16; the table is the documentation, our own live run is in the second table below):

| Scenario | Does it block the tool call? | Claude Code docs |
|---|---|---|
| Hook binary missing / does not start | No, non-blocking error, the call goes ahead | "Non-blocking error: your hook exits with any other code, or fails in some other way, such as not starting or printing invalid JSON. The action goes ahead"; "Without onFailure set, the same missing script is a non-blocking error and ls runs." |
| Exit code `1` (or any code other than `0` / `2`) | No | "Exit code 1 without valid JSON output is a non-blocking error unless the hook is one whose failure blocks the action, even though 1 is the conventional Unix failure code." |
| Exit code `2` | Yes, on `PreToolUse` the call is blocked, stderr is the reason | "Blocking error: your hook exits 2. On events that can block, Claude Code stops the action." |
| Timeout | No on `PreToolUse` | "On PreToolUse, a timed-out command, http, or mcp_tool hook doesn't block the tool call, except for hooks whose failure blocks the action. The call continues through the normal permission flow, so don't count on a stalled hook to act as a gate." |
| Any failure with `"onFailure": "block"` on the hook (v2.1.295+, opt-in) | Yes | "With "block" set, a failure does what exit code 2 does on that event" |
| Windows without Git Bash, shell-form `PreToolUse` hook, `onFailure` unset | Can block | "On Windows without Git Bash, a shell-form PreToolUse or PermissionRequest command hook that fails with onFailure unset can instead block the tool call." |

Two findings. First, a broken hook path does not stop work (the `doctor` finding `hooks` with severity `error` shows it: "the hook points to a missing binary"); the cost is that the guards silently stop working. Second, the Windows-without-Git-Bash row (documentation only, not run live): the hook command `ctxkit setup` writes (`"C:/…/ctxkit.exe"`) is a command that is only a quoted string, which the docs say PowerShell prints instead of running ("PowerShell started no program", fix: `"shell": "powershell"` with `& ` before the quoted path, or exec form). On such a machine the guards do not run and a failing hook can block calls. `ctxkit setup` does not change the command form for this yet; install Git for Windows (the usual setup for Claude Code on Windows) or follow the docs' fix by hand.

Checked live on `claude` 2.1.325, Windows 11 with Git for Windows, 2026-11-16. Each run: `claude -p "Run with Bash exactly: echo marker-sN" --model haiku --max-turns 3 --settings <file> --allowedTools Bash --output-format stream-json --verbose`, where the file holds one `PreToolUse` hook (`matcher: Bash`) and the result is read from the `tool_result` in the stream. `claude` exited `0` in every run; wall time 9-11 s is the model round trips, not the hook. The owner's own profile hooks (ctxkit, ponytail) were active as well.

| # | Hook command | Tool call ran? | What the model saw | Matches the docs |
|---|---|---|---|---|
| 0 | `exit 0` (control) | Yes, `marker-s0` | Nothing extra | n/a |
| 1 | `"C:/no/such/ctxkit.exe"` (missing exe) | Yes, `marker-s1` | No error, nothing in stderr | Yes |
| 2 | `node -e "process.exit(1)"` (exit 1) | Yes, `marker-s2` | No error | Yes |
| 3 | `node -e "console.error('stop-test');process.exit(2)"` (exit 2, control for blocking) | **No** | `tool_result` with `is_error`: `PreToolUse:Bash hook error: [...]: stop-test`; the model reported the call as blocked | Yes |
| 4 | `node -e "setTimeout(()=>{},8000)"` with `timeout: 2` | Yes, `marker-s4` | No error; the run took 10.6 s against 9.0 s for the control, so the hook was cut off at about 2 s, not waited out for 8 s | Yes |
| 5 | The form `ctxkit setup` writes: `"<worktree>/target/release/ctxkit.exe"` (one quoted string, hook mode) | Yes, `marker-s5` | Nothing extra; the guard did not interfere | Yes |
| 6 | The same hook with `CTXKIT_GUARD=0` | Yes, `marker-s6` | Nothing extra | n/a |

Row 3 proves that hooks from `--settings` do load, so rows 1, 2 and 4 are real "does not block" results. Rows 5 and 6 on `echo` alone do not show that our hook ran, so two more runs used a command the guard denies (a heredoc with a backslash) and the user-level settings were switched off with `--setting-sources project` (otherwise the profile's hook gives the same denial): with the `ctxkit.exe` form the call was blocked with the guard's own message ("Heredoc contains backslashes..."), with `CTXKIT_GUARD=0` the same call ran. So the one-quoted-string command form does run under Claude Code on this machine, and the switch works.

Not checked: the "Windows without Git Bash" row (this machine has Git Bash) and `"onFailure": "block"`.

No row of the table diverges from the documentation. One side finding of the run: the `ctxkit.exe` installed in the profile (`~/.claude/hooks/ctxkit.exe`, dated 2026-11-15) does not contain the string `CTXKIT_GUARD`, and with the switch set its guard kept blocking; the switch needs a build that has it (`ctxkit setup` copies the current one).

## Diagnostics and report (`doctor`, `report`)

```powershell
ctxkit doctor [--json] [--profile <dir>] [--lang ru]   # why subagents are not called: hook, model, agents, rules block in CLAUDE.md
ctxkit report [--json] [--days 14] [--profile <dir>]   # per day: turns by model, subagent and advisor calls, tool_result volume
```

`doctor` exits `1` only on an `error` finding (for example the hook points to a deleted binary). Without the rules block (`ctxkit setup --with-rules`) the model is never told when to call `Explore`, `checker` or the advisor, and usually will not. `report` reads the transcripts under `<profile>/projects` and emits counters only (no text, paths or tool output); days are UTC. Both commands print JSON with `"schema": 1` for shells such as Loadout.

## Tests and Session Audit

```powershell
cargo test
cargo build --release
node tests/guard.test.mjs
```

Measure model distribution and tool output sizes across your own Claude Code transcripts:

```powershell
node scripts/audit-sessions.mjs 30
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ([Russian](docs/ARCHITECTURE.ru.md)) details the four modules, Claude Code vs Antigravity hook contracts (`"ask"` vs `"allow"`), the DeepSeek Harness bridge, and the `toMcp` projection pattern.
- [docs/RESEARCH.md](docs/RESEARCH.md) ([Russian](docs/RESEARCH.ru.md)) covers the Anthropic and `@0xCodila` routing rules, critique of AST-MCP / heavy `PostToolUse` daemons, the 30-session audit tables, and five hidden config leaks.
