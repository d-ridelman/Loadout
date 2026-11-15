//! Адаптер Claude Code (CLI и вкладка Code в Claude Desktop). Источники — таблица §2 CONCEPT.md.

use crate::mask::{self, mcp_detail};
use crate::model::{Client, Entity, Format, Kind, State, Target};
use crate::{esc_ptr, frontmatter, scan_hooks, scan_skills, Ctx};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;

const CLIENT: Client = Client::ClaudeCode;
/// Ключи верхнего уровня `~/.claude.json`, где лежат «выключенные» MCP (стэш владельца, не штатный механизм Claude Code).
const STASH_KEYS: [&str; 2] = ["_disabledMcpServers", "_mcpServersDisabled"];

pub fn scan(c: &mut Ctx) {
    let settings = c.read_json(&c.home.join(".claude/settings.json"));
    plugins(c, settings.as_ref());
    marketplaces(c);
    let connectors_off = settings
        .as_ref()
        .and_then(|s| s.get("disableClaudeAiConnectors"))
        .and_then(Value::as_bool)
        == Some(true);
    // `deniedMcpServers`: `[{serverName | serverCommand | serverUrl: …}]`, действует из любого файла настроек
    // (документация Claude Code, managed-mcp.md). Сопоставляем только по `serverName`: так же называются
    // коннекторы claude.ai (`claude.ai Slack`). По команде и URL M1 не сопоставляет.
    let denied: HashSet<String> = settings
        .as_ref()
        .and_then(|s| s.get("deniedMcpServers"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| e.get("serverName").and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    mcp(c, connectors_off, &denied);
    let skills = c.home.join(".claude/skills");
    scan_skills(c, CLIENT, &skills, "user");
    md_dir(c, "agents", Kind::Agent);
    md_dir(c, "commands", Kind::Command);
    if let Some(h) = settings.as_ref().and_then(|s| s.get("hooks")) {
        scan_hooks(c, CLIENT, "~/.claude/settings.json", "/hooks", "user", h);
    }
}

/// Булев ключ в `~/.claude/settings.json` (цель записи R1).
fn settings_flag(c: &Ctx, path: &[&str]) -> Target {
    Target {
        file: c.home.join(".claude/settings.json"),
        format: Format::Json,
        path: path.iter().map(|s| (*s).to_owned()).collect(),
        inverted: false,
    }
}

fn plugins(c: &mut Ctx, settings: Option<&Value>) {
    let file = "~/.claude/plugins/installed_plugins.json";
    let installed = c.read_json(&c.home.join(".claude/plugins/installed_plugins.json"));
    let enabled = settings
        .and_then(|s| s.get("enabledPlugins"))
        .and_then(Value::as_object);
    let mut seen = HashSet::new();

    let records = installed
        .as_ref()
        .and_then(|v| v.get("plugins"))
        .and_then(Value::as_object);
    for (key, recs) in records.into_iter().flatten() {
        seen.insert(key.clone());
        let recs = recs.as_array().map(Vec::as_slice).unwrap_or_default();
        let is_user_rec = |r: &Value| {
            r.get("scope")
                .and_then(Value::as_str)
                .is_none_or(|s| s == "user")
        };
        fn version_of(r: &Value) -> Option<&str> {
            r.get("version").and_then(Value::as_str)
        }
        // Разные версии в одной области — расхождение (stale). В разных областях это норма, только пометка.
        let user_versions: HashSet<&str> = recs
            .iter()
            .filter(|r| is_user_rec(r))
            .filter_map(version_of)
            .collect();
        let all_versions: HashSet<&str> = recs.iter().filter_map(version_of).collect();
        for (i, r) in recs.iter().enumerate() {
            let scope = match r.get("scope").and_then(Value::as_str) {
                Some("project") => format!(
                    "project:{}",
                    c.tilde(Path::new(
                        r.get("projectPath").and_then(Value::as_str).unwrap_or("?")
                    ))
                ),
                Some(s @ ("user" | "local" | "managed" | "enterprise")) => s.to_owned(),
                Some(_) => "other".to_owned(), // неизвестное значение из файла в вывод не пускаем
                None => "user".to_owned(),
            };
            let is_user = scope == "user";
            let path_ok = r
                .get("installPath")
                .and_then(Value::as_str)
                .is_some_and(|p| Path::new(p).exists());
            let flag = enabled.and_then(|m| m.get(key)).and_then(Value::as_bool);
            let (state, note) = if !path_ok {
                (
                    State::Broken,
                    Some("installPath не существует на диске".to_owned()),
                )
            } else if !is_user {
                (
                    State::Unknown,
                    Some(format!(
                        "флаг включения лежит в настройках области «{scope}», M0 их не читает"
                    )),
                )
            } else {
                match flag {
                    Some(true) if user_versions.len() > 1 => (
                        State::Stale,
                        Some(format!(
                            "в области user записано {} версий",
                            user_versions.len()
                        )),
                    ),
                    Some(true) if all_versions.len() > 1 => (
                        State::On,
                        Some("в другой области (project/local) стоит другая версия".to_owned()),
                    ),
                    Some(true) => (State::On, None),
                    Some(false) => (State::Off, None),
                    None => (
                        State::Unknown,
                        Some("нет записи в enabledPlugins".to_owned()),
                    ),
                }
            };
            let mut e = Entity::new(
                CLIENT,
                Kind::Plugin,
                scope,
                key.clone(),
                state,
                file,
                format!("/plugins/{}/{i}", esc_ptr(key)),
            )
            .version(
                r.get("version")
                    .and_then(Value::as_str)
                    .and_then(mask::safe_version),
            )
            .detail(json!({ "sha": r.get("gitCommitSha").and_then(Value::as_str).and_then(mask::safe_version) }));
            if let Some(n) = note {
                e = e.note(n);
            }
            if is_user && path_ok {
                e = e.target(settings_flag(c, &["enabledPlugins", key]));
            }
            c.push(e);
        }
    }

    for (key, v) in enabled.into_iter().flatten() {
        if v.as_bool() == Some(true) && !seen.contains(key) {
            let e = Entity::new(
                CLIENT,
                Kind::Plugin,
                "user",
                key.clone(),
                State::Broken,
                "~/.claude/settings.json",
                format!("/enabledPlugins/{}", esc_ptr(key)),
            )
            .note("включён в enabledPlugins, но не установлен")
            .target(settings_flag(c, &["enabledPlugins", key]));
            c.push(e);
        }
    }
}

fn marketplaces(c: &mut Ctx) {
    let Some(v) = c.read_json(&c.home.join(".claude/plugins/known_marketplaces.json")) else {
        return;
    };
    let Some(map) = v.as_object() else {
        c.warnings
            .push("~/.claude/plugins/known_marketplaces.json: ожидался объект".into());
        return;
    };
    for (name, m) in map {
        let src = m
            .get("source")
            .and_then(|s| s.get("source"))
            .and_then(Value::as_str);
        let e = Entity::new(
            CLIENT,
            Kind::Marketplace,
            "user",
            name.clone(),
            State::On,
            "~/.claude/plugins/known_marketplaces.json",
            format!("/{}", esc_ptr(name)),
        )
        .detail(json!({ "sourceType": src.and_then(mask::safe_version) }));
        c.push(e);
    }
}

fn mcp(c: &mut Ctx, connectors_off: bool, denied: &HashSet<String>) {
    let Some(v) = c.read_json(&c.home.join(".claude.json")) else {
        return;
    };
    let file = "~/.claude.json";
    let mut found = Vec::new();

    // Облачные коннекторы claude.ai (CONCEPT.md §5.1, C0/C1): на диске только имена «когда-либо подключались»,
    // источник правды — аккаунт. Локально их гасит один ключ `disableClaudeAiConnectors`.
    for (i, name) in v
        .get("claudeAiMcpEverConnected")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .enumerate()
    {
        let (state, note) = if connectors_off {
            (State::Off, "выключены в Claude Code ключом disableClaudeAiConnectors (все сразу); аккаунт и Desktop не затронуты")
        } else {
            (
                State::Cloud,
                "в списке «когда-либо подключались»; источник правды — аккаунт claude.ai",
            )
        };
        let mut t = settings_flag(c, &["disableClaudeAiConnectors"]);
        t.inverted = true; // `true` в файле — коннекторы выключены, и это касается всех сразу
        found.push(
            Entity::new(
                CLIENT,
                Kind::Connector,
                "cloud",
                name,
                state,
                file,
                format!("/claudeAiMcpEverConnected/{i}"),
            )
            .note(note)
            .target(t),
        );
    }

    for (name, cfg) in v
        .get("mcpServers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        found.push(
            Entity::new(
                CLIENT,
                Kind::Mcp,
                "user",
                name.clone(),
                State::On,
                file,
                format!("/mcpServers/{}", esc_ptr(name)),
            )
            .detail(mcp_detail(cfg)),
        );
    }
    for key in STASH_KEYS {
        for (name, cfg) in v.get(key).and_then(Value::as_object).into_iter().flatten() {
            if name.starts_with('_') {
                continue; // `_note` и подобное — не серверы
            }
            found.push(
                Entity::new(
                    CLIENT,
                    Kind::Mcp,
                    "user",
                    name.clone(),
                    State::Off,
                    file,
                    format!("/{key}/{}", esc_ptr(name)),
                )
                .note("лежит вне mcpServers, Claude Code его не запускает (стэш, не штатный ключ)")
                .detail(mcp_detail(cfg)),
            );
        }
    }
    for (path, p) in v
        .get("projects")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        for (name, cfg) in p
            .get("mcpServers")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            // `shown` — путь для показа (с `~`), а не настоящий ключ `projects`; для записи в M3 ключ ищется по `scope`.
            let shown = c.tilde(Path::new(path));
            found.push(
                Entity::new(
                    CLIENT,
                    Kind::Mcp,
                    format!("project:{shown}"),
                    name.clone(),
                    State::On,
                    file,
                    format!("/projects/{}/mcpServers/{}", esc_ptr(&shown), esc_ptr(name)),
                )
                .detail(mcp_detail(cfg)),
            );
        }
    }
    for mut e in found {
        if denied.contains(&e.name) {
            // ключ `disableClaudeAiConnectors` запрет по имени не снимает, и когда коннектор уже выключен этим ключом
            e.target = None;
            if e.state != State::Off || e.kind == Kind::Connector {
                e.state = State::Off;
                e.note = Some("запрещён в deniedMcpServers (по имени)".to_owned());
            }
        }
        c.push(e);
    }
}

fn md_dir(c: &mut Ctx, dir: &str, kind: Kind) {
    let root = c.home.join(".claude").join(dir);
    let Ok(rd) = std::fs::read_dir(&root) else {
        return;
    };
    let mut files: Vec<_> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .collect();
    files.sort();
    for p in files {
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let fm = frontmatter::read(&p).unwrap_or_default();
        // имя из frontmatter проходит тот же фильтр, что у скилов
        let name = fm
            .get("name")
            .and_then(|n| mask::safe_name(n))
            .map_or(stem, str::to_owned);
        let e = Entity::new(
            CLIENT,
            kind,
            "user",
            name,
            State::On,
            c.tilde(&p),
            "frontmatter",
        )
        .detail(
            json!({ "model": fm.get("model").map(String::as_str).and_then(mask::safe_version) }),
        );
        c.push(e);
    }
}
