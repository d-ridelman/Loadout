# Архитектура `ctxkit`

<p><a href="ARCHITECTURE.md">English</a> | <strong>Русский</strong></p>

`ctxkit` компилируется в один нативный бинарник на Rust без внешних runtime-зависимостей (среднее время `PreToolUse` составляет `9-14 ms`). Работает с проектами на TypeScript/JS, Python, Go, Rust, C++ и любыми другими стеками.

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

- Контроль `Read` (Claude Code) и `read_file` (Antigravity) опирается на пороги `MAX_READ_BYTES = 28_000`, `MAX_READ_LINES = 450` и `MAX_HUGE_BYTES = 250_000`. Чтение диапазоном (`limit <= 450` или `EndLine - StartLine + 1 <= 450`), а также изображения, видео, аудио и PDF пропускаются без задержки. Попытка загрузить большой текстовый файл целиком отклоняется с подсказкой искать нужное место через `Grep`/LSP или делегировать чтение субагенту `Explore`. Чтение от смещения без лимита (или с лимитом выше порога) проходит, только если остаток укладывается и в порог по строкам, и в порог по байтам; смещение `1` считается чтением целиком, а файлам крупнее `MAX_HUGE_BYTES` нужны и смещение, и лимит.
- Контроль `shell_read_guard` блокирует прямые `cat` (`> 12 KB` или `> 200` строк), PowerShell `Get-Content` / `gc` / `type` / `cat` (в том числе с `-Raw`, `-Path`, `-Encoding`) и нефильтрованный рекурсивный `grep -r` / `rg` в обоих shell. Команда сначала делится на слова, поэтому флаг — это только отдельное слово без кавычек. Не затрагиваются команды с конвейерами (`|`), перенаправлениями (`>`), `&&`, `;`, heredoc, флагами `-l`, `-c`, `-m N`, `--max-count`, а также `rg --version` / `--files` / `--help` и поиск ровно в одном файле.

### 2. `backslash.rs`: экранирование и синтаксис

- На `PreToolUse` (`Bash`, `PowerShell`, `Write`, Antigravity `run_command`/`write_file`) проверяет inline-вызовы, `sed -i`, bash heredoc, PowerShell here-string и одноразовые patch-скрипты с `\`, где shell или парсер аргументов искажает последовательности. У каждого интерпретатора свои флаги «дальше идёт код» (`node -e/-p/--eval`, `python -c`, `perl -e`, `ruby -e`, `php -r`, `bash -c`, `pwsh -Command`), поэтому `node -c file` или `bash -e script` с путём Windows за inline-код не принимаются. `printf`/`echo`/`awk` блокируются, только когда пишут в файл: `>` внутри кавычек — текст, `2>` — stderr.
- На `PostToolUse` (Claude Code `Edit|Write`, DeepSeek Harness `write|edit`) проверяет `.json` через `serde_json` (пропуская JSONC в `tsconfig*`, `jsconfig*`, `.eslintrc*`, `devcontainer.json`, `.code-workspace`, `.vscode/` и `.devcontainer/`), `.js/.mjs/.cjs` через `node --check` и `.py` через `python -I` с `ast.parse`.

### 3. `check.rs`: сжатый вывод проверок (`ctxkit check <cmd>`)

- Для `cargo check`, `cargo clippy` и `cargo build` добавляет `--message-format=json --quiet`, убирает дубликаты и каскад, оставляя до `3` уникальных первопричин (`file:line:col [code] - message (label)`).
- Для остальных команд (`tsc`, `npm run typecheck`, `npm test`, `node --test`, `pytest`, `go test`) при успехе печатает `OK (<ms>)` с краткой сводкой числа тестов, а при ошибке выводит до `30` ключевых строк и сохраняет полный вывод в `%TEMP%/last-check.log` (`/tmp/last-check.log` на Unix).

### 4. `setup.rs`: автонастройка и диагностика (`ctxkit setup`)

- Перед изменением любого файла (`settings.json`, `CLAUDE.md`, `ccd-session-presets.json`, `hooks.json`) создаётся бэкап `backups/<name>.<unix_ts>.bak` (только при реальной разнице содержимого).
- Используется merge вместо перезаписи: сохраняются `env`, `permissions`, `enabledPlugins` и сторонние хуки; заменяются только `no-inline-backslash`, прежние хуки `claude-guard` и блоки между маркерами `<!-- claude-guard:start/end -->` или `<!-- ctxkit:start/end -->`.
- Ключ `--dry-run` показывает все планируемые изменения без записи на диск.
- Самодиагностика проверяет версию `claude` (`< 2.1.321` при включённом `fable`), количество активных глобальных плагинов (`> 8`), размер `CLAUDE.md` (`> 200` строк или `> 8 KB`) и число глобальных MCP в `~/.claude.json` (`> 2`). При ключе `--antigravity` дополнительно проверяет модель `agy` CLI, включённые плагины в `~/.gemini/config/plugins/` (`> 6`), активные MCP в `mcp_config.json` и плагинах (`> 4`), а также размер файлов правил плагинов (лимит `24 KB`).

## Контракты протоколов хуков

| Параметр | Claude Code | Antigravity |
|---|---|---|
| Конфиг | `~/.claude/settings.json` | `~/.gemini/config/hooks.json` (или `.agents/hooks.json`) |
| Инструменты | `Read`, `Write`, `Edit`, `Bash`, `PowerShell` | `read_file`, `write_file`, `run_command` |
| Блокировка `PreToolUse` | `hookSpecificOutput.permissionDecision = "deny"` | `{"decision": "deny", "reason": "..."}` |
| Пропуск `PreToolUse` | Пустой `stdout` | `{"decision": "ask"}` |
| `PostToolUse` | Проверка синтаксиса и `{"decision": "block"}` | Только `{}` (блокировка после записи не поддерживается) |

В контракте Antigravity значение `"decision": "allow"` автоматически одобряет вызов инструмента в обход политики подтверждений пользователя. Поэтому при успешной проверке `ctxkit` всегда возвращает `{"decision": "ask"}`, передавая финальное решение встроенной политике безопасности.

### DeepSeek Harness Desktop

Своего конфига хуков у DeepSeek Harness нет: плагин `@deepseek-ai/dsh-hooks-claude-code` исполняет `hooks.json` формата Claude Code на точках `tools/pre-execute` и `tools/post-execute`. Входной JSON и допустимые ответы совпадают с колонкой Claude Code выше, поэтому `ctxkit` использует тот же обработчик; отличаются только имена инструментов (`read`, `write`, `edit`, `bash`, `pwsh`), и подсказки в отказах называют их, а не `Grep`/`Explore`. Клиент выбирается флагом `--dsh` или определяется по `tool_name` в нижнем регистре.

`ctxkit setup --dsh` записывает `~/.dsh/ctxkit-hooks.json` (`PreToolUse`: `read|write|bash|pwsh`, `PostToolUse`: `write|edit`) и добавляет в `~/.dsh/profiles/desktop/cordis.patch.yml` запись `insert` (`id: ctxkit-hooks`) между своими маркерами, не трогая остальные. Команда хука пишется под shell, которым её запускает harness (`pwsh -Command` в Windows, `bash -c` в остальных ОС). Пакет моста не входит в поставку приложения, а конфиг читается один раз при старте, поэтому setup предупреждает, если пакета нет в `node_modules` профиля, и после любой из правок приложение нужно перезапустить.

## Локализация (`CTXKIT_LANG`)

Ответы хуков (`guard.rs`, `backslash.rs`, `PostToolUse` в `main.rs`) по умолчанию выводятся на английском (`en`) и переключаются на русский через `CTXKIT_LANG=ru` или `--lang ru`. При запуске `ctxkit setup --lang ru` переменная `CTXKIT_LANG=ru` записывается в секцию `env` файла `settings.json`, а при `--antigravity` флаг `--lang ru` добавляется к команде в `hooks.json`.

## Проекция `toMcp` для своих MCP-серверов

В собственных MCP-серверах стоит разделять ответы для UI и для агента через проекцию `toMcp`. Веб-интерфейс и REST API продолжают получать полные объекты с историей, кнопками действий и вложенными списками, а MCP-инструмент отдаёт компактный JSON без форматирования, вырезает UI-поля и сворачивает длинные списки в счётчик `count` плюс первые несколько проблемных элементов с `id` для точечного запроса.
