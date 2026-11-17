//! Check against the owner's real configs. The test is `#[ignore]`: it reads real files (secret values
//! stay in the test's memory and are never printed) and is run manually:
//!
//! ```text
//! cargo test -p loadout-core --test real_machine -- --ignored --nocapture
//! ```
//!
//! M1 exit criterion: no value of a secret-named key (`token`, `secret`, `password`, `*key`, …) and no
//! value from `env` and MCP headers appears in the scanner output. There is one deliberate exception: an address
//! without credentials (`https://host:port`) is shown, it is not a secret.

use loadout_core::mask::is_secret_key;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// A value the core shows deliberately: an address without user, password, query and path.
fn harmless_address(v: &str) -> bool {
    v.split_once("://").is_some_and(|(scheme, rest)| {
        matches!(scheme, "http" | "https") && !rest.contains(['@', '?', '#', '/'])
    })
}

/// Value → name of the key it sits under (the key name is not a secret and is needed to analyse matches).
type Secrets = BTreeMap<String, String>;

fn collect(node: &Value, out: &mut Secrets) {
    match node {
        Value::Object(o) => {
            for (k, v) in o {
                let container = matches!(
                    k.as_str(),
                    "env" | "environment" | "headers" | "http_headers" | "env_http_headers"
                );
                match v {
                    Value::String(s) if is_secret_key(k) => {
                        out.entry(s.clone()).or_insert_with(|| k.clone());
                    }
                    Value::Object(inner) if container => {
                        for (name, val) in inner {
                            if let Some(s) = val.as_str() {
                                out.entry(s.to_owned())
                                    .or_insert_with(|| format!("{k}.{name}"));
                            }
                        }
                    }
                    _ => {}
                }
                collect(v, out);
            }
        }
        Value::Array(a) => {
            // value after a secret flag: ["--token", "…"]
            for pair in a.windows(2) {
                if let (Some(flag), Some(val)) = (pair[0].as_str(), pair[1].as_str()) {
                    if flag.starts_with('-') && is_secret_key(flag.trim_start_matches('-')) {
                        out.entry(val.to_owned())
                            .or_insert_with(|| format!("arg {flag}"));
                    }
                }
            }
            a.iter().for_each(|x| collect(x, out));
        }
        _ => {}
    }
}

#[test]
#[ignore = "reads the owner's real configs; run manually"]
fn no_secret_value_reaches_the_scan_output() {
    let Some(home) = home() else { return };
    let mut secrets = Secrets::new();

    for rel in [
        ".claude.json",
        ".claude/settings.json",
        ".codex/hooks.json",
        ".gemini/config/mcp_config.json",
        "AppData/Roaming/Claude/claude_desktop_config.json",
    ] {
        if let Ok(text) = std::fs::read_to_string(home.join(rel)) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                collect(&v, &mut secrets);
            }
        }
    }
    for rel in [
        ".config/opencode/opencode.json",
        ".config/opencode/opencode.jsonc",
    ] {
        if let Ok(text) = std::fs::read_to_string(home.join(rel)) {
            if let Ok(Some(v)) = jsonc_parser::parse_to_serde_value(&text, &Default::default()) {
                collect(&v, &mut secrets);
            }
        }
    }
    if let Ok(text) = std::fs::read_to_string(home.join(".codex/config.toml")) {
        if let Ok(t) = text.parse::<toml::Table>() {
            if let Ok(v) = serde_json::to_value(&t) {
                collect(&v, &mut secrets);
            }
        }
    }
    // Values that coincide with client names (`claude-code` in `env.GLIDEHAND_OVERLAY_NAME`) appear in the
    // output in every entry as the `client` field: that is a word match, not a leak.
    let slugs: Vec<&str> = loadout_core::model::Client::ALL
        .iter()
        .map(|c| c.slug())
        .collect();
    secrets.retain(|s, _| {
        s.len() >= 6 && !harmless_address(s) && !slugs.contains(&s.to_lowercase().as_str())
    });

    let result = loadout_core::scan(&home);
    let out = serde_json::to_string(&result).expect("output serialises");

    // Lower bound: "zero leaks" must not come from the scanner silently finding nothing
    // (a rejected file, hidden names, merged entries).
    assert!(
        result.warnings.is_empty(),
        "scan warnings: {:?}",
        result.warnings
    );
    for (dir, client) in [
        (".claude", "claude-code"),
        (".codex", "codex"),
        (".gemini/config", "antigravity"),
        (".dsh", "deepseek"),
        (".config/opencode", "opencode"),
    ] {
        if home.join(dir).is_dir() {
            let n = result
                .entities
                .iter()
                .filter(|e| e.client.slug() == client)
                .count();
            assert!(
                n > 0,
                "directory {dir} exists but there are no {client} entries"
            );
        }
    }
    if home.join(".dsh/cordis.patch.yml").is_file() {
        let mcp = result
            .entities
            .iter()
            .filter(|e| e.client.slug() == "deepseek" && e.kind == loadout_core::model::Kind::Mcp)
            .count();
        assert!(
            mcp > 0,
            "cordis.patch.yml exists but no dsh MCP found: file rejected?"
        );
    }
    let hidden: Vec<_> = result
        .entities
        .iter()
        // a pointer with a project path may be partly hidden (a segment looks like a token): rows do not merge because of that,
        // and the id is computed before hiding
        .filter(|e| {
            [&e.name, &e.logical_key, &e.scope]
                .iter()
                .any(|s| s.contains("<masked"))
        })
        .map(|e| format!("{}/{:?}/{}", e.client.slug(), e.kind, e.logical_key))
        .collect();
    assert!(hidden.is_empty(), "hidden names merge entries: {hidden:?}");
    let hits: Vec<(&String, &String)> = secrets
        .iter()
        .filter(|(value, _)| out.contains(value.as_str()))
        .collect();
    let leaked = hits.len();
    println!(
        "secret values checked: {}, found in the output: {leaked}",
        secrets.len()
    );
    for (value, key) in &hits {
        let where_found: Vec<String> = result
            .entities
            .iter()
            .filter(|e| serde_json::to_string(e).is_ok_and(|j| j.contains(value.as_str())))
            .take(3)
            .map(|e| format!("{}/{:?}/{}", e.client.slug(), e.kind, e.name))
            .collect();
        println!("  where: {where_found:?}");
        // name of the source key and the shape of the match; the value itself is not printed
        println!(
            "  match: key '{key}', length {}, has ://: {}, has space: {}, has path: {}",
            value.len(),
            value.contains("://"),
            value.contains(' '),
            value.contains('/'),
        );
    }
    assert_eq!(leaked, 0, "secret values leaked into the scanner output");

    let user = home
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let path_hits = out
        .to_lowercase()
        .matches(&format!("/users/{user}"))
        .count()
        + out
            .to_lowercase()
            .matches(&format!("\\\\users\\\\{user}"))
            .count();
    assert_eq!(path_hits, 0, "home directory path leaked into the output");
}
