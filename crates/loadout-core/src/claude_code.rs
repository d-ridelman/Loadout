//! Claude Code adapter (the CLI and the Code tab in Claude Desktop). Sources: the table in CONCEPT.md §2.

use crate::mask::{self, mcp_detail};
use crate::model::{Client, Entity, Format, Kind, Source, Src, State, Target, TargetKind};
use crate::{esc_ptr, frontmatter, scan_hooks, scan_skills, Ctx};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

const CLIENT: Client = Client::ClaudeCode;
/// Top-level keys of `~/.claude.json` that hold "disabled" MCP servers (the owner's stash, not an official Claude Code mechanism).
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
    // `deniedMcpServers`: `[{serverName | serverCommand | serverUrl: …}]`, applies from any settings file
    // (Claude Code docs, managed-mcp.md). We match by `serverName` only: claude.ai connectors
    // are named the same way (`claude.ai Slack`). M1 does not match by command or URL.
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
    let first = c.entities.len();
    scan_skills(c, CLIENT, &skills, "user");
    // `/skills` saves to `settings.local.json`, which outranks the user file key by key (docs, settings precedence)
    let local = c.read_json(&c.home.join(".claude/settings.local.json"));
    let mut overrides: HashMap<String, (String, &str)> = HashMap::new();
    for (s, file) in [
        (settings.as_ref(), "~/.claude/settings.json"),
        (local.as_ref(), "~/.claude/settings.local.json"),
    ] {
        let o = s
            .and_then(|s| s.get("skillOverrides"))
            .and_then(Value::as_object);
        for (name, v) in o.into_iter().flatten() {
            if let Some(v) = v.as_str() {
                overrides.insert(name.clone(), (v.to_owned(), file));
            }
        }
    }
    skill_overrides(&mut c.entities[first..], &overrides);
    md_dir(c, "agents", Kind::Agent);
    md_dir(c, "commands", Kind::Command);
    if let Some(h) = settings.as_ref().and_then(|s| s.get("hooks")) {
        let real = c.home.join(".claude/settings.json");
        scan_hooks(
            c,
            CLIENT,
            "~/.claude/settings.json",
            "/hooks",
            "user",
            h,
            Some(&real),
        );
    }
}

/// `skillOverrides` (skill name → value, file it came from): `on` | `name-only` | `user-invocable-only` | `off`
/// (Claude Code docs, settings-reference). Only `off` hides the skill from both Claude and the `/` menu.
fn skill_overrides(skills: &mut [Entity], o: &HashMap<String, (String, &str)>) {
    for e in skills {
        let Some((value, file)) = o.get(&e.name) else {
            continue;
        };
        let note = match value.as_str() {
            "off" => {
                e.state = State::Off;
                crate::tr!(
                    "выключен в skillOverrides (\"off\", {file}): Claude его не видит, в меню / его нет",
                    "turned off in skillOverrides (\"off\", {file}): Claude does not see it, it is not in the / menu"
                )
            }
            "name-only" => crate::tr!(
                "skillOverrides (\"name-only\", {file}): Claude видит только имя, без описания",
                "skillOverrides (\"name-only\", {file}): Claude sees the name only, without the description"
            ),
            "user-invocable-only" => crate::tr!(
                "skillOverrides (\"user-invocable-only\", {file}): Claude его не видит, вызвать можно только вручную через /",
                "skillOverrides (\"user-invocable-only\", {file}): Claude does not see it, it can only be invoked by hand via /"
            ),
            _ => continue,
        };
        e.note = Some(match e.note.take() {
            Some(n) => format!("{n}; {note}"),
            None => note,
        });
    }
}

/// A boolean key in `~/.claude/settings.json` (write target R1).
fn settings_flag(c: &Ctx, path: &[&str]) -> Target {
    Target {
        file: c.home.join(".claude/settings.json"),
        format: Format::Json,
        path: path.iter().map(|s| (*s).to_owned()).collect(),
        inverted: false,
        kind: TargetKind::Flag,
    }
}

fn plugins(c: &mut Ctx, settings: Option<&Value>) {
    let file = "~/.claude/plugins/installed_plugins.json";
    let installed = c.read_json(&c.home.join(".claude/plugins/installed_plugins.json"));
    let enabled = settings
        .and_then(|s| s.get("enabledPlugins"))
        .and_then(Value::as_object);
    let mut seen = HashSet::new();
    // many plugins share one project: each settings file is read (and warned about) once
    let mut project_files: HashMap<PathBuf, Option<Value>> = HashMap::new();

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
        // Different versions in one scope are a discrepancy (stale). In different scopes this is normal, just a mark.
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
                Some(_) => "other".to_owned(), // an unknown value from the file is not let into the output
                None => "user".to_owned(),
            };
            let is_user = scope == "user";
            let install = r.get("installPath").and_then(Value::as_str).map(Path::new);
            let path_ok = install.is_some_and(Path::exists);
            let flag = enabled.and_then(|m| m.get(key)).and_then(Value::as_bool);
            let by_default = |c: &mut Ctx| {
                let on = install
                    .and_then(|p| c.read_json(&p.join(".claude-plugin/plugin.json")))
                    .and_then(|m| m.get("defaultEnabled").and_then(Value::as_bool))
                    .unwrap_or(true);
                (
                    if on { State::On } else { State::Off },
                    Some(crate::tr!(
                        "нет записи в enabledPlugins: действует defaultEnabled = {on} (из манифеста плагина или по умолчанию; запись маркетплейса Loadout не читает)",
                        "no entry in enabledPlugins: defaultEnabled = {on} applies (from the plugin manifest or the default; Loadout does not read the marketplace entry)"
                    )),
                )
            };
            let (state, note) = if !path_ok {
                (
                    State::Broken,
                    Some(crate::tr!(
                        "installPath не существует на диске",
                        "installPath does not exist on disk"
                    )),
                )
            } else if scope.starts_with("project:") || scope == "local" {
                let raw = r.get("projectPath").and_then(Value::as_str);
                match raw.and_then(project_dir) {
                    None => (
                        State::Unknown,
                        Some(crate::tr!(
                            "projectPath не указан или не принят (относительный, с `..` или сетевой): настройки проекта не прочитаны",
                            "projectPath is missing or not accepted (relative, with `..` or a network path): project settings were not read"
                        )),
                    ),
                    Some(dir) if !dir.is_dir() => (
                        State::Unknown,
                        Some(crate::tr!(
                            "каталог проекта {} не найден",
                            "project directory {} not found",
                            c.tilde(&dir)
                        )),
                    ),
                    Some(dir) => {
                        let user_flag = flag.map(|b| (b, "~/.claude/settings.json".to_owned()));
                        match project_flag(c, &mut project_files, &dir, key).map(|f| f.or(user_flag)) {
                            Ok(Some((on, from))) => (
                                if on { State::On } else { State::Off },
                                Some(crate::tr!(
                                    "флаг включения взят из {from}",
                                    "the enable flag comes from {from}"
                                )),
                            ),
                            Ok(None) => by_default(c),
                            Err(file) => (
                                State::Unknown,
                                Some(crate::tr!(
                                    "{file} не прочитан (см. предупреждения сканера): флаг включения неизвестен",
                                    "{file} could not be read (see the scanner warnings): the enable flag is unknown"
                                )),
                            ),
                        }
                    }
                }
            } else if !is_user {
                (
                    State::Unknown,
                    Some(crate::tr!(
                        "флаг включения лежит в настройках области «{scope}», Loadout их не читает",
                        "the enable flag is in the settings of scope “{scope}”, Loadout does not read them"
                    )),
                )
            } else {
                match flag {
                    Some(true) if user_versions.len() > 1 => (
                        State::Stale,
                        Some(crate::tr!(
                            "в области user записано версий: {}",
                            "versions recorded in scope user: {}",
                            user_versions.len()
                        )),
                    ),
                    Some(true) if all_versions.len() > 1 => (
                        State::On,
                        Some(crate::tr!(
                            "в другой области (project/local) стоит другая версия",
                            "another scope (project/local) has a different version"
                        )),
                    ),
                    Some(true) => (State::On, None),
                    Some(false) => (State::Off, None),
                    None => by_default(c),
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
            .note(crate::tr!(
                "включён в enabledPlugins, но не установлен",
                "enabled in enabledPlugins but not installed"
            ))
            .target(settings_flag(c, &["enabledPlugins", key]));
            c.push(e);
        }
    }
}

/// `projectPath` from `installed_plugins.json`: only an absolute local path without `..` is read.
pub(crate) fn project_dir(raw: &str) -> Option<PathBuf> {
    let p = PathBuf::from(raw);
    let network = raw.starts_with("\\\\") || raw.starts_with("//");
    (p.is_absolute() && !network && !p.components().any(|x| x == Component::ParentDir)).then_some(p)
}

/// The project's own `enabledPlugins` value: `.claude/settings.local.json` over `.claude/settings.json`
/// (Claude Code docs, plugins/loading, "Find where a plugin is enabled"). Returns the value and the file it came from;
/// `Err(file)` when a file that decides first exists but could not be read (the scan warns about it).
fn project_flag(
    c: &mut Ctx,
    files: &mut HashMap<PathBuf, Option<Value>>,
    dir: &Path,
    key: &str,
) -> Result<Option<(bool, String)>, String> {
    for name in ["settings.local.json", "settings.json"] {
        let p = dir.join(".claude").join(name);
        if !files.contains_key(&p) {
            let v = c.read_json(&p);
            files.insert(p.clone(), v);
        }
        let Some(v) = files[&p].as_ref() else {
            if p.exists() {
                return Err(c.tilde(&p));
            }
            continue;
        };
        let flag = v
            .get("enabledPlugins")
            .and_then(|m| m.get(key))
            .and_then(Value::as_bool);
        if let Some(b) = flag {
            return Ok(Some((b, c.tilde(&p))));
        }
    }
    Ok(None)
}

fn marketplaces(c: &mut Ctx) {
    let Some(v) = c.read_json(&c.home.join(".claude/plugins/known_marketplaces.json")) else {
        return;
    };
    let Some(map) = v.as_object() else {
        c.warnings.push(crate::tr!(
            "~/.claude/plugins/known_marketplaces.json: ожидался объект",
            "~/.claude/plugins/known_marketplaces.json: an object was expected"
        ));
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
    let claude_json = c.home.join(".claude.json");
    let Some(v) = c.read_json(&claude_json) else {
        return;
    };
    let file = "~/.claude.json";
    let mut found = Vec::new();

    // claude.ai cloud connectors (CONCEPT.md §5.1, C0/C1): on disk there are only the names of those "ever connected",
    // the source of truth is the account. Locally they are switched off by the single key `disableClaudeAiConnectors`.
    for (i, name) in v
        .get("claudeAiMcpEverConnected")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .enumerate()
    {
        let (state, note) = if connectors_off {
            (
                State::Off,
                crate::tr!(
                    "выключены в Claude Code ключом disableClaudeAiConnectors (все сразу); аккаунт и Desktop не затронуты",
                    "turned off in Claude Code by the disableClaudeAiConnectors key (all at once); the account and Desktop are not affected"
                ),
            )
        } else {
            (
                State::Cloud,
                crate::tr!(
                    "в списке «когда-либо подключались»; источник правды — аккаунт claude.ai",
                    "in the “ever connected” list; the source of truth is the claude.ai account"
                ),
            )
        };
        let mut t = settings_flag(c, &["disableClaudeAiConnectors"]);
        t.inverted = true; // `true` in the file means the connectors are off, all of them at once
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
        let live = vec!["mcpServers".to_owned(), name.clone()];
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
            .detail(mcp_detail(cfg))
            // switching off cuts the entry into the Loadout trash (MCP has no "disabled" flag)
            .target(Target {
                file: claude_json.clone(),
                format: Format::Json,
                path: live.clone(),
                inverted: false,
                kind: TargetKind::Cut,
            })
            .src(Src {
                file: claude_json.clone(),
                format: Format::Json,
                path: live,
            }),
        );
    }
    for key in STASH_KEYS {
        for (name, cfg) in v.get(key).and_then(Value::as_object).into_iter().flatten() {
            if name.starts_with('_') {
                continue; // `_note` and the like are not servers
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
                .note(crate::tr!(
                    "лежит вне mcpServers, Claude Code его не запускает (стэш, не штатный ключ)",
                    "lies outside mcpServers, Claude Code does not launch it (owner's stash, not a standard key)"
                ))
                .detail(mcp_detail(cfg))
                // switching on moves the entry back into mcpServers within the same file
                .target(Target {
                    file: claude_json.clone(),
                    format: Format::Json,
                    path: vec![key.to_owned(), name.clone()],
                    inverted: false,
                    kind: TargetKind::Restore(Source::Stash(vec![key.to_owned()])),
                }),
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
            found.push(local_mcp(c, &claude_json, path, name, cfg));
        }
    }
    for mut e in found {
        if denied.contains(&e.name) {
            // the `disableClaudeAiConnectors` key does not lift a by-name denial, even when the connector is already off through that key
            e.target = None;
            if e.state != State::Off || e.kind == Kind::Connector {
                e.state = State::Off;
                e.note = Some(crate::tr!(
                    "запрещён в deniedMcpServers (по имени)",
                    "denied in deniedMcpServers (by name)"
                ));
            }
        }
        c.push(e);
    }
}

/// A local-scope server: `~/.claude.json` → `projects.<key>.mcpServers.<name>`. Read only (Loadout does not toggle it),
/// but it can be copied to another client in the same project.
pub(crate) fn local_mcp(c: &Ctx, claude_json: &Path, key: &str, name: &str, cfg: &Value) -> Entity {
    // `shown` is the display path (with `~`), not the real `projects` key; the copy source keeps the real key.
    let shown = c.tilde(Path::new(key));
    let mut e = Entity::new(
        CLIENT,
        Kind::Mcp,
        format!("project:{shown}"),
        name.to_owned(),
        State::On,
        c.tilde(claude_json),
        format!("/projects/{}/mcpServers/{}", esc_ptr(&shown), esc_ptr(name)),
    )
    .detail(mcp_detail(cfg))
    .copy_from(crate::model::CopyFrom::Entry(Src {
        file: claude_json.to_path_buf(),
        format: Format::Json,
        path: vec![
            "projects".into(),
            key.to_owned(),
            "mcpServers".into(),
            name.to_owned(),
        ],
    }));
    if let Some(dir) = project_dir(key) {
        e.project = Some(crate::projects::id_of(&dir));
    }
    e
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
        // the name from frontmatter goes through the same filter as skill names
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
