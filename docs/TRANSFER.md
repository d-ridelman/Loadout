# Перенос записей между клиентами: где что лежит и что во что переводится

English version: [TRANSFER.en.md](TRANSFER.en.md).

На этой карте построены «Копировать в клиент…» (инспектор) и «Добавить ▾ → Из другого клиента…» (пакетом, глобально или в проекте). Факты сверены с официальной документацией и
исходниками 17.11.2026 (Codex rust-v0.169.0, OpenCode v1.19.6, документация Antigravity CLI, которая ставится вместе с
программой, README пакетов DeepSeek Harness 0.2.1). Что не нашлось в первоисточнике, помечено **не проверено**. `~` —
домашняя папка, `<p>` — папка проекта.

## 1. Где лежат записи

| Клиент | Тип | Глобально (user) | Проект | Формат | Источник |
|---|---|---|---|---|---|
| Claude Code | скил | `~/.claude/skills/<имя>/SKILL.md` | `<p>/.claude/skills/<имя>/SKILL.md` | Markdown с YAML-заголовком | [skills][cc-skills] |
| | MCP | `~/.claude.json` → `mcpServers` (область user) | `~/.claude.json` → `projects.<p>.mcpServers` (область local, личная) и `<p>/.mcp.json` (область project, общая) | JSON: `command`, `args`, `env` / `type: http`, `url`, `headers` | [mcp][cc-mcp] |
| | хук | `~/.claude/settings.json` → `hooks` | `<p>/.claude/settings.json`, `<p>/.claude/settings.local.json` | JSON: событие → `[{matcher, hooks: [{type, command, timeout}]}]` | [hooks][cc-hooks] |
| | плагин | `~/.claude/plugins/` (ставит `claude`), включается `enabledPlugins` в любом файле настроек | `enabledPlugins` в `<p>/.claude/settings.json` (плагин ещё должен быть установлен, а маркетплейс известен) | пакет: `.claude-plugin/plugin.json`, `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json` | [plugins][cc-plugins] |
| Claude Desktop (чат) | MCP | `%APPDATA%\Claude\claude_desktop_config.json` → `mcpServers` | нет | JSON: `command`, `args`, `env`. Удалённые серверы добавляются в приложении как коннекторы; работает ли `url` в этом файле — **не проверено** | [MCP quickstart][desk-mcp] |
| | скил | в аккаунте claude.ai (загружается zip-архивом), не в файлах | нет | — | [use skills][desk-skills] |
| | хук, плагин | в файлах не найдено (**не проверено**) | нет | — | — |
| ChatGPT / Codex | скил | `~/.agents/skills` (текущий); `~/.codex/skills` устарел, но читается | `<p>/.agents/skills`, `<p>/.codex/skills` | SKILL.md: `name` (до 64, по умолчанию имя папки) и непустой `description`; остальные ключи игнорируются | [skills][cx-skills], [host_roots.rs][cx-roots], [parser.rs][cx-parser] |
| | MCP | `~/.codex/config.toml` → `[mcp_servers.<имя>]` | `<p>/.codex/config.toml` (читается только в доверенном проекте) | TOML: `command`, `args`, `env`, `env_vars`, `cwd` / `url`, `http_headers`, `bearer_token_env_var` | [mcp][cx-mcp], [config][cx-config] |
| | хук | `~/.codex/hooks.json` или `[hooks]` в `config.toml` | `<p>/.codex/hooks.json` (доверенные проекты) | форма Claude Code; новый или изменённый хук запускается только после доверия в `/hooks` | [hooks][cx-hooks], [discovery.rs][cx-disc] |
| | плагин | `[plugins."имя@маркетплейс"] enabled` в `config.toml`; кеш `~/.codex/plugins/cache/` | маркетплейс `<p>/.agents/plugins/marketplace.json` | пакет: `plugin.json` / `.codex-plugin/plugin.json`, скилы, хуки, `.mcp.json` | [plugins][cx-plugins] |
| Antigravity | скил | `~/.gemini/config/skills/<имя>/SKILL.md` | `<p>/.agents/skills` (`.agent/skills` пока работает) | SKILL.md: обязателен `description` | локальная `skills.md`, [skills][ag-skills] |
| | MCP | `~/.gemini/config/mcp_config.json` → `mcpServers` | `<p>/.agents/mcp_config.json` — только по веб-странице (**не проверено**: в документации CLI его нет) | JSON: `command`, `args`, `env` / `url` (`serverUrl` — старое имя) | локальная `mcp_servers.md` |
| | хук | `~/.gemini/config/hooks.json` | `<p>/.agents/hooks.json` | JSON: имя хука → событие → группы; вход и ответ в camelCase (`toolCall.name`, `decision`) | локальная `hooks.md` |
| | плагин | `~/.gemini/config/plugins/<имя>/` | `<p>/.agents/plugins/<имя>/` | `plugin.json`, `mcp_config.json`, `hooks.json`, `skills/`, `rules/`; `agy plugin import claude` переводит плагины Claude Code | локальная `plugins.md`, [plugins][ag-plugins] |
| DeepSeek Harness | скил | `~/.dsh/skills`, `~/.agents/skills` | `<p>/.dsh/skills`, `<p>/.agents/skills` | SKILL.md: обязательны `name` (kebab-case) и `description` | README `dsh-skill-filesystem` |
| | MCP | `~/.dsh/cordis.patch.yml` → запись `insert` пакета `@deepseek-ai/dsh-mcp-client` | нет | YAML с тегами `!!js`: `serverName`, `transport`, `command`, `args`, `env`, `url`, `headers` | README `dsh-mcp-client`, `dsh-app-boot` |
| | хук | JSON, на который указывает `config.configPath` записи `@deepseek-ai/dsh-hooks-claude-code` | нет | форма Claude Code; события `SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop` | README `dsh-hooks-claude-code` |
| | плагин | npm-пакеты профиля (`dsh plugin`) | нет | плагины cordis, а не пакеты Claude Code | README `dsh` |
| OpenCode | скил | `~/.config/opencode/skills`; **читает ещё** `~/.claude/skills` и `~/.agents/skills` | `<p>/.opencode/skills`; **читает ещё** `<p>/.claude/skills` и `<p>/.agents/skills` | SKILL.md: `name`, `description` | [skills][oc-skills], [compatibility.ts][oc-compat] |
| | MCP | `~/.config/opencode/opencode.json(c)` → `mcp.<имя>` (V1) или `mcp.servers.<имя>` (V2) | `<p>/opencode.json(c)`, `<p>/.opencode/opencode.json(c)` | JSONC: `type: local`, `command: [exe, …args]`, `environment` / `type: remote`, `url`, `headers` | [mcp][oc-mcp], [config][oc-config] |
| | хук | нет: только JS/TS-плагины (`tool.hook("execute.before")` и другие) | нет | — | [plugins][oc-plugins] |
| | плагин | `plugin`/`plugins` в конфиге (npm), `~/.config/opencode/plugins/*.ts` | `<p>/.opencode/plugins/` | код на JS/TS | [plugins][oc-plugins] |

## 2. Что во что переводится

«Без потерь» — клиент-получатель прочитает запись так же, как источник. «С потерями» — названо, чего у получателя нет.

### Скилы

Папка со `SKILL.md` — один открытый формат во всех клиентах, кроме чата Claude Desktop, поэтому скил копируется папкой.

| Откуда → куда | Итог |
|---|---|
| любой → Claude Code, Codex, Antigravity, DeepSeek, OpenCode | папка копируется как есть. **Потери:** ключи, которые понимает только Claude Code (`allowed-tools`, `context`, `agent`, `hooks`, `paths`, `shell`, `model`, `effort`, `arguments`, `argument-hint`, `when_to_use`), остальные клиенты игнорируют; строки `` !`команда` `` и `${CLAUDE_SKILL_DIR}` / `${CLAUDE_PROJECT_DIR}` вне Claude Code не раскрываются. DeepSeek отбрасывает скил, у которого `name` не в kebab-case; Codex не принимает пустой `description` |
| Claude Code → OpenCode | **не нужно:** OpenCode и так читает `~/.claude/skills` и `<p>/.claude/skills` |
| любой → Claude Desktop (чат) | **невозможно:** скилы чата живут в аккаунте |

Куда ложится копия (Loadout пишет в папку, которую читает клиент и сканирует Loadout): Claude Code `~/.claude/skills`,
Codex `~/.codex/skills` (Codex считает её устаревшей, но читает; `~/.agents/skills` общая с DeepSeek и OpenCode),
Antigravity `~/.gemini/config/skills`, DeepSeek `~/.dsh/skills`, OpenCode `~/.config/opencode/skills`. В проекте:
Claude Code `<p>/.claude/skills`; Codex, Antigravity, DeepSeek и OpenCode читают общую `<p>/.agents/skills`, так что
одна копия там работает у всех четырёх.

### MCP-серверы

| Откуда → куда | Итог |
|---|---|
| между Claude Code, Claude Desktop, Codex, Antigravity, OpenCode | `command`, `args`, `env`, `url`, заголовки переносятся; JSON ⇄ TOML и массив `command` у OpenCode переводятся. **Потери:** любой другой ключ (`cwd`, таймауты, `oauth`, `enabled_tools` …) назван в предпросмотре и не копируется. Подстановки `${VAR}` — возможность Claude Code: Codex и OpenCode (`{env:VAR}`) получат их буквальным текстом. Транспортам `sse` и `ws` у остальных соответствия нет |
| удалённый сервер → Claude Desktop | **отказ:** документация показывает в этом файле только локальные серверы, удалённые добавляются в приложении как коннекторы |
| любой → DeepSeek | **Loadout не делает:** запись живёт в YAML с тегами (`!!js`), который Loadout только вынимает и возвращает |
| в Claude Code | копия ложится в `~/.claude.json`, который запущенный Claude Code часто переписывает: откат из журнала пройдёт, только пока файл не менялся, иначе запись убирает `claude mcp remove <имя> -s user` (или `-s local`); предпросмотр об этом говорит |
| в проект | Claude Code: личная область local `~/.claude.json` → `projects.<p>.mcpServers` (не общий `.mcp.json`); Codex: `<p>/.codex/config.toml` (создаётся, если его нет; Codex читает его только в доверенном проекте); OpenCode: уже существующий `<p>/opencode.json(c)` (без него неизвестно поколение схемы). У Antigravity, Claude Desktop и DeepSeek проверенного проектного файла нет |

### Хуки

| Откуда → куда | Итог |
|---|---|
| Claude Code ⇄ Codex | одна форма JSON. Общие события: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`; хук на любом другом событии — отказ. **Потери:** копируется только `type: command` (`prompt` и `agent` Codex пропускает); ключи кроме `command`, `timeout`, `statusMessage` названы и не копируются. Имена инструментов в `matcher`: у Codex есть `Bash`, `apply_patch` (совпадает и как `Edit`, `Write`) и `mcp__…`; у `Read`, `Glob`, `Grep`, `WebFetch` … из Claude Code соответствия в Codex нет — они убираются из matcher (если не осталось ни одного — отказ); matcher-регулярное выражение — отказ. В Codex скопированный хук не запустится, пока ему не доверят в `/hooks`. Оболочка разная: на Windows Claude Code запускает команду через Git Bash, Codex — через `cmd /C` (`codex-rs/hooks`, command_runner.rs), поэтому `ИМЯ=значение` перед командой, `$HOME`, `%VAR%` и одинарные кавычки в другой оболочке ломаются (предпросмотр предупреждает). `$CLAUDE_PROJECT_DIR` задаёт Claude Code; задаёт ли его Codex и в каких единицах Codex читает `timeout` — **не проверено** |
| → Antigravity | **невозможно:** другой протокол (уровень имени хука, вход в camelCase `toolCall.args`, `decision` вместо `hookSpecificOutput`) — скрипт для Claude Code его не поймёт |
| → OpenCode | **невозможно:** хуков-команд нет, только плагины-код |
| → DeepSeek | **Loadout не делает:** файл хуков назван внутри YAML с тегами; мост запускает только `command`-хуки семи событий, а `Stop` не видит `stop_hook_active` (блокирующий Stop-хук зациклится) |
| → Claude Desktop | **невозможно:** хуков нет |
| хуки Context Toolkit | **отказ:** они свои у каждого клиента; для другого клиента их ставит раздел «Инструменты контекста» |

### Плагины

Плагин — пакет, который ставит и обновляет инструмент самого клиента; правкой файла его не принимает ни одна пара.

| Откуда → куда | Что сделать вместо |
|---|---|
| Claude Code → Antigravity | `agy plugin import claude` (конвертер самого Antigravity) |
| Claude Code → Codex | Codex читает маркетплейсы Claude Code (`.claude-plugin/marketplace.json`): добавьте маркетплейс и поставьте плагин в Codex (**не проверено** целиком) |
| Claude Code → OpenCode, DeepSeek, Desktop | как пакет невозможно (плагины OpenCode — код на JS, у DeepSeek — npm-пакеты). Скилы и MCP-серверы плагина Loadout тоже не копирует: копия перестала бы следовать обновлениям плагина, а `${CLAUDE_PLUGIN_ROOT}` указывает в кеш с номером версии |

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

«Локальная» документация Antigravity — файлы `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/*.md`,
которые ставятся с CLI; README DeepSeek — из установленных пакетов `@deepseek-ai/*`.
