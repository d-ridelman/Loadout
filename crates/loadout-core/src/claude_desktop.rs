//! Адаптер Claude Desktop (чат): `%APPDATA%\Claude\claude_desktop_config.json` → `mcpServers`.
//! Облачные коннекторы аккаунта на диске не лежат (CONCEPT.md §5.1): здесь только локальные MCP.

use crate::model::Client;
use crate::{scan_mcp_servers, Ctx};

pub fn scan(c: &mut Ctx) {
    // shortcut: путь Windows (`<дом>/AppData/Roaming`); macOS и Linux добавятся вместе с их сборками.
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
