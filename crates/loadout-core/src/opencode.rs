//! OpenCode adapter (`sst/opencode`, the terminal agent). Shapes come from the official docs (opencode.ai/docs: config,
//! mcp-servers, agents, commands, plugins, skills, migrate-v1) and were checked against a real V2 config (key names only).
//!
//! - Global config: `~/.config/opencode/opencode.json` and `opencode.jsonc` (the same path on Windows), JSONC; both are read
//!   and deep-merged by OpenCode.
//! - Two schema generations. V1: `mcp.<name>` with `enabled`, maps `agent` and `command`, array `plugin`.
//!   V2: `mcp.servers.<name>` with the inverse `disabled`, maps `agents` and `commands`, array `plugins`. OpenCode rejects
//!   unknown top-level keys, so a write follows the generation of the file it lands in.
//! - An MCP entry: `{type: "local", command: [exe, ...args], environment?, cwd?}` or `{type: "remote", url, headers?, oauth?}`.
//! - Markdown agents and commands `agent(s)/<name>.md`, `command(s)/<name>.md` (the file name is the name), skills
//!   `skill(s)/<name>/SKILL.md`, local plugins `plugin(s)/` (files or directories); singular and plural names both work.
//!
//! - The system config `%ProgramData%\opencode\opencode.json(c)` (highest precedence, set by an administrator) is read as scope
//!   `managed` and never written: changing a machine-wide file needs administrator rights.
//!
//! Not read: project configs (OpenCode keeps its list of projects only in its SQLite database `opencode.db`), `AGENTS.md`
//! rules (no entry kind for them), `tui.json` (screen settings, no entries), macOS managed preferences.

use crate::mask::{self, mcp_detail};
use crate::model::{Client, Entity, Format, Kind, Src, State, Target, TargetKind};
use crate::{esc_ptr, frontmatter, scan_skills, Ctx};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

const CLIENT: Client = Client::OpenCode;
pub(crate) const DIR: &str = ".config/opencode";
/// The `.jsonc` name goes first: a write lands in it when both files exist.
pub const FILES: [&str; 2] = ["opencode.jsonc", "opencode.json"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Gen {
    V1,
    V2,
}

/// The generation by the file's own keys; `None` when nothing tells them apart (then nothing is written there).
pub(crate) fn generation(root: &Value) -> Option<Gen> {
    // by the value types, not the key names: a V2 server may be called `url` or `type`, and its value is then an object
    let server_like = |v: &Value| {
        v.as_object().is_some_and(|o| {
            o.get("type").is_some_and(Value::is_string)
                || o.get("command").is_some_and(Value::is_array)
                || o.get("url").is_some_and(Value::is_string)
                || o.get("enabled").is_some_and(Value::is_boolean)
        })
    };
    let mcp = root.get("mcp").and_then(Value::as_object);
    // a V1 server named "servers" has its own type/command/url
    if let Some(s) = mcp.and_then(|m| m.get("servers")) {
        return Some(if server_like(s) { Gen::V1 } else { Gen::V2 });
    }
    if mcp.is_some_and(|m| m.values().any(server_like)) {
        return Some(Gen::V1);
    }
    let has = |keys: &[&str]| keys.iter().any(|k| root.get(*k).is_some());
    if has(&["providers", "agents", "commands", "plugins"]) {
        Some(Gen::V2)
    } else if has(&["provider", "agent", "command", "plugin", "mode"]) {
        Some(Gen::V1)
    } else {
        None
    }
}

/// Keys from the file root to the object of MCP servers.
pub(crate) fn servers_path(g: Gen) -> Vec<String> {
    match g {
        Gen::V1 => vec!["mcp".to_owned()],
        Gen::V2 => vec!["mcp".to_owned(), "servers".to_owned()],
    }
}

/// [`servers_path`] of a file's text, for adding and copying into OpenCode.
pub(crate) fn servers_path_of(text: &str) -> Result<Vec<String>, String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let root = jsonc_parser::parse_to_serde_value(text, &Default::default())
        .ok()
        .flatten()
        .ok_or_else(|| crate::tr!("не JSONC", "not JSONC"))?;
    generation(&root).map(servers_path).ok_or_else(|| {
        crate::tr!(
            "по конфигу OpenCode не понять, старая это схема (mcp.<имя>) или новая (mcp.servers.<имя>): добавьте сервер в OpenCode сами, дальше Loadout подхватит",
            "the OpenCode config does not show whether it uses the old schema (mcp.<name>) or the new one (mcp.servers.<name>): add a server in OpenCode yourself, Loadout picks it up from there"
        )
    })
}

/// An OpenCode MCP entry in the shape the other clients share (`command` + `args`, `env`, `type`), for the detail, editing and
/// copying. Keys it does not know stay, so a copy names them as not carried over.
pub(crate) fn to_common(cfg: &Value) -> Value {
    let Some(obj) = cfg.as_object() else {
        return cfg.clone();
    };
    let mut out = Map::new();
    for (k, v) in obj {
        match (k.as_str(), v.as_array()) {
            ("command", Some(a)) => {
                if let Some(first) = a.first() {
                    out.insert("command".into(), first.clone());
                }
                if a.len() > 1 {
                    out.insert("args".into(), Value::Array(a[1..].to_vec()));
                }
            }
            ("environment", _) => {
                out.insert("env".into(), v.clone());
            }
            ("type", _) => {
                let t = match v.as_str() {
                    Some("local") => "stdio",
                    Some("remote") => "http",
                    _ => "other",
                };
                out.insert("type".into(), json!(t));
            }
            _ => {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

/// The inverse of [`to_common`] for a translated entry (`command`, `args`, `env`, `url`, `headers`).
pub(crate) fn from_common(v: &Value) -> Value {
    let mut out = Map::new();
    if let Some(cmd) = v.get("command").and_then(Value::as_str) {
        let mut all = vec![json!(cmd)];
        all.extend(
            v.get("args")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        out.insert("type".into(), json!("local"));
        out.insert("command".into(), Value::Array(all));
        if let Some(env) = v.get("env") {
            out.insert("environment".into(), env.clone());
        }
    } else if let Some(url) = v.get("url") {
        out.insert("type".into(), json!("remote"));
        out.insert("url".into(), url.clone());
        if let Some(h) = v.get("headers") {
            out.insert("headers".into(), h.clone());
        }
    }
    Value::Object(out)
}

/// The machine-wide config directory, `%ProgramData%\opencode`, for a scan of the real machine (the CLI decides when).
pub fn system_dir() -> Option<PathBuf> {
    std::env::var_os("ProgramData").map(|p| PathBuf::from(p).join("opencode"))
}

pub fn scan(c: &mut Ctx) {
    let dir = c.home.join(DIR);
    let before = c.entities.len();
    for f in FILES {
        config(c, &dir.join(f), "user");
    }
    note_twins(&mut c.entities[before..]);
    if let Some(sys) = c.opencode_system.clone() {
        for f in FILES {
            config(c, &sys.join(f), "managed");
        }
    }
    for d in ["agent", "agents"] {
        md_dir(c, &dir.join(d), Kind::Agent);
    }
    for d in ["command", "commands"] {
        md_dir(c, &dir.join(d), Kind::Command);
    }
    for d in ["plugin", "plugins"] {
        plugin_dir(c, &dir.join(d));
    }
    for d in ["skill", "skills"] {
        scan_skills(c, CLIENT, &dir.join(d), "user");
    }
}

/// The same MCP server in both `opencode.json` and `opencode.jsonc`: OpenCode merges the two files into one server, so each
/// entry says so (switching one file alone may not change what OpenCode uses).
fn note_twins(found: &mut [Entity]) {
    let mcp = |e: &Entity| e.kind == Kind::Mcp;
    let twins: Vec<String> = found
        .iter()
        .filter(|e| mcp(e))
        .filter(|e| {
            found
                .iter()
                .any(|o| mcp(o) && o.name == e.name && o.origin.file != e.origin.file)
        })
        .map(|e| e.name.clone())
        .collect();
    for e in found
        .iter_mut()
        .filter(|e| e.kind == Kind::Mcp && twins.contains(&e.name))
    {
        e.note = Some(crate::tr!(
            "этот сервер описан и в opencode.json, и в opencode.jsonc: OpenCode сливает оба файла в один сервер, поэтому выключите его в обоих или удалите лишнюю копию",
            "this server is in both opencode.json and opencode.jsonc: OpenCode merges the two files into one server, so turn it off in both or remove the extra copy"
        ));
    }
}

/// One config file; `scope` is `user` (the global config, writable) or `managed` (the system config, read only).
fn config(c: &mut Ctx, path: &Path, scope: &'static str) {
    let Some(root) = c.read_jsonc(path) else {
        return;
    };
    let file = c.tilde(path);
    if let Some(g) = generation(&root) {
        mcp(c, path, &file, &root, g, scope);
    }
    for key in ["agent", "agents"] {
        named_map(c, &file, &root, key, Kind::Agent, scope);
    }
    for key in ["command", "commands"] {
        named_map(c, &file, &root, key, Kind::Command, scope);
    }
    for key in ["plugin", "plugins"] {
        plugin_list(c, &file, &root, key, scope);
    }
}

fn mcp(c: &mut Ctx, path: &Path, file: &str, root: &Value, g: Gen, scope: &'static str) {
    let base = servers_path(g);
    let servers = base.iter().try_fold(root, |v, k| v.get(k));
    // V1 `enabled: false` and V2 `disabled: true` mean "off"; `inverted` marks the V2 key
    let (flag, inverted) = match g {
        Gen::V1 => ("enabled", false),
        Gen::V2 => ("disabled", true),
    };
    let ptr: String = base.iter().map(|k| format!("/{}", esc_ptr(k))).collect();
    for (name, cfg) in servers.and_then(Value::as_object).into_iter().flatten() {
        if !cfg.is_object() {
            continue;
        }
        let Some(shown) = mask::safe_name(name) else {
            c.warnings.push(crate::tr!(
                "{file}: MCP-сервер с недопустимым именем пропущен",
                "{file}: MCP server with an invalid name skipped"
            ));
            continue;
        };
        let off = cfg.get(flag).and_then(Value::as_bool) == Some(inverted);
        let mut at = base.clone();
        at.push(name.clone());
        let mut key = at.clone();
        key.push(flag.to_owned());
        let e = Entity::new(
            CLIENT,
            Kind::Mcp,
            scope,
            shown,
            if off { State::Off } else { State::On },
            file,
            format!("{ptr}/{}", esc_ptr(name)),
        )
        .detail(mcp_detail(&to_common(cfg)));
        // the system config is read only: no switch and no source to edit or copy from
        let e = if scope == "managed" {
            e
        } else {
            e.target(Target {
                file: path.to_path_buf(),
                format: Format::Json,
                path: key,
                inverted,
                kind: TargetKind::Flag,
            })
            .src(Src {
                file: path.to_path_buf(),
                format: Format::Json,
                path: at,
            })
        };
        c.push(e);
    }
}

/// `agent` / `agents` and `command` / `commands`: `{name: {...}}`. Prompts and templates are not shown (they can hold anything).
fn named_map(c: &mut Ctx, file: &str, root: &Value, key: &str, kind: Kind, scope: &'static str) {
    for (name, v) in root
        .get(key)
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let Some(shown) = mask::safe_name(name) else {
            continue;
        };
        let off = ["disable", "disabled"]
            .iter()
            .any(|k| v.get(*k).and_then(Value::as_bool) == Some(true));
        let e = Entity::new(
            CLIENT,
            kind,
            scope,
            shown,
            if off { State::Off } else { State::On },
            file,
            format!("/{key}/{}", esc_ptr(name)),
        )
        .detail(json!({ "model": v.get("model").and_then(Value::as_str).and_then(model_name) }));
        c.push(e);
    }
}

/// An OpenCode model is `provider/model[#variant]`: shown through the name filter, which allows `/`.
fn model_name(s: &str) -> Option<&str> {
    mask::safe_name(s)
}

/// `plugin` (V1: a name or `[name, options]`) and `plugins` (V2: a name or `{package, options}`). Options are not shown.
fn plugin_list(c: &mut Ctx, file: &str, root: &Value, key: &str, scope: &'static str) {
    for (i, p) in root
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let spec = p
            .as_str()
            .or_else(|| p.get(0).and_then(Value::as_str))
            .or_else(|| p.get("package").and_then(Value::as_str));
        let Some((name, version, local)) = spec.and_then(plugin_name) else {
            continue;
        };
        let e = Entity::new(
            CLIENT,
            Kind::Plugin,
            scope,
            name,
            State::On,
            file,
            format!("/{key}/{i}"),
        )
        .version(version.as_deref())
        .detail(json!({ "source": if local { "local" } else { "npm" } }));
        c.push(e);
    }
}

const PLUGIN_EXT: [&str; 6] = ["js", "ts", "mjs", "cjs", "mts", "cts"];

/// The shown name of a plugin spec: an npm package (`name@1.2.0` → name and version) or the last part of a local path
/// (`./plugins/local`, `file:///…/x.js`; `…/x/index.ts` is `x`). `None` for a name the masking filter refuses.
fn plugin_name(spec: &str) -> Option<(String, Option<String>, bool)> {
    // an address (`https://user:pass@host/x.tgz`): only the part after the credentials and the query is looked at
    let spec = match spec.split_once("://") {
        Some((_, rest)) if !spec.starts_with("file:") => {
            let rest = rest.split(['?', '#']).next().unwrap_or("");
            &rest[rest.rfind('@').map_or(0, |i| i + 1)..]
        }
        _ => spec,
    };
    let local = spec.starts_with(['.', '/', '\\'])
        || spec.starts_with("file:")
        || spec.as_bytes().get(1) == Some(&b':')
        || spec.contains('/') && !spec.starts_with('@');
    if !local {
        let (name, version) = match spec.rfind('@').filter(|i| *i > 0) {
            Some(i) => (&spec[..i], mask::safe_version(&spec[i + 1..])),
            None => (spec, None),
        };
        return mask::safe_name(name).map(|n| (n.to_owned(), version.map(str::to_owned), false));
    }
    let parts: Vec<&str> = spec.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    let last = *parts.last()?;
    let name = match last.rsplit_once('.') {
        Some(("index", ext)) if PLUGIN_EXT.contains(&ext) => {
            *parts.get(parts.len().checked_sub(2)?)?
        }
        Some((stem, ext)) if PLUGIN_EXT.contains(&ext) => stem,
        _ => last,
    };
    mask::safe_name(name).map(|n| (n.to_owned(), None, true))
}

/// Local plugins: a script file or a directory in `plugin(s)/`.
fn plugin_dir(c: &mut Ctx, dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut items: Vec<_> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let n = p
                .file_name()
                .map(|n| n.to_string_lossy())
                .unwrap_or_default();
            !n.starts_with('.') && n != "node_modules"
        })
        .filter(|p| {
            p.is_dir()
                || p.extension()
                    .is_some_and(|x| PLUGIN_EXT.contains(&x.to_string_lossy().as_ref()))
        })
        .collect();
    items.sort();
    for p in items {
        // a name from the file system, like skill directories: not filtered (see `Entity::fs_named`)
        let raw = if p.is_dir() {
            p.file_name()
        } else {
            p.file_stem()
        };
        let Some(name) = raw.map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
        let e = Entity::new(
            CLIENT,
            Kind::Plugin,
            "user",
            name,
            State::On,
            c.tilde(&p),
            "/",
        )
        .detail(json!({ "source": "local" }))
        .fs_named();
        c.push(e);
    }
}

/// Markdown agents or commands: the file name is the name; `disable` (V1) or `disabled` (V2) in the frontmatter turns one off.
fn md_dir(c: &mut Ctx, dir: &Path, kind: Kind) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<_> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "md"))
        .collect();
    files.sort();
    for p in files {
        let Some(name) = p.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
        let fm = frontmatter::read(&p).unwrap_or_default();
        let off = ["disable", "disabled"]
            .iter()
            .any(|k| fm.get(*k).is_some_and(|v| v == "true"));
        let e = Entity::new(
            CLIENT,
            kind,
            "user",
            name,
            if off { State::Off } else { State::On },
            c.tilde(&p),
            "frontmatter",
        )
        .detail(json!({ "model": fm.get("model").map(String::as_str).and_then(model_name) }))
        .fs_named();
        c.push(e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_is_told_by_the_file_keys() {
        let g = |s: &str| generation(&serde_json::from_str(s).unwrap());
        assert_eq!(
            g(r#"{"mcp":{"servers":{"a":{"type":"local"}}}}"#),
            Some(Gen::V2)
        );
        assert_eq!(
            g(r#"{"mcp":{"servers":{"type":"local","command":["x"]}}}"#),
            Some(Gen::V1)
        );
        assert_eq!(
            g(r#"{"mcp":{"a":{"type":"local","command":["x"]}}}"#),
            Some(Gen::V1)
        );
        assert_eq!(g(r#"{"mcp":{"old":{"enabled":false}}}"#), Some(Gen::V1));
        // V2 servers named like V1 keys
        assert_eq!(
            g(
                r#"{"mcp":{"servers":{"url":{"type":"remote","url":"https://h/mcp"},"type":{"type":"local","command":["x"]}}}}"#
            ),
            Some(Gen::V2)
        );
        // V2 `mcp.timeout` is not a server
        assert_eq!(
            g(r#"{"mcp":{"timeout":{"catalog":1}},"providers":{}}"#),
            Some(Gen::V2)
        );
        assert_eq!(g(r#"{"plugin":["x"]}"#), Some(Gen::V1));
        assert_eq!(g(r#"{"model":"a/b","$schema":"x"}"#), None);
    }

    #[test]
    fn the_system_config_is_read_as_managed_and_never_switched() {
        let dir = std::env::temp_dir().join(format!("loadout-oc-system-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("opencode.json");
        std::fs::write(
            &file,
            r#"{"mcp":{"servers":{"corp":{"type":"remote","url":"https://h/mcp","disabled":true}}},"agents":{"review":{}},"plugins":["corp-guard@1.0.0"]}"#,
        )
        .unwrap();
        let mut c = Ctx {
            home: dir.join("home"),
            entities: vec![],
            warnings: vec![],
            opencode_system: None,
        };
        config(&mut c, &file, "managed");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(
            c.entities.len(),
            3,
            "{:?}",
            c.entities.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        assert!(c
            .entities
            .iter()
            .all(|e| e.scope == "managed" && e.target.is_none()));
        let mcp = c.entities.iter().find(|e| e.kind == Kind::Mcp).unwrap();
        assert_eq!(
            mcp.state,
            State::Off,
            "V2 `disabled: true` is off in the system config too"
        );
        assert!(
            mcp.src.is_none(),
            "a system entry is not a source to edit or copy"
        );
    }

    #[test]
    fn a_server_in_both_files_says_so() {
        let dir = std::env::temp_dir().join(format!("loadout-oc-twins-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let both = r#"{"mcp":{"servers":{"twin":{"type":"local","command":["x"]}}}}"#;
        std::fs::write(dir.join("opencode.json"), both).unwrap();
        std::fs::write(dir.join("opencode.jsonc"), both).unwrap();
        std::fs::write(
            dir.join("lone.json"),
            r#"{"mcp":{"servers":{"lone":{"type":"local","command":["y"]}}}}"#,
        )
        .unwrap();
        let mut c = Ctx {
            home: dir.clone(),
            entities: vec![],
            warnings: vec![],
            opencode_system: None,
        };
        for f in ["opencode.json", "opencode.jsonc", "lone.json"] {
            config(&mut c, &dir.join(f), "user");
        }
        note_twins(&mut c.entities);
        std::fs::remove_dir_all(&dir).ok();
        let noted = |n: &str| {
            c.entities
                .iter()
                .filter(|e| e.name == n && e.note.is_some())
                .count()
        };
        assert_eq!(
            noted("twin"),
            2,
            "both copies of a server in both files carry the note"
        );
        assert_eq!(noted("lone"), 0, "a server in one file has no note");
    }

    #[test]
    fn entries_translate_both_ways() {
        let oc =
            json!({"type":"local","command":["npx","-y","pkg"],"environment":{"K":"v"},"cwd":"."});
        let common = to_common(&oc);
        assert_eq!(common["command"], "npx");
        assert_eq!(common["args"], json!(["-y", "pkg"]));
        assert_eq!(common["env"], json!({"K":"v"}));
        assert_eq!(
            common["cwd"], ".",
            "unknown keys stay to be named as not copied"
        );
        let back = from_common(&json!({"command":"npx","args":["-y","pkg"],"env":{"K":"v"}}));
        assert_eq!(
            back,
            json!({"type":"local","command":["npx","-y","pkg"],"environment":{"K":"v"}})
        );
        let remote = from_common(&json!({"url":"https://x/mcp","headers":{"A":"b"}}));
        assert_eq!(
            remote,
            json!({"type":"remote","url":"https://x/mcp","headers":{"A":"b"}})
        );
    }

    #[test]
    fn plugin_names_from_specs() {
        let n = plugin_name;
        assert_eq!(
            n("opencode-x@1.2.0"),
            Some(("opencode-x".into(), Some("1.2.0".into()), false))
        );
        assert_eq!(
            n("@acme/opencode-plugin"),
            Some(("@acme/opencode-plugin".into(), None, false))
        );
        assert_eq!(n("./plugins/local"), Some(("local".into(), None, true)));
        assert_eq!(
            n("file:///C:/u/p/status-tui/index.ts"),
            Some(("status-tui".into(), None, true))
        );
        assert_eq!(
            n("C:\\u\\p\\status.js"),
            Some(("status".into(), None, true))
        );
        // credentials and the query of an address never become the name
        for url in [
            "https://deploy:hunter2pass@host.example/x.tgz",
            "https://deploy:hunter2pass@host.example",
        ] {
            let (name, _, _) = n(url).unwrap();
            assert!(
                !name.contains("hunter2pass") && !name.contains("deploy"),
                "{name}"
            );
        }
        assert_eq!(n("https://h.example/p/x.tgz?token=abc").unwrap().0, "x.tgz");
    }
}
