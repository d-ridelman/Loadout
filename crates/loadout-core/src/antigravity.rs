//! Адаптер Antigravity. Формы файлов сняты с этой машины (имена ключей), см. таблицу §2 CONCEPT.md.
//!
//! - `~/.gemini/config/mcp_config.json` — `{mcpServers: {имя: {command, args, env?}}}`; флага «выключено» не видно.
//! - `~/.gemini/config/hooks.json` — `{группа: {Событие: [{matcher?, hooks: [...]}]}}`, то есть формат Claude Code
//!   на уровень глубже.
//! - `~/.gemini/config/plugins/<каталог>/{plugin.json, mcp_config.json, skills/}` — плагины.
//! - скилы: `~/.gemini/config/skills`, встроенные в `~/.gemini/antigravity/builtin/skills` и `antigravity-cli/builtin/skills`.

use crate::mask;
use crate::model::{Client, Entity, Kind, State};
use crate::{scan_hooks, scan_mcp_servers, scan_skills, Ctx};
use serde_json::{json, Value};

const CLIENT: Client = Client::Antigravity;

pub fn scan(c: &mut Ctx) {
    let mcp = c.home.join(".gemini/config/mcp_config.json");
    if let Some(v) = c.read_json(&mcp) {
        let file = c.tilde(&mcp);
        scan_mcp_servers(c, CLIENT, &file, "/mcpServers", "user", v.get("mcpServers"));
    }
    hooks(c);
    plugins(c);
    for (rel, scope) in [
        (".gemini/config/skills", "user"),
        (".gemini/antigravity/builtin/skills", "builtin"),
        (".gemini/antigravity-cli/builtin/skills", "builtin"),
    ] {
        let dir = c.home.join(rel);
        scan_skills(c, CLIENT, &dir, scope);
    }
}

fn hooks(c: &mut Ctx) {
    let path = c.home.join(".gemini/config/hooks.json");
    let Some(v) = c.read_json(&path) else { return };
    let file = c.tilde(&path);
    for (group, events) in v.as_object().into_iter().flatten() {
        scan_hooks(
            c,
            CLIENT,
            &file,
            &format!("/{}", crate::esc_ptr(group)),
            events,
        );
    }
}

fn plugins(c: &mut Ctx) {
    let root = c.home.join(".gemini/config/plugins");
    let Ok(rd) = std::fs::read_dir(&root) else {
        return;
    };
    let mut dirs: Vec<_> = rd.flatten().filter(|e| e.path().is_dir()).collect();
    dirs.sort_by_key(|e| e.file_name());
    for d in dirs {
        let dir_name = d.file_name().to_string_lossy().into_owned();
        let manifest = d.path().join("plugin.json");
        let Some(m) = c.read_json(&manifest) else {
            continue;
        };
        let name = m
            .get("name")
            .and_then(Value::as_str)
            .and_then(mask::safe_name)
            .map_or_else(|| dir_name.clone(), str::to_owned);
        let e = Entity::new(
            CLIENT,
            Kind::Plugin,
            "user",
            name.clone(),
            State::On,
            c.tilde(&manifest),
            "/name",
        )
        .version(
            m.get("version")
                .and_then(Value::as_str)
                .and_then(mask::safe_version),
        )
        .detail(json!({
            "displayName": m.get("displayName").and_then(Value::as_str).and_then(mask::safe_name),
        }));
        c.push(e);

        // MCP и скилы, которые приносит плагин
        let scope = format!("plugin:{name}");
        let mcp = d.path().join("mcp_config.json");
        if let Some(v) = c.read_json(&mcp) {
            let file = c.tilde(&mcp);
            scan_mcp_servers(c, CLIENT, &file, "/mcpServers", &scope, v.get("mcpServers"));
        }
        scan_skills(c, CLIENT, &d.path().join("skills"), &scope);
    }
}
