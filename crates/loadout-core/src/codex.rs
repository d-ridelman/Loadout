//! ChatGPT / Codex adapter (the `OpenAI.Codex` app, config `~/.codex`). Sources: the table in CONCEPT.md §2.

use crate::mask::{self, mcp_detail};
use crate::model::{Client, Entity, Format, Kind, Src, State, Target, TargetKind};
use crate::{scan_hooks, scan_skills, Ctx};
use serde_json::{json, Value};

const CLIENT: Client = Client::Codex;
const CONFIG: &str = "~/.codex/config.toml";

/// A TOML key in the pointer: bare if it consists of `A-Za-z0-9_-`, otherwise quoted.
pub(crate) fn toml_key(name: &str) -> String {
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

/// The `enabled` key in the `config.toml` table (write target R1).
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
    // toml::Value implements Serialize, so from here on we work with the common serde_json::Value, as in Claude Code.
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
    // `[apps.<id>] enabled`: the account's apps (connectors). The key is described in the Codex configuration reference;
    // `apps._default` is the default for the rest and does not count as an entry of its own.
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

/// Cache of the remote plugin catalog: this is not a confirmed connection, just what the app has downloaded (CONCEPT.md §5.1, C0).
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
        let shown = display_name(c, &root.join(&n));
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
        .detail(json!({ "displayName": shown }))
        .fs_named(); // the name is the cache directory (`app-69f0dc45…`), not the file content
        c.push(e);
    }
}

/// The human name of a cached plugin: `<dir>/<version>/.codex-plugin/plugin.json` → `interface.displayName`, else `name`
/// (Codex source, core-plugins/manifest.rs; `.claude-plugin` is its fallback location). Text from a file: through `safe_name`.
fn display_name(c: &mut Ctx, dir: &std::path::Path) -> Option<String> {
    let mut versions: Vec<_> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    versions.sort();
    versions.iter().rev().find_map(|v| {
        let m = [".codex-plugin", ".claude-plugin"]
            .iter()
            .find_map(|d| c.read_json(&v.join(d).join("plugin.json")))?;
        let name = m
            .pointer("/interface/displayName")
            .and_then(Value::as_str)
            .and_then(mask::safe_name)
            .or_else(|| {
                m.get("name")
                    .and_then(Value::as_str)
                    .and_then(mask::safe_name)
            });
        name.map(str::to_owned)
    })
}
