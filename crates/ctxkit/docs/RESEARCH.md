# Token Usage, Subscription Limits, and Agent Efficiency Research

<p><strong>English</strong> | <a href="RESEARCH.ru.md">Русский</a></p>

This note combines three inputs: the routing setup shared on X (`@0xCodila`, Nov 10-11, 2026) alongside Anthropic docs, a technical critique of the "Rust AST-MCP + PostToolUse daemon" pattern discussed with Gemini, and an empirical audit of 30 real Claude Code sessions (`26,256` assistant turns measured with [`scripts/audit-sessions.mjs`](../scripts/audit-sessions.mjs)).

## Scope: Why Savings Apply Beyond Rust

`ctxkit` is written in Rust solely for single-binary distribution and `9-14 ms` cold starts without spawning Node or Python per hook call. The savings target any repository stack, including TypeScript/JS, Python, Go, and Rust. In the 30 measured sessions, most bloat came from `2,793` shell file inspections and `1,363` full-file `Read` calls (up to `66.6 KB` each), plus `2,197` runs of `tsc`, `npm test`, `node --test`, `pytest`, and project builds.

## Findings from X (`@0xCodila`) and Anthropic Docs

Posts by `@0xCodila` and Anthropic documentation (`advisor`, `sub-agents`, `model-config`) describe a 4-model team that cuts token burn by roughly `~3.4x` compared to running a flagship model on every turn.

| Role | Model | Scope | Purpose |
|---|---|---|---|
| Main session | `Sonnet` (`sonnet`) | Edits code, writes tests, runs checks | Handles routine turns on a fast mid-tier model |
| Advisor | `Fable` (`advisorModel: fable`) | Consultation only, writes no files | Consulted ~3 times per task: plan lock, repeated error, final check |
| Search and reading | `Haiku` (`Explore`) | `Read, Grep, Glob` (read-only) | Keeps broad search output out of the main prompt cache |
| Final reviewer | `Opus` (`checker`) | `Read, Grep, Glob, Bash` (read-only) | Reviews `git diff`, runs tests, and checks edge cases before handoff |

Four implementation details decide whether this routing holds in practice:

1. Without explicit triggers in `CLAUDE.md` (consult the advisor before locking a non-trivial plan, when the same error repeats twice, and before declaring work done), Anthropic reported Sonnet calling the advisor `0 out of 198` times.
2. Lowering `effortLevel` on the main model sharply reduces advisor calls, so keep `effortLevel` at `high` when using `/advisor`.
3. Built-in `Explore` ignores `CLAUDE_CODE_SUBAGENT_MODEL` and stays on the main model unless overridden by an explicit `Explore.md` agent file (`name: Explore`, `model: haiku`) under `~/.claude/agents/`.
4. Keep the root `CLAUDE.md` under ~200 lines (~4-6 KB) and scope directory rules into `.claude/rules/*.md` using `paths:`. Placing exceptions in the same sentence as a prohibition raised rule compliance from `~1/10` to `~9/10` in Anthropic tests.

To justify advisor cost, the `@0xCodila` write-up cited `Fable 5.2` benchmarks: `Remote Labor Index` `41.3%` vs `21.3%` (`Opus 5.5`), `20.8%` (`GPT-6 Astra`), and `17.9%` (`Fable 5.1`); `BenchCAD 2.1` `83.5` vs `65.3`; `OSWorld 2.1` `89.3%`. At `$8` / `$40` per 1M input/output tokens, running that tier for grep and config reads wastes budget, whereas three targeted consultations per task pay back cleanly.

## Critique of the "Rust MCP + PostToolUse Daemon" Proposal

The Gemini discussion proposed three measures: (1) replacing native `Read`/`Bash` tools with a custom `tree-sitter`/`syn` AST-MCP server, (2) triggering a `PostToolUse` daemon running `cargo check`, `clippy --fix`, and a local LLM after every write, and (3) banning ordinary text responses in `CLAUDE.md`. Testing against real workflows sorted those ideas out:

| Proposal | Verdict | Evidence |
|---|---|---|
| Compact `cargo check --message-format=json` and test logs | Adopted (`ctxkit check`) | Targets `11.2%` of `tool_result` chars (~6-10% overall on mixed repos, up to 12-15% during heavy compile/typecheck loops) |
| Static prompt prefix for Prompt Caching | Adopted | `/advisor` keeps the cached prefix intact, whereas switching models mid-session invalidates it |
| `rendered.lines().take(4)` snippet from the Gemini draft | Fixed | `expected A, found B` diagnostics often start below line 4 of `rendered`; `check.rs` reads `message.message` and the primary `span` directly from JSON |
| Replace native `Read`/`Bash`/`Edit` with an AST-MCP server | Rejected | Coding models are heavily trained on native `Read`/`Grep`/`Edit`/`Bash`; LSP servers already cover AST navigation, while custom AST tools break on logs, configs, and `git` |
| Heavy `PostToolUse` build/autofix daemon on every file write | Rejected | While editing N coupled files, files 1..N-1 fail to compile temporarily and emit false errors; background auto-edits desync subsequent `Edit` calls |
| Ban normal assistant prose in `CLAUDE.md` | Disproven by telemetry | Plain chat text accounts for only ~1% of output tokens |

## Audit of 30 Recent Claude Code Sessions

Measured across local JSONL transcripts under `~/.claude/projects` using [`scripts/audit-sessions.mjs`](../scripts/audit-sessions.mjs):

| Metric | 30-Session Total | Notes |
|---|---:|---|
| Assistant turns | `26,256` | Average `875` turns per session |
| `cache_read_input_tokens` | `12,243,065,484` (~`12.24B`) | Every turn replays the accumulated session history |
| `cache_creation_input_tokens` | `92,662,314` (~`92.66M`) | `cache_read / cache_create` ratio = `132 : 1` |
| `input_tokens` (uncached) | `52,582` | |
| `output_tokens` | `29,915,599` (~`29.92M`) | |

### Model Distribution

| Model | Turns | Share | `output_tokens` | `cache_read` |
|---|---:|---:|---:|---:|
| Opus (5.5 + 4.8) | `16,271` | `62.0%` | `16,837,184` | `7,202,472,858` |
| Fable (5.2) | `8,736` | `33.3%` | `11,518,515` | `4,624,328,102` |
| Sonnet (5.5) | `1,243` | `4.7%` | `1,559,900` | `416,264,524` |
| Haiku | `0` | `0%` | `0` | `0` |

`95.3%` of all turns executed on flagship tiers, while `Haiku` handled zero turns.

### Output Breakdown (`29.92M` Tokens)

Plain chat responses (`textChars`) totaled `1,279,337` chars (~`320K` tokens, roughly `1%` of `output_tokens`). Tool invocation arguments (`toolUseChars`) used `10,399,201` chars, and visible thinking blocks (`thinkingChars`) added `3,184,254` chars on top of internal reasoning tokens. Session length (`875` turns average with 132x cache replay) on expensive models drove quota consumption.

### Incoming `tool_result` Bloat (`14,331,527` Chars)

| Source | Calls | Chars | Share of `tool_result` |
|---|---:|---:|---:|
| `Bash` + `PowerShell` | `6,788` | `7,976,419` | `55.7%` |
| file read/search via shell (`sed`/`cat`/`grep`/`rg`/`ls`/`tail`) | `2,793` | `4,657,398` | `32.5%` (`58.4%` of shell output) |
| build, test, lint, and check scripts | `2,197` | `1,605,014` | `11.2%` |
| `git` commands | `897` | `1,141,943` | `8.0%` |
| Native `Read` (single reads up to `66,559` chars) | `1,363` | `4,007,302` | `28.0%` |
| `Edit` | `3,853` | `478,297` | `3.3%` |
| `Grep` | `362` | `477,412` | `3.3%` |

Full-file reads and shell file inspection combined (`4.66M + 4.01M` chars) made up `60.5%` of all `tool_result` data. Single unfiltered third-party MCP responses routinely injected `45+ KB` of nested UI state and long histories in a single call.

## Five Hidden Config and Harness Leaks

An infrastructure audit uncovered five additional drains outside application code:

1. **Claude Desktop presets (`ccd-session-presets.json`) override `settings.json`**. Desktop stores per-project model and effort defaults separately, often pinning new sessions to `Opus` or `Fable` even after CLI `settings.json` switches to `Sonnet`.
2. **Four overlapping check layers**. Global wildcard telemetry hooks (`PreToolUse *` / `PostToolUse *`), regex `Stop` hooks scanning assistant prose ("said not tested"), heavy test commands on every `Stop`, and repo `.githooks`. Regex `Stop` hooks do not inspect code at all, yet force up to three full cache replays just to rephrase an answer. Keep deterministic `< 20 ms` guards in `PreToolUse`/`PostToolUse` and run suites before commit or final review.
3. **20+ global plugins and OpenAPI MCP servers**. Tool schemas from every enabled plugin and OpenAPI endpoint load into the system prompt on every turn. Keep 5-8 core plugins global and enable project-specific ones in `.claude/settings.json`.
4. **Stale git worktrees (`.claude/worktrees/`)**. Leftover worktrees slow down search and indexing; prune them with `git worktree prune`.
5. **Unfiltered MCP payloads without `toMcp` projection**. Returning raw REST objects with indentation, icon metadata, and 40+ history items wastes context; project responses with `toMcp` into compact JSON and summary counts.

Across Claude Code, Antigravity, and custom agent harnesses, the practical stack has five layers: configure models, presets, and a concise `CLAUDE.md` (`ctxkit setup`); block unbounded reads and raw grep via `PreToolUse`; compress build logs (`ctxkit check`) and MCP payloads (`toMcp`); reset finished tasks early with `/clear` while batching reads/edits/browser actions (`browser_batch`, `browser_snapshot` with `interactive_only: true` and `viewport_only: true`); and, in custom harnesses, apply Context Folding to collapse `tool_result` entries older than 6-8 turns into `[cmd #N -> OK / err]`.
