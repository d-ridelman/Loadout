<p align="center">
  <img src="assets/cover.jpg" alt="ctxkit: Surgical Context & Token Toolkit" width="100%" />
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>Русский</strong>
</p>

<p align="center">
  <a href="#быстрый-старт">Быстрый старт</a> ·
  <a href="#что-делает-ctxkit">Модули</a> ·
  <a href="#флаги-setup">Флаги <code>setup</code></a> ·
  <a href="docs/ARCHITECTURE.ru.md">Архитектура</a> ·
  <a href="docs/RESEARCH.ru.md">Исследование (30 сессий)</a>
</p>

Нативный бинарник на Rust для **Claude Code**, **Claude Desktop**, **Antigravity** и **DeepSeek Harness Desktop**. Режет лишнее раздутие контекста на чтении файлов и логах сборок, защищает обратные слеши в shell-командах и одной командой настраивает экономичную схему моделей.

Написан на Rust ради холодного старта за `9-14 ms` без запуска Node или Python на каждый хук. Подходит для **любых стеков** (TypeScript/JS, Python, Go, Rust, конфиги): в реальном аудите 30 сессий `60.5%` входящего мусора давали именно чтения больших `.ts`, `.js`, `.py` и `.md` файлов и вывод grep через консоль.

## Почему сгорают лимиты

По замеру 30 реальных сессий (`26 256` ходов, подробнее в [исследовании](docs/RESEARCH.ru.md)):

| Утечка в базовой настройке | Что делает `ctxkit` |
|---|---|
| `95.3%` ходов шли на `Opus` / `Fable` (включая Desktop-пресеты и поиск) | `ctxkit setup --main-model sonnet --advisor fable` переводит рутину на `Sonnet`, оставляя `Fable` на редкие консультации; setup добавляет также поиск на `Haiku` (`Explore`) и `Opus` для `checker` |
| `60.5%` `tool_result` уходило на загрузку длинных файлов и нефильтрованный `rg`/`cat` | `PreToolUse`-хук пропускает только чтения диапазонами (до `450` строк), направляя в `Grep`/`LSP` или `Explore` |
| `11.2%` занимали простыни компиляторов и тестов | `ctxkit check <cmd>` при успехе возвращает `OK (<ms>)`, при ошибке выделяет первопричины |
| Ошибки экранирования `\` в однострочниках давали холостые циклы перезаписи | Перехватывает `\` в `node -e`, `python -c`, heredoc и here-string до выполнения, а на `PostToolUse` проверяет синтаксис |

## Быстрый старт

**Зависимости:** [Rust / Cargo](https://rustup.rs/) для сборки из исходников, [Node.js](https://nodejs.org/) для тестов `tests/guard.test.mjs`, аудита сессий и синтаксической проверки `.js` в `PostToolUse`, а также Python 3 (опционально, для проверки `.py`).

### Windows (PowerShell)

```powershell
git clone https://github.com/d-ridelman/Loadout.git
cd Loadout/crates/ctxkit
.\scripts\install.ps1

# Скрипт добавит %USERPROFILE%\.local\bin в User PATH; для текущего окна укажи путь явно:
& "$env:USERPROFILE\.local\bin\ctxkit.exe" setup --lang ru --dry-run
& "$env:USERPROFILE\.local\bin\ctxkit.exe" setup --lang ru --with-rules --desktop --antigravity
```

### macOS и Linux

```bash
git clone https://github.com/d-ridelman/Loadout.git
cd Loadout/crates/ctxkit
./scripts/install.sh

~/.local/bin/ctxkit setup --lang ru --dry-run
~/.local/bin/ctxkit setup --lang ru --with-rules
```

Перед изменением `settings.json`, `CLAUDE.md`, `ccd-session-presets.json` или `hooks.json` создаётся резервная копия `backups/<имя>.<timestamp>.bak`. Пользовательские `env`, права доступа, плагины и сторонние хуки сохраняются; старые хуки `claude-guard` и `no-inline-backslash` автоматически заменяются на `ctxkit`.

## Что делает `ctxkit`

```text
  PreToolUse / PostToolUse              CLI
  ────────────────────────              ───
  Claude Code, Antigravity, DSH         ctxkit setup   ──▶  модели, агенты, хуки, диагностика
        │                               ctxkit check   ──▶  сжатие tsc / pytest / go test / cargo
        ├──▶ guard.rs      (< 15 ms, блокирует чтение целиком > 28 KB / > 450 строк и широкий grep)
        └──▶ backslash.rs  (ловит потерю \ до вызова и проверяет .json/.js/.py после записи)
```

| Модуль | Назначение | Ключевые детали |
|---|---|---|
| `guard.rs` | Защита чтения и поиска | Блокирует целиком файлы крупнее `28 KB` / `450` строк (и `> 250 KB` без диапазона) в `Read`, `read_file` и `read` (DSH), не трогая изображения, видео, аудио и PDF. Чтение хвоста от смещения проходит, только если остаток укладывается в оба порога. Останавливает голые `cat`, `Get-Content` и широкий `grep -r`/`rg` без фильтров (поиск в одном названном файле разрешён), не мешая пайпам и `&&`. |
| `backslash.rs` | Контроль `\` и синтаксиса | На `PreToolUse` ловит `\` в inline-коде (`node -e`, `python -c`, `perl -e`, `php -r`, `bash -c`), `sed -i`, heredoc, here-string и patch-скриптах; флаги проверки синтаксиса вроде `node -c` не трогает. На `PostToolUse` проверяет `.json` (с исключением для JSONC вроде `tsconfig`, `.vscode/` и `.devcontainer/`), `.js/.mjs/.cjs` (`node --check`) и `.py` (`ast.parse`). |
| `check.rs` | Сжатие логов (`ctxkit check`) | Для `cargo check`/`clippy`/`build` читает JSON-вывод и выводит до 3 уникальных первопричин `file:line:col`. Для `tsc`, `npm test`, `node --test`, `pytest`, `go test` при успехе даёт `OK (<ms>)`, при ошибке до 30 строк и полный лог в `%TEMP%/last-check.log` (`/tmp/last-check.log` на Unix). |
| `setup.rs` | Автонастройка (`ctxkit setup`) | Подключает хуки, создаёт `Explore.md` (`haiku`) и `checker.md` (`opus`), с `--with-rules` добавляет блок правил, диагностирует CLI (`< 2.1.321`), плагины, `CLAUDE.md`, глобальные MCP и конфиги Antigravity. Модель, советник и effort ставятся **только флагами** `--main-model`, `--advisor`, `--effort` (прежняя схема: `ctxkit setup --main-model sonnet --advisor fable --effort high`); `CLAUDE_CODE_SUBAGENT_MODEL` пишется только при `--subagent`. Каждый запуск, в том числе с `--dry-run`, печатает «было -> стало» (или «kept») по каждой настройке. |

## Флаги `setup`

`setup` сам не меняет твой выбор моделей: `model`, `advisorModel` и effort пишутся, только когда передан флаг, иначе остаются как есть (отсутствующий ключ остаётся отсутствующим), а в выводе стоит строка вида `model: opus (kept; pass --main-model sonnet to set)`. Для схемы, под которую настроен ctxkit (советник `fable` и основная `claude-sonnet-5-5`), запусти `ctxkit setup --main-model sonnet --advisor fable --effort high`. Окно Loadout передаёт `--advisor`, только если советник выбран в форме (по умолчанию «не менять»), и никогда не передаёт `--main-model` и `--effort`.

| Флаг | Назначение |
|---|---|
| `--dry-run` | Показать план правок и диагностику без записи на диск |
| `--profile <dir>` | Выбрать отдельный профиль (например, `~/.claude-work`) |
| `--main-model <name>` | Записать `model` (например, `sonnet`) |
| `--advisor <name>` | Записать `advisorModel` (`fable`, `opus`, либо `none`, чтобы убрать) |
| `--effort <level>` | Записать effort: `modelSettings.<модель>.effortLevel` для `--main-model` или твоей `model` (известная модель, `low`/`medium`/`high`/`xhigh`), верхнеуровневый `effortLevel` и effort пресетов Desktop при `--desktop` |
| `--desktop` | Записать `modelId` (`--desktop-model`) в пресеты Claude Desktop (`ccd-session-presets.json`); effort пресета меняется только с `--effort`. Запускать при полностью закрытом Claude Desktop, включая значок в трее: открытое приложение держит пресеты в памяти и перезаписывает файл, поэтому setup в этом случае ничего не пишет и предупреждает |
| `--desktop-model <id>` | Идентификатор модели в пресетах Desktop (по умолчанию `claude-sonnet-5-5`) |
| `--antigravity` | Зарегистрировать `ctxkit` в `~/.gemini/config/hooks.json` и проверить MCP, плагины и модель `agy` CLI |
| `--dsh` | Записать `~/.dsh/ctxkit-hooks.json` и подключить к нему мост `@deepseek-ai/dsh-hooks-claude-code` в профиле `desktop` DeepSeek Harness (`--dsh-home <path>` заменяет `~/.dsh`); если пакета моста нет, выводит точную команду `pnpm add` |
| `--with-rules` | Добавить в `CLAUDE.md` блок правил (включая триггер `/advisor` и `/clear`) между маркерами `ctxkit` |
| `--force-agents` | Перезаписать уже существующие `Explore.md` и `checker.md` |
| `--no-stop-gate` | Не подключать шлюз Stop и убрать наш, если он есть. По умолчанию `setup` добавляет хук `Stop`: если за ход правились два и более файла с кодом (или сделано пять и более правок), а после последней не вызван ни `checker`, ни advisor, модель один раз возвращается к работе. Два раза подряд не срабатывает; `CTXKIT_GATE=0` отключает на сессию |
| `--lang <en\|ru>` | Язык шаблонов и хуков (`en` по умолчанию; при `ru` пишет `CTXKIT_LANG=ru` в `settings.json` и `--lang ru` в `hooks.json`) |

Язык сообщений самих хуков задаётся переменной `CTXKIT_LANG` (`en` по умолчанию, `ru` для русского) или флагом `--lang`. Полная справка вызывается через `ctxkit setup --help`. В [`examples/`](examples/) лежат шаблоны конфигов с POSIX-заглушками путей; для реальной установки надёжнее запускать `ctxkit setup`, который подставляет точный абсолютный путь под вашу ОС.

## Как откатить

```powershell
ctxkit setup --uninstall --dry-run     # что будет убрано
ctxkit setup --uninstall               # убрать (с теми же --profile / --antigravity / --dsh, что были у setup)
```

`--uninstall` убирает только то, что добавил `ctxkit setup`: наши элементы в хуках `PreToolUse` / `PostToolUse` / `Stop` в `settings.json` (хук наш, если его команда запускает файл `ctxkit`, `claude-guard` или `no-inline-backslash`: первое слово либо второе после `node`/`bun`/`deno`/`npx`/`python`; поэтому `node C:/x/no-inline-backslash.mjs` наш, а `node C:/tools/ctxkit-helper/stop.js` и `logger.exe ctxkit` нет; чужие хуки, в том числе из той же группы, остаются; хук, который вы написали сами и который вызывает `ctxkit`, например `ctxkit report` в хуке Stop, тоже считается нашим, так что держите такие команды в скрипте с другим именем), `env.CTXKIT_LANG`, блок правил между маркерами `ctxkit` в `CLAUDE.md` и свой бинарь `hooks/ctxkit` (последним, чтобы не осталось хука на несуществующий файл). С `--antigravity` / `--agy-file` убирает запись `ctxkit` из `hooks.json`; с `--dsh` / `--dsh-home` убирает `ctxkit-hooks.json`, блок ctxkit в `cordis.patch.yml` и блок правил в `AGENTS.md`. Перед каждой записью делается бэкап; повторный запуск ничего не меняет. `~/.local/bin/ctxkit` удаляется, только если это побайтовая копия текущего бинаря или `hooks/ctxkit`, иначе печатается путь. Если запущенный бинарь не может удалить сам себя (Windows), он печатает `удалите вручную: <путь>` и всё равно завершается с кодом `0`.

Откат **не трогает** `model`, `advisorModel`, `effortLevel`, `modelSettings`, `env.CLAUDE_CODE_SUBAGENT_MODEL`, пресеты Claude Desktop и файлы агентов `Explore.md` / `checker.md`: прежние значения неизвестны, а в `modelSettings` бывают записи самого Claude Code. Он печатает их текущие значения и пути к последнему и самому раннему `backups/settings.json.*.bak` (самый ранний, скорее всего, хранит состояние до первого setup), чтобы вернуть старое вручную. Опции, нужные только для установки (`--no-agents`, `--effort`, `--main-model` и т. д.), вместе с `--uninstall` отвергаются.

## Безопасный отказ

Хук не должен мешать работе. В режиме хука `ctxkit` при любом сбое завершается с кодом `0` и пустым stdout (вызов идёт дальше): пустой или битый JSON, нет полей или они не того типа, неизвестное событие, нет транскрипта для шлюза Stop, ввод больше 64 МиБ, не-UTF-8, даже паника. Блокирует только осознанное срабатывание правила (`deny` для `PreToolUse`, `block` для `PostToolUse` / `Stop`); с кодом `2` не выходит никогда. `ctxkit setup` пишет `"timeout": 10` у каждого добавленного хука (Claude Code, Antigravity, DeepSeek Harness).

Аварийные выключатели: `CTXKIT_GUARD=0` заставляет хуки `PreToolUse` / `PostToolUse` сразу выходить без вывода; `CTXKIT_GATE=0` делает то же для шлюза Stop. Задавай в окружении сессии (например, `CTXKIT_GUARD=0 claude`). Убрать хуки совсем: «Как откатить».

Что делает сам Claude Code, когда хук ведёт себя плохо (справочник по хукам, https://code.claude.com/docs/en/hooks, прочитан 2026-11-16; это документация, а не наш прогон — см. примечание под таблицей):

| Сценарий | Блокирует ли вызов инструмента | Документация Claude Code |
|---|---|---|
| Бинарь хука не найден / не запускается | Нет, неблокирующая ошибка, вызов идёт дальше | "Non-blocking error: your hook exits with any other code, or fails in some other way, such as not starting or printing invalid JSON. The action goes ahead"; "Without onFailure set, the same missing script is a non-blocking error and ls runs." |
| Код выхода `1` (или любой, кроме `0` / `2`) | Нет | "Exit code 1 without valid JSON output is a non-blocking error unless the hook is one whose failure blocks the action, even though 1 is the conventional Unix failure code." |
| Код выхода `2` | Да, на `PreToolUse` вызов блокируется, причина берётся из stderr | "Blocking error: your hook exits 2. On events that can block, Claude Code stops the action." |
| Таймаут | На `PreToolUse` нет | "On PreToolUse, a timed-out command, http, or mcp_tool hook doesn't block the tool call, except for hooks whose failure blocks the action. The call continues through the normal permission flow, so don't count on a stalled hook to act as a gate." |
| Любой сбой при `"onFailure": "block"` у хука (v2.1.295+, включается явно) | Да | "With "block" set, a failure does what exit code 2 does on that event" |
| Windows без Git Bash, `PreToolUse`-хук в shell-форме, `onFailure` не задан | Может блокировать | "On Windows without Git Bash, a shell-form PreToolUse or PermissionRequest command hook that fails with onFailure unset can instead block the tool call." |

Две находки. Во-первых, неверный путь к хуку работу не останавливает (его показывает находка `hooks` уровня `error` в `doctor`: «хук указывает на несуществующий бинарь»); цена в том, что защита молча перестаёт работать. Во-вторых, строка про Windows без Git Bash: команда хука, которую пишет `ctxkit setup` (`"C:/…/ctxkit.exe"`), состоит только из строки в кавычках, и по документации PowerShell её печатает, а не запускает («PowerShell started no program»; лечится `"shell": "powershell"` и `& ` перед путём в кавычках либо формой exec). На такой машине защита не работает, а упавший хук может блокировать вызовы. `ctxkit setup` форму команды для этого случая пока не меняет: поставь Git for Windows (обычная схема Claude Code на Windows) или примени исправление из документации вручную.

Примечание о проверке: живой прогон этих сценариев через `claude -p --settings <файл>` (несуществующий exe, хук, который спит дольше `timeout: 2`, код 1, код 2) на машине автора выполнить не удалось: у CLI `claude` истёк OAuth-сеанс. Таблица опирается на документацию; перед тем как на неё полагаться, повтори прогон на машине с выполненным входом.

## Диагностика и отчёт (`doctor`, `report`)

```powershell
ctxkit doctor [--json] [--profile <dir>] [--lang ru]   # почему не вызываются субагенты: хук, модель, агенты, блок правил в CLAUDE.md
ctxkit report [--json] [--days 14] [--profile <dir>]   # по дням: ходы по моделям, вызовы субагентов и advisor, объём tool_result
```

`doctor` возвращает `1`, только если есть находка `error` (например, хук указывает на удалённый бинарь). Без блока правил (`ctxkit setup --with-rules`) модели нигде не сказано, когда звать `Explore`, `checker` и advisor. Тогда она обычно их не зовёт. `report` читает транскрипты `<профиль>/projects`, отдаёт только счётчики (без текста, путей и вывода инструментов), дни считает по UTC. JSON обоих команд имеет `"schema": 1` и предназначен для оболочек вроде Loadout.

## Тесты и аудит своих сессий

```powershell
cargo test
cargo build --release
node tests/guard.test.mjs
```

Проверить распределение моделей и размер ответов инструментов по вашим локальным транскриптам Claude Code:

```powershell
node scripts/audit-sessions.mjs 30
```

## Материалы проекта

- [docs/ARCHITECTURE.ru.md](docs/ARCHITECTURE.ru.md) ([English](docs/ARCHITECTURE.md)) описание модулей, контрактов Claude Code и Antigravity (`"ask"` вместо `"allow"`), моста DeepSeek Harness, паттерна `toMcp`.
- [docs/RESEARCH.ru.md](docs/RESEARCH.ru.md) ([English](docs/RESEARCH.md)) разбор рекомендаций Anthropic и `@0xCodila`, проверка идей из Gemini-чата, полные таблицы по 30 сессиям и 5 скрытых утечек в конфигах.
