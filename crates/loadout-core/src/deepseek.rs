//! Адаптер DeepSeek harness (`dsh`). Формы сняты с этой машины, см. §2 CONCEPT.md.
//!
//! `~/.dsh/cordis.patch.yml` — YAML-список операций; сейчас встречается только `insert`. Каждая вставка — экземпляр
//! плагина `{id, name: "@deepseek-ai/<плагин>", config}`. MCP — плагин `dsh-mcp-client`, хуки — `dsh-hooks-*` с
//! `config.configPath` на JSON в формате хуков Claude Code. Файл содержит нестандартный тег `!!js process.cwd()`:
//! тег не исполняется, значение читается как обычная строка.

use crate::mask::{self, mcp_detail};
use crate::model::{Client, Entity, Kind, State};
use crate::{scan_hooks, scan_skills, Ctx};
use serde_json::{json, Map, Value};
use std::path::{Component, Path, PathBuf};
use yaml_rust2::{Yaml, YamlLoader};

const CLIENT: Client = Client::DeepSeek;
const MCP_CLIENT: &str = "@deepseek-ai/dsh-mcp-client";
const HOOKS_PREFIX: &str = "@deepseek-ai/dsh-hooks-";

pub fn scan(c: &mut Ctx) {
    let root = c.home.join(".dsh");
    patch(c, &root.join("cordis.patch.yml"), "user");
    // Профили (`default`, `desktop`, …) держат свои патчи; `node_modules` внутри `profiles` пропускаем.
    if let Ok(rd) = std::fs::read_dir(root.join("profiles")) {
        let mut names: Vec<String> = rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "node_modules")
            .collect();
        names.sort();
        for n in names {
            patch(
                c,
                &root.join("profiles").join(&n).join("cordis.patch.yml"),
                &format!("profile:{n}"),
            );
        }
    }
    scan_skills(c, CLIENT, &root.join("skills"), "user");
}

fn patch(c: &mut Ctx, path: &Path, scope: &str) {
    let Some(text) = c.read_text(path) else {
        return;
    };
    let file = c.tilde(path);
    let docs = match YamlLoader::load_from_str(&text) {
        Ok(d) => d,
        Err(e) => {
            c.warnings.push(format!("{file}: не YAML ({})", e.info()));
            return;
        }
    };
    let Some(ops) = docs.first().and_then(Yaml::as_vec) else {
        return;
    };
    for (oi, op) in ops.iter().enumerate() {
        let Some(entries) = op["insert"].as_vec() else {
            continue;
        };
        for (ei, entry) in entries.iter().enumerate() {
            let ptr = format!("/{oi}/insert/{ei}");
            insert_entry(c, &file, &ptr, scope, entry);
        }
    }
}

fn insert_entry(c: &mut Ctx, file: &str, ptr: &str, scope: &str, entry: &Yaml) {
    let plugin = entry["name"].as_str().unwrap_or("");
    let id = entry["id"]
        .as_str()
        .and_then(mask::safe_name)
        .unwrap_or("?");
    let config = yaml_to_json(&entry["config"]);

    if plugin == MCP_CLIENT {
        let server = config
            .get("serverName")
            .and_then(Value::as_str)
            .and_then(mask::safe_name)
            .unwrap_or(id)
            .to_owned();
        let mut cfg = config;
        // у dsh транспорт называется `transport`, у остальных клиентов `type`
        // Схема пакета `@deepseek-ai/dsh-mcp-client` (npm 0.0.1-rc.1): transport = `stdio` | `streamable-http`.
        if let Some(t) = cfg.get("transport").and_then(Value::as_str) {
            cfg["type"] = Value::from(if t == "streamable-http" { "http" } else { t });
        }
        let e = Entity::new(CLIENT, Kind::Mcp, scope, server, State::On, file, ptr)
            .detail(mcp_detail(&cfg))
            .note("запись плагина dsh-mcp-client; признака «выключено» у записи нет (убрать запись = выключить)");
        c.push(e);
    } else if let Some(kind) = plugin.strip_prefix(HOOKS_PREFIX) {
        hooks_file(c, kind, config.get("configPath").and_then(Value::as_str));
    } else if !plugin.is_empty() {
        let e = Entity::new(
            CLIENT,
            Kind::Plugin,
            scope,
            mask::safe_name(plugin).unwrap_or("?"),
            State::On,
            file,
            ptr,
        )
        .detail(json!({ "id": id }));
        c.push(e);
    }
}

/// Файл хуков, на который указывает запись `dsh-hooks-*`. Читаем только внутри домашнего каталога.
fn hooks_file(c: &mut Ctx, _flavor: &str, config_path: Option<&str>) {
    let Some(raw) = config_path else { return };
    let path = PathBuf::from(raw);
    let shown = c.tilde(&path);
    let escapes = path.components().any(|p| matches!(p, Component::ParentDir));
    if !shown.starts_with('~') || escapes {
        c.warnings
            .push("файл хуков dsh вне домашнего каталога не читается".to_owned());
        return;
    }
    if let Some(v) = c.read_json(&path) {
        let (hooks, ptr) = v.get("hooks").map_or((&v, ""), |h| (h, "/hooks"));
        scan_hooks(c, CLIENT, &shown, ptr, hooks);
    }
}

fn yaml_to_json(y: &Yaml) -> Value {
    match y {
        Yaml::Hash(h) => Value::Object(
            h.iter()
                .map(|(k, v)| {
                    (
                        k.as_str().map_or_else(|| format!("{k:?}"), str::to_owned),
                        yaml_to_json(v),
                    )
                })
                .collect::<Map<_, _>>(),
        ),
        Yaml::Array(a) => Value::Array(a.iter().map(yaml_to_json).collect()),
        Yaml::String(s) => Value::String(s.clone()),
        Yaml::Integer(i) => Value::from(*i),
        Yaml::Real(r) => r.parse::<f64>().map_or(Value::Null, Value::from),
        Yaml::Boolean(b) => Value::Bool(*b),
        Yaml::Null | Yaml::Alias(_) | Yaml::BadValue => Value::Null,
    }
}
