# TODO

## Шлюз Stop (ctxkit)

Что сделано и как проверено: `docs/CONCEPT.md`, §10.8 (там же принятые ограничения шлюза).

- [ ] Сравнить вызовы advisor и `checker` по дням (`ctxkit report`) не раньше 22.11.2026 (неделя после установки шлюза 15.11). Базовая линия до шлюза: 14.11 — 3 и 3, 15.11 — 37 и 20 (при 2645 ходах Sonnet за 15.11).

## Хвосты аудита (ponytail), 16.11

Найдено при ревью и аудите, в этот заход не берётся. Номера строк даны на 16.11.

- [ ] Бэкапы и корзина Loadout хранят конфиги целиком, открытым текстом, вместе с секретами в `env` MCP, и не чистятся: `crates/loadout-core/src/write.rs:1148`, `crates/loadout-core/src/trash.rs:13`, `trash.rs:65-77`, `app/package.json:41` (`deleteAppDataOnUninstall: false`). `manifests()` читает все операции подряд.
- [ ] `ctxkit setup` пишет чужие файлы не атомарно: `fs::write` поверх `settings.json`, `CLAUDE.md`, `hooks.json`, `ccd-session-presets.json` (`crates/ctxkit/src/setup.rs`). `serde_json` без `preserve_order` пересортировывает ключи чужих файлов; признак общий на воркспейс, нужен отдельный прогон `cargo test` ядра.
- [ ] Битый `profiles.json` превращается в «профилей нет», и следующее сохранение его затирает: `crates/loadout-core/src/profiles.rs:35-41`, `profiles.rs:86-91`.
- [ ] Нет `requestSingleInstanceLock` (`app/src/main/index.ts:350`); временный файл `.loadout.tmp` без pid в имени.
- [ ] Нет повторной сверки sha перед `rename` в commit и rollback: `crates/loadout-core/src/write.rs:1152-1190`, `write.rs:1603-1638`.
- [ ] `ctxkit check` запускает команду через `cmd.exe /d /c` и ломает аргументы с `&`, `|`, `%`, `^`: `crates/ctxkit/src/check.rs:30-35`.
- [ ] `install.ps1` перезаписывает пользовательский `PATH` раскрытыми значениями: `crates/ctxkit/scripts/install.ps1:27-31`.
- [ ] Нет тестов на IPC-ворота главного процесса (`validateIntent`, `trusted`): `app/src/main/index.ts:260-310`.
- [ ] Дубли: разворот `~` (`crates/loadout-core/src/write.rs:107-118` и `crates/loadout-core/src/lib.rs:42-54`) и поиск домашнего каталога (`crates/loadoutd/src/main.rs`).
- [ ] Логи `last-check-*.log` в TEMP не чистятся: `crates/ctxkit/src/check.rs:240-252`.
- [ ] `PostToolUse` блокирует `.json` с комментариями (`turbo.json`, `biome.json`): `crates/ctxkit/src/backslash.rs:412-430`.
- [ ] Шлюз Stop при `--advisor none` без `checker` всё равно просит вызвать «их»: `crates/ctxkit/src/gate.rs:130-146`.
- [ ] Таблица алиасов `canonical_model_id` устареет (`crates/ctxkit/src/setup.rs`, около строки 540); `doctor` не замечает отсутствия `modelSettings` для основной модели.
- [ ] Кнопка отката ctxkit в окне Loadout (следующий шаг после `ctxkit setup --uninstall`).
- [ ] Сравнение advisor и `checker` по дням не раньше 22.11.2026 (остаётся как есть, см. раздел про шлюз Stop выше).
- [ ] Команда хука из `ctxkit setup` (`"C:/…/ctxkit.exe"`) состоит из одной строки в кавычках: на Windows без Git Bash PowerShell её печатает, а не запускает, а упавший хук `PreToolUse` без `onFailure` может блокировать вызов (docs хуков). Проверить на настоящем Claude Code и решить: форма exec (`command` + `args`) или `"shell": "powershell"` с `& `, либо `"onFailure": "continue"` (нужен Claude Code 2.1.295+).
- [ ] Живой прогон таблицы «сценарий → блокирует ли» (раздел «Безопасный отказ» в README ctxkit) через `claude -p --settings`: не выполнен 16.11, у CLI `claude` истёк OAuth-сеанс. Повторить на машине с входом.
