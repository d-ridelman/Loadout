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
   └─ иначе                    ──▶ Claude Code hook     (PreToolUse / PostToolUse)
```

### 1. `guard.rs`: ограничение чтения и широкого поиска

- Контроль `Read` (Claude Code) и `read_file` (Antigravity) опирается на пороги `MAX_READ_BYTES = 28_000`, `MAX_READ_LINES = 450` и `MAX_HUGE_BYTES = 250_000`. Чтение диапазоном (`limit <= 450` или `EndLine - StartLine + 1 <= 450`), а также изображения, видео, аудио и PDF пропускаются без задержки. Попытка загрузить большой текстовый файл целиком отклоняется с подсказкой искать нужное место через `Grep`/LSP или делегировать чтение субагенту `Explore`.
- Контроль `shell_read_guard` блокирует прямые `cat` (`> 12 KB` или `> 200` строк), PowerShell `Get-Content` / `gc` / `type` и нефильтрованный рекурсивный `grep -r` / `rg`. Команды с конвейерами (`|`), перенаправлениями (`>`), `&&`, `;`, heredoc и флагами `-l`, `-c`, `-m` не затрагиваются.

### 2. `backslash.rs`: экранирование и синтаксис

- На `PreToolUse` (`Bash`, `PowerShell`, `Write`, Antigravity `run_command`/`write_file`) проверяет inline-вызовы (`node -e`, `python -c`, `sed -i`), bash heredoc, PowerShell here-string и одноразовые patch-скрипты с `\`, где shell или парсер аргументов искажает последовательности.
- На `PostToolUse` (Claude Code `Edit|Write`) проверяет `.json` через `serde_json` (пропуская JSONC в `tsconfig*`, `jsconfig*`, `.eslintrc*`, `.code-workspace` и `.vscode/`), `.js/.mjs/.cjs` через `node --check` и `.py` через `python -I` с `ast.parse`.

### 3. `check.rs`: сжатый вывод проверок (`ctxkit check <cmd>`)

- Для `cargo check`, `cargo clippy` и `cargo build` добавляет `--message-format=json --quiet`, убирает дубликаты и каскад, оставляя до `3` уникальных первопричин (`file:line:col [code] - message (label)`).
- Для остальных команд (`tsc`, `npm run typecheck`, `npm test`, `node --test`, `pytest`, `go test`) при успехе печатает `OK (<ms>)` с краткой сводкой числа тестов, а при ошибке выводит до `30` ключевых строк и сохраняет полный вывод в `%TEMP%/last-check.log` (`/tmp/last-check.log` на Unix).

### 4. `setup.rs`: автонастройка и диагностика (`ctxkit setup`)

- Перед изменением любого файла (`settings.json`, `CLAUDE.md`, `ccd-session-presets.json`, `hooks.json`) создаётся бэкап `backups/<name>.<unix_ts>.bak` (только при реальной разнице содержимого).
- Используется merge вместо перезаписи: сохраняются `env`, `permissions`, `enabledPlugins` и сторонние хуки; заменяются только `no-inline-backslash`, прежние хуки `claude-guard` и блоки между маркерами `<!-- claude-guard:start/end -->` или `<!-- ctxkit:start/end -->`.
- Ключ `--dry-run` показывает все планируемые изменения без записи на диск.
- Самодиагностика проверяет версию `claude` (`< 2.1.321` при включённом `fable`), количество активных глобальных плагинов (`> 8`), размер `CLAUDE.md` (`> 200` строк или `> 8 KB`) и число глобальных MCP в `~/.claude.json` (`> 2`).

## Контракты протоколов хуков

| Параметр | Claude Code | Antigravity |
|---|---|---|
| Конфиг | `~/.claude/settings.json` | `~/.gemini/config/hooks.json` (или `.agents/hooks.json`) |
| Инструменты | `Read`, `Write`, `Edit`, `Bash`, `PowerShell` | `read_file`, `write_file`, `run_command` |
| Блокировка `PreToolUse` | `hookSpecificOutput.permissionDecision = "deny"` | `{"decision": "deny", "reason": "..."}` |
| Пропуск `PreToolUse` | Пустой `stdout` | `{"decision": "ask"}` |
| `PostToolUse` | Проверка синтаксиса и `{"decision": "block"}` | Только `{}` (блокировка после записи не поддерживается) |

В контракте Antigravity значение `"decision": "allow"` автоматически одобряет вызов инструмента в обход политики подтверждений пользователя. Поэтому при успешной проверке `ctxkit` всегда возвращает `{"decision": "ask"}`, передавая финальное решение встроенной политике безопасности.

## Локализация (`CTXKIT_LANG`)

Ответы хуков (`guard.rs`, `backslash.rs`, `PostToolUse` в `main.rs`) по умолчанию выводятся на английском (`en`) и переключаются на русский через `CTXKIT_LANG=ru` или `--lang ru`. При запуске `ctxkit setup --lang ru` переменная `CTXKIT_LANG=ru` записывается в секцию `env` файла `settings.json`.

## Проекция `toMcp` для своих MCP-серверов

В собственных MCP-серверах стоит разделять ответы для UI и для агента через проекцию `toMcp`. Веб-интерфейс и REST API продолжают получать полные объекты с историей, кнопками действий и вложенными списками, а MCP-инструмент отдаёт компактный JSON без форматирования, вырезает UI-поля и сворачивает длинные списки в счётчик `count` плюс первые несколько проблемных элементов с `id` для точечного запроса.
