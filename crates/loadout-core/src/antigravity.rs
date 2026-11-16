//! Antigravity adapter. File shapes were taken from this machine (key names), see the table in CONCEPT.md §2.
//!
//! - `~/.gemini/config/mcp_config.json`: `{mcpServers: {name: {command, args, env?}}}`; no "disabled" flag is visible.
//! - `~/.gemini/config/hooks.json`: `{group: {Event: [{matcher?, hooks: [...]}]}}`, i.e. the Claude Code format
//!   one level deeper.
//! - `~/.gemini/config/plugins/<dir>/{plugin.json, mcp_config.json, skills/}`: plugins.
//! - skills: `~/.gemini/config/skills`, built-in ones in `~/.gemini/antigravity/builtin/skills` and `antigravity-cli/builtin/skills`.

use crate::mask;
use crate::model::{Client, Entity, Kind, State};
use crate::{scan_hooks, scan_mcp_servers, scan_skills, Ctx};
use serde_json::{json, Value};

const CLIENT: Client = Client::Antigravity;

pub fn scan(c: &mut Ctx) {
    let mcp = c.home.join(".gemini/config/mcp_config.json");
    if let Some(v) = c.read_json(&mcp) {
        let file = c.tilde(&mcp);
        scan_mcp_servers(
            c,
            CLIENT,
            &file,
            "/mcpServers",
            "user",
            v.get("mcpServers"),
            Some(&mcp),
        );
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
            "user",
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

        // MCP servers and skills that the plugin brings
        let scope = format!("plugin:{name}");
        let mcp = d.path().join("mcp_config.json");
        if let Some(v) = c.read_json(&mcp) {
            let file = c.tilde(&mcp);
            // plugin files belong to the plugin: Loadout does not write to them
            scan_mcp_servers(
                c,
                CLIENT,
                &file,
                "/mcpServers",
                &scope,
                v.get("mcpServers"),
                None,
            );
        }
        scan_skills(c, CLIENT, &d.path().join("skills"), &scope);
    }
}
