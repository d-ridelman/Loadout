//! Loadout core: read-only (R0). A scanner for six clients: Claude Code, Claude Desktop, Codex, Antigravity, DeepSeek, OpenCode.

pub mod antigravity;
pub mod claude_code;
pub mod claude_desktop;
pub mod codex;
pub mod deepseek;
pub mod diff;
pub mod edit;
pub mod facts;
pub mod frontmatter;
pub mod i18n;
pub mod mask;
pub mod model;
pub mod opencode;
pub mod profiles;
pub mod trash;
pub mod watch;
pub mod write;
pub mod yaml_edit;

use model::{Client, Entity, Kind, ScanResult, State};
use serde_json::{json, Value};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub struct Ctx {
    pub home: PathBuf,
    pub entities: Vec<Entity>,
    pub warnings: Vec<String>,
    /// The OpenCode system config directory (`%ProgramData%\opencode`); `None` reads none (checks on a fixture home).
    pub opencode_system: Option<PathBuf>,
}

/// Size limit for a file being read.
const MAX_FILE_BYTES: u64 = 16 << 20;

fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Path for display without the user name: `~/…` with forward slashes. The boundary is by character and by `/`, letter case does not matter
/// (Windows: a project path in `.claude.json` may be written differently from `USERPROFILE`). The only implementation:
/// writing and the skill use it too.
pub(crate) fn tilde(home: &Path, p: &Path) -> String {
    let (s, h) = (norm(p), norm(home));
    let h = h.trim_end_matches('/');
    let under = s.len() >= h.len()
        && s.is_char_boundary(h.len())
        && s[..h.len()].eq_ignore_ascii_case(h)
        && (s.len() == h.len() || s.as_bytes()[h.len()] == b'/');
    if under {
        format!("~{}", &s[h.len()..])
    } else {
        s
    }
}

impl Ctx {
    /// Path for output, see [`tilde`].
    pub fn tilde(&self, p: &Path) -> String {
        tilde(&self.home, p)
    }

    /// A missing file is normal (the client is not installed); anything else is a warning.
    pub fn read_text(&mut self, p: &Path) -> Option<String> {
        // Client files can be large (`.claude.json` with caches), but not gigabytes: the limit protects against hangs.
        if std::fs::metadata(p).is_ok_and(|m| m.len() > MAX_FILE_BYTES) {
            let w = crate::tr!(
                "{}: файл больше {} МБ, пропущен",
                "{}: file is larger than {} MB, skipped",
                self.tilde(p),
                MAX_FILE_BYTES >> 20
            );
            self.warnings.push(w);
            return None;
        }
        match std::fs::read_to_string(p) {
            Ok(t) => Some(t),
            Err(e) if e.kind() == ErrorKind::NotFound => None,
            Err(e) => {
                let w = format!("{}: {}", self.tilde(p), e);
                self.warnings.push(w);
                None
            }
        }
    }

    pub fn read_json(&mut self, p: &Path) -> Option<Value> {
        let text = self.read_text(p)?;
        // a BOM (Notepad and some Windows editors write one) is no reason to ignore the file: the write side keeps it too
        match serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text)) {
            Ok(v) => Some(v),
            Err(e) => {
                let w = crate::tr!("{}: не JSON ({})", "{}: not JSON ({})", self.tilde(p), e);
                self.warnings.push(w);
                None
            }
        }
    }

    /// [`Ctx::read_json`] for JSONC files (comments, trailing commas): OpenCode's `opencode.json(c)`.
    pub fn read_jsonc(&mut self, p: &Path) -> Option<Value> {
        let text = self.read_text(p)?;
        let body = text.strip_prefix('\u{feff}').unwrap_or(&text);
        match jsonc_parser::parse_to_serde_value(body, &Default::default()) {
            Ok(v) => v,
            Err(e) => {
                let w = crate::tr!("{}: не JSONC ({})", "{}: not JSONC ({})", self.tilde(p), e);
                self.warnings.push(w);
                None
            }
        }
    }

    pub fn push(&mut self, e: Entity) {
        self.entities.push(e);
    }
}

/// Key name in a JSON Pointer (RFC 6901): `~` → `~0`, `/` → `~1`.
pub(crate) fn esc_ptr(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

/// A skill description as shown: masked first, cut to 200 characters after, so the cut never leaves a piece of a
/// token too short to be recognised.
fn shown_description(s: &str) -> String {
    mask::mask_prose(s).chars().take(200).collect()
}

/// The `mcpServers` object in the format `{name: {command, args, env?, url?}}` (Antigravity, Claude Desktop, Antigravity plugins).
pub(crate) fn scan_mcp_servers(
    c: &mut Ctx,
    client: Client,
    file: &str,
    root_ptr: &str,
    scope: &str,
    servers: Option<&Value>,
    // A client file Loadout may write to (R1/R2); `None` for plugin entries and entries from foreign directories.
    writable: Option<&Path>,
) {
    for (name, cfg) in servers.and_then(Value::as_object).into_iter().flatten() {
        let Some(shown) = mask::safe_name(name) else {
            c.warnings.push(crate::tr!(
                "{file}: MCP-сервер с недопустимым именем пропущен",
                "{file}: MCP server with an invalid name skipped"
            ));
            continue;
        };
        let mut e = Entity::new(
            client,
            Kind::Mcp,
            scope,
            shown,
            State::On,
            file,
            format!("{root_ptr}/{}", esc_ptr(name)),
        )
        .detail(mask::mcp_detail(cfg));
        if let Some(file_path) = writable {
            // the entry has no "disabled" flag: disabling cuts it out into the trash (trash.rs)
            let mut path: Vec<String> = root_ptr
                .split('/')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect();
            path.push(name.clone());
            e = e
                .target(model::Target {
                    file: file_path.to_path_buf(),
                    format: model::Format::Json,
                    path: path.clone(),
                    inverted: false,
                    kind: model::TargetKind::Cut,
                })
                .src(model::Src {
                    file: file_path.to_path_buf(),
                    format: model::Format::Json,
                    path,
                });
        }
        c.push(e);
    }
}

/// Directories `<root>/<name>/SKILL.md`. Directories without `SKILL.md` (service ones like `synced/`) are skipped.
pub(crate) fn scan_skills(c: &mut Ctx, client: Client, root: &Path, scope: &str) {
    let Ok(rd) = std::fs::read_dir(root) else {
        return;
    };
    let mut dirs: Vec<_> = rd.flatten().filter(|e| e.path().is_dir()).collect();
    dirs.sort_by_key(|e| e.file_name());
    for d in dirs {
        let dir_name = d.file_name().to_string_lossy().into_owned();
        let md = d.path().join("SKILL.md");
        let Some(fm) = frontmatter::read(&md) else {
            continue;
        };
        // Name and description are text from the file: they go through the filters so that a secret in the description does not reach the output.
        let name = fm
            .get("name")
            .and_then(|n| mask::safe_name(n))
            .map_or_else(|| dir_name.clone(), str::to_owned);
        let desc: String = fm
            .get("description")
            .map(|s| shown_description(s))
            .unwrap_or_default();
        let mut e = Entity::new(
            client,
            Kind::Skill,
            scope,
            name.clone(),
            State::On,
            c.tilde(&md),
            "frontmatter",
        )
        .detail(json!({ "description": desc }))
        .fs_named(); // the name has already passed safe_name, and the fallback is the directory name
        if name != dir_name {
            e = e.note(crate::tr!(
                "имя в frontmatter «{name}» не совпадает с каталогом «{dir_name}»",
                "name in frontmatter “{name}” does not match the directory “{dir_name}”"
            ));
        }
        c.push(e);
    }
}

/// Hooks in the shared Claude Code / Codex format: `{Event: [{matcher?, hooks: [{type, command, timeout}]}]}`.
pub(crate) fn scan_hooks(
    c: &mut Ctx,
    client: Client,
    file: &str,
    root_ptr: &str,
    scope: &str,
    hooks: &Value,
) {
    let Some(events) = hooks.as_object() else {
        return;
    };
    for (event, groups) in events {
        let Some(ev) = mask::safe_name(event) else {
            c.warnings.push(crate::tr!(
                "{file}: событие хука с недопустимым именем пропущено",
                "{file}: hook event with an invalid name skipped"
            ));
            continue;
        };
        for (gi, g) in groups.as_array().into_iter().flatten().enumerate() {
            let matcher = g.get("matcher").and_then(Value::as_str);
            for (hi, h) in g
                .get("hooks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                let cmd = h.get("command").and_then(Value::as_str).unwrap_or("");
                // Both the label and the displayed command are built from already masked tokens.
                let tokens = mask::mask_args(&mask::split_shell(cmd));
                let label = hook_label(&tokens);
                let e = Entity::new(
                    client,
                    Kind::Hook,
                    scope,
                    format!("{ev}: {label}"),
                    State::On,
                    file,
                    format!("{root_ptr}/{}/{gi}/hooks/{hi}", esc_ptr(event)),
                )
                // A hook without a recognized label is not merged with identical hooks of other clients into one row.
                .logical(agent_hooks_group(&tokens).unwrap_or_else(|| {
                    if label == "hook" {
                        format!("hook:{}", client.slug())
                    } else {
                        label
                    }
                }))
                .detail(json!({
                    "event": ev,
                    "matcher": matcher.and_then(mask::safe_matcher),
                    "type": h.get("type").and_then(Value::as_str).and_then(mask::safe_version),
                    "command": mask::join_line(&tokens),
                    "timeout": h.get("timeout").filter(|t| t.is_number()),
                }));
                c.push(e);
            }
        }
    }
}

/// Short hook name: the executable name of the first command (`& 'C:/x/context-toolkit.exe' --lang ru` → `context-toolkit`).
/// Tokens are already masked: masked ones, `NAME=value`, flags and keys like `/c` are skipped.
fn hook_label(tokens: &[String]) -> String {
    // Interpreters and wrappers with the real command behind them.
    const RUNNERS: [&str; 15] = [
        "node",
        "python",
        "python3",
        "pwsh",
        "powershell",
        "bash",
        "sh",
        "cmd",
        "nohup",
        "disown",
        "exec",
        "env",
        "sudo",
        "time",
        "start",
    ];
    let stem = |t: &str| {
        let base = t.rsplit(['/', '\\']).next().unwrap_or(t).to_owned();
        base.rsplit_once('.')
            .map_or(base.clone(), |(s, _)| s.to_owned())
    };
    let is_switch = |t: &str| t.len() == 2 && t.starts_with('/');
    let tokens = expand_nested(tokens, 0);
    // the value of a flag whose value the mask shows (`--client codex`) is not a program name
    let flag_value = |i: usize, _: &str| i > 0 && mask::is_plain_flag(&tokens[i - 1]);
    tokens
        .iter()
        .enumerate()
        .filter(|(i, t)| !flag_value(*i, t))
        .map(|(_, t)| t.trim_matches(|c| c == '&' || c == ';'))
        .filter(|t| {
            !t.is_empty()
                && !t.contains('>') // redirections `>/dev/null`, `2>&1`
                && !t.starts_with('-')
                && !t.contains('=')
                && !t.contains(mask::MASK)
                && !is_switch(t)
        })
        .map(stem)
        // flag values (`--lang ru`) cannot be a hook name, even if the program path is hidden
        .find(|s| {
            let l = s.to_ascii_lowercase();
            !RUNNERS.contains(&l.as_str()) && !VALUE_WORDS.contains(&l.as_str())
        })
        .unwrap_or_else(|| "hook".to_owned())
}

/// Words that occur as flag values rather than program names.
const VALUE_WORDS: [&str; 12] = [
    "ru", "en", "true", "false", "debug", "info", "warn", "error", "trace", "latest", "main",
    "origin",
];

/// Hooks that one external program installs into several clients at once live in the `<program>/agent-hooks` directory
/// (on the owner's machine `~/.orca/agent-hooks/codex-hook.cmd`, `dsh-hook.cmd`) and are named after the client. To match across
/// clients we take not the file name but the group: `orca-agent-hooks`.
fn agent_hooks_group(tokens: &[String]) -> Option<String> {
    tokens.iter().find_map(|t| {
        let norm = t.replace('\\', "/");
        let parts: Vec<&str> = norm.split('/').collect();
        let i = parts.iter().position(|p| *p == "agent-hooks")?;
        let owner = parts.get(i.checked_sub(1)?)?.trim_start_matches('.');
        (!owner.is_empty() && mask::safe_name(owner).is_some())
            .then(|| format!("{owner}-agent-hooks"))
    })
}

/// A nested command line (`bash -c "tool --x"`) arrives as one token with spaces:
/// for the label we expand it into tokens. A path with spaces (every word with a separator) stays one token.
fn expand_nested(tokens: &[String], depth: usize) -> Vec<String> {
    let mut out = Vec::new();
    for t in tokens {
        // a program path with spaces stays whole (the mask kept it only in the program position)
        if mask::is_nested_command(t) && !mask::is_spaced_path(t) && depth < 3 {
            out.extend(expand_nested(&mask::split_shell(t), depth + 1));
        } else {
            out.push(t.clone());
        }
    }
    out
}

fn chars_eq_ci(a: char, b: char) -> bool {
    a == b || a.to_lowercase().eq(b.to_lowercase())
}

/// Replaces `pat` with `~` case-insensitively (including Cyrillic). Works on characters, not bytes:
/// slicing a string inside a multibyte letter is impossible.
fn replace_ci(s: &str, pat: &str) -> String {
    let pc: Vec<char> = pat.chars().collect();
    if pc.is_empty() {
        return s.to_owned();
    }
    let sc: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < sc.len() {
        let end = i + pc.len();
        // A match must not cut a name in half: `C:\Users\alice` does not belong to the home `C:\Users\al`.
        let hit = end <= sc.len()
            && sc[i..end].iter().zip(&pc).all(|(a, b)| chars_eq_ci(*a, *b))
            && !sc
                .get(end)
                .is_some_and(|c| c.is_alphanumeric() || *c == '_');
        if hit {
            out.push('~');
            i = end;
        } else {
            out.push(sc[i]);
            i += 1;
        }
    }
    out
}

fn scrub_str(s: &mut String, forms: &[String]) {
    for f in forms {
        *s = replace_ci(s, f);
    }
    // Mixed separators (`C:\Users/x\y`): we also check a copy with forward slashes.
    if s.contains('\\') {
        let normalized = s.replace('\\', "/");
        let mut r = normalized.clone();
        for f in forms {
            r = replace_ci(&r, f);
        }
        if r != normalized {
            *s = r;
        }
    }
}

fn scrub(v: &mut Value, forms: &[String]) {
    match v {
        Value::String(s) => scrub_str(s, forms),
        Value::Array(a) => a.iter_mut().for_each(|x| scrub(x, forms)),
        Value::Object(o) => o.values_mut().for_each(|x| scrub(x, forms)),
        _ => {}
    }
}

/// `scrub` for an entry's `detail`. `exact` (set by `mask::mcp_detail`) promises the window the command as the file holds it;
/// a home path turned into `~` breaks that promise (a server is started without a shell, nobody expands `~`).
fn scrub_detail(detail: &mut Value, forms: &[String]) {
    let shown = |d: &Value| (d.get("command").cloned(), d.get("args").cloned());
    let before = shown(detail);
    scrub(detail, forms);
    if detail.get("exact") == Some(&Value::Bool(true)) && shown(detail) != before {
        detail["exact"] = Value::Bool(false);
    }
}

/// The home directory path in a string (in all `home_forms` forms) is replaced with `~`: for plans and the write journal,
/// where user-entered commands and copied arguments end up.
pub(crate) fn scrub_home(home: &Path, s: &str) -> String {
    let mut out = s.to_owned();
    scrub_str(&mut out, &home_forms(home));
    out
}

/// All spellings of the home directory as they may appear in foreign files:
/// `C:\Users\x`, `C:/Users/x`, Git Bash `/c/Users/x`, WSL `/mnt/c/Users/x`.
fn home_forms(home: &Path) -> Vec<String> {
    let raw = home.to_string_lossy().into_owned();
    let fwd = raw.replace('\\', "/");
    // `C:\\Users\\x` is how the path looks inside a JSON string and escaped arguments.
    let doubled = raw.replace('\\', "\\\\");
    let mut forms = vec![raw, fwd.clone(), doubled];
    let b = fwd.as_bytes();
    if b.len() > 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        let drive = (b[0] as char).to_ascii_lowercase();
        let rest = &fwd[2..];
        forms.push(format!("/{drive}{rest}"));
        forms.push(format!("/mnt/{drive}{rest}"));
        // administrative UNC share: `\\localhost\c$\Users\x`
        let unc = format!("\\\\localhost\\{drive}${}", rest.replace('/', "\\"));
        forms.push(unc.replace('\\', "/"));
        forms.push(unc);
    }
    // Short 8.3 name (`RIDELM~1`): the first six letters and digits of the name, upper case.
    if let (Some(user), Some(parent)) = (home.file_name().and_then(|n| n.to_str()), home.parent()) {
        let short: String = user
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .take(6)
            .collect::<String>()
            .to_ascii_uppercase();
        if user.chars().count() > 8 && short.len() >= 2 {
            let parent = parent.to_string_lossy().replace('\\', "/");
            for n in 1..=3 {
                forms.push(format!("{parent}/{short}~{n}"));
            }
        }
    }
    // WSL/Linux/macOS home directory with the same user name (Codex configs contain `/home/<name>/…`).
    if let Some(user) = home.file_name().and_then(|n| n.to_str()) {
        forms.push(format!("/home/{user}"));
        forms.push(format!("/Users/{user}"));
    }
    // Long forms first: `/c/Users/x` is contained in `/mnt/c/Users/x` and would otherwise leave `/mnt~`.
    forms.sort_by_key(|f| std::cmp::Reverse(f.len()));
    forms
}

pub fn scan(home: &Path) -> ScanResult {
    scan_with(home, None)
}

/// A scan with the Loadout trash (`store` is the app's backup directory): removed entries show up as disabled.
/// No machine-wide config is read: the result depends on `home` alone (what checks need).
pub fn scan_with(home: &Path, store: Option<&Path>) -> ScanResult {
    scan_all(home, store, None)
}

/// [`scan_with`] plus the machine-wide OpenCode config in `opencode_system` (the CLI passes `%ProgramData%\opencode`).
pub fn scan_all(home: &Path, store: Option<&Path>, opencode_system: Option<&Path>) -> ScanResult {
    let mut c = Ctx {
        home: home.to_path_buf(),
        entities: Vec::new(),
        warnings: Vec::new(),
        opencode_system: opencode_system.map(Path::to_path_buf),
    };
    claude_code::scan(&mut c);
    claude_desktop::scan(&mut c);
    codex::scan(&mut c);
    antigravity::scan(&mut c);
    deepseek::scan(&mut c);
    opencode::scan(&mut c);
    if let Some(store) = store {
        trash::inject(&mut c, store);
    }

    // Last line of defense: the home directory path must not remain in any string field.
    let forms = home_forms(home);
    let mut seen_ids: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for e in &mut c.entities {
        e.can_toggle = e.target.is_some();
        e.can_edit = e.src.is_some();
        e.toggle_level = e.target.as_ref().map(|t| {
            match t.kind {
                model::TargetKind::Flag => "R1",
                _ => "R2",
            }
            .to_owned()
        });
        if !e.can_toggle {
            e.toggle_why = Some(write::why_not(e));
        }
        // the same place the write plan will name; computed before the origin strings below are scrubbed
        e.toggle_at = e
            .target
            .as_ref()
            .map(|t| {
                let (file, pointer) = write::toggle_place(home, e, t);
                model::Origin { file, pointer }
            })
            .filter(|at| *at != e.origin);
        for s in [
            &mut e.name,
            &mut e.scope,
            &mut e.logical_key,
            &mut e.origin.file,
            &mut e.origin.pointer,
        ] {
            scrub_str(s, &forms);
        }
        if let Some(at) = e.toggle_at.as_mut() {
            scrub_str(&mut at.file, &forms);
            scrub_str(&mut at.pointer, &forms);
            if !e.fs_named {
                at.pointer = mask::scrub_words(&at.pointer);
            }
        }
        // Strings from files in names, scopes and pointers: words that look like a token are hidden.
        // Names from the file system (skill directories, the Codex directory) are left alone: they are not secrets, and hiding them merges entries.
        let fs = e.fs_named;
        let fields: [&mut String; 5] = [
            &mut e.name,
            &mut e.scope,
            &mut e.logical_key,
            &mut e.origin.file,
            &mut e.origin.pointer,
        ];
        // The file path of such an entry is the same directory name, and its note quotes only that name and the filtered one.
        for (i, s) in fields.into_iter().enumerate() {
            let fs_field = matches!(i, 0 | 2 | 3 | 4) && fs;
            if !fs_field {
                *s = mask::scrub_words(s);
            }
        }
        if let Some(s) = e.note.as_mut() {
            scrub_str(s, &forms);
            if !fs {
                *s = mask::scrub_words(s);
            }
        }
        if let Some(s) = e.version.as_mut() {
            scrub_str(s, &forms);
        }
        scrub_detail(&mut e.detail, &forms);
        // the id is unique within one scan, even if one entry is read from two places (a patch and a dsh profile).
        let n = seen_ids.entry(e.id.clone()).or_insert(0);
        *n += 1;
        if *n > 1 {
            e.id = format!("{}-{n}", e.id);
        }
    }
    for w in &mut c.warnings {
        scrub_str(w, &forms);
    }
    ScanResult {
        entities: c.entities,
        warnings: c.warnings,
        facts: facts::collect(home),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_description_is_masked_before_it_is_cut() {
        // a 32-hex token across the 200-character cut: cutting first would leave 10 characters, too few to recognise
        let token = "0123456789abcdef0123456789abcdef";
        let s = format!("{} {token} tail", "word ".repeat(38).trim_end());
        assert!(s.chars().count() > 200 && s.find(token).unwrap() < 200);
        let shown = shown_description(&s);
        assert!(!shown.contains("0123456789"), "{shown}");
        assert!(shown.chars().count() <= 200);
    }

    fn label(cmd: &str) -> String {
        hook_label(&mask::mask_args(&mask::split_shell(cmd)))
    }

    #[test]
    fn a_home_path_turned_into_tilde_is_not_an_exact_command() {
        let forms = home_forms(Path::new(r"C:\Users\me"));
        let mut inside = mask::mcp_detail(
            &serde_json::json!({"command":"node","args":[r"C:\Users\me\mcp\server.js"]}),
        );
        assert_eq!(
            inside["exact"],
            serde_json::json!(true),
            "masking alone keeps a plain path"
        );
        scrub_detail(&mut inside, &forms);
        assert_eq!(inside["exact"], serde_json::json!(false), "{inside}");
        let mut outside =
            mask::mcp_detail(&serde_json::json!({"command":"node","args":[r"D:\tools\server.js"]}));
        scrub_detail(&mut outside, &forms);
        assert_eq!(outside["exact"], serde_json::json!(true), "{outside}");
    }

    #[test]
    fn labels() {
        assert_eq!(
            label("& 'C:/Users/x/.claude/hooks/ctxkit.exe' --dsh --lang ru"),
            "ctxkit"
        );
        assert_eq!(
            label("node C:\\h\\no-inline-backslash.mjs"),
            "no-inline-backslash"
        );
        assert_eq!(
            label("pwsh -NoProfile -File C:/h/temp-sweep.ps1"),
            "temp-sweep"
        );
        assert_eq!(label("cmd /c notify.cmd"), "notify");
        assert_eq!(label(""), "hook");
    }

    #[test]
    fn wrapper_hooks_share_a_group_across_clients() {
        let t = |s: &str| mask::mask_args(&mask::split_shell(s));
        assert_eq!(
            agent_hooks_group(&t("C:/Users/x/.orca/agent-hooks/codex-hook.cmd")).as_deref(),
            Some("orca-agent-hooks")
        );
        assert_eq!(
            agent_hooks_group(&t("C:\\Users\\x\\.orca\\agent-hooks\\dsh-hook.cmd")).as_deref(),
            Some("orca-agent-hooks")
        );
        assert_eq!(agent_hooks_group(&t("C:/x/hooks/ctxkit.exe")), None);
    }

    #[test]
    fn label_skips_wrappers_and_redirects() {
        // the real shape of the owner's SessionStart hook
        assert_eq!(
            label(
                r#""C:/Program Files/Git/usr/bin/bash.exe" -lc "nohup bash $HOME/.claude/skill-sources/pull-skills.sh >/dev/null 2>&1 & disown""#
            ),
            "pull-skills"
        );
    }

    #[test]
    fn label_from_nested_command_lines() {
        assert_eq!(label(r#"bash -c "tool --token N01""#), "tool");
        assert_eq!(label(r#"sh -c "bash -c 'guard --api-key N02'""#), "guard");
        assert_eq!(label(r#"node "C:/Program Files/x/hook.js""#), "hook");
        assert_eq!(label(r#"bash -c "/usr/bin/tool --token N03""#), "tool");
    }

    #[test]
    fn a_visible_flag_value_is_not_the_label() {
        assert_eq!(label("node --client codex guard.mjs"), "guard");
        assert_eq!(label("tool --client=codex"), "tool");
        assert_eq!(label("bash --login script.sh"), "script");
        assert_eq!(label("sudo --preserve-env docker run"), "docker");
        assert_eq!(
            label(r#""C:\Program Files\Microsoft VS Code\bin\code.cmd" --wait"#),
            "code"
        );
        assert_eq!(label(r#"cmd /c "C:\T\A.exe Pw1 X\o.txt""#), "A");
    }

    #[test]
    fn label_never_carries_a_secret() {
        // a secret before the script name: the former `name="PreToolUse: H02"`
        assert_eq!(label("node --token H02 guard.mjs"), "guard");
        assert_eq!(label("TOKEN=H01 node a.js"), "a");
    }

    #[test]
    fn scrub_is_case_insensitive_and_knows_other_path_forms() {
        let forms = home_forms(Path::new("C:\\Users\\Alice"));
        for (input, want) in [
            ("C:\\Users\\Alice\\x", "~\\x"),
            ("c:/users/alice/x", "~/x"),
            ("/c/Users/Alice/x", "~/x"),
            ("/mnt/c/Users/Alice/x", "~/x"),
            ("/home/alice/proj", "~/proj"),
        ] {
            let mut s = input.to_owned();
            scrub_str(&mut s, &forms);
            assert_eq!(s, want, "{input}");
        }
    }

    #[test]
    fn scrub_handles_non_ascii_text_and_word_boundaries() {
        let forms = home_forms(Path::new("C:\\Users\\al"));
        for (input, want) in [
            ("Путь C:\\Users\\al\\проект", "Путь ~\\проект"),
            ("C:\\Users\\alice\\x", "C:\\Users\\alice\\x"), // a different user: leave alone
            ("😀 C:/Users/al/x 日本語", "😀 ~/x 日本語"),
            ("C:\\\\Users\\\\al\\\\x", "~\\\\x"), // a path inside a JSON string
            ("\\\\localhost\\c$\\Users\\al\\p", "~\\p"),
        ] {
            let mut s = input.to_owned();
            scrub_str(&mut s, &forms);
            assert_eq!(s, want, "{input}");
        }
    }

    #[test]
    fn scrub_ignores_case_of_non_ascii_names() {
        let forms = home_forms(Path::new("C:\\Users\\Пётр"));
        let mut s = "C:/Users/ПЁТР/a.js и c:\\users\\пётр\\b".to_owned();
        scrub_str(&mut s, &forms);
        assert_eq!(s, "~/a.js и ~\\b");
    }

    #[test]
    fn scrub_mixed_separators_and_short_names() {
        let forms = home_forms(Path::new("C:\\Users\\Alexandra Petrova"));
        for (input, want) in [
            ("C:\\Users/Alexandra Petrova\\x/Zed/y", "~/x/Zed/y"),
            ("C:/Users/ALEXAN~1/x.txt", "~/x.txt"),
            ("C:\\Users\\ALEXAN~2\\x", "~/x"),
        ] {
            let mut s = input.to_owned();
            scrub_str(&mut s, &forms);
            assert_eq!(s, want, "{input}");
        }
    }

    #[test]
    fn tilde_ignores_case() {
        let c = Ctx {
            home: PathBuf::from("C:\\Users\\Alice"),
            entities: vec![],
            warnings: vec![],
            opencode_system: None,
        };
        assert_eq!(c.tilde(Path::new("c:/users/ALICE/work/p")), "~/work/p");
        assert_eq!(c.tilde(Path::new("D:/other")), "D:/other");
        assert_eq!(c.tilde(Path::new("C:/Users/Alicia/x")), "C:/Users/Alicia/x");
    }
}
