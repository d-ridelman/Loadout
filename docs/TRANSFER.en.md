# Moving entries between clients: where each client keeps them, and what translates

Russian version: [TRANSFER.md](TRANSFER.md).

This is the map behind “Copy to client…” and “Copy from a project…”. Facts were checked against the official documentation
and source code on 17 November 2026 (Codex rust-v0.169.0, OpenCode v1.19.6, the Antigravity CLI documentation shipped with
the program, the README files of the DeepSeek Harness 0.2.1 packages). Anything not found in a primary source is marked
**not verified**. Paths use `~` for the user's home folder and `<p>` for a project folder.

## 1. Where entries live

| Client | Kind | Global (user) | Project | Format | Source |
|---|---|---|---|---|---|
| Claude Code | skill | `~/.claude/skills/<name>/SKILL.md` | `<p>/.claude/skills/<name>/SKILL.md` | Markdown with YAML frontmatter | [skills][cc-skills] |
| | MCP | `~/.claude.json` → `mcpServers` (scope user) | `~/.claude.json` → `projects.<p>.mcpServers` (scope local, private) and `<p>/.mcp.json` (scope project, shared) | JSON: `command`, `args`, `env` / `type: http`, `url`, `headers` | [mcp][cc-mcp] |
| | hook | `~/.claude/settings.json` → `hooks` | `<p>/.claude/settings.json`, `<p>/.claude/settings.local.json` | JSON: event → `[{matcher, hooks: [{type, command, timeout}]}]` | [hooks][cc-hooks] |
| | plugin | `~/.claude/plugins/` (installed by `claude`), enabled by `enabledPlugins` in any settings file | `enabledPlugins` in `<p>/.claude/settings.json` (the plugin must also be installed and its marketplace known) | a package: `.claude-plugin/plugin.json`, `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json` | [plugins][cc-plugins] |
| Claude Desktop (chat) | MCP | `%APPDATA%\Claude\claude_desktop_config.json` → `mcpServers` | none | JSON: `command`, `args`, `env`. Remote servers are added in the app as connectors; whether `url` in this file works is **not verified** | [MCP quickstart][desk-mcp] |
| | skill | in the claude.ai account (uploaded as a zip), not in files | none | — | [use skills][desk-skills] |
| | hook, plugin | none found in files (**not verified**) | none | — | — |
| ChatGPT / Codex | skill | `~/.agents/skills` (current); `~/.codex/skills` is deprecated but still read | `<p>/.agents/skills`, `<p>/.codex/skills` | SKILL.md: `name` (≤ 64, defaults to the folder name) and a non-empty `description`; other keys are ignored | [skills][cx-skills], [host_roots.rs][cx-roots], [parser.rs][cx-parser] |
| | MCP | `~/.codex/config.toml` → `[mcp_servers.<name>]` | `<p>/.codex/config.toml` (read only when the project is trusted) | TOML: `command`, `args`, `env`, `env_vars`, `cwd` / `url`, `http_headers`, `bearer_token_env_var` | [mcp][cx-mcp], [config][cx-config] |
| | hook | `~/.codex/hooks.json` or `[hooks]` in `config.toml` | `<p>/.codex/hooks.json` (trusted projects) | the Claude Code JSON shape; a new or changed hook runs only after it is trusted in `/hooks` | [hooks][cx-hooks], [discovery.rs][cx-disc] |
| | plugin | `[plugins."name@marketplace"] enabled` in `config.toml`; cache `~/.codex/plugins/cache/` | marketplace `<p>/.agents/plugins/marketplace.json` | a package: `plugin.json` / `.codex-plugin/plugin.json`, skills, hooks, `.mcp.json` | [plugins][cx-plugins] |
| Antigravity | skill | `~/.gemini/config/skills/<name>/SKILL.md` | `<p>/.agents/skills` (`.agent/skills` still works) | SKILL.md: `description` required | local docs `skills.md`, [skills][ag-skills] |
| | MCP | `~/.gemini/config/mcp_config.json` → `mcpServers` | `<p>/.agents/mcp_config.json` per the web page only (**not verified**: the documentation shipped with the CLI does not mention it) | JSON: `command`, `args`, `env` / `url` (`serverUrl` is the old name) | local docs `mcp_servers.md` |
| | hook | `~/.gemini/config/hooks.json` | `<p>/.agents/hooks.json` | JSON: hook name → event → groups; stdin and the answer are camelCase (`toolCall.name`, `decision`) | local docs `hooks.md` |
| | plugin | `~/.gemini/config/plugins/<name>/` | `<p>/.agents/plugins/<name>/` | `plugin.json`, `mcp_config.json`, `hooks.json`, `skills/`, `rules/`; `agy plugin import claude` converts Claude Code plugins | local docs `plugins.md`, [plugins][ag-plugins] |
| DeepSeek Harness | skill | `~/.dsh/skills`, `~/.agents/skills` | `<p>/.dsh/skills`, `<p>/.agents/skills` | SKILL.md: `name` (kebab-case) and `description` required | `dsh-skill-filesystem` README |
| | MCP | `~/.dsh/cordis.patch.yml` → an `insert` entry of `@deepseek-ai/dsh-mcp-client` | none | YAML with `!!js` tags: `serverName`, `transport`, `command`, `args`, `env`, `url`, `headers` | `dsh-mcp-client`, `dsh-app-boot` README |
| | hook | the JSON named by `config.configPath` of a `@deepseek-ai/dsh-hooks-claude-code` entry | none | the Claude Code shape; events `SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop` | `dsh-hooks-claude-code` README |
| | plugin | npm packages of the profile (`dsh plugin`) | none | cordis plugins, not Claude Code packages | `dsh` README |
| OpenCode | skill | `~/.config/opencode/skills`; **also reads** `~/.claude/skills` and `~/.agents/skills` | `<p>/.opencode/skills`; **also reads** `<p>/.claude/skills` and `<p>/.agents/skills` | SKILL.md: `name`, `description` | [skills][oc-skills], [compatibility.ts][oc-compat] |
| | MCP | `~/.config/opencode/opencode.json(c)` → `mcp.<name>` (V1) or `mcp.servers.<name>` (V2) | `<p>/opencode.json(c)`, `<p>/.opencode/opencode.json(c)` | JSONC: `type: local`, `command: [exe, …args]`, `environment` / `type: remote`, `url`, `headers` | [mcp][oc-mcp], [config][oc-config] |
| | hook | none: only JS/TS plugins (`tool.hook("execute.before")` and others) | none | — | [plugins][oc-plugins] |
| | plugin | `plugin`/`plugins` in the config (npm), `~/.config/opencode/plugins/*.ts` | `<p>/.opencode/plugins/` | JS/TS code | [plugins][oc-plugins] |

## 2. What translates

“Lossless” means the target reads the entry the way the source did. “With losses” names what the target does not have.

### Skills

The folder with `SKILL.md` is the same open format in every client except the Claude Desktop chat, so a skill is copied as
a folder.

| From → to | Result |
|---|---|
| any → Claude Code, Codex, Antigravity, DeepSeek, OpenCode | the folder is copied as is. **Losses:** keys only Claude Code understands (`allowed-tools`, `context`, `agent`, `hooks`, `paths`, `shell`, `model`, `effort`, `arguments`, `argument-hint`, `when_to_use`) are ignored by the others; `` !`command` `` lines and `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PROJECT_DIR}` are not expanded outside Claude Code. DeepSeek drops a skill whose `name` is not kebab-case; Codex refuses an empty `description` |
| Claude Code → OpenCode | **not needed:** OpenCode already reads `~/.claude/skills` and `<p>/.claude/skills` |
| any → Claude Desktop (chat) | **impossible:** chat skills live in the account |

Where the copy lands (Loadout writes into the folder the client reads and Loadout scans): Claude Code `~/.claude/skills`,
Codex `~/.codex/skills` (deprecated by Codex but read; `~/.agents/skills` is shared with DeepSeek and OpenCode),
Antigravity `~/.gemini/config/skills`, DeepSeek `~/.dsh/skills`, OpenCode `~/.config/opencode/skills`. In a project:
Claude Code `<p>/.claude/skills`; Codex, Antigravity, DeepSeek and OpenCode share `<p>/.agents/skills`, so one copy there
serves all four.

### MCP servers

| From → to | Result |
|---|---|
| between Claude Code, Claude Desktop, Codex, Antigravity, OpenCode | `command`, `args`, `env`, `url`, headers carry over; JSON ⇄ TOML and the OpenCode `command` array are converted. **Losses:** any other key (`cwd`, timeouts, `oauth`, `enabled_tools` …) is named in the preview and not copied. `${VAR}` placeholders are a Claude Code feature: Codex and OpenCode (`{env:VAR}`) would get them as literal text. An `sse` or `ws` transport has no counterpart in the others |
| remote server → Claude Desktop | **refused:** the documentation shows only local servers in this file; remote ones are added in the app as connectors |
| any → DeepSeek | **not done by Loadout:** the entry lives in tagged YAML (`!!js`) that Loadout only cuts and restores |
| into a project | Claude Code: the private local scope `~/.claude.json` → `projects.<p>.mcpServers` (not the shared `.mcp.json`); Codex: `<p>/.codex/config.toml` (created if missing; Codex reads it only in a trusted project); OpenCode: an existing `<p>/opencode.json(c)` (without one the schema generation is unknown). Antigravity, Claude Desktop and DeepSeek have no verified project file |

### Hooks

| From → to | Result |
|---|---|
| Claude Code ⇄ Codex | the same JSON shape. Shared events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`; a hook on any other event is refused. **Losses:** only `type: command` is copied (Codex skips `prompt` and `agent`); keys other than `command`, `timeout`, `statusMessage` are named and not copied. Tool names in `matcher`: Codex has `Bash`, `apply_patch` (also matched as `Edit` and `Write`) and `mcp__…`; Claude Code `Read`, `Glob`, `Grep`, `WebFetch` … have no Codex counterpart and are dropped from the matcher (a hook left with none is refused); a regular-expression matcher is refused. A copied hook does not run in Codex until it is trusted in `/hooks`. `$CLAUDE_PROJECT_DIR` is set by Claude Code; whether Codex sets it is **not verified** |
| → Antigravity | **impossible:** another protocol (hook name level, camelCase stdin `toolCall.args`, `decision` instead of `hookSpecificOutput`): a Claude Code script would not understand it |
| → OpenCode | **impossible:** no command hooks, only code plugins |
| → DeepSeek | **not done by Loadout:** the hooks file is named inside tagged YAML; the bridge runs only `command` hooks of seven events, `Stop` cannot see `stop_hook_active` (a blocking Stop hook loops) |
| → Claude Desktop | **impossible:** no hooks |
| Context Toolkit hooks | **refused:** they are client-specific; install them for another client in Context Toolkit |

### Plugins

A plugin is a package that the client's own tool installs and updates; no pair can take it by a file edit.

| From → to | What to do instead |
|---|---|
| Claude Code → Antigravity | `agy plugin import claude` (Antigravity's own converter) |
| Claude Code → Codex | Codex reads Claude Code marketplaces (`.claude-plugin/marketplace.json`): add the marketplace and install the plugin in Codex (**not verified** end to end) |
| Claude Code → OpenCode, DeepSeek, Desktop | impossible as a package (OpenCode plugins are JS code, DeepSeek plugins are npm packages); copy the plugin's skills and MCP servers one by one where they are visible as entries |

[cc-skills]: https://code.claude.com/docs/en/skills
[cc-mcp]: https://code.claude.com/docs/en/mcp
[cc-hooks]: https://code.claude.com/docs/en/hooks
[cc-plugins]: https://code.claude.com/docs/en/plugins/manifest-reference
[desk-mcp]: https://modelcontextprotocol.io/quickstart/user
[desk-skills]: https://support.claude.com/en/articles/12512180-use-skills-in-claude
[cx-skills]: https://learn.chatgpt.com/docs/build-skills
[cx-roots]: https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs
[cx-parser]: https://github.com/openai/codex/blob/main/codex-rs/skills/src/parser.rs
[cx-mcp]: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
[cx-config]: https://learn.chatgpt.com/docs/config-file/config-basic
[cx-hooks]: https://learn.chatgpt.com/docs/hooks
[cx-disc]: https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs
[cx-plugins]: https://developers.openai.com/plugins/build/plugins
[ag-skills]: https://antigravity.google/docs/skills
[ag-plugins]: https://antigravity.google/docs/plugins
[oc-skills]: https://opencode.ai/docs/skills/
[oc-compat]: https://github.com/anomalyco/opencode/blob/dev/packages/core/src/config/plugin/compatibility.ts
[oc-mcp]: https://opencode.ai/docs/mcp-servers/
[oc-config]: https://opencode.ai/docs/config/
[oc-plugins]: https://opencode.ai/docs/plugins/

“Local docs” for Antigravity are the files `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/*.md` shipped
with the CLI; the DeepSeek READMEs are those of the installed `@deepseek-ai/*` packages.
