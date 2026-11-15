//! Адаптер DeepSeek harness (`dsh`). Формы сняты с этой машины, см. §2 CONCEPT.md.
//!
//! `~/.dsh/cordis.patch.yml` — YAML-список операций; сейчас встречается только `insert`. Каждая вставка — экземпляр
//! плагина `{id, name: "@deepseek-ai/<плагин>", config}`. MCP — плагин `dsh-mcp-client`, хуки — `dsh-hooks-*` с
//! `config.configPath` на JSON в формате хуков Claude Code. Файл содержит нестандартный тег `!!js process.cwd()`:
//! тег не исполняется, значение читается как обычная строка.

use crate::mask::{self, mcp_detail};
use crate::model::{Client, Entity, Format, Kind, State, Target, TargetKind};
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
            .filter(|n| n != "node_modules" && mask::safe_name(n).is_some())
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
    if let Some(why) = yaml_guard(&text) {
        c.warnings.push(format!("{file}: пропущен ({why})"));
        return;
    }
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
            // В указателе (а с ним и в id записи) стоит `id` записи, а не её номер: после выноса соседней записи номера
            // сдвигаются, и позиционный id менялся бы посреди пакета.
            let key = entry["id"]
                .as_str()
                .and_then(mask::safe_name)
                .map_or_else(|| ei.to_string(), str::to_owned);
            let ptr = format!("/{oi}/insert/{key}");
            insert_entry(c, &file, &ptr, scope, entry, (path, oi, ei));
        }
    }
}

fn insert_entry(
    c: &mut Ctx,
    file: &str,
    ptr: &str,
    scope: &str,
    entry: &Yaml,
    // файл, номер операции и номер записи в её списке `insert`: по ним запись выносится в корзину
    loc: (&Path, usize, usize),
) {
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
            .note("запись плагина dsh-mcp-client; признака «выключено» у записи нет: выключение выносит её строки в корзину Loadout")
            .target(Target {
                file: loc.0.to_path_buf(),
                format: Format::Yaml,
                path: vec![loc.1.to_string(), "insert".to_owned(), loc.2.to_string()],
                inverted: false,
                kind: TargetKind::Cut,
            });
        c.push(e);
    } else if let Some(kind) = plugin.strip_prefix(HOOKS_PREFIX) {
        hooks_file(
            c,
            kind,
            scope,
            config.get("configPath").and_then(Value::as_str),
        );
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

/// Описание вынесенной в корзину записи (строки YAML) в том же виде, что у живой: команда, аргументы, ключи env.
pub(crate) fn trashed_detail(raw: &str) -> Value {
    let Ok(docs) = YamlLoader::load_from_str(raw) else {
        return json!({});
    };
    let entry = docs
        .first()
        .and_then(|d| d.as_vec())
        .and_then(|v| v.first());
    let Some(entry) = entry else {
        return json!({});
    };
    let mut cfg = yaml_to_json(&entry["config"]);
    if let Some(t) = cfg.get("transport").and_then(Value::as_str) {
        cfg["type"] = Value::from(if t == "streamable-http" { "http" } else { t });
    }
    mcp_detail(&cfg)
}

/// Файл хуков, на который указывает запись `dsh-hooks-*`. Читаем только внутри домашнего каталога.
fn hooks_file(c: &mut Ctx, _flavor: &str, scope: &str, config_path: Option<&str>) {
    let Some(raw) = config_path else { return };
    let path = PathBuf::from(raw);
    let shown = c.tilde(&path);
    // Только абсолютный путь без `..`, лежащий в домашнем каталоге, причём и после раскрытия ссылок и junction'ов.
    let escapes = path.components().any(|p| matches!(p, Component::ParentDir));
    let outside_real = match (std::fs::canonicalize(&path), std::fs::canonicalize(&c.home)) {
        (Ok(real), Ok(home)) => !real.starts_with(home),
        _ => false, // файла нет: читать нечего
    };
    if !path.is_absolute() || !shown.starts_with('~') || escapes || outside_real {
        c.warnings
            .push("файл хуков dsh вне домашнего каталога не читается".to_owned());
        return;
    }
    if let Some(v) = c.read_json(&path) {
        let (hooks, ptr) = v.get("hooks").map_or((&v, ""), |h| (h, "/hooks"));
        scan_hooks(c, CLIENT, &shown, ptr, scope, hooks);
    }
}

/// Защита разбора YAML: якоря и алиасы (`&x`, `*x`, `<<:`) растут экспоненциально при разворачивании, очень глубокая
/// вложенность валит стек. Файл конфигурации dsh ничего из этого не использует, поэтому такой файл не читаем.
pub(crate) fn yaml_guard(text: &str) -> Option<&'static str> {
    let (mut depth, mut max_depth) = (0usize, 0usize);
    for c in text.chars() {
        match c {
            '[' | '{' => {
                depth += 1;
                max_depth = max_depth.max(depth);
            }
            ']' | '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    if max_depth > 64 {
        return Some("слишком глубокая вложенность");
    }
    for line in text.lines() {
        let indent = line.len() - line.trim_start().len();
        if indent > 200 {
            return Some("слишком глубокая вложенность");
        }
        // значение: после `- ` и после `ключ: `; якорь `&имя` или алиас `*имя` стоит в самом начале значения
        let t = line.trim_start().trim_start_matches("- ").trim_start();
        let value = t.split_once(": ").map_or(t, |(_, v)| v.trim_start());
        let marked = |s: &str| {
            s.strip_prefix(['*', '&'])
                .and_then(|r| r.chars().next())
                .is_some_and(|c| c.is_alphanumeric() || c == '_')
        };
        if t.starts_with("<<:")
            || marked(t)
            || marked(value)
            || value.contains(" *") && value.contains('[')
        {
            return Some("якоря и алиасы YAML не поддерживаются");
        }
    }
    None
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
