//! Claude Desktop (chat) adapter:`%APPDATA%\Claude\claude_desktop_config.json` → `mcpServers`.
//! Account cloud connectors are not on disk (CONCEPT.md §5.1): only local MCP servers here.

use crate::model::Client;
use crate::{scan_mcp_servers, Ctx};

pub fn scan(c: &mut Ctx) {
    // shortcut: Windows path (`<home>/AppData/Roaming`); macOS and Linux will be added together with their builds.
    let path = c
        .home
        .join("AppData/Roaming/Claude/claude_desktop_config.json");
    if let Some(v) = c.read_json(&path) {
        let file = c.tilde(&path);
        scan_mcp_servers(
            c,
            Client::ClaudeDesktop,
            &file,
            "/mcpServers",
            "user",
            v.get("mcpServers"),
            Some(&path),
        );
    }
}
