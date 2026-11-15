# Loadout

Один экран вместо пяти конфигов: Loadout показывает и меняет плагины, MCP-серверы, скилы, агентов, хуки и команды сразу у пяти клиентов — Claude Code, Claude Desktop, Codex, Antigravity и DeepSeek Harness. Запись идёт точечно и безопасно: предпросмотр, хеш-блокировка, бэкап, журнал, откат.

Внутри два продукта в одном Cargo-воркспейсе:

| Каталог | Что это |
|---|---|
| `app/` | Приложение Loadout (Electron + React, Windows) |
| `crates/loadout-core`, `crates/loadoutd` | Ядро на Rust: скан, запись, сторож файлов, процесс-ядро для приложения |
| `crates/ctxkit` | [ctxkit](crates/ctxkit/README.md): набор хуков и диагностики, который экономит контекст и токены Claude Code и других клиентов. Встроен в приложение (раздел «ctxkit»), но ставится и отдельно |
| `docs/CONCEPT.md` | Концепция, решения, итоги этапов и аудитов |

## Сборка и проверки

```bash
cargo build --release          # ядро и ctxkit (бинари в target/release)
cargo test                     # тесты Rust
cd app && npm install
npm run e2e                    # сборка и сценарии в окне
npm run dist                   # установщик (NSIS, без подписи)
```

`ctxkit.exe` для приложения берётся из `crates/ctxkit` (`npm run bundle:ctxkit`).

## Лицензии

`crates/ctxkit` — MIT (см. `crates/ctxkit/LICENSE`). Остальное — пока без лицензии (все права сохранены).
