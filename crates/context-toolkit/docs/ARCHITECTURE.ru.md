# Архитектура Инструментов контекста

<p><a href="ARCHITECTURE.md">English</a> | <strong>Русский</strong></p>

Инструменты контекста (раньше назывались ctxkit) компилируются в один нативный бинарник `context-toolkit` на Rust без внешних runtime-зависимостей (среднее время `PreToolUse` составляет `9-14 ms`). Работают с проектами на TypeScript/JS, Python, Go, Rust, C++ и любыми другими стеками.

## Четыре режима запуска

```text
CLI args / stdin JSON
   │
   ├─ argv[1] == "setup"       ──▶ setup::run_setup()   (автонастройка профилей и диагностика конфигов)
   │
   ├─ argv[1] == "check"       ──▶ check::run_check()   (сжатый раннер компиляторов и тестов)
   │
   ├─ stdin содержит toolCall  ──▶ Antigravity hook     (read_file / write_file / run_command)
   │
   ├─ --dsh или tool_name DSH  ──▶ DeepSeek Harness     (read / write / edit / bash / pwsh)
   │
   └─ иначе                    ──▶ Claude Code hook     (PreToolUse / PostToolUse)
```

### 1. `guard.rs`: ограничение чтения и широкого поиска

- Контроль `Read` (Claude Code), `read` (DeepSeek Harness) и `read_file` (Antigravity) опирается на пороги `MAX_READ_BYTES = 28_000`, `MAX_READ_LINES = 450` и `MAX_HUGE_BYTES = 250_000`. Чтение диапазоном (`limit <= 450` или `EndLine - StartLine + 1 <= 450`), а также изображения, видео, аудио и PDF пропускаются без задержки. Инвертированные диапазоны (`EndLine < StartLine`) отклоняются с пояснением. Попытка загрузить большой текстовый файл целиком отклоняется с подсказкой искать нужное место через `Grep`/LSP или субагента (`Explore` / `subagent`). Чтение от смещения без лимита (или с лимитом выше порога) проходит, только если остаток укладывается и в порог по строкам, и в порог по байтам; смещение `1` считается чтением целиком, а файлам крупнее `MAX_HUGE_BYTES` нужны и смещение, и лимит. Все пути резолвятся относительно переданного `cwd` или `workdir`.
- Контроль `shell_read_guard` блокирует прямые `cat` (`> 12 KB` или `> 200` строк), PowerShell `Get-Content` / `gc` / `type` / `cat` (в том числе с `-Raw`, `-Path`, `-Encoding`) и нефильтрованный рекурсивный `grep -r` / `rg` в обоих shell. Команда сначала делится на слова, поэтому флаг — это только отдельное слово без кавычек. Для составных цепочек команд (`&&`, `;`, `\n`) каждая подкоманда валидируется отдельно с отслеживанием переходов директорий `cd`. Не затрагиваются подкоманды с конвейерами (`|`), перенаправлениями (`>`), heredoc, флагами `-l`, `-c`, `-m N`, `--max-count`, а также `rg --version` / `--files` / `--help` и точечный поиск в одном файле.

### 2. `backslash.rs`: экранирование и синтаксис

- На `PreToolUse` (`Bash`, `PowerShell`, `Write`, `Edit`, `MultiEdit`, `apply_patch`, Antigravity `run_command`/`write_file`/`edit_file`) проверяет inline-вызовы, `sed -i`, bash heredoc, PowerShell here-string и одноразовые patch-скрипты с `\`, где shell или парсер аргументов искажает последовательности. У каждого интерпретатора свои флаги «дальше идёт код» (`node -e/-p/--eval`, `python -c`, `perl -e`, `ruby -e`, `php -r`, `bash -c`, `pwsh -Command`), поэтому `node -c file` или `bash -e script` с путём Windows за inline-код не принимаются. `printf`/`echo`/`awk` блокируются, только когда пишут в файл: `>` внутри кавычек — текст, `2>` — stderr.
- На `PostToolUse` (Claude Code `Edit|Write|MultiEdit`, DeepSeek Harness `write|edit|apply_patch`) проверяет `.json` через `serde_json` (пропуская JSONC в `tsconfig*`, `jsconfig*`, `.eslintrc*`, `devcontainer.json`, `.code-workspace`, `.vscode/` и `.devcontainer/`; остальные файлы, не разобравшиеся строго, разбираются ещё раз как JSONC, где комментарии и хвостовые запятые заменены пробелами, и блокируются, только если не разобрались и так), `.js/.mjs/.cjs` через `node --check` и `.py` через `python -I` с `ast.parse` (с учётом рабочего каталога `cwd`). Для `apply_patch` проверяются все изменённые или добавленные патчем файлы.

### 3. `check.rs`: сжатый вывод проверок (`context-toolkit check <cmd>`)

- Для `cargo check`, `cargo clippy` и `cargo build` добавляет `--message-format=json --quiet`, убирает дубликаты и каскад, оставляя до `3` уникальных первопричин (`file:line:col [code] - message (label)`).
- Для остальных команд (`tsc`, `npm run typecheck`, `npm test`, `node --test`, `pytest`, `go test`) при успехе печатает `OK (<ms>)` с краткой сводкой числа тестов, а при ошибке выводит до `30` ключевых строк и сохраняет полный вывод в `%TEMP%/last-check-<pid>.log` (`/tmp/...` на Unix; по файлу на запуск, поэтому параллельные сессии не затирают друг друга, а логи старше суток удаляются при следующей записи).

### 4. `setup.rs`: автонастройка и диагностика (`context-toolkit setup`)

- Перед изменением любого файла (`settings.json`, `CLAUDE.md`, `ccd-session-presets.json`, `hooks.json`, `cordis.patch.yml`) бэкап сохраняется в подпапке `backups/<name>.<unix_ts>.bak` (только при реальной разнице содержимого), не засоряя рабочие каталоги конфигов.
- Используется merge вместо перезаписи: сохраняются `env`, `permissions`, `enabledPlugins` и сторонние хуки; заменяются только `no-inline-backslash`, прежние хуки `claude-guard` и `ctxkit` и блоки между маркерами `<!-- claude-guard:start/end -->`, `<!-- ctxkit:start/end -->` или `<!-- context-toolkit:start/end -->`.
- Переход с прежнего имени (ctxkit). Хуки с `ctxkit.exe` (а также `claude-guard` и `no-inline-backslash`) считаются своими и получают команду `.../hooks/context-toolkit.exe`, чужие не трогаются. `env.CTXKIT_LANG` заменяется на `CONTEXT_TOOLKIT_LANG`. Старые маркеры блока правил распознаются всегда, а `--with-rules` переводит блок на `<!-- context-toolkit:start -->` / `<!-- context-toolkit:end -->`. Если есть только `ctxkit.json`, он копируется в `context-toolkit.json`; старый файл, созданный setup, удаляется в конце запуска, если старый бинарь хуков не остаётся для другого клиента (тот читает только этот файл), а написанный владельцем остаётся, но больше не читается. С `--antigravity` ключ `ctxkit` в `hooks.json` заменяется на `context-toolkit`, с `--dsh` старый блок в `cordis.patch.yml` заменяется новым. Старый `hooks/ctxkit.exe` удаляется только после успешной записи `settings.json`. Подробности — в README, раздел «Переход с ctxkit».
- Ключ `--dry-run` показывает все планируемые изменения без записи на диск.
- Самодиагностика проверяет версию `claude` (`< 2.1.321` при включённом `fable`), количество активных глобальных плагинов (`> 8`), размер `CLAUDE.md` (`> 200` строк или `> 8 KB`) и число глобальных MCP в `~/.claude.json` (`> 2`). При ключе `--antigravity` дополнительно проверяет модель `agy` CLI, включённые плагины в `~/.gemini/config/plugins/` (`> 6`), активные MCP в `mcp_config.json` и плагинах (`> 4`), а также размер файлов правил плагинов (лимит `24 KB`). При ключе `--dsh` проверяет `AGENTS.md`, число глобальных MCP-серверов в `cordis.patch.yml` и количество скиллов в `~/.dsh/skills/`. Поддерживает добавление правил `--with-rules` в `~/.dsh/AGENTS.md`.

## Контракты протоколов хуков

| Параметр | Claude Code | Antigravity |
|---|---|---|
| Конфиг | `~/.claude/settings.json` | `~/.gemini/config/hooks.json` (или `.agents/hooks.json`) |
| Инструменты | `Read`, `Write`, `Edit`, `MultiEdit`, `Bash`, `PowerShell` | `read_file`, `write_file`, `edit_file`, `run_command` |
| Блокировка `PreToolUse` | `hookSpecificOutput.permissionDecision = "deny"` | `{"decision": "deny", "reason": "..."}` |
| Пропуск `PreToolUse` | Пустой `stdout` | `{"decision": "ask"}` |
| Вопрос `PreToolUse` (политики `confirm_irreversible`, `stray_files`, см. README) | `hookSpecificOutput.permissionDecision = "ask"` + `permissionDecisionReason` | `{"decision": "ask", "reason": "..."}` |
| `PostToolUse` | Проверка синтаксиса и `{"decision": "block"}` | Только `{}` (блокировка после записи не поддерживается) |

В контракте Antigravity значение `"decision": "allow"` автоматически одобряет вызов инструмента в обход политики подтверждений пользователя. Поэтому при успешной проверке `context-toolkit` всегда возвращает `{"decision": "ask"}`, передавая финальное решение встроенной политике безопасности.

Собственная документация хуков Antigravity (`agy-customizations/docs/hooks.md`, лежит в `~/.gemini/antigravity-cli/builtin/skills/`, прочитана 2026-11-16) говорит, что хук «должен вывести результат JSON-объектом в stdout», а `decision` у `PreToolUse` обязателен (`allow`, `deny`, `ask`, `force_ask`). Пустой ответ как «нет мнения» в ней не описан. Поэтому в режиме `--agy` (флаг, который `context-toolkit setup --antigravity` кладёт в команду хука) случаи «решения нет» печатают тот же `{"decision": "ask"}`, что и чистая проверка: нечитаемый или слишком большой ввод, паника и `CONTEXT_TOOLKIT_GUARD=0` (для вызова `PostToolUse` это `{}`). Без `--agy` нечитаемый ввод нельзя отличить от ввода Claude Code, которому нужна тишина, поэтому ничего не печатается; разобранный ввод Antigravity (в нём есть `toolCall`) узнаётся и без флага. Вживую не проверено: что сам Antigravity делает с пустым ответом (документация молчит); явный ответ от этого не зависит.

### OpenCode

У OpenCode 2 (сверено с исходниками тега `v2.3.0`, 2026-11-18) хуков-команд нет, поэтому `setup --opencode` пишет плагин V2 `<config>/plugins/loadout-context-toolkit/index.js` (текст — `src/setup/opencode-plugin.js`; `<config>` — `--opencode-home`, иначе `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME/opencode`, `~/.config/opencode`). OpenCode сам грузит такие каталоги при запуске. На `tool.hook("execute.before")` плагин отдаёт `context-toolkit --opencode` (без оболочки, через stdin, таймаут 15 с) вызов `{hook_event_name: "PreToolUse", tool_name, tool_input, cwd}` с именами и полями OpenCode как есть:

- `read`, `write`, `edit`, `patch` и `shell` становятся `Read`, `Write`, `Edit`, `apply_patch` и `run_command`; `path`/`filePath`, `newString` и `patchText` — `file_path`, `new_string` и `patch`. Оболочка проверяется в обоих диалектах: на Windows OpenCode выбирает её сам. Подсказки называют `read`, `grep`, `edit` и `write`.
- `deny` плагин бросает как `Error` с причиной: адаптер промис-плагинов делает из него `Tool.Error`, вызов не выполняется, модель видит причину.
- `ask` идёт через `ctx.permission.assert` с действием `context-toolkit`. Базовая политика OpenCode разрешает любое действие (`*` → `allow`), поэтому плагин в `permission.hook("evaluate")` поднимает своё действие до `ask` с причиной в `message`. Если окно не показано (нет API или оценка прошла без хука) или человек не подтвердил, вызов отклоняется с причиной «нужно подтверждение человека».
- Хук упал, завис или ничего не ответил — вызов проходит, как и у остальных клиентов.

Шлюза Stop нет (у OpenCode нет события конца ответа), проверки синтаксиса после правки тоже (`execute.after` отказать не может). OpenCode берёт первый существующий из `<config>/AGENTS.md` и, с 2.3.1, `~/.claude/CLAUDE.md` (`packages/core/src/config/plugin/instruction.ts`), поэтому блок правил setup пишет только в уже существующий `AGENTS.md`: созданный файл отрезал бы `CLAUDE.md` владельца. `doctor` говорит, свой ли плагин, текущий ли он или правленый. В живом OpenCode не проверено: по исходникам и прогоном плагина под Node и под Bun 1.4.4 (среда OpenCode) с подставным контекстом.

### DeepSeek Harness Desktop

Своего конфига хуков у DeepSeek Harness нет: плагин `@deepseek-ai/dsh-hooks-claude-code` исполняет `hooks.json` формата Claude Code на точках `tools/pre-execute` и `tools/post-execute`. Входной JSON и допустимые ответы совпадают с колонкой Claude Code выше, поэтому `context-toolkit` использует тот же обработчик; отличаются только имена инструментов (`read`, `write`, `edit`, `apply_patch`, `bash`, `pwsh`), и подсказки в отказах называют их, а не `Grep`/`Explore`. Клиент выбирается флагом `--dsh` или определяется по `tool_name` в нижнем регистре или вызову `apply_patch`.

`context-toolkit setup --dsh` записывает `~/.dsh/context-toolkit-hooks.json` (`PreToolUse`: `read|write|edit|apply_patch|bash|pwsh`, `PostToolUse`: `write|edit|apply_patch`) и добавляет в `~/.dsh/profiles/desktop/cordis.patch.yml` запись `insert` (`id: context-toolkit-hooks`) между своими маркерами, не трогая остальные. Команда хука пишется под shell, которым её запускает harness (`pwsh -Command` в Windows, `bash -c` в остальных ОС). Пакет моста не входит в поставку приложения, а конфиг читается один раз при старте, поэтому setup предупреждает, если пакета нет в `node_modules` профиля, и после любой из правок приложение нужно перезапустить.

## Локализация (`CONTEXT_TOOLKIT_LANG`)

Ответы хуков (`guard.rs`, `backslash.rs`, `PostToolUse` в `main.rs`) по умолчанию выводятся на английском (`en`) и переключаются на русский через `CONTEXT_TOOLKIT_LANG=ru` или `--lang ru`. При запуске `context-toolkit setup --lang ru` переменная `CONTEXT_TOOLKIT_LANG=ru` записывается в секцию `env` файла `settings.json`, а при `--dsh` и `--antigravity` флаг `--lang ru` добавляется к команде в хуках. Старое имя переменной `CTXKIT_LANG` поддерживается (как и `CTXKIT_GUARD`, `CTXKIT_GATE`); если заданы обе, действует новая.

## Проекция `toMcp` для своих MCP-серверов

В собственных MCP-серверах стоит разделять ответы для UI и для агента через проекцию `toMcp`. Веб-интерфейс и REST API продолжают получать полные объекты с историей, кнопками действий и вложенными списками, а MCP-инструмент отдаёт компактный JSON без форматирования, вырезает UI-поля и сворачивает длинные списки в счётчик `count` плюс первые несколько проблемных элементов с `id` для точечного запроса.
