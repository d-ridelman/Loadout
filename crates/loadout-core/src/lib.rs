//! Ядро Loadout: только чтение (R0). Сканер пяти клиентов: Claude Code, Claude Desktop, Codex, Antigravity, DeepSeek.

pub mod antigravity;
pub mod claude_code;
pub mod claude_desktop;
pub mod codex;
pub mod deepseek;
pub mod diff;
pub mod edit;
pub mod facts;
pub mod frontmatter;
pub mod mask;
pub mod model;
pub mod profiles;
pub mod trash;
pub mod watch;
pub mod write;

use model::{Client, Entity, Kind, ScanResult, State};
use serde_json::{json, Value};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub struct Ctx {
    pub home: PathBuf,
    pub entities: Vec<Entity>,
    pub warnings: Vec<String>,
}

/// Предел размера читаемого файла.
const MAX_FILE_BYTES: u64 = 16 << 20;

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
        // Файлы клиентов бывают большими (`.claude.json` с кешами), но не гигабайтными: лимит защищает от зависания.
        if std::fs::metadata(p).is_ok_and(|m| m.len() > MAX_FILE_BYTES) {
            let w = format!(
                "{}: файл больше {} МБ, пропущен",
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

/// Объект `mcpServers` в формате `{имя: {command, args, env?, url?}}` (Antigravity, Claude Desktop, плагины Antigravity).
pub(crate) fn scan_mcp_servers(
    c: &mut Ctx,
    client: Client,
    file: &str,
    root_ptr: &str,
    scope: &str,
    servers: Option<&Value>,
    // Файл клиента, в который Loadout может писать (R1/R2); у записей плагинов и чужих каталогов `None`.
    writable: Option<&Path>,
) {
    for (name, cfg) in servers.and_then(Value::as_object).into_iter().flatten() {
        let Some(shown) = mask::safe_name(name) else {
            c.warnings
                .push(format!("{file}: MCP-сервер с недопустимым именем пропущен"));
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
            // у записи нет флага «выключено»: выключение вырезает её в корзину (trash.rs)
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
        // Имя и описание — текст из файла: проходят фильтры, чтобы секрет из описания не попал в вывод.
        let name = fm
            .get("name")
            .and_then(|n| mask::safe_name(n))
            .map_or_else(|| dir_name.clone(), str::to_owned);
        let desc: String = fm
            .get("description")
            .map(|s| mask::mask_prose(&s.chars().take(200).collect::<String>()))
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
        .fs_named(); // имя уже прошло safe_name, а запасное — имя каталога
        if name != dir_name {
            e = e.note(format!(
                "имя в frontmatter «{name}» не совпадает с каталогом «{dir_name}»"
            ));
        }
        c.push(e);
    }
}

/// Хуки в общем формате Claude Code / Codex: `{Событие: [{matcher?, hooks: [{type, command, timeout}]}]}`.
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
            c.warnings.push(format!(
                "{file}: событие хука с недопустимым именем пропущено"
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
                // И метка, и показанная команда строятся из уже замаскированных токенов.
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
                // Хук без опознанной метки не склеивается с такими же хуками других клиентов в одну строку.
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
        // значения флагов (`--lang ru`) именем хука быть не могут, даже если путь к программе скрыт
        .find(|s| {
            let l = s.to_ascii_lowercase();
            !RUNNERS.contains(&l.as_str()) && !VALUE_WORDS.contains(&l.as_str())
        })
        .unwrap_or_else(|| "hook".to_owned())
}

/// Слова, которые бывают значениями флагов, а не именами программ.
const VALUE_WORDS: [&str; 12] = [
    "ru", "en", "true", "false", "debug", "info", "warn", "error", "trace", "latest", "main",
    "origin",
];

/// Хуки, которые одна внешняя программа ставит сразу в несколько клиентов, лежат в каталоге `<программа>/agent-hooks`
/// (у владельца `~/.orca/agent-hooks/codex-hook.cmd`, `dsh-hook.cmd`) и называются по клиенту. Для сопоставления между
/// клиентами берём не имя файла, а группу: `orca-agent-hooks`.
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

/// Вложенная командная строка (`bash -c "tool --x"`) приходит одним токеном с пробелами:
/// для метки раскрываем её в токены. Путь с пробелами (каждое слово с разделителем) остаётся одним токеном.
fn expand_nested(tokens: &[String], depth: usize) -> Vec<String> {
    let mut out = Vec::new();
    for t in tokens {
        if mask::is_nested_command(t) && depth < 3 {
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

/// Заменяет `pat` на `~` без учёта регистра (в том числе кириллицы). Работает по символам, а не по байтам:
/// срез строки внутри многобайтной буквы невозможен.
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
        // Совпадение не должно обрывать имя: домой `C:\Users\al` не принадлежит `C:\Users\alice`.
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
    // Смешанные разделители (`C:\Users/x\y`): сверяем ещё и копию с прямыми слэшами.
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
    // Короткое имя 8.3 (`RIDELM~1`): первые шесть букв и цифр имени, верхний регистр.
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
    scan_with(home, None)
}

/// Скан с корзиной Loadout (`store` — каталог бэкапов приложения): вынесенные записи видны как выключенные.
pub fn scan_with(home: &Path, store: Option<&Path>) -> ScanResult {
    let mut c = Ctx {
        home: home.to_path_buf(),
        entities: Vec::new(),
        warnings: Vec::new(),
    };
    claude_code::scan(&mut c);
    claude_desktop::scan(&mut c);
    codex::scan(&mut c);
    antigravity::scan(&mut c);
    deepseek::scan(&mut c);
    if let Some(store) = store {
        trash::inject(&mut c, store);
    }

    // Последний рубеж: путь домашнего каталога не должен остаться ни в одном строковом поле.
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
            e.toggle_why = Some(write::why_not(e).to_owned());
        }
        for s in [
            &mut e.name,
            &mut e.scope,
            &mut e.logical_key,
            &mut e.origin.file,
            &mut e.origin.pointer,
        ] {
            scrub_str(s, &forms);
        }
        // Строки из файлов в именах, областях и указателях: слова, похожие на токен, скрываются.
        // Имена из файловой системы (каталоги скилов, каталог Codex) не трогаем: они не секрет, а скрытие сливает записи.
        let fs = e.fs_named;
        let fields: [&mut String; 5] = [
            &mut e.name,
            &mut e.scope,
            &mut e.logical_key,
            &mut e.origin.file,
            &mut e.origin.pointer,
        ];
        for (i, s) in fields.into_iter().enumerate() {
            let fs_field = matches!(i, 0 | 2 | 4) && fs;
            if !fs_field {
                *s = mask::scrub_words(s);
            }
        }
        if let Some(s) = e.note.as_mut() {
            scrub_str(s, &forms);
            *s = mask::scrub_words(s);
        }
        if let Some(s) = e.version.as_mut() {
            scrub_str(s, &forms);
        }
        scrub(&mut e.detail, &forms);
        // id однозначен в пределах одного скана, даже если одна запись прочитана из двух мест (патч и профиль dsh).
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
        };
        assert_eq!(c.tilde(Path::new("c:/users/ALICE/work/p")), "~/work/p");
        assert_eq!(c.tilde(Path::new("D:/other")), "D:/other");
        assert_eq!(c.tilde(Path::new("C:/Users/Alicia/x")), "C:/Users/Alicia/x");
    }
}
