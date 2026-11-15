//! Адаптер ChatGPT / Codex (приложение `OpenAI.Codex`, конфиг `~/.codex`). Источники — таблица §2 CONCEPT.md.

use crate::mask::{self, mcp_detail};
use crate::model::{Client, Entity, Format, Kind, Src, State, Target, TargetKind};
use crate::{scan_hooks, scan_skills, Ctx};
use serde_json::{json, Value};

const CLIENT: Client = Client::Codex;
const CONFIG: &str = "~/.codex/config.toml";

/// Ключ TOML в указателе: голый, если состоит из `A-Za-z0-9_-`, иначе в кавычках.
fn toml_key(name: &str) -> String {
    if !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        name.to_owned()
    } else {
        format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

/// Ключ `enabled` в таблице `config.toml` (цель записи R1).
fn flag(file: &std::path::Path, table: &[&str]) -> Target {
    let mut path: Vec<String> = table.iter().map(|s| (*s).to_owned()).collect();
    path.push("enabled".to_owned());
    Target {
        file: file.to_path_buf(),
        format: Format::Toml,
        path,
        inverted: false,
        kind: TargetKind::Flag,
    }
}

pub fn scan(c: &mut Ctx) {
    config(c);
    if let Some(v) = c.read_json(&c.home.join(".codex/hooks.json")) {
        if let Some(h) = v.get("hooks") {
            scan_hooks(c, CLIENT, "~/.codex/hooks.json", "/hooks", "user", h);
        }
    }
    let skills = c.home.join(".codex/skills");
    scan_skills(c, CLIENT, &skills, "user");
    scan_skills(c, CLIENT, &skills.join(".system"), "builtin");
    remote_catalog(c);
}

fn config(c: &mut Ctx) {
    let path = c.home.join(".codex/config.toml");
    let Some(text) = c.read_text(&path) else {
        return;
    };
    let table: toml::Table = match text.parse() {
        Ok(t) => t,
        Err(e) => {
            c.warnings.push(crate::tr!(
                "{CONFIG}: не TOML ({})",
                "{CONFIG}: not TOML ({})",
                e.message()
            ));
            return;
        }
    };
    // toml::Value реализует Serialize, поэтому дальше работаем с общим serde_json::Value, как у Claude Code.
    let root = serde_json::to_value(&table).unwrap_or(Value::Null);

    for (name, p) in root
        .get("plugins")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let (state, note) = match p.get("enabled").and_then(Value::as_bool) {
            Some(true) => (State::On, None),
            Some(false) => (State::Off, None),
            None => (
                State::Unknown,
                Some(crate::tr!("нет ключа enabled", "no enabled key")),
            ),
        };
        let mut e = Entity::new(
            CLIENT,
            Kind::Plugin,
            "user",
            name.clone(),
            state,
            CONFIG,
            format!("plugins.{}", toml_key(name)),
        )
        .target(flag(&path, &["plugins", name]));
        if let Some(n) = note {
            e = e.note(n);
        }
        c.push(e);
    }
    for (name, m) in root
        .get("marketplaces")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let e = Entity::new(
            CLIENT,
            Kind::Marketplace,
            "user",
            name.clone(),
            State::On,
            CONFIG,
            format!("marketplaces.{}", toml_key(name)),
        )
        .detail(json!({ "sourceType": m.get("source_type").and_then(Value::as_str).and_then(mask::safe_version) }));
        c.push(e);
    }
    for (name, m) in root
        .get("mcp_servers")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let state = if m.get("enabled").and_then(Value::as_bool) == Some(false) {
            State::Off
        } else {
            State::On
        };
        let e = Entity::new(
            CLIENT,
            Kind::Mcp,
            "user",
            name.clone(),
            state,
            CONFIG,
            format!("mcp_servers.{}", toml_key(name)),
        )
        .target(flag(&path, &["mcp_servers", name]))
        .src(Src {
            file: path.clone(),
            format: Format::Toml,
            path: vec!["mcp_servers".to_owned(), name.clone()],
        })
        .detail(mcp_detail(m));
        c.push(e);
    }
    // `[apps.<id>] enabled`: приложения (коннекторы) аккаунта. Ключ описан в справочнике конфигурации Codex;
    // `apps._default` — значение по умолчанию для остальных, самостоятельной записью не считается.
    let default_on = root
        .pointer("/apps/_default/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    for (id, a) in root
        .get("apps")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(id, _)| !id.starts_with('_'))
    {
        let on = a
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(default_on);
        let e = Entity::new(
            CLIENT,
            Kind::Connector,
            "cloud",
            id.clone(),
            if on { State::On } else { State::Off },
            CONFIG,
            format!("apps.{}", toml_key(id)),
        )
        .note(crate::tr!(
            "локальный переключатель приложения аккаунта; источник правды — аккаунт ChatGPT",
            "local switch of an account app; the source of truth is the ChatGPT account"
        ))
        .target(flag(&path, &["apps", id]));
        c.push(e);
    }
}

/// Кеш каталога удалённых плагинов: это не подтверждённое подключение, а то, что приложение скачало (CONCEPT.md §5.1, C0).
fn remote_catalog(c: &mut Ctx) {
    let root = c.home.join(".codex/plugins/cache/openai-curated-remote");
    let Ok(rd) = std::fs::read_dir(&root) else {
        return;
    };
    let mut names: Vec<String> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for n in names {
        let e = Entity::new(
            CLIENT,
            Kind::Connector,
            "cloud",
            n.clone(),
            State::Cloud,
            "~/.codex/plugins/cache/openai-curated-remote",
            format!("/{n}"),
        )
        .note(crate::tr!(
            "запись кеша каталога удалённых плагинов; источник правды — аккаунт",
            "an entry of the remote plugin catalog cache; the source of truth is the account"
        ))
        .fs_named(); // имя — каталог кеша (`app-69f0dc45…`), не содержимое файла
        c.push(e);
    }
}
