mod backslash;
mod check;
mod doctor;
mod fsx;
mod gate;
mod guard;
mod report;
mod setup;

use serde_json::{json, Value};
use std::env;
use std::io::{self, Read};
use std::path::PathBuf;

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

/// The one rule of the emergency switches `CTXKIT_GUARD` and `CTXKIT_GATE`: the value, trimmed and
/// without regard to case, is `0`, `off`, `false` or `no`. Anything else (or unset) leaves the hook on.
fn is_off_value(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "0" | "off" | "false" | "no"
    )
}

pub fn env_off(name: &str) -> bool {
    env::var(name).is_ok_and(|v| is_off_value(&v))
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("check") => std::process::exit(check::run_check(&args[1..])),
        Some("setup") => std::process::exit(setup::run_setup(&args[1..])),
        Some("doctor") => std::process::exit(doctor::run_doctor(&args[1..])),
        Some("report") => std::process::exit(report::run_report(&args[1..])),
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

    // A hook must never break the user's work: any failure below (bad input, a panic) is a pass,
    // exit 0 and (for Claude Code and DSH) empty stdout. Only a deliberate rule match prints a block/deny.
    // Antigravity wants a JSON answer every time (`decision` is required in its PreToolUse contract, see
    // docs/ARCHITECTURE.md), so in `--agy` mode a pass is spelled out: `agy_pass`.
    std::panic::set_hook(Box::new(|_| {}));
    let done = std::panic::catch_unwind(|| run_hook(&args, forced_client, forced_post));
    if done.is_err() && forced_client == Some(Client::Antigravity) {
        agy_pass(forced_post);
    }
}

/// Antigravity's "no opinion": `ask` leaves the decision to its own confirmation policy (never `allow`, which
/// would auto-approve); a PostToolUse answer is an empty object.
fn agy_pass(post: bool) {
    print!("{}", if post { "{}" } else { r#"{"decision":"ask"}"# });
}

/// Largest hook payload we parse; a bigger one is passed unchecked rather than held in memory.
const MAX_STDIN: u64 = 64 * 1024 * 1024;

fn run_hook(args: &[String], forced_client: Option<Client>, forced_post: bool) {
    let lang = detect_lang(args);
    // Without a readable payload only the `--agy` flag tells which client is waiting for the answer.
    let unreadable = || {
        if forced_client == Some(Client::Antigravity) {
            agy_pass(forced_post);
        }
    };

    let mut buf = Vec::new();
    if io::stdin()
        .lock()
        .take(MAX_STDIN + 1)
        .read_to_end(&mut buf)
        .is_err()
        || buf.len() as u64 > MAX_STDIN
    {
        return unreadable();
    }
    let Ok(raw) = String::from_utf8(buf) else {
        return unreadable();
    };
    // A BOM before the payload must not turn the hook into a silent pass.
    let Ok(call) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) else {
        return unreadable();
    };

    let client = forced_client.unwrap_or_else(|| {
        if call.get("toolCall").is_some() {
            Client::Antigravity
        } else if matches!(
            call["tool_name"].as_str(),
            Some("read" | "write" | "edit" | "apply_patch" | "bash" | "pwsh")
        ) {
            Client::Dsh
        } else {
            Client::Claude
        }
    });
    // Emergency switch for PreToolUse/PostToolUse (the Stop gate has its own CTXKIT_GATE=0).
    if call["hook_event_name"].as_str() != Some("Stop") && env_off("CTXKIT_GUARD") {
        if client == Client::Antigravity {
            agy_pass(forced_post || call.get("error").is_some());
        }
        return;
    }

    match client {
        Client::Antigravity => handle_antigravity(&call, forced_post, lang),
        Client::Claude | Client::Dsh => handle_claude(&call, forced_post, lang, client),
    }
}

fn handle_antigravity(call: &Value, forced_post: bool, lang: Lang) {
    if forced_post || call.get("error").is_some() {
        agy_pass(true);
        return;
    }

    let cwd: Option<PathBuf> = call.get("cwd").and_then(|v| v.as_str()).map(PathBuf::from);
    let tc = &call["toolCall"];
    let tool = tc["name"].as_str().unwrap_or("");
    let args = &tc["args"];

    let reason = match tool {
        "read_file" => {
            let path = args["Path"].as_str().unwrap_or("");
            let start = args["StartLine"].as_u64();
            let end = args["EndLine"].as_u64();
            if let (Some(s), Some(e)) = (start, end) {
                if e < s {
                    let msg = match lang {
                        Lang::En => format!("EndLine ({e}) is less than StartLine ({s}). Specify a valid line range."),
                        Lang::Ru => format!("EndLine ({e}) меньше StartLine ({s}). Укажи корректный диапазон строк."),
                    };
                    Some(msg)
                } else {
                    let limit = Some(e - s + 1);
                    guard::read_guard(
                        path,
                        start,
                        limit,
                        Client::Antigravity,
                        lang,
                        cwd.as_deref(),
                    )
                }
            } else {
                let limit = end;
                guard::read_guard(
                    path,
                    start,
                    limit,
                    Client::Antigravity,
                    lang,
                    cwd.as_deref(),
                )
            }
        }
        "write_file" => {
            let path = args["Path"].as_str().unwrap_or("");
            let content = args["Content"].as_str().unwrap_or("");
            backslash::pre_reason("Write", path, content, "", Client::Antigravity, lang)
        }
        "edit_file" => {
            let path = args["Path"].as_str().unwrap_or("");
            let replacement = args["Replacement"].as_str().unwrap_or("");
            backslash::pre_reason("Edit", path, replacement, "", Client::Antigravity, lang)
        }
        "run_command" => {
            let cmd = args["CommandLine"].as_str().unwrap_or("");
            backslash::pre_reason("run_command", "", "", cmd, Client::Antigravity, lang).or_else(
                || {
                    guard::shell_read_guard(
                        "run_command",
                        cmd,
                        Client::Antigravity,
                        lang,
                        cwd.as_deref(),
                    )
                },
            )
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
        agy_pass(false);
    }
}

/// DSH tool names differ from Claude Code only in case/spelling; arguments are the same.
fn claude_tool_name(tool: &str, client: Client) -> &str {
    match (client, tool) {
        (Client::Dsh, "read") => "Read",
        (Client::Dsh, "write") => "Write",
        (Client::Dsh, "edit") => "Edit",
        (Client::Dsh, "apply_patch") => "apply_patch",
        (Client::Dsh, "bash") => "Bash",
        (Client::Dsh, "pwsh") => "PowerShell",
        _ => tool,
    }
}

fn extract_patch_files(input: &Value) -> Vec<String> {
    let mut files = Vec::new();
    if let Some(path) = input["file_path"].as_str() {
        if !path.is_empty() {
            files.push(path.to_string());
        }
    }
    let patch_text = input["input"]
        .as_str()
        .or_else(|| input["patch"].as_str())
        .unwrap_or("");
    for line in patch_text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed
            .strip_prefix("*** Update File:")
            .or_else(|| trimmed.strip_prefix("*** Add File:"))
            .or_else(|| trimmed.strip_prefix("--- a/"))
            .or_else(|| trimmed.strip_prefix("+++ b/"))
        {
            let p = rest.trim();
            if !p.is_empty() && !files.iter().any(|f| f == p) {
                files.push(p.to_string());
            }
        }
    }
    files
}

fn handle_claude(call: &Value, forced_post: bool, lang: Lang, client: Client) {
    let event = call["hook_event_name"].as_str().unwrap_or("");
    if event == "Stop" {
        if let Some(reason) = gate::stop_reason(call, lang) {
            print!("{}", json!({"decision": "block", "reason": reason}));
        }
        return;
    }
    let tool = claude_tool_name(call["tool_name"].as_str().unwrap_or(""), client);
    let input = &call["tool_input"];

    let global_cwd: Option<PathBuf> = call.get("cwd").and_then(|v| v.as_str()).map(PathBuf::from);
    let tool_workdir: Option<PathBuf> = input
        .get("workdir")
        .and_then(|v| v.as_str())
        .map(PathBuf::from);
    let eff_cwd: Option<PathBuf> = match (global_cwd, tool_workdir) {
        (Some(g), Some(w)) => Some(if w.is_absolute() { w } else { g.join(w) }),
        (Some(g), None) => Some(g),
        (None, Some(w)) => Some(w),
        (None, None) => None,
    };

    if forced_post || event == "PostToolUse" {
        let files = if tool == "apply_patch" {
            extract_patch_files(input)
        } else {
            let p = input["file_path"].as_str().unwrap_or("");
            if p.is_empty() {
                vec![]
            } else {
                vec![p.to_string()]
            }
        };

        for path in files {
            if let Some(err) = backslash::post_syntax_error(&path, eff_cwd.as_deref()) {
                let edit = if client == Client::Dsh {
                    if tool == "apply_patch" {
                        "apply_patch"
                    } else {
                        "edit"
                    }
                } else {
                    "Edit"
                };
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
                return;
            }
        }
        return;
    }

    if tool == "Read" {
        let path = input["file_path"].as_str().unwrap_or("");
        let offset = input["offset"].as_u64();
        let limit = input["limit"].as_u64();
        if let Some(reason) =
            guard::read_guard(path, offset, limit, client, lang, eff_cwd.as_deref())
        {
            deny_claude(reason);
        }
        return;
    }

    let path = input["file_path"].as_str().unwrap_or("");
    let content = input["content"]
        .as_str()
        .or_else(|| input["new_string"].as_str())
        .or_else(|| input["input"].as_str())
        .or_else(|| input["patch"].as_str())
        .unwrap_or("");
    let command = input["command"].as_str().unwrap_or("");

    if let Some(reason) = backslash::pre_reason(tool, path, content, command, client, lang) {
        deny_claude(reason);
        return;
    }

    if tool == "Bash" || tool == "PowerShell" {
        if let Some(reason) =
            guard::shell_read_guard(tool, command, client, lang, eff_cwd.as_deref())
        {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_values_are_trimmed_and_case_blind() {
        for v in ["0", " 0 ", "off", " OFF", "False", "no", "No\t"] {
            assert!(is_off_value(v), "{v:?}");
        }
        for v in ["", "1", "on", "yes", "of", "00", "true"] {
            assert!(!is_off_value(v), "{v:?}");
        }
    }
}
