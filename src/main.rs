mod backslash;
mod check;
mod guard;
mod setup;

use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Client {
    Claude,
    Antigravity,
    /// DeepSeek Harness via @deepseek-ai/dsh-hooks-claude-code: Claude hook protocol, DSH tool names.
    Dsh,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    En,
    Ru,
}

pub fn parse_lang(s: &str) -> Option<Lang> {
    let norm = s.trim().to_ascii_lowercase();
    if norm == "ru" || norm.starts_with("ru_") || norm.starts_with("ru-") {
        Some(Lang::Ru)
    } else if norm == "en" || norm.starts_with("en_") || norm.starts_with("en-") {
        Some(Lang::En)
    } else {
        None
    }
}

pub fn t(lang: Lang, en: &'static str, ru: &'static str) -> &'static str {
    match lang {
        Lang::En => en,
        Lang::Ru => ru,
    }
}

fn detect_lang(args: &[String]) -> Lang {
    let mut i = 0;
    while i < args.len() {
        if let Some(val) = args[i].strip_prefix("--lang=") {
            if let Some(l) = parse_lang(val) {
                return l;
            }
        } else if args[i] == "--lang" {
            if let Some(val) = args.get(i + 1) {
                if let Some(l) = parse_lang(val) {
                    return l;
                }
            }
        }
        i += 1;
    }
    env::var("CTXKIT_LANG")
        .ok()
        .and_then(|v| parse_lang(&v))
        .unwrap_or(Lang::En)
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("check") => std::process::exit(check::run_check(&args[1..])),
        Some("setup") => std::process::exit(setup::run_setup(&args[1..])),
        Some("--version" | "-V") => {
            println!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
            return;
        }
        _ => {}
    }

    let mut forced_client: Option<Client> = None;
    let mut forced_post = false;
    for a in &args {
        match a.as_str() {
            "--agy" => forced_client = Some(Client::Antigravity),
            "--claude" => forced_client = Some(Client::Claude),
            "--dsh" => forced_client = Some(Client::Dsh),
            "--post" => forced_post = true,
            _ => {}
        }
    }

    let lang = detect_lang(&args);

    let mut raw = String::new();
    if io::stdin().read_to_string(&mut raw).is_err() {
        return;
    }
    // A BOM before the payload must not turn the hook into a silent pass.
    let Ok(call) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) else {
        return;
    };

    let client = forced_client.unwrap_or_else(|| {
        if call.get("toolCall").is_some() {
            Client::Antigravity
        } else if matches!(
            call["tool_name"].as_str(),
            Some("read" | "write" | "edit" | "bash" | "pwsh")
        ) {
            Client::Dsh
        } else {
            Client::Claude
        }
    });

    match client {
        Client::Antigravity => handle_antigravity(&call, forced_post, lang),
        Client::Claude | Client::Dsh => handle_claude(&call, forced_post, lang, client),
    }
}

fn handle_antigravity(call: &Value, forced_post: bool, lang: Lang) {
    if forced_post || call.get("error").is_some() {
        print!("{{}}");
        return;
    }

    let tc = &call["toolCall"];
    let tool = tc["name"].as_str().unwrap_or("");
    let args = &tc["args"];

    let reason = match tool {
        "read_file" => {
            let path = args["Path"].as_str().unwrap_or("");
            let start = args["StartLine"].as_u64();
            let end = args["EndLine"].as_u64();
            let limit = end.map(|e| e.saturating_sub(start.unwrap_or(1).max(1)) + 1);
            guard::read_guard(path, start, limit, Client::Antigravity, lang)
        }
        "write_file" => {
            let path = args["Path"].as_str().unwrap_or("");
            let content = args["Content"].as_str().unwrap_or("");
            backslash::pre_reason("Write", path, content, "", Client::Antigravity, lang)
        }
        "run_command" => {
            let cmd = args["CommandLine"].as_str().unwrap_or("");
            backslash::pre_reason("run_command", "", "", cmd, Client::Antigravity, lang)
                .or_else(|| guard::shell_read_guard("run_command", cmd, Client::Antigravity, lang))
        }
        _ => None,
    };

    if let Some(reason) = reason {
        let out = json!({
            "decision": "deny",
            "reason": reason
        });
        print!("{out}");
    } else {
        // Delegate to Antigravity's built-in confirmation policy rather than auto-allowing.
        print!(r#"{{"decision":"ask"}}"#);
    }
}

/// DSH tool names differ from Claude Code only in case/spelling; arguments are the same.
fn claude_tool_name(tool: &str, client: Client) -> &str {
    match (client, tool) {
        (Client::Dsh, "read") => "Read",
        (Client::Dsh, "write") => "Write",
        (Client::Dsh, "bash") => "Bash",
        (Client::Dsh, "pwsh") => "PowerShell",
        _ => tool,
    }
}

fn handle_claude(call: &Value, forced_post: bool, lang: Lang, client: Client) {
    let event = call["hook_event_name"].as_str().unwrap_or("");
    let tool = claude_tool_name(call["tool_name"].as_str().unwrap_or(""), client);
    let input = &call["tool_input"];

    if forced_post || event == "PostToolUse" {
        let path = input["file_path"].as_str().unwrap_or("");
        if let Some(err) = backslash::post_syntax_error(path) {
            let edit = if client == Client::Dsh { "edit" } else { "Edit" };
            let reason = match lang {
                Lang::En => format!(
                    "File {path} failed syntax check after edit (likely a lost or extra backslash). Fix it with {edit}:\n{err}"
                ),
                Lang::Ru => format!(
                    "После правки файл {path} не разбирается. Возможно, потерян или лишний обратный слеш. Исправь инструментом {edit}:\n{err}"
                ),
            };
            let out = json!({
                "decision": "block",
                "reason": reason
            });
            print!("{out}");
        }
        return;
    }

    if tool == "Read" {
        let path = input["file_path"].as_str().unwrap_or("");
        let offset = input["offset"].as_u64();
        let limit = input["limit"].as_u64();
        if let Some(reason) = guard::read_guard(path, offset, limit, client, lang) {
            deny_claude(reason);
        }
        return;
    }

    let path = input["file_path"].as_str().unwrap_or("");
    let content = input["content"].as_str().unwrap_or("");
    let command = input["command"].as_str().unwrap_or("");

    if let Some(reason) = backslash::pre_reason(tool, path, content, command, client, lang) {
        deny_claude(reason);
        return;
    }

    if tool == "Bash" || tool == "PowerShell" {
        if let Some(reason) = guard::shell_read_guard(tool, command, client, lang) {
            deny_claude(reason);
        }
    }
}

fn deny_claude(reason: String) {
    let out = json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason
        }
    });
    print!("{out}");
}
