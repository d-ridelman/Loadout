use crate::{t, Client, Lang};
use regex::Regex;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;

fn fix_hint(client: Client, lang: Lang) -> &'static str {
    match client {
        Client::Claude => t(
            lang,
            "Backslashes get stripped here. Modify existing files with Edit (multiple edits for multiple spots). Write new scripts via Write and run them in a separate command; do not bypass this block by rewriting the same command.",
            "Так обратные слеши теряются. Правку существующего файла делай инструментом Edit (несколько мест — несколько Edit). Новый код запиши инструментом Write в файл и запусти его отдельной командой. Не обходи запрет другой формой той же команды.",
        ),
        Client::Antigravity => t(
            lang,
            "Backslashes get stripped here. Modify existing files with edit_file. Write new scripts via write_file and run them in a separate command; do not bypass this block by rewriting the same command.",
            "Так обратные слеши теряются. Правку существующего файла делай инструментом edit_file. Новый код запиши через write_file и запусти его отдельной командой. Не обходи запрет другой формой той же команды.",
        ),
    }
}

pub fn pre_reason(
    tool: &str,
    path: &str,
    content: &str,
    command: &str,
    client: Client,
    lang: Lang,
) -> Option<String> {
    let why = match tool {
        "Write" => write_reason(path, content, lang),
        "Bash" if command.contains('\\') => bash_reason(command, lang),
        "PowerShell" if command.contains('\\') => ps_reason(command, lang),
        "run_command" if command.contains('\\') => {
            ps_reason(command, lang).or_else(|| bash_reason(command, lang))
        }
        _ => None,
    };
    why.map(|w| format!("{w} {}", fix_hint(client, lang)))
}

fn re_inline() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)(?:^|[\s/\\"'(;&|])(?:node|nodejs|bun|deno|python[\d.]*|py|perl|ruby|php|pwsh|powershell|bash|sh|zsh)(?:\.exe)?["']?\s+(?:(?:-X\s+\S+\s+)|(?:-\S*\s+))*?(?:-[a-z]{0,2}[ec]|--eval|--print|-p|-Command|-EncodedCommand)\s+"#).unwrap()
    })
}

fn code_arg(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return "";
    }
    let q = bytes[0];
    if q != b'"' && q != b'\'' {
        return s.split(char::is_whitespace).next().unwrap_or("");
    }
    let mut i = 1;
    while i < bytes.len() {
        if bytes[i] == b'\\' && q == b'"' {
            i += 2;
            continue;
        }
        if bytes[i] == q {
            return &s[..=i];
        }
        i += 1;
    }
    s
}

fn has_inline_backslash(cmd: &str, lang: Lang) -> Option<&'static str> {
    for m in re_inline().find_iter(cmd) {
        if code_arg(&cmd[m.end()..]).contains('\\') {
            return Some(t(
                lang,
                "Inline interpreter code (-e / -c) contains backslashes.",
                "Код с обратными слешами передан интерпретатору в аргументе (-e / -c).",
            ));
        }
    }
    None
}

fn has_unquoted_redirect(s: &str) -> bool {
    let bytes = s.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'>' {
            let prev = if i > 0 { Some(bytes[i - 1]) } else { None };
            if matches!(prev, Some(b'0'..=b'9') | Some(b'&') | Some(b'>')) {
                continue;
            }
            let mut j = i + 1;
            if j < bytes.len() && bytes[j] == b'>' {
                j += 1;
            }
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && !matches!(bytes[j], b'&' | b'\r' | b'\n') {
                return true;
            }
        }
    }
    false
}

fn has_heredoc_backslash(cmd: &str) -> bool {
    static RE_START: OnceLock<Regex> = OnceLock::new();
    let re = RE_START.get_or_init(|| {
        Regex::new(r#"<<-?\s*(?:["']?)([A-Za-z_]\w*)["']?[^\n]*\n"#).unwrap()
    });
    for cap in re.captures_iter(cmd) {
        let Some(full) = cap.get(0) else { continue };
        let Some(tag) = cap.get(1) else { continue };
        let body_start = full.end();
        let rest = &cmd[body_start..];
        let mut offset = 0;
        for line in rest.split('\n') {
            let trimmed = line.trim_matches(|c| c == ' ' || c == '\t' || c == '\r');
            if trimmed == tag.as_str() {
                if rest[..offset].contains('\\') {
                    return true;
                }
                break;
            }
            offset += line.len() + 1;
        }
    }
    false
}

fn has_ps_herestring_backslash(cmd: &str) -> bool {
    let bytes = cmd.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() {
        if bytes[i] == b'@' && (bytes[i + 1] == b'\'' || bytes[i + 1] == b'"') {
            let q = bytes[i + 1];
            let mut j = i + 2;
            if j < bytes.len() && bytes[j] == b'\r' {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'\n' {
                let body_start = j + 1;
                let rest = &cmd[body_start..];
                let mut offset = 0;
                for line in rest.split('\n') {
                    let clean = line.trim_end_matches('\r');
                    if clean.len() >= 2 && clean.as_bytes()[0] == q && clean.as_bytes()[1] == b'@'
                    {
                        if rest[..offset].contains('\\') {
                            return true;
                        }
                        break;
                    }
                    offset += line.len() + 1;
                }
            }
        }
        i += 1;
    }
    false
}

fn bash_reason(cmd: &str, lang: Lang) -> Option<&'static str> {
    if has_heredoc_backslash(cmd) {
        return Some(t(
            lang,
            "Heredoc contains backslashes.",
            "В heredoc есть обратные слеши.",
        ));
    }
    if let Some(msg) = has_inline_backslash(cmd, lang) {
        return Some(msg);
    }
    static RE_SED: OnceLock<Regex> = OnceLock::new();
    let re_sed = RE_SED.get_or_init(|| {
        Regex::new(r#"\bsed\b[^\n]*?\s(?:-[A-Za-z]*i\b|--in-place)[^\n]*"#).unwrap()
    });
    for m in re_sed.find_iter(cmd) {
        if m.as_str().contains('\\') {
            return Some(t(
                lang,
                "sed -i expression contains backslashes.",
                "sed -i с обратными слешами в выражении.",
            ));
        }
    }
    static RE_ECHO: OnceLock<Regex> = OnceLock::new();
    let re_echo = RE_ECHO.get_or_init(|| {
        Regex::new(r#"(?:^|[\s;&|(])(?:printf|echo)\s([^\n&|]*)"#).unwrap()
    });
    for cap in re_echo.captures_iter(cmd) {
        let arg = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        if arg.contains('\\') && has_unquoted_redirect(arg) {
            return Some(t(
                lang,
                "printf/echo redirects backslash strings to a file.",
                "printf/echo пишет строку с обратными слешами в файл.",
            ));
        }
    }
    static RE_AWK: OnceLock<Regex> = OnceLock::new();
    let re_awk = RE_AWK.get_or_init(|| {
        Regex::new(r#"(?:^|[\s;&|(])g?awk\s([^\n;&|]*)"#).unwrap()
    });
    for cap in re_awk.captures_iter(cmd) {
        let arg = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        if arg.contains('\\') && (has_unquoted_redirect(arg) || arg.contains("-i inplace")) {
            return Some(t(
                lang,
                "awk with backslashes writes to a file.",
                "awk с обратными слешами пишет в файл.",
            ));
        }
    }
    None
}

fn ps_reason(cmd: &str, lang: Lang) -> Option<&'static str> {
    if let Some(msg) = has_inline_backslash(cmd, lang) {
        return Some(msg);
    }
    static RE_SINK: OnceLock<Regex> = OnceLock::new();
    let re_sink = RE_SINK.get_or_init(|| {
        Regex::new(r#"(?i)\b(?:node|python[\d.]*|py|perl|ruby|bash|Set-Content|Add-Content|Out-File|WriteAllText|WriteAllLines)\b"#).unwrap()
    });
    if (re_sink.is_match(cmd) || has_unquoted_redirect(cmd)) && has_ps_herestring_backslash(cmd) {
        return Some(t(
            lang,
            "PowerShell here-string contains backslashes.",
            "В here-string есть обратные слеши.",
        ));
    }
    static RE_REPLACE: OnceLock<Regex> = OnceLock::new();
    static RE_WRITE_CMD: OnceLock<Regex> = OnceLock::new();
    let re_rep = RE_REPLACE.get_or_init(|| Regex::new(r#"(?i)-replace\s[^|\n]*\\"#).unwrap());
    let re_wr = RE_WRITE_CMD.get_or_init(|| {
        Regex::new(r#"(?i)\b(?:Set-Content|Add-Content|Out-File|WriteAllText|WriteAllLines)\b"#)
            .unwrap()
    });
    if re_rep.is_match(cmd) && re_wr.is_match(cmd) {
        return Some(t(
            lang,
            "-replace with backslashes writes to a file.",
            "-replace с обратными слешами пишет в файл.",
        ));
    }
    None
}

fn write_reason(path: &str, content: &str, lang: Lang) -> Option<&'static str> {
    static RE_EXT: OnceLock<Regex> = OnceLock::new();
    let re_ext =
        RE_EXT.get_or_init(|| Regex::new(r#"(?i)\.(?:py|m?js|cjs|ts|ps1|sh|pl|rb)$"#).unwrap());
    if !re_ext.is_match(path) || !content.contains('\\') {
        return None;
    }
    static RE_DIR: OnceLock<Regex> = OnceLock::new();
    static RE_BASE: OnceLock<Regex> = OnceLock::new();
    static RE_REWRITE: OnceLock<Regex> = OnceLock::new();
    static RE_SUB: OnceLock<Regex> = OnceLock::new();
    let re_dir = re_dir_init(&RE_DIR);
    let re_base = RE_BASE
        .get_or_init(|| Regex::new(r#"(?i)(?:^|[-_.])(?:patch|fix|edit|rep|sub|tmp)"#).unwrap());
    let base = Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let throwaway = re_dir.is_match(path) || re_base.is_match(base);
    if !throwaway {
        return None;
    }
    let re_rw = RE_REWRITE.get_or_init(|| {
        Regex::new(r#"writeFileSync|writeFile\(|write_text\(|\.write\(|WriteAllText|Set-Content|Out-File"#).unwrap()
    });
    let re_sub = RE_SUB
        .get_or_init(|| Regex::new(r#"\.replace\(|\.sub\(|-replace|\.split\([^)]*\)\.join\("#).unwrap());
    if re_rw.is_match(content) && re_sub.is_match(content) {
        return Some(t(
            lang,
            "Throwaway patch script rewrites another file with backslash strings.",
            "Скрипт-заплатка: строки со слешами для замены в другом файле.",
        ));
    }
    None
}

fn re_dir_init(cell: &OnceLock<Regex>) -> &Regex {
    cell.get_or_init(|| Regex::new(r#"(?i)[\\/](?:te?mp|scratchpad)[\\/]"#).unwrap())
}

pub fn post_syntax_error(path: &str) -> Option<String> {
    let p = Path::new(path);
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let base = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if ext == "json" {
        static RE_JSONC: OnceLock<Regex> = OnceLock::new();
        static RE_VSCODE: OnceLock<Regex> = OnceLock::new();
        let re_jsonc = RE_JSONC.get_or_init(|| {
            Regex::new(r#"(?i)^(?:ts|js)config|^\.?eslintrc|\.code-workspace$"#).unwrap()
        });
        let re_vscode = RE_VSCODE.get_or_init(|| Regex::new(r#"(?i)[\\/]\.vscode[\\/]"#).unwrap());
        if re_jsonc.is_match(base) || re_vscode.is_match(path) {
            return None;
        }
        let raw = fs::read_to_string(p).ok()?;
        let clean = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
        return match serde_json::from_str::<serde_json::Value>(clean) {
            Ok(_) => None,
            Err(e) => Some(e.to_string()),
        };
    }

    let out = match ext.as_str() {
        "js" | "mjs" | "cjs" => Command::new("node").args(["--check", path]).output().ok()?,
        "py" => Command::new("python")
            .args([
                "-I",
                "-c",
                "import ast,sys; ast.parse(open(sys.argv[1],\"rb\").read(), sys.argv[1])",
                path,
            ])
            .output()
            .ok()?,
        _ => return None,
    };

    if out.status.success() {
        return None;
    }
    let msg = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    let trimmed = msg.trim();
    if trimmed.is_empty() {
        return None;
    }
    if ext != "py"
        && (trimmed.contains("Unexpected token '<'")
            || trimmed.contains("SyntaxError: Unexpected token '.'"))
    {
        static RE_JSX: OnceLock<Regex> = OnceLock::new();
        let re_jsx = RE_JSX.get_or_init(|| Regex::new(r#"<[A-Za-z>]"#).unwrap());
        if let Ok(src) = fs::read_to_string(p) {
            if re_jsx.is_match(&src) {
                return None;
            }
        }
    }
    let short: Vec<&str> = trimmed.lines().take(8).collect();
    Some(short.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_inline_and_herestring_for_agy() {
        let r = pre_reason(
            "run_command",
            "",
            "",
            r#"python -c "print('a\nb')""#,
            Client::Antigravity,
            Lang::En,
        )
        .unwrap();
        assert!(r.contains("edit_file"));
        assert!(pre_reason(
            "run_command",
            "",
            "",
            "@'\nconst re = /\\d+/;\n'@ | Set-Content x.js",
            Client::Antigravity,
            Lang::En,
        )
        .is_some());
        assert!(pre_reason(
            "run_command",
            "",
            "",
            r#"python scripts/run.py -c "C:\cfg.ini""#,
            Client::Antigravity,
            Lang::Ru,
        )
        .is_none());
    }
}
