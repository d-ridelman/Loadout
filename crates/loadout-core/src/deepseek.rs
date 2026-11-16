//! DeepSeek harness (`dsh`) adapter. Shapes were taken from this machine, see CONCEPT.md §2.
//!
//! `~/.dsh/cordis.patch.yml` is a YAML list of operations; only `insert` occurs so far. Each insert is an instance
//! of the plugin `{id, name: "@deepseek-ai/<plugin>", config}`. MCP is the plugin `dsh-mcp-client`, hooks are `dsh-hooks-*` with
//! `config.configPath` pointing to JSON in the Claude Code hooks format. The file contains the non-standard tag `!!js process.cwd()`:
//! the tag is not executed, the value is read as a plain string.

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
    // Profiles (`default`, `desktop`, …) keep their own patches; `node_modules` inside `profiles` is skipped.
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
        c.warnings.push(crate::tr!(
            "{file}: пропущен ({why})",
            "{file}: skipped ({why})"
        ));
        return;
    }
    let docs = match YamlLoader::load_from_str(&text) {
        Ok(d) => d,
        Err(e) => {
            c.warnings.push(crate::tr!(
                "{file}: не YAML ({})",
                "{file}: not YAML ({})",
                e.info()
            ));
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
        // the entry's `id` is good for a stable pointer only if it is simple and not repeated within the operation
        let stable = |e: &Yaml| {
            e["id"]
                .as_str()
                .filter(|s| {
                    !s.is_empty()
                        && s.chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                })
                .map(str::to_owned)
        };
        for (ei, entry) in entries.iter().enumerate() {
            let sid = stable(entry);
            let unique = sid.as_ref().is_some_and(|s| {
                entries
                    .iter()
                    .filter(|o| stable(o).as_deref() == Some(s.as_str()))
                    .count()
                    == 1
            });
            // The pointer (and with it the entry id) holds the entry's `id`, not its number: after a neighbouring entry is cut out the numbers
            // shift, and a positional id would change in the middle of a batch. Entries without a simple unique `id` stay
            // positional and get no write target: cutting them out by lines is impossible without the risk of missing.
            let key = sid
                .clone()
                .filter(|_| unique)
                .unwrap_or_else(|| ei.to_string());
            let ptr = format!("/{oi}/insert/{}", crate::esc_ptr(&key));
            insert_entry(c, &file, &ptr, scope, entry, (path, oi, ei), unique);
        }
    }
}

fn insert_entry(
    c: &mut Ctx,
    file: &str,
    ptr: &str,
    scope: &str,
    entry: &Yaml,
    // file, operation number and entry number in its `insert` list: they are what the entry is cut into the trash by
    loc: (&Path, usize, usize),
    // the entry has a simple unique `id`: only then can it be cut into the trash
    writable: bool,
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
        // in dsh the transport is called `transport`, in other clients `type`
        // Schema of the `@deepseek-ai/dsh-mcp-client` package (npm 0.0.1-rc.1): transport = `stdio` | `streamable-http`.
        if let Some(t) = cfg.get("transport").and_then(Value::as_str) {
            cfg["type"] = Value::from(if t == "streamable-http" { "http" } else { t });
        }
        let mut e = Entity::new(CLIENT, Kind::Mcp, scope, server, State::On, file, ptr)
            .detail(mcp_detail(&cfg))
            .note(crate::tr!(
                "запись плагина dsh-mcp-client; признака «выключено» у записи нет: выключение выносит её строки в корзину Loadout",
                "an entry of the dsh-mcp-client plugin; the entry has no “off” flag: turning it off moves its lines to the Loadout trash"
            ));
        if writable {
            e = e.target(Target {
                file: loc.0.to_path_buf(),
                format: Format::Yaml,
                path: vec![loc.1.to_string(), "insert".to_owned(), loc.2.to_string()],
                inverted: false,
                kind: TargetKind::Cut,
            });
        }
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

/// Description of an entry cut into the trash (YAML lines) in the same shape as a live one: command, arguments, env keys.
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

/// The hooks file that a `dsh-hooks-*` entry points to. Read only inside the home directory.
fn hooks_file(c: &mut Ctx, _flavor: &str, scope: &str, config_path: Option<&str>) {
    let Some(raw) = config_path else { return };
    let path = PathBuf::from(raw);
    let shown = c.tilde(&path);
    // Only an absolute path without `..` that lies in the home directory, also after resolving links and junctions.
    let escapes = path.components().any(|p| matches!(p, Component::ParentDir));
    let outside_real = match (std::fs::canonicalize(&path), std::fs::canonicalize(&c.home)) {
        (Ok(real), Ok(home)) => !real.starts_with(home),
        _ => false, // no file: nothing to read
    };
    if !path.is_absolute() || !shown.starts_with('~') || escapes || outside_real {
        c.warnings.push(crate::tr!(
            "файл хуков dsh вне домашнего каталога не читается",
            "the dsh hooks file outside the home directory is not read"
        ));
        return;
    }
    if let Some(v) = c.read_json(&path) {
        let (hooks, ptr) = v.get("hooks").map_or((&v, ""), |h| (h, "/hooks"));
        scan_hooks(c, CLIENT, &shown, ptr, scope, hooks);
    }
}

/// YAML parsing guard: anchors and aliases (`&x`, `*x`, `<<:`) grow exponentially when expanded, very deep
/// nesting blows the stack. The dsh config file uses none of this, so such a file is not read.
pub(crate) fn yaml_guard(text: &str) -> Option<String> {
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
        return Some(crate::tr!(
            "слишком глубокая вложенность",
            "nesting is too deep"
        ));
    }
    for line in text.lines() {
        let indent = line.len() - line.trim_start().len();
        if indent > 200 {
            return Some(crate::tr!(
                "слишком глубокая вложенность",
                "nesting is too deep"
            ));
        }
        // value: after `- ` and after `key: `; an anchor `&name` or alias `*name` stands at the very start of the value
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
            return Some(crate::tr!(
                "якоря и алиасы YAML не поддерживаются",
                "YAML anchors and aliases are not supported"
            ));
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
