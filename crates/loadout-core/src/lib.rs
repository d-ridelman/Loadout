//! Ядро Loadout, этап M0: только чтение (R0). Сканер Claude Code и Codex.

pub mod claude_code;
pub mod codex;
pub mod frontmatter;
pub mod mask;
pub mod model;

use model::{Client, Entity, Kind, ScanResult, State};
use serde_json::{json, Value};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub struct Ctx {
    pub home: PathBuf,
    pub entities: Vec<Entity>,
    pub warnings: Vec<String>,
}

fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

impl Ctx {
    /// Путь для вывода: `~/…` с прямыми слэшами, чтобы имя пользователя не попадало в отчёты.
    /// Регистр букв не важен (Windows): путь проекта в `.claude.json` может быть записан иначе, чем `USERPROFILE`.
    pub fn tilde(&self, p: &Path) -> String {
        let (s, h) = (norm(p), norm(&self.home));
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

    /// Отсутствие файла — норма (клиент не установлен), остальное — предупреждение.
    pub fn read_text(&mut self, p: &Path) -> Option<String> {
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
        match serde_json::from_str(&text) {
            Ok(v) => Some(v),
            Err(e) => {
                let w = format!("{}: не JSON ({})", self.tilde(p), e);
                self.warnings.push(w);
                None
            }
        }
    }

    pub fn push(&mut self, e: Entity) {
        self.entities.push(e);
    }
}

/// Имя ключа в JSON Pointer (RFC 6901): `~` → `~0`, `/` → `~1`.
pub(crate) fn esc_ptr(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

/// Каталоги `<корень>/<имя>/SKILL.md`. Каталоги без `SKILL.md` (служебные вроде `synced/`) пропускаем.
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
        let name = fm.get("name").cloned().unwrap_or_else(|| dir_name.clone());
        let desc: String = fm
            .get("description")
            .map(|s| s.chars().take(200).collect())
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
        .detail(json!({ "description": desc }));
        if name != dir_name {
            e = e.note(format!(
                "имя в frontmatter «{name}» не совпадает с каталогом «{dir_name}»"
            ));
        }
        c.push(e);
    }
}

/// Хуки в общем формате Claude Code / Codex: `{Событие: [{matcher?, hooks: [{type, command, timeout}]}]}`.
pub(crate) fn scan_hooks(c: &mut Ctx, client: Client, file: &str, root_ptr: &str, hooks: &Value) {
    let Some(events) = hooks.as_object() else {
        return;
    };
    for (event, groups) in events {
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
                // И метка, и показанная команда строятся из уже замаскированных токенов.
                let tokens = mask::mask_args(&mask::split_shell(cmd));
                let label = hook_label(&tokens);
                let e = Entity::new(
                    client,
                    Kind::Hook,
                    "user",
                    format!("{event}: {label}"),
                    State::On,
                    file,
                    format!("{root_ptr}/{}/{gi}/hooks/{hi}", esc_ptr(event)),
                )
                .logical(label)
                .detail(json!({
                    "event": event,
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

/// Короткое имя хука: имя исполняемого файла первой команды (`& 'C:/x/ctxkit.exe' --lang ru` → `ctxkit`).
/// Токены уже замаскированы: замаскированные, `ИМЯ=значение`, флаги и ключи вида `/c` пропускаем.
fn hook_label(tokens: &[String]) -> String {
    // Интерпретаторы и обёртки, за которыми стоит настоящая команда.
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
    expand_nested(tokens, 0)
        .iter()
        .map(|t| t.trim_matches(|c| c == '&' || c == ';'))
        .filter(|t| {
            !t.is_empty()
                && !t.contains('>') // перенаправления `>/dev/null`, `2>&1`
                && !t.starts_with('-')
                && !t.contains('=')
                && !t.contains(mask::MASK)
                && !is_switch(t)
        })
        .map(stem)
        .find(|s| !RUNNERS.contains(&s.to_ascii_lowercase().as_str()))
        .unwrap_or_else(|| "hook".to_owned())
}

/// Вложенная командная строка (`bash -c "tool --x"`) приходит одним токеном с пробелами:
/// для метки раскрываем её в токены. Токен, у которого первое слово — путь, считаем одним путём с пробелами.
fn expand_nested(tokens: &[String], depth: usize) -> Vec<String> {
    let mut out = Vec::new();
    for t in tokens {
        let mut words = t.split_whitespace();
        let first = words.next().unwrap_or("");
        // Путь с пробелами: первое слово с разделителем и дальше ни одного флага (`-x`).
        let looks_like_path = first.contains(['/', '\\']) && !words.any(|w| w.starts_with('-'));
        let nested = t.contains(char::is_whitespace) && !looks_like_path;
        if nested && depth < 3 {
            out.extend(expand_nested(&mask::split_shell(t), depth + 1));
        } else {
            out.push(t.clone());
        }
    }
    out
}

/// Заменяет `pat` на `~` без учёта регистра ASCII.
fn replace_ci(s: &str, pat: &str) -> String {
    let (sb, pb) = (s.as_bytes(), pat.as_bytes());
    if pb.is_empty() {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let end = i + pb.len();
        // Совпадение не должно обрывать имя: домой `C:\Users\al` не принадлежит `C:\Users\alice`.
        // Границу символа проверяем до любого среза: `end` может попасть внутрь кириллической буквы.
        let hit = end <= sb.len()
            && s.is_char_boundary(end)
            && sb[i..end].eq_ignore_ascii_case(pb)
            && !s[end..]
                .chars()
                .next()
                .is_some_and(|c| c.is_alphanumeric() || c == '_');
        if hit {
            out.push('~');
            i = end;
        } else {
            let ch = s[i..].chars().next().expect("i на границе символа");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn scrub_str(s: &mut String, forms: &[String]) {
    for f in forms {
        *s = replace_ci(s, f);
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

/// Все записи домашнего каталога, как они могут встретиться в чужих файлах:
/// `C:\Users\x`, `C:/Users/x`, Git Bash `/c/Users/x`, WSL `/mnt/c/Users/x`.
fn home_forms(home: &Path) -> Vec<String> {
    let raw = home.to_string_lossy().into_owned();
    let fwd = raw.replace('\\', "/");
    // `C:\\Users\\x` — так путь выглядит внутри JSON-строки и экранированных аргументов.
    let doubled = raw.replace('\\', "\\\\");
    let mut forms = vec![raw, fwd.clone(), doubled];
    let b = fwd.as_bytes();
    if b.len() > 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        let drive = (b[0] as char).to_ascii_lowercase();
        let rest = &fwd[2..];
        forms.push(format!("/{drive}{rest}"));
        forms.push(format!("/mnt/{drive}{rest}"));
        // административная UNC-шара: `\\localhost\c$\Users\x`
        let unc = format!("\\\\localhost\\{drive}${}", rest.replace('/', "\\"));
        forms.push(unc.replace('\\', "/"));
        forms.push(unc);
    }
    // Домашний каталог WSL/Linux/macOS с тем же именем пользователя (в конфигах Codex встречается `/home/<имя>/…`).
    if let Some(user) = home.file_name().and_then(|n| n.to_str()) {
        forms.push(format!("/home/{user}"));
        forms.push(format!("/Users/{user}"));
    }
    // Длинные формы первыми: `/c/Users/x` входит в `/mnt/c/Users/x` и иначе оставит `/mnt~`.
    forms.sort_by_key(|f| std::cmp::Reverse(f.len()));
    forms
}

pub fn scan(home: &Path) -> ScanResult {
    let mut c = Ctx {
        home: home.to_path_buf(),
        entities: Vec::new(),
        warnings: Vec::new(),
    };
    claude_code::scan(&mut c);
    codex::scan(&mut c);

    // Последний рубеж: путь домашнего каталога не должен остаться ни в одном строковом поле.
    let forms = home_forms(home);
    for e in &mut c.entities {
        for s in [
            &mut e.name,
            &mut e.scope,
            &mut e.logical_key,
            &mut e.origin.file,
            &mut e.origin.pointer,
        ] {
            scrub_str(s, &forms);
        }
        if let Some(s) = e.note.as_mut() {
            scrub_str(s, &forms);
        }
        if let Some(s) = e.version.as_mut() {
            scrub_str(s, &forms);
        }
        scrub(&mut e.detail, &forms);
    }
    for w in &mut c.warnings {
        scrub_str(w, &forms);
    }
    ScanResult {
        entities: c.entities,
        warnings: c.warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(cmd: &str) -> String {
        hook_label(&mask::mask_args(&mask::split_shell(cmd)))
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
    fn label_skips_wrappers_and_redirects() {
        // реальная форма хука SessionStart у владельца
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
    fn label_never_carries_a_secret() {
        // секрет перед именем скрипта: бывший `name="PreToolUse: H02"`
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
            ("C:\\Users\\alice\\x", "C:\\Users\\alice\\x"), // другой пользователь: не трогаем
            ("😀 C:/Users/al/x 日本語", "😀 ~/x 日本語"),
            ("C:\\\\Users\\\\al\\\\x", "~\\\\x"), // путь внутри JSON-строки
            ("\\\\localhost\\c$\\Users\\al\\p", "~\\p"),
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
        };
        assert_eq!(c.tilde(Path::new("c:/users/ALICE/work/p")), "~/work/p");
        assert_eq!(c.tilde(Path::new("D:/other")), "D:/other");
        assert_eq!(c.tilde(Path::new("C:/Users/Alicia/x")), "C:/Users/Alicia/x");
    }
}
