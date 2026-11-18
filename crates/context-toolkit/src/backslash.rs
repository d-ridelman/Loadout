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
            "Backslashes get stripped here. Modify existing files with replace_file_content. Write new scripts via write_to_file and run them in a separate command; do not bypass this block by rewriting the same command.",
            "Так обратные слеши теряются. Правку существующего файла делай инструментом replace_file_content. Новый код запиши через write_to_file и запусти его отдельной командой. Не обходи запрет другой формой той же команды.",
        ),
        Client::Codex => t(
            lang,
            "Backslashes get stripped here. Modify files with apply_patch. Write a new script into a file with apply_patch and run it in a separate command; do not bypass this block by rewriting the same command.",
            "Так обратные слеши теряются. Правь файлы через apply_patch. Новый код запиши в файл через apply_patch и запусти его отдельной командой. Не обходи запрет другой формой той же команды.",
        ),
        Client::Dsh | Client::OpenCode => t(
            lang,
            "Backslashes get stripped here. Modify existing files with edit. Write new scripts via write and run them in a separate command; do not bypass this block by rewriting the same command.",
            "Так обратные слеши теряются. Правку существующего файла делай инструментом edit. Новый код запиши через write и запусти его отдельной командой. Не обходи запрет другой формой той же команды.",
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
        "Write" | "Edit" | "MultiEdit" | "apply_patch" => write_reason(path, content, lang),
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
        // Each interpreter has its own "code follows" flags: `-c` is inline code for python and
        // bash but a syntax check for node, perl and ruby; `-e` is code for node but not for bash.
        let families = [
            (r"node|nodejs|bun|deno", r"-[a-z]{0,2}[ep]\s+|--(?:eval|print)(?:\s+|=)"),
            (r"python[\d.]*|py", r"-[A-Za-z]*c\s+"),
            (r"perl", r"-[A-Za-z0-9.]*[eE]\s+"),
            (r"ruby", r"-[a-z]*e\s+"),
            (r"php", r"-r\s+"),
            (r"pwsh|powershell", r"(?i:-[a-z]{0,2}[ec]|-Command|-EncodedCommand)\s+"),
            (r"bash|sh|zsh", r"-[a-z]*c[a-z]*\s+"),
        ];
        let alt: Vec<String> = families
            .iter()
            .map(|(names, flags)| {
                // Options before the code flag, including the ones that take a value (-X, -W).
                format!(
                    r#"(?i:{names})(?:\.exe)?["']?\s+(?:(?:-[XWro]|(?i:-ExecutionPolicy|-ep|-ex|-WindowStyle))\s+\S+\s+|-\S*\s+)*?(?:{flags})"#
                )
            })
            .collect();
        Regex::new(&format!(r#"(?:^|[\s/\\"'(;&|])(?:{})"#, alt.join("|"))).unwrap()
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

/// A `>` that writes stdout to a file. With `bash_quotes`, `>` inside quotes is text
/// ("a -> b", awk's `$3 > 100`) and a backslash escapes the next character, as bash reads it.
/// PowerShell text is scanned raw: its quoting rules differ and here-strings hold stray quotes.
fn has_unquoted_redirect(s: &str, bash_quotes: bool) -> bool {
    let bytes = s.as_bytes();
    let mut quote = 0u8;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if bash_quotes {
            if b == b'\\' && quote != b'\'' {
                i += 2;
                continue;
            }
            if quote != 0 {
                if b == quote {
                    quote = 0;
                }
                i += 1;
                continue;
            }
            if b == b'"' || b == b'\'' {
                quote = b;
                i += 1;
                continue;
            }
        }
        // `2>` is stderr and the second `>` of `>>` was handled; `1>` and `&>` do write stdout.
        if b == b'>' && !(i > 0 && matches!(bytes[i - 1], b'2'..=b'9' | b'>')) {
            let mut j = i + 1;
            if j < bytes.len() && matches!(bytes[j], b'>' | b'|') {
                j += 1;
            }
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && !matches!(bytes[j], b'&' | b'\r' | b'\n') {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn has_heredoc_backslash(cmd: &str) -> bool {
    static RE_START: OnceLock<Regex> = OnceLock::new();
    let re = RE_START.get_or_init(|| {
        // Tag forms: EOF, 'EOF', "EOF", \EOF; tags may contain `-` (END-TAG). `<<<` is a
        // here-string, not a heredoc.
        Regex::new(r#"(?:^|[^<])<<-?\s*(\\|["'])?([A-Za-z_][\w-]*)["']?[^\n]*\n"#).unwrap()
    });
    // `<<` inside the body of an earlier heredoc is that heredoc's text (C++ `cout << x`).
    let mut skip_until = 0;
    for cap in re.captures_iter(cmd) {
        let Some(full) = cap.get(0) else { continue };
        let Some(tag) = cap.get(2) else { continue };
        if full.start() < skip_until {
            continue;
        }
        let body_start = full.end();
        let rest = &cmd[body_start..];
        let mut offset = 0;
        let mut closed = false;
        for line in rest.split('\n') {
            let trimmed = line.trim_matches(|c| c == ' ' || c == '\t' || c == '\r');
            if trimmed == tag.as_str() {
                if rest[..offset].contains('\\') {
                    return true;
                }
                closed = true;
                skip_until = body_start + offset;
                break;
            }
            offset += line.len() + 1;
        }
        // bash runs an unterminated heredoc up to end of input. That needs proof it is a
        // heredoc: a quoted tag, and `<<` not sitting inside a quoted string (a shift in code).
        if !closed && cap.get(1).is_some() && rest.contains('\\') {
            let line_start = cmd[..tag.start()].rfind('\n').map_or(0, |p| p + 1);
            let before = &cmd[line_start..tag.start() - 1];
            if before.matches('\'').count().is_multiple_of(2)
                && before.matches('"').count().is_multiple_of(2)
            {
                return true;
            }
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
                    if clean.len() >= 2 && clean.as_bytes()[0] == q && clean.as_bytes()[1] == b'@' {
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
    // Stay inside sed's own command: an unquoted `;`, `|` or `&` ends it, so `-i` of a later
    // command in the chain (`sed -n ...; grep -i ...`) is not taken for sed's flag; `)` and a
    // backtick end a command substitution. `-ie` is in-place too (suffix "e").
    let re_sed = RE_SED.get_or_init(|| {
        // An escaped character (`\)` in an unquoted script) is part of the command.
        let seg = r#"(?:[^\n;|&'"`)\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")"#;
        Regex::new(&format!(
            r"\bsed\b{seg}*?\s(?:-[A-Za-z]*i[A-Za-z]*\b|--in-place){seg}*"
        ))
        .unwrap()
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
        // `&>` is a redirect, not the end of the command.
        Regex::new(r#"(?:^|[\s;&|(])(?:printf|echo)\s((?:>\||&>|[^\n&|])*)"#).unwrap()
    });
    for cap in re_echo.captures_iter(cmd) {
        let arg = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        if arg.contains('\\') && has_unquoted_redirect(arg, true) {
            return Some(t(
                lang,
                "printf/echo redirects backslash strings to a file.",
                "printf/echo пишет строку с обратными слешами в файл.",
            ));
        }
    }
    static RE_AWK: OnceLock<Regex> = OnceLock::new();
    let re_awk = RE_AWK.get_or_init(|| Regex::new(r#"(?:^|[\s;&|(])g?awk\s([^\n;&|]*)"#).unwrap());
    // Inside the awk program a redirect is `print ... > "file"`; `$3 > 100` is a comparison.
    static RE_AWK_PRINT: OnceLock<Regex> = OnceLock::new();
    let re_print = RE_AWK_PRINT.get_or_init(|| Regex::new(r#"printf?\b[^\n;}]*>>?\s*""#).unwrap());
    for cap in re_awk.captures_iter(cmd) {
        let arg = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        if arg.contains('\\')
            && (has_unquoted_redirect(arg, true)
                || arg.contains("-i inplace")
                || re_print.is_match(arg))
        {
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
    if (re_sink.is_match(cmd) || has_unquoted_redirect(cmd, false))
        && has_ps_herestring_backslash(cmd)
    {
        return Some(t(
            lang,
            "PowerShell here-string contains backslashes.",
            "В here-string есть обратные слеши.",
        ));
    }
    static RE_REPLACE: OnceLock<Regex> = OnceLock::new();
    static RE_WRITE_CMD: OnceLock<Regex> = OnceLock::new();
    // The operator's own arguments: up to `|` or `;` outside quotes.
    let re_rep = RE_REPLACE.get_or_init(|| {
        Regex::new(r#"(?i)-[ci]?replace\s(?:[^|;\n'"]|'[^']*'|"[^"]*")*"#).unwrap()
    });
    let re_wr = RE_WRITE_CMD.get_or_init(|| {
        Regex::new(r#"(?i)\b(?:Set-Content|Add-Content|Out-File|WriteAllText|WriteAllLines)\b"#)
            .unwrap()
    });
    if re_wr.is_match(cmd) && re_rep.find_iter(cmd).any(|m| m.as_str().contains('\\')) {
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
    if (!path.is_empty() && !re_ext.is_match(path)) || !content.contains('\\') {
        return None;
    }
    static RE_DIR: OnceLock<Regex> = OnceLock::new();
    static RE_BASE: OnceLock<Regex> = OnceLock::new();
    static RE_REWRITE: OnceLock<Regex> = OnceLock::new();
    static RE_SUB: OnceLock<Regex> = OnceLock::new();
    let re_dir = re_dir_init(&RE_DIR);
    let re_base = RE_BASE
        .get_or_init(|| {
            // The word must end: `fix-2.js`, `fixPaths.js`, `replace_paths.py`, not `fixtures.js`.
            Regex::new(r#"(?:^|[-_.])(?i:patch(?:es)?|fix(?:es|up)?|edit|rep(?:lace)?|sub|tmp)(?:[-_.\dA-Z]|$)"#).unwrap()
        });
    // A patch (`apply_patch`, path empty) is throwaway by the files it touches, like a write: a patch to an ordinary
    // source file that happens to hold `.write(` and `.replace(` is a normal edit (in Codex it is the only edit tool).
    let throwaway_file = |p: &str| {
        let b = Path::new(p)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        // patch paths are often relative (`tmp/x.py`): the folder pattern needs a separator before the folder name
        re_dir.is_match(&format!("/{p}")) || re_base.is_match(b)
    };
    let throwaway = if path.is_empty() {
        content.lines().any(|l| {
            let l = l.trim();
            l.strip_prefix("*** Add File:")
                .or_else(|| l.strip_prefix("*** Update File:"))
                .is_some_and(|p| throwaway_file(p.trim()))
        })
    } else {
        throwaway_file(path)
    };
    if !throwaway {
        return None;
    }
    let re_rw = RE_REWRITE.get_or_init(|| {
        Regex::new(
            r#"writeFileSync|writeFile\(|write_text\(|\.write\(|WriteAllText|Set-Content|Out-File"#,
        )
        .unwrap()
    });
    let re_sub = RE_SUB.get_or_init(|| {
        Regex::new(r#"\.replace\(|\.sub\(|-replace|\.split\([^)]*\)\.join\("#).unwrap()
    });
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

/// JSONC as plain JSON: `//` and `/* */` comments and commas before `}` / `]` become spaces
/// (newlines stay), strings are left alone. An unterminated block comment is kept, so it still fails.
fn blank_jsonc(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out: Vec<char> = Vec::with_capacity(chars.len());
    let blank = |c: char| if c == '\n' || c == '\r' { c } else { ' ' };
    let (mut i, mut in_str, mut esc) = (0, false, false);
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            in_str = !(c == '"' && !esc);
            esc = c == '\\' && !esc;
            out.push(c);
            i += 1;
        } else if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                out.push(blank(chars[i]));
                i += 1;
            }
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            let end = (i + 2..chars.len().saturating_sub(1))
                .find(|&j| chars[j] == '*' && chars[j + 1] == '/');
            let Some(end) = end else {
                out.extend(&chars[i..]);
                break;
            };
            out.extend(chars[i..end + 2].iter().map(|&c| blank(c)));
            i = end + 2;
        } else {
            if c == '}' || c == ']' {
                // A comma after a value is a trailing one; `[,]`, `{,}` and `,,` stay errors.
                let mut kept = out.iter_mut().rev().filter(|p| !p.is_whitespace());
                if let (Some(comma), Some(before)) = (kept.next(), kept.next()) {
                    if *comma == ',' && !matches!(*before, '[' | '{' | ',') {
                        *comma = ' ';
                    }
                }
            }
            out.push(c);
            i += 1;
        }
    }
    out.into_iter().collect()
}

pub fn post_syntax_error(path: &str, cwd: Option<&Path>) -> Option<String> {
    let p = if let Some(base) = cwd {
        let p_rel = Path::new(path);
        if p_rel.is_absolute() {
            p_rel.to_path_buf()
        } else {
            base.join(p_rel)
        }
    } else {
        Path::new(path).to_path_buf()
    };
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let base = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
    // A missing path or a directory is not a syntax error of the file.
    if !p.is_file() {
        return None;
    }
    let p_str = p.to_str().unwrap_or(path);
    if ext == "json" {
        static RE_JSONC: OnceLock<Regex> = OnceLock::new();
        static RE_VSCODE: OnceLock<Regex> = OnceLock::new();
        let re_jsonc = RE_JSONC.get_or_init(|| {
            Regex::new(r#"(?i)^(?:ts|js)config|^\.?eslintrc|^\.?devcontainer|\.code-workspace$"#)
                .unwrap()
        });
        let re_vscode = RE_VSCODE.get_or_init(|| {
            Regex::new(r#"(?i)(?:^|[\\/])\.(?:vscode|devcontainer)[\\/]"#).unwrap()
        });
        if re_jsonc.is_match(base) || re_vscode.is_match(path) {
            return None;
        }
        let raw = fs::read_to_string(&p).ok()?;
        let clean = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
        if serde_json::from_str::<serde_json::Value>(clean).is_ok() {
            return None;
        }
        // turbo.json, biome.json and others are JSONC: comments and trailing commas are legal there.
        // Blanking keeps every offset, so a real error still points at the right line.
        return match serde_json::from_str::<serde_json::Value>(&blank_jsonc(clean)) {
            Ok(_) => None,
            Err(e) => Some(e.to_string()),
        };
    }

    let mut cmd_node = Command::new("node");
    cmd_node.args(["--check", p_str]);
    if let Some(c) = cwd {
        cmd_node.current_dir(c);
    }

    let mut cmd_py = Command::new("python");
    cmd_py.args([
        "-I",
        "-c",
        // Print the error itself, not the traceback of this wrapper.
        "import ast,sys\ntry: ast.parse(open(sys.argv[1],'rb').read(), sys.argv[1])\nexcept (SyntaxError, ValueError) as e: sys.exit(f'{type(e).__name__}: {getattr(e, \"msg\", e)}' + (f' (line {e.lineno})' if getattr(e, 'lineno', None) else '') + '\\n' + (getattr(e, 'text', None) or '').rstrip())",
        p_str,
    ]);
    if let Some(c) = cwd {
        cmd_py.current_dir(c);
    }

    let out = match ext.as_str() {
        "js" | "mjs" | "cjs" => cmd_node.output().ok()?,
        "py" => cmd_py.output().ok()?,
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

    fn json_error(name: &str, body: &str) -> Option<String> {
        let dir = std::env::temp_dir().join(format!("ctxkit-jsonc-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        fs::write(&p, body).unwrap();
        let r = post_syntax_error(p.to_str().unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
        r
    }

    #[test]
    fn json_with_comments_and_trailing_commas_passes_but_broken_json_does_not() {
        let jsonc =
            "{\n  // pipeline\n  \"a\": [1, 2,], /* why */\n  \"url\": \"http://x/*y*/,]\",\n}\n";
        assert_eq!(json_error("turbo.json", jsonc), None);
        assert_eq!(
            json_error("biome.json", "\u{feff}{ \"a\": 1, // c\n}"),
            None
        );
        assert_eq!(json_error("ok.json", "{\"a\": 1}"), None);
        // still broken once comments and trailing commas are ignored
        assert!(json_error("a.json", "{\n  // c\n  \"a\": 1\n  \"b\": 2\n}").is_some());
        assert!(json_error("b.json", "{ \"a\": 1 /* open").is_some());
        assert!(json_error("c.json", "{ \"a\": 1,, }").is_some());
        assert!(json_error("d1.json", "[,]").is_some());
        assert!(json_error("d2.json", "{,}").is_some());
        assert!(json_error("d3.json", "[1, /* c */ ,]").is_some());
        assert_eq!(json_error("d4.json", "[1, // c\n]"), None);
        // the error still names the right line (offsets are kept)
        let e = json_error("d.json", "{\n  // one\n  /* two\n  three */\n  \"a\" 1\n}").unwrap();
        assert!(e.contains("line 5"), "{e}");
    }

    #[test]
    fn blanking_leaves_strings_and_text_offsets_alone() {
        let src = "{\"a\":\"// not a comment, \\\" /* nor this */\"}";
        assert_eq!(blank_jsonc(src), src);
        let s = "[1,/* x */ 2,\n]";
        assert_eq!(blank_jsonc(s).len(), s.len());
        assert!(serde_json::from_str::<serde_json::Value>(&blank_jsonc(s)).is_ok());
    }

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
        assert!(r.contains("replace_file_content"));
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
