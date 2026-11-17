//! Masking (CONCEPT.md §5): secret values never leave the core.
//!
//! The approach is an allow list. Arguments and hook commands are free text, and a deny list of words would give a new
//! bypass with every audit. So everything not recognised as harmless is hidden (`<masked>`):
//! what is shown: flag names, numbers, paths (rooted or with a file name of a known type), URLs without secret
//! parts, package names, file names, executables and a small set of common words. The value after
//! a flag or key with a secret-looking name is always hidden, even if it looks harmless.
//!
//! Cost: part of the useful text (positional words, flag values) is replaced with `<masked>` in the output.
//! In M3 the UI will show the full command on an explicit "show" action (press and hold), not by default.

use serde_json::{json, Value};

pub const MASK: &str = "<masked>";

/// Substrings that are enough anywhere in a name.
const SECRET_PARTS: [&str; 12] = [
    "token",
    "secret",
    "password",
    "passwd",
    "passphrase",
    "authorization",
    "credential",
    "cookie",
    "apikey",
    "api_key",
    "bearer",
    "oauth",
];
/// Words counted only as whole words (`pat` in `GH_PAT`, but not in `path`).
const SECRET_WORDS: [&str; 14] = [
    "pat", "auth", "pass", "pwd", "pw", "sid", "jwt", "cred", "session", "private", "pin", "otp",
    "passcode", "code",
];

/// Words that are safe to show: interpreters, wrappers, common subcommands and values.
const SAFE_WORDS: &[&str] = &[
    "node",
    "npx",
    "npm",
    "pnpm",
    "yarn",
    "uv",
    "uvx",
    "pipx",
    "bunx",
    "dlx",
    "python",
    "python3",
    "pwsh",
    "powershell",
    "bash",
    "sh",
    "zsh",
    "cmd",
    "cargo",
    "go",
    "git",
    "docker",
    "nohup",
    "disown",
    "exec",
    "env",
    "sudo",
    "time",
    "start",
    "export",
    "mcp",
    "serve",
    "server",
    "stdio",
    "sse",
    "http",
    "run",
    "stop",
    "restart",
    "status",
    "install",
    "list",
    "scan",
    "sync",
    "pull",
    "update",
    "origin",
    "main",
    "master",
    "latest",
    "true",
    "false",
    "bypass",
    "remotesigned",
    "hidden",
    "debug",
    "info",
    "warn",
    "warning",
    "error",
    "trace",
    "ru",
    "en",
];
/// File extensions whose file names may be shown.
const SAFE_EXT: &[&str] = &[
    "js", "mjs", "cjs", "ts", "py", "sh", "ps1", "cmd", "bat", "exe", "json", "yaml", "yml",
    "toml", "md", "txt", "sql", "db", "ini", "cfg", "conf", "log", "jar", "dll", "so", "rs", "go",
    "rb", "php", "html", "css", "lock", "pid", "sock",
];
/// PowerShell parameters whose name is harmless.
const PS_FLAGS: &[&str] = &[
    "NoProfile",
    "File",
    "Command",
    "ExecutionPolicy",
    "NonInteractive",
    "WindowStyle",
    "NoLogo",
    "Version",
];
/// Programs that run a package by name: the next word without a flag is the package name.
const LAUNCHERS: &[&str] = &["npx", "uvx", "pipx", "bunx", "dlx"];
/// URL schemes that we treat as URLs.
const SCHEMES: &[&str] = &[
    "http",
    "https",
    "ws",
    "wss",
    "ssh",
    "git",
    "git+https",
    "git+ssh",
    "file",
    "ftp",
    "sse",
];

pub fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase().replace('-', "_");
    k.ends_with("key")
        || SECRET_PARTS.iter().any(|p| k.contains(p))
        || k.split(|c: char| !c.is_ascii_alphanumeric())
            .any(|w| w == "key" || SECRET_WORDS.contains(&w))
}

/// A long string of letters and digits (allowing `_`, `-`, `:`): looks like a token (`ghp_…`, UUID without hyphens, `bot123:AAH…`).
fn looks_like_token(s: &str) -> bool {
    s.len() >= 24
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':'))
        && s.chars().any(|c| c.is_ascii_digit())
        && s.chars().any(|c| c.is_ascii_alphabetic())
}

/// A mix of upper case, lower case and digits of 16+ characters: base64 and random keys, not a word.
fn high_entropy(s: &str) -> bool {
    s.chars().count() >= 16
        && s.chars().any(|c| c.is_ascii_digit())
        && s.chars().any(|c| c.is_ascii_uppercase())
        && s.chars().any(|c| c.is_ascii_lowercase())
}

/// A path fragment or word that most likely holds a secret.
fn seg_secret(seg: &str) -> bool {
    let stem = seg.rsplit_once('.').map_or(seg, |(s, _)| s);
    // a hex string of 20+ characters (API keys, hashes) and a long word of only letters and digits of 32+ characters
    let hex = |s: &str| s.len() >= 20 && s.chars().all(|c| c.is_ascii_hexdigit());
    let long_plain = |s: &str| s.len() >= 32 && s.chars().all(|c| c.is_ascii_alphanumeric());
    looks_like_token(seg)
        || high_entropy(seg)
        || seg.contains("eyJ")
        || looks_like_token(stem)
        || high_entropy(stem)
        || hex(seg)
        || hex(stem)
        || long_plain(seg)
        || long_plain(stem)
}

/// Package version: `1.2`, `6.8.0`, `1.0.0-rc.1` or a release tag. Short numbers without a dot (`123`) and random
/// strings do not count as a version: so `admin@123` and `name@token` do not pass for `package@version`.
fn is_version(v: &str) -> bool {
    if matches!(
        v,
        "latest" | "next" | "beta" | "alpha" | "canary" | "rc" | "stable"
    ) {
        return true;
    }
    let (core, pre) = v.split_once(['-', '+']).map_or((v, ""), |(c, p)| (c, p));
    let parts: Vec<&str> = core.split('.').collect();
    (2..=4).contains(&parts.len())
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 6 && p.chars().all(|c| c.is_ascii_digit()))
        && pre.len() <= 20
        && pre
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        && !seg_secret(pre)
}

fn is_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !s.starts_with(|c: char| c.is_ascii_digit())
}

/// Operators after which a new command starts.
fn is_control_op(s: &str) -> bool {
    matches!(s, "&" | "&&" | "|" | "||" | ";")
}

/// Redirections without a file value; no command starts after them.
fn is_redirect(s: &str) -> bool {
    matches!(
        s,
        ">/dev/null" | "2>/dev/null" | "&>/dev/null" | "2>&1" | ">" | ">>" | "2>"
    )
}

fn has_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() > 2 && b[1] == b':' && b[0].is_ascii_alphabetic()
}

fn is_file_name(s: &str) -> bool {
    match s.rsplit_once('.') {
        Some((stem, ext)) => {
            !stem.is_empty()
                && stem.len() <= 40
                && SAFE_EXT.contains(&ext.to_ascii_lowercase().as_str())
                && stem
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                && !seg_secret(stem)
        }
        None => false,
    }
}

/// Path: rooted (`/`, `\`, `~`, `.`, `$`, `%`, `C:`) or ending with a file name of a known type;
/// without characters that hide secrets; a colon only in a drive name; no segment looks like a secret.
/// A base64 string with slashes does not qualify: it is not rooted and does not end with a file name.
fn is_path_like(s: &str) -> bool {
    let segs: Vec<&str> = s.split(['/', '\\']).collect();
    if segs.len() < 2 {
        return false;
    }
    let rooted = s.starts_with(['/', '\\', '~', '.', '$', '%']) || has_drive(s);
    let last = segs.last().copied().unwrap_or("");
    let colon_ok = segs.iter().enumerate().all(|(i, seg)| {
        !seg.contains(':') || (i == 0 && seg.len() == 2 && seg.as_bytes()[0].is_ascii_alphabetic())
    });
    (rooted || is_file_name(last))
        && colon_ok
        && !s.contains([
            '@', '?', '=', ';', '&', '|', '<', '>', '"', '\'', '`', '+', '!', '*',
        ])
        && !s.contains("$(")
        && segs
            .iter()
            .all(|seg| seg.chars().count() <= 80 && !seg_secret(seg))
        && !scrambled(s)
}

/// The whole path looks like base64 cut by slashes (`/K7MDENG/bPxRfiCYEXAMPLEKEY`): a mix of cases and digits,
/// long, without dots. Real paths with a dot in the file name do not match.
fn scrambled(s: &str) -> bool {
    let flat: String = s.chars().filter(|c| !matches!(c, '/' | '\\')).collect();
    !s.contains('.') && high_entropy(&flat) && flat.chars().count() >= 20
}

/// Package name with a version: `rea-agents@6.8.0`, `@scope/name@1.2`.
fn is_pkg_version(s: &str) -> bool {
    let Some((name, ver)) = s.rsplit_once('@').filter(|(n, _)| !n.is_empty()) else {
        return false;
    };
    let name = name.strip_prefix('@').unwrap_or(name);
    !name.is_empty()
        && name.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.' | '/')
        })
        && is_version(ver)
}

/// Package name after `npx`/`uvx`: `firecrawl-mcp`, `@upstash/context7-mcp@latest`, `mcp-server-fetch`.
fn is_package_name(s: &str) -> bool {
    let body = s.strip_prefix('@').unwrap_or(s);
    let (path, version) = body
        .split_once('@')
        .map_or((body, None), |(p, v)| (p, Some(v)));
    !path.is_empty()
        && s.len() <= 80
        && path.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && path.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.' | '/')
        })
        && path.matches('/').count() <= 1
        && version.is_none_or(is_version)
}

/// A value (not a flag): shown only if recognised as harmless.
fn safe_value(v: &str) -> String {
    if v.contains("://") {
        return mask_url(v);
    }
    let lower = v.to_ascii_lowercase();
    let ok = (!v.is_empty() && v.len() <= 5 && v.chars().all(|c| c.is_ascii_digit()))
        || SAFE_WORDS.contains(&lower.as_str())
        || is_pkg_version(v)
        || is_path_like(v)
        || is_file_name(v);
    if ok {
        v.to_owned()
    } else {
        MASK.to_owned()
    }
}

/// Command-line parsing state.
#[derive(Clone, Copy, Default)]
struct Pos {
    /// An executable is expected.
    cmd: bool,
    /// A package name is expected (after `npx`, `uvx`).
    pkg: bool,
    /// The previous token is a long flag from [`VALUE_FLAGS`] (`--client`): its value may be shown.
    flag: bool,
}

/// A short plain value of a harmless flag (`--client x`, `--mode stdio`): lower-case letters and `-` only, so a password
/// with a digit or a mixed-case key never passes.
fn is_plain_word(v: &str) -> bool {
    (1..=16).contains(&v.len())
        && v.starts_with(|c: char| c.is_ascii_lowercase())
        && v.chars().all(|c| c.is_ascii_lowercase() || c == '-')
}

/// Long flags whose value names a client, mode or format, never a credential (an allow list, as everywhere here:
/// `--header`, `--env`, `--config` carry secrets and are not on it).
const VALUE_FLAGS: &[&str] = &[
    "client",
    "mode",
    "transport",
    "scope",
    "profile",
    "format",
    "type",
    "level",
    "log-level",
    "target",
    "channel",
    "shell",
    "lang",
    "language",
    "locale",
    "model",
    "provider",
    "agent",
];

/// `--name` (without `=`) from [`VALUE_FLAGS`]: the next token is its value.
pub(crate) fn is_plain_flag(a: &str) -> bool {
    a.strip_prefix("--")
        .is_some_and(|n| VALUE_FLAGS.contains(&n))
}

/// One command-line token. `next` is the next token (for short flags with a separate value).
/// Returns the token to show and a "hide the next value" flag.
fn mask_token(a: &str, pos: Pos, next: Option<&str>) -> (String, bool) {
    if a.is_empty() || is_control_op(a) || is_redirect(a) {
        return (a.to_owned(), false);
    }
    if a.starts_with(['{', '[']) || a.starts_with("@{") {
        return (MASK.to_owned(), false); // JSON and PowerShell hash tables: keys are unknown, hide the whole thing
    }
    if let Some(long) = a.strip_prefix("--") {
        let (name, val) = long
            .split_once('=')
            .map_or((long, None), |(n, v)| (n, Some(v)));
        let valid = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !valid {
            return (MASK.to_owned(), false);
        }
        let secretish = is_secret_key(name) || matches!(name, "user" | "proxy-user");
        return match val {
            Some(_) if secretish => (format!("--{name}={MASK}"), false),
            Some(v) if VALUE_FLAGS.contains(&name) && is_plain_word(v) => (a.to_owned(), false),
            Some(v) => (format!("--{name}={}", safe_value(v)), false),
            None => (a.to_owned(), secretish),
        };
    }
    if let Some(short) = a.strip_prefix('-') {
        let letters = !short.is_empty() && short.chars().all(|c| c.is_ascii_alphabetic());
        if letters && (short.len() <= 2 || PS_FLAGS.contains(&short)) {
            // `-p value`, `-a value`: one-letter password and key flags; hide the value unless it is a flag or a URL
            let secret_letter =
                (short.len() == 1 && "pPaAwWkK".contains(short)) || is_secret_key(short);
            let hide =
                secret_letter && next.is_some_and(|n| !n.starts_with('-') && !n.contains("://"));
            return (a.to_owned(), hide);
        }
        // `-pPASSWORD`, `-ubob:pw`, `-pw value`, `-Password value`: the flag name is unknown, so the value after it
        return (MASK.to_owned(), true);
    }
    // `X-Token:` is a header name as a separate token: the value comes next
    if a.len() > 2 && a.ends_with(':') {
        return (MASK.to_owned(), true);
    }
    if let Some((name, _)) = a.split_once('=') {
        if is_identifier(name) {
            return (format!("{name}={MASK}"), false); // `NAME=value`: the value is always hidden
        }
        return (MASK.to_owned(), false);
    }
    if a.len() == 2 && a.starts_with('/') && a.as_bytes()[1].is_ascii_alphabetic() {
        return (a.to_owned(), false); // cmd key: `/c`
    }
    let shown = safe_value(a);
    if shown != MASK {
        return (shown, false);
    }
    if pos.flag && is_plain_word(a) {
        return (a.to_owned(), false);
    }
    // Package name after npx/uvx and executable name in the command position: lower-case letters only.
    if pos.pkg && is_package_name(a) && !seg_secret(a) {
        return (a.to_owned(), false);
    }
    if pos.cmd
        && a.len() <= 41
        && a.starts_with(|c: char| c.is_ascii_lowercase())
        && a.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
        && !looks_like_token(a)
    {
        return (a.to_owned(), false);
    }
    (shown, false)
}

/// Command-line arguments where the first token is the executable (hooks).
pub fn mask_args(args: &[String]) -> Vec<String> {
    mask_args_ex(
        args,
        0,
        Pos {
            cmd: true,
            ..Pos::default()
        },
    )
}

/// Nesting deeper than this (`sh -c "bash -c '…'"`) is not parsed but hidden whole.
const MAX_DEPTH: usize = 3;

/// An argument with a space that does not look like a path with spaces is a nested command line.
pub(crate) fn is_nested_command(a: &str) -> bool {
    a.contains(char::is_whitespace) && !a.split_whitespace().all(|w| w.contains(['/', '\\']))
}

/// A program path whose directory names have spaces (`C:\Program Files\Microsoft VS Code\bin\code.cmd`). It is only
/// trusted where a program is expected (the command position, an MCP `command`): there a line is not a nested command.
/// Arguments cannot hide in it: the file name has no space, and every word of a spaced directory name is capitalised
/// ASCII letters or `(x86)` / `(x64)` / `(arm64)` (no digits, dots or dashes: `Run.exe Hunter2 x` and `x.exe --pw y` do not pass).
/// shortcut: a capitalised all-letter password between two path parts still passes; tighten if such a config turns up.
pub(crate) fn is_spaced_path(s: &str) -> bool {
    let segs: Vec<&str> = s.split(['/', '\\']).collect();
    let (Some(last), Some(dirs)) = (segs.last(), segs.get(..segs.len().saturating_sub(1))) else {
        return false;
    };
    let folder_word = |w: &str| {
        let letters = w.starts_with(|c: char| c.is_ascii_uppercase())
            && w.chars().all(|c| c.is_ascii_alphabetic());
        letters || matches!(w, "(x86)" | "(x64)" | "(arm64)")
    };
    // only a plain space separates folder words: a tab or NBSP would slip past the word check below
    s.contains(' ')
        && !s.chars().any(|c| c.is_whitespace() && c != ' ')
        && !last.contains(' ')
        && dirs
            .iter()
            .filter(|d| d.contains(' '))
            .all(|d| d.split(' ').all(folder_word))
        // each word is checked as a segment: `Program Files (x86)` as a whole mixes cases and digits like a key
        && is_path_like(&s.replace(' ', "/"))
}

fn mask_nested(arg: &str, depth: usize) -> String {
    if depth >= MAX_DEPTH {
        return MASK.to_owned();
    }
    let masked = join_line(&mask_args_ex(
        &split_shell(arg),
        depth + 1,
        Pos {
            cmd: true,
            ..Pos::default()
        },
    ));
    // collapse consecutive hidden words into one
    let mut out: Vec<&str> = Vec::new();
    for w in masked.split(' ') {
        if !(w == MASK && out.last() == Some(&MASK)) {
            out.push(w);
        }
    }
    out.join(" ")
}

fn stem_of(token: &str) -> String {
    let base = token.rsplit(['/', '\\']).next().unwrap_or(token);
    base.rsplit_once('.')
        .map_or(base, |(s, _)| s)
        .to_ascii_lowercase()
}

fn mask_args_ex(args: &[String], depth: usize, start: Pos) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let (mut hide_next, mut pos) = (false, start);
    for (i, a) in args.iter().enumerate() {
        if hide_next {
            out.push(MASK.to_owned());
            hide_next = false;
            pos = Pos::default();
        } else if pos.cmd && is_spaced_path(a) {
            out.push(a.clone()); // the program itself: `"C:\Program Files\…\code.cmd" --wait`
            pos = Pos::default();
        } else if is_nested_command(a) {
            out.push(mask_nested(a, depth));
            pos = Pos::default();
        } else if a.contains(char::is_whitespace) {
            // path with spaces
            out.push(if is_path_like(a) {
                a.clone()
            } else {
                MASK.to_owned()
            });
            pos = Pos {
                pkg: pos.pkg,
                ..Pos::default()
            };
        } else {
            let (shown, hide) = mask_token(a, pos, args.get(i + 1).map(String::as_str));
            let launcher = LAUNCHERS.contains(&stem_of(a).as_str());
            let is_flag = a.starts_with('-');
            // a command is expected after a control operator; the package name after npx/uvx, flags do not reset it
            pos = Pos {
                cmd: is_control_op(a),
                // the package name may come right after npx/uvx and after value-less flags (`-y`); a flag with a value
                // (`--header secret`) breaks the count, and the next word is not taken as a package
                pkg: launcher
                    || (pos.pkg
                        && is_flag
                        && matches!(
                            a.as_str(),
                            "-y" | "--yes" | "-q" | "--quiet" | "--no-install"
                        )),
                flag: is_plain_flag(a),
            };
            hide_next = hide;
            out.push(shown);
        }
    }
    out
}

/// Splits the command line on spaces, honouring quotes. A backslash is not treated as an escape
/// (on Windows it is a path separator), except `\"` and `\'` inside quotes.
pub fn split_shell(line: &str) -> Vec<String> {
    let (mut out, mut cur, mut quote, mut any) = (Vec::new(), String::new(), None::<char>, false);
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), '\\') if matches!(chars.peek(), Some(&n) if n == q) => {
                cur.push(q);
                chars.next();
            }
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                any = true;
            }
            (None, c) if c.is_whitespace() => {
                if any || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            (None, c) => cur.push(c),
        }
    }
    if any || !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// A whole command line (hooks, MCP `command`).
pub fn mask_line(line: &str) -> String {
    join_line(&mask_args(&split_shell(line)))
}

/// Joins tokens back into a line: tokens with spaces are put in double quotes.
pub fn join_line(tokens: &[String]) -> String {
    tokens
        .iter()
        .map(|t| {
            if t.contains(char::is_whitespace) {
                format!("\"{t}\"")
            } else {
                t.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Host with port: a name of letters, digits, `.` and `-` (or IPv6 in brackets), the port digits only.
fn host_ok(h: &str) -> bool {
    let (name, port) = match h.strip_prefix('[') {
        Some(r) => match r.split_once(']') {
            Some((v6, tail)) => (v6, tail.strip_prefix(':').or(tail.is_empty().then_some(""))),
            None => return false,
        },
        None => h.rsplit_once(':').map_or((h, None), |(n, p)| (n, Some(p))),
    };
    let name_ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'));
    name_ok && port.is_none_or(|p| p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()))
}

/// URL: without userinfo (`user:pass@`, `token@`), query, fragment and `;params`; host and port are checked;
/// token-like, JWT and %-encoded path segments are hidden. A string with an unknown scheme is hidden whole.
pub fn mask_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return MASK.to_owned();
    };
    if !SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) {
        return MASK.to_owned();
    }
    // Userinfo: everything up to the first `@` if there is no slash before it. A slash before `@` means either a path (`/@scope/pkg`),
    // or a password with a slash (`u:pa/ss@host`): we tell them apart by whether the word between the last slash and `@` is empty.
    let rest = match rest.find('@') {
        Some(i) => match rest[..i].rfind('/') {
            None => &rest[i + 1..],
            Some(j) if j + 1 < i => &rest[i + 1..],
            _ => rest,
        },
        None => rest,
    };
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let (host, path) = rest.split_once('/').map_or((rest, ""), |(h, p)| (h, p));
    if !host_ok(host) {
        return MASK.to_owned();
    }
    if path.is_empty() {
        return format!("{scheme}://{host}");
    }
    let path: Vec<String> = path
        .split('/')
        .map(|s| {
            let s = s.split(';').next().unwrap_or("");
            if seg_secret(s) || (s.contains('%') && s.len() >= 16) {
                MASK.to_owned()
            } else {
                s.to_owned()
            }
        })
        .collect();
    format!("{scheme}://{host}/{}", path.join("/"))
}

/// Version, commit hash, type, scheme name: only harmless characters and a sensible length, otherwise nothing.
pub fn safe_version(s: &str) -> Option<&str> {
    let hex = (7..=40).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit());
    let plain = !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-' | '_'))
        && !looks_like_token(s)
        && !high_entropy(s);
    (hex || plain).then_some(s)
}

/// Hook matcher (`Bash`, `Write|Edit`, `mcp__x__.*`): only regular-expression characters over tool names.
pub fn safe_matcher(s: &str) -> Option<&str> {
    (!s.is_empty()
        && s.len() <= 120
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '|' | '*' | '.' | '_' | '-' | ':' | '(' | ')' | '^' | '$')
        })
        && !s.split(['|', '(', ')']).any(seg_secret))
    .then_some(s)
}

/// Name of an entity from a file (skill, agent, hook event): letters of any alphabet, digits and `._-:@/` with a space, up to 80 characters,
/// without words that look like a secret.
pub fn safe_name(s: &str) -> Option<&str> {
    (!s.is_empty()
        && s.chars().count() <= 80
        && s.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-' | ':' | '@' | '/'))
        && !s.split_whitespace().any(seg_secret))
    .then_some(s)
}

/// A string from a file in a field where there should be no secrets (name, scope, pointer, note): pieces between
/// separators (`/ \ : @ , = ;` and space) that look like a token are replaced. Separators are kept.
pub fn scrub_words(s: &str) -> String {
    let is_delim =
        |c: char| c.is_whitespace() || matches!(c, '/' | '\\' | ':' | '@' | ',' | '=' | ';' | '~');
    let mut out = String::with_capacity(s.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        if !word.is_empty() {
            out.push_str(if seg_secret(word) { MASK } else { word });
            word.clear();
        }
    };
    // In a JSON Pointer `~1` is `/` and `~0` is `~` (RFC 6901): the escape is a delimiter as a whole, so its digit
    // does not glue to the next word and make a long name look like a token. The string itself stays encoded.
    let pointer = s.starts_with('/');
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if pointer && c == '~' && matches!(chars.peek(), Some('0' | '1')) {
            flush(&mut word, &mut out);
            out.push(c);
            out.extend(chars.next());
        } else if is_delim(c) {
            flush(&mut word, &mut out);
            out.push(c);
        } else {
            word.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

/// Free text (skill description): words that look like a token or a key of a known kind are replaced.
pub fn mask_prose(s: &str) -> String {
    const PREFIXES: [&str; 8] = ["sk-", "sk_", "ghp_", "gho_", "xox", "AKIA", "eyJ", "glpat"];
    s.split(' ')
        .map(|w| {
            let bare = w.trim_matches(|c: char| !c.is_alphanumeric());
            if seg_secret(bare) || PREFIXES.iter().any(|p| bare.starts_with(p)) {
                MASK
            } else {
                w
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn keys_of(cfg: &Value, names: &[&str]) -> Vec<String> {
    let mut keys: Vec<String> = names
        .iter()
        .filter_map(|n| cfg.get(n).and_then(Value::as_object))
        .flat_map(|o| o.keys().cloned())
        .map(|k| if seg_secret(&k) { MASK.to_owned() } else { k })
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

/// MCP server description without env and header values: key names only.
pub fn mcp_detail(cfg: &Value) -> Value {
    let command = cfg.get("command").and_then(Value::as_str);
    let url = cfg.get("url").and_then(Value::as_str);
    let transport = match cfg.get("type").and_then(Value::as_str) {
        Some(t @ ("stdio" | "http" | "sse")) => t,
        Some(_) => "other",
        None if command.is_some() => "stdio",
        None => "http",
    };
    let args: Vec<String> = cfg
        .get("args")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    // `args` do not start with the executable: it is in `command`. If it is npx/uvx, the first word without a flag is the package.
    let launcher = command.is_some_and(|c| LAUNCHERS.contains(&stem_of(c).as_str()));
    json!({
        "transport": transport,
        // `command` is the program itself (its arguments are in `args`): a bare path with spaces is not split
        "command": command.map(|c| if is_spaced_path(c) { c.to_owned() } else { mask_line(c) }),
        "args": mask_args_ex(&args, 0, Pos { pkg: launcher, ..Pos::default() }),
        "url": url.map(mask_url),
        "envKeys": keys_of(cfg, &["env"]),
        "headerKeys": keys_of(cfg, &["headers", "http_headers", "env_http_headers"]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn shown(v: &[&str]) -> String {
        mask_args(&a(v)).join(" ")
    }

    #[test]
    fn secret_keys() {
        for k in [
            "API_KEY",
            "github_token",
            "Authorization",
            "x-api-key",
            "PASSWORD",
            "oauthToken",
            "GH_PAT",
            "KEY_ID",
            "OAUTH_CLIENT",
            "auth",
            "session-id",
            "passphrase",
        ] {
            assert!(is_secret_key(k), "{k}");
        }
        for k in [
            "command",
            "NODE_ENV",
            "serverName",
            "timeout",
            "path",
            "PATH",
            "lang",
            "Content-Type",
        ] {
            assert!(!is_secret_key(k), "{k}");
        }
    }

    /// Findings of the final M1 audit: no value may get through.
    #[test]
    fn m1_audit_forms_do_not_leak() {
        let cases: Vec<(&str, &str)> = vec![
            ("tool --login bot@7a9F2kLmQ8xZ3vB1nC4dE6", "7a9F"),
            ("plink -pw admin@123 host", "admin@123"),
            ("plink -pw 4821 host", "4821"),
            ("tool -Password 48213", "48213"),
            ("openssl -pass 4821", "4821"),
            ("tool --pin 48213", "48213"),
            (r#"curl -H "X-Token: 48213" https://x"#, "48213"),
            (r#"tool -pw "correct horse battery""#, "correct"),
            (
                "aws configure set aws_secret_access_key /K7MDENG/bPxRfiCYEXAMPLEKEY",
                "K7MDENG",
            ),
            ("curl https://h/mcp/a1b2c3d4e5f6a7b8c9d0/sse", "a1b2c3d4"),
            (
                "curl https://h/mcp/qwErtyuiopAsdfghjklZxcvbnmQwertyuiop/sse",
                "qwErty",
            ),
            ("npx mypkg@a3f9c2e8b1d4f6a7c9e2b5d8", "a3f9c2e8"),
            ("npx -y a3f9c2e8b1d4f6a7c9e2", "a3f9c2e8"),
        ];
        for (line, secret) in cases {
            let out = mask_line(line);
            assert!(!out.contains(secret), "{line} -> {out}");
        }
        // and the harmless part is still visible
        assert_eq!(
            mask_line("npx -y firecrawl-mcp@1.2.3"),
            "npx -y firecrawl-mcp@1.2.3"
        );
        // user@address is not a secret and looks like package@version: we show it deliberately
        assert_eq!(mask_line("ssh admin@10.0.0.5"), "ssh admin@10.0.0.5");
    }

    #[test]
    fn scrub_words_hides_token_like_pieces_and_keeps_delimiters() {
        assert_eq!(
            scrub_words("/mcpServers/ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/x"),
            "/mcpServers/<masked>/x"
        );
        assert_eq!(scrub_words("claude.ai Github"), "claude.ai Github");
        assert_eq!(scrub_words("project:~/work/proj"), "project:~/work/proj");
        assert_eq!(scrub_words("harnio@harnio"), "harnio@harnio");
    }

    /// False positives of the 2a audit: these harmless values stay visible...
    #[test]
    fn audit_2a_harmless_values_stay_visible() {
        // a program under a directory with spaces (`Microsoft VS Code`): quoted in a hook, bare in an MCP `command`
        let code = r"C:\Program Files\Microsoft VS Code\bin\code.cmd";
        assert_eq!(
            mask_line(&format!("\"{code}\" --wait")),
            format!("\"{code}\" --wait")
        );
        assert_eq!(
            mcp_detail(&json!({ "command": code }))["command"],
            json!(code)
        );
        assert_eq!(
            mcp_detail(&json!({ "command": r"C:\Program Files (x86)\Tool Kit\tool.exe" }))
                ["command"],
            json!(r"C:\Program Files (x86)\Tool Kit\tool.exe")
        );
        // a short plain value right after a flag that does not name a secret
        assert_eq!(mask_line("tool --client x"), "tool --client x");
        assert_eq!(mask_line("tool --client=codex"), "tool --client=codex");
        assert_eq!(
            mask_line("tool --mode stdio --client claude-code"),
            "tool --mode stdio --client claude-code"
        );
        // RFC 6901 escapes in a pointer are not glued to the next word (`~1` is `/`, `~0` is `~`)
        for p in [
            "/projects/~0~1work~1loadout-release-candidate-two/mcpServers/x",
            "/enabledPlugins/scope~1loadout-release-candidate-two@mp",
        ] {
            assert_eq!(scrub_words(p), p);
        }
    }

    /// ...while the same shapes with a real secret stay hidden.
    #[test]
    fn audit_2a_secrets_next_to_them_stay_hidden() {
        for (line, secret) in [
            ("tool --client hunter2", "hunter2"),
            ("tool --client sk-abc123SECRETxyz", "sk-abc"),
            ("tool --token x", " x"),
            ("tool --user x", " x"),
            ("tool --env GITHUB_PAT S03", "S03"),
            ("tool --client=hunter2", "hunter2"),
            ("curl --header hunterpw", "hunterpw"),
            ("curl --header=hunterpw", "hunterpw"),
            ("tool --env hunterpw", "hunterpw"),
            ("tool --config hunterpw", "hunterpw"),
            ("tool x", " x"),
            ("plink -p 4821 host", "4821"),
            (r#""/usr/bin/tool --pw hunter""#, "hunter"),
            (r#"bash -c "C:\tools\x.exe hunter""#, "hunter"),
            (r#""C:\x\tool secretpw rel\f.txt""#, "secretpw"),
        ] {
            let out = mask_line(line);
            assert!(!out.contains(secret), "{line} -> {out}");
        }
        // checker's bypasses: a capitalised password between a program and a path, in a command or a nested line
        for (line, secret) in [
            (r#"cmd /c "C:\T\A.exe Pw1 X\o.txt""#, "Pw1"),
            (r#"bash -c "/opt/Run Hunter2 X/o.txt""#, "Hunter2"),
            (r#"bash -c "/opt/Run Hunterpw X/run.sh""#, "Hunterpw"),
            (
                r#""C:\Program Files\App\Run.exe Hunter2 More\x.js""#,
                "Hunter2",
            ),
            ("\"C:\\Program Files\\A.exe\tPw1\tX\\o.txt\" --wait", "Pw1"),
        ] {
            let out = mask_line(line);
            assert!(!out.contains(secret), "{line} -> {out}");
        }
        for cmd in [
            r"C:\tools\x.exe hunter",
            "/usr/bin/tool --pw hunter",
            r"C:\x\tool secretpw rel\f.txt",
            r"C:\Tools\Srv.exe Summer2024 Data\cfg.json",
            r"C:\Program Files\App\Run.exe Hunter2 More\x.js",
            "/opt/App/Server Hunter2pw Data/cfg.json",
            "C:\\Program Files\\A.exe\tPw1\tX\\o.txt",
        ] {
            let out = mcp_detail(&json!({ "command": cmd }))["command"].to_string();
            assert!(
                !["hunter", "secretpw", "Summer2024", "Hunter2", "Pw1"]
                    .iter()
                    .any(|s| out.contains(s)),
                "{cmd} -> {out}"
            );
        }
        assert_eq!(
            scrub_words("/mcpServers/~1ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
            "/mcpServers/~1<masked>"
        );
    }

    #[test]
    fn what_stays_visible() {
        for (line, want) in [
            (
                "-y rea-agents@6.8.0 mcp --idle-timeout 0",
                "-y rea-agents@6.8.0 mcp --idle-timeout 0",
            ),
            ("python -u script.py", "python -u script.py"),
            (
                "C:/Users/x/path/auth.json --lang ru --port 8080",
                "C:/Users/x/path/auth.json --lang ru --port 8080",
            ),
            ("uvx mcp-server-fetch", "uvx mcp-server-fetch"),
            ("npx -y firecrawl-mcp", "npx -y firecrawl-mcp"),
            (
                "npx -y @upstash/context7-mcp@latest",
                "npx -y @upstash/context7-mcp@latest",
            ),
            (
                "pwsh -NoProfile -ExecutionPolicy Bypass -File C:/x/y.ps1",
                "pwsh -NoProfile -ExecutionPolicy Bypass -File C:/x/y.ps1",
            ),
            (
                "git pull --rebase origin main",
                "git pull --rebase origin main",
            ),
            ("dist/mcp/stdio-wrapper.js", "dist/mcp/stdio-wrapper.js"),
            (
                "node server.js --log-level debug",
                "node server.js --log-level debug",
            ),
        ] {
            assert_eq!(mask_line(line), want, "{line}");
        }
        assert_eq!(
            mask_line("& 'C:/Program Files/x/tool.exe' --lang ru"),
            "& \"C:/Program Files/x/tool.exe\" --lang ru"
        );
    }

    /// Forms from the three audits: no value may get through.
    #[test]
    fn audit_forms_do_not_leak() {
        let cases: Vec<(Vec<&str>, &str)> = vec![
            (vec!["-e", "GH_PAT=S02"], "S02"),
            (vec!["--env", "GITHUB_PAT", "S03"], "S03"),
            (vec!["-u", "user:S04"], "S04"),
            (vec!["--config", r#"{"token":"S05"}"#], "S05"),
            (vec!["-H", "X-Api-Key:S06"], "S06"),
            (vec!["--auth", "S07"], "S07"),
            (vec!["Server=h;Password=S08"], "S08"),
            (vec!["https://example.com/mcp/s/S09abcdefghijklmnopqrstuvwxyz0/mcp"], "S09"),
            (vec!["OAUTH_CLIENT=S10"], "S10"),
            (vec!["--pat", "S12"], "S12"),
            (vec!["--header", "Authorization: Bearer S13"], "S13"),
            (vec!["--header=Authorization: Bearer S14"], "S14"),
            (vec!["--user=bob:PW1"], "PW1"),
            (vec!["-ubob:PW2"], "PW2"),
            (vec!["-pPW3"], "PW3"),
            (vec!["-p", "PW4"], "PW4"),
            (vec!["-a", "PW5"], "PW5"),
            (vec!["/P:PW7"], "PW7"),
            (vec!["/user:bob", "PW8"], "PW8"),
            (vec!["--args", r#"{"args":["--api-key","J1"]}"#], "J1"),
            (vec![r#"{"url":"https://u:J3@h"}"#], "J3"),
            (vec!["$env:API_TOKEN", "=", "PS3"], "PS3"),
            (vec!["@{", "X-Api-Key", "=", "PS2", "}"], "PS2"),
            (vec!["user:URL1@host:5432"], "URL1"),
            (vec!["tool", "AKIAABCDEFGHIJKLMNOP"], "AKIA"),
            (vec!["tool", "hunter2"], "hunter2"),
            (vec!["--token=my secret"], "secret"),
            (vec!["PASSWORD=correct horse"], "horse"),
            // third audit
            (vec!["uvx", "--from", "git+https://ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1@github.com/org/repo@main", "tool"], "ghp_"),
            (vec!["aws", "configure", "set", "aws_secret_access_key", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"], "wJalr"),
            (vec!["-EncodedCommand", "SQBFAFgAIAAoAE4AZQB3AC0ATwBi/+AAA"], "SQBF"),
            (vec!["--config", "C:/keys/ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345.json"], "ghp_"),
            (vec!["--x=sk-abc123SECRET+https://h"], "sk-abc"),
            (vec!["-p", "correct.horse"], "horse"),
            (vec!["-p", "4821"], "4821"),
            (vec!["--passphrase=hunter.22"], "hunter"),
            (vec!["--user=bob/secretpw"], "secretpw"),
            (vec!["tool", "2>/dev/null", "hunterpw"], "hunterpw"),
            (vec!["tool", ">hunterpw"], "hunterpw"),
            (vec!["Basic", "dXNlcjpwYXNz/d29yZA"], "dXNlcjpwYXNz"),
        ];
        for (c, secret) in cases {
            let out = shown(&c);
            assert!(!out.contains(secret), "{c:?} -> {out}");
        }
    }

    #[test]
    fn hook_lines_with_quotes_and_nesting() {
        for (line, secret) in [
            (r#"curl -H "Authorization: Bearer L01" https://x"#, "L01"),
            (r#"curl -H 'X-Api-Key: L02' https://x"#, "L02"),
            ("TOKEN=L03 node a.js", "L03"),
            ("node --token L04 guard.mjs", "L04"),
            (r#"bash -c "tool --token N01""#, "N01"),
            (r#"pwsh -Command "tool --api-key=N02 --user=bob""#, "N02"),
            (r#"cmd /c "tool -H 'X-Api-Key: N03'""#, "N03"),
            (r#"sh -c "bash -c 'tool --token N04'""#, "N04"),
            (r#"sh -c "sh -c \"sh -c 'sh -c tool --token N05'\"""#, "N05"),
            (r#"bash -c "export A=1; tool --token SC1""#, "SC1"),
            (
                r#"pwsh -Command "$ErrorActionPreference='Stop'; tool -Token SC2""#,
                "SC2",
            ),
            (r#"node --token="my secret" hook.js"#, "secret"),
            (r#"bash -c "tool --token \"ESC2 ESC2b\"""#, "ESC2b"),
            ("cat <<EOF | tool\nHD1\nEOF", "HD1"),
            ("mysql -pPW3 db", "PW3"),
            ("sshpass -p PW6 ssh host", "PW6"),
            // third audit: a nested string whose first word is a path
            (
                r#"bash -c "/usr/bin/tool sk_live_51HabcdefghijklmnopqrSTUV""#,
                "sk_live",
            ),
            (
                r#"bash -c "$HOME/bin/send.sh xoxb-1234-5678-abcdefSECRET prod""#,
                "xoxb",
            ),
            (r#"bash -c "./deploy.sh MyPassw0rd!""#, "MyPassw0rd"),
            (
                r#"curl -H "Authorization: Bearer abc/def+ghiSECRETtoken""#,
                "ghiSECRET",
            ),
        ] {
            let out = mask_line(line);
            assert!(!out.contains(secret), "{line} -> {out}");
        }
    }

    #[test]
    fn urls() {
        assert_eq!(
            mask_url("https://user:pw@api.example.com/mcp/?key=S3#x"),
            "https://api.example.com/mcp/"
        );
        assert_eq!(mask_url("http://127.0.0.1:4020"), "http://127.0.0.1:4020");
        assert_eq!(
            mask_url("https://TOKEN4@registry.npmjs.org/@scope/pkg"),
            "https://registry.npmjs.org/@scope/pkg"
        );
        for (url, secret) in [
            ("https://u:pa?ss@host/x", "ss"),
            ("https://u:pa#ss@host/x", "ss"),
            ("https://u:pa/ss@host/x", "ss"),
            ("redis:URL2@host", "URL2"),
            ("https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage", "AAH"),
            ("https://h/x;token=MX1/y", "MX1"),
            ("https://h/abc%2Bdef%2Fghi%3Djkl", "abc"),
            ("https://h:SECRETPW;key=SEC1/x", "SECRETPW"),
            ("https://h:SECRETPW/x", "SECRETPW"),
            ("sk-abc123SECRET+https://h", "sk-abc"),
            ("https://h/v1/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SIGNATUREPART/mcp", "eyJ"),
            ("https://h/hook/TOKEN3AbCdEfGhIjKlMnOpQrSt.json", "TOKEN3"),
        ] {
            let out = mask_url(url);
            assert!(!out.contains(secret), "{url} -> {out}");
        }
        assert_eq!(mask_url("https://[::1]:8080/x"), "https://[::1]:8080/x");
        assert_eq!(
            mask_url("https://h.example/@scope/pkg"),
            "https://h.example/@scope/pkg"
        );
    }

    #[test]
    fn mcp_detail_has_no_values() {
        let cfg = json!({"command":"node","args":["a.js","--token","S4","--user=bob:M1","-pM2","correcthorsebatterystaple"],"url":"user:M3@h","env":{"API_KEY":"S5","ghp_AbCdEfGhIjKlMnOpQrStUvWx0123":"x"},"headers":{"Authorization":"Bearer S6"}});
        let s = mcp_detail(&cfg).to_string();
        for secret in ["S4", "S5", "S6", "M1", "M2", "M3", "correcthorse", "ghp_"] {
            assert!(!s.contains(secret), "{secret} leaked: {s}");
        }
        assert!(s.contains("API_KEY") && s.contains("Authorization"));
        // the npx package name stays
        let npx = mcp_detail(&json!({"command":"npx","args":["-y","firecrawl-mcp"]})).to_string();
        assert!(npx.contains("firecrawl-mcp"), "{npx}");
    }

    #[test]
    fn free_text_fields() {
        assert_eq!(safe_version("1.2.3-rc.1"), Some("1.2.3-rc.1"));
        assert_eq!(
            safe_version("b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6"),
            Some("b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6")
        );
        assert_eq!(
            safe_version("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
            None
        );
        assert_eq!(safe_version("abc def"), None);
        assert_eq!(safe_name("Скил про VPN"), Some("Скил про VPN"));
        assert_eq!(safe_name("sk-ant-api03-AbCdEfGh0123456789xyz"), None);
        assert_eq!(
            safe_matcher("Write|Edit|mcp__x__.*"),
            Some("Write|Edit|mcp__x__.*")
        );
        assert_eq!(
            mask_prose("Ключ sk-ant-api03-AbCdEf0123456789 и текст"),
            "Ключ <masked> и текст"
        );
    }

    #[test]
    fn no_panics_on_odd_input() {
        for s in [
            "",
            "\"",
            "'",
            "\\",
            "é--token=ж",
            "Bearer",
            "eyJ",
            "日本語 --token 秘密",
            "a b c d e f g h",
            "😀 --x=😀",
            "https://",
            "://",
            "@",
            "[",
            "]:",
        ] {
            let _ = mask_line(s);
            let _ = mask_url(s);
            let _ = mask_args(&a(&[s]));
            let _ = mask_prose(s);
        }
        let long = "[".repeat(100_000);
        let _ = mask_line(&long);
        let _ = mask_url(&format!("https://{}", "@".repeat(50_000)));
    }
}
