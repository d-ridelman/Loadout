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

impl Ctx {
    /// Путь для вывода: `~/…` с прямыми слэшами, чтобы имя пользователя не попадало в отчёты.
    pub fn tilde(&self, p: &Path) -> String {
        match p.strip_prefix(&self.home) {
            Ok(rest) => format!("~/{}", rest.to_string_lossy().replace('\\', "/")),
            Err(_) => p.to_string_lossy().replace('\\', "/"),
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
                let label = hook_label(cmd);
                let e = Entity::new(
                    client,
                    Kind::Hook,
                    "user",
                    format!("{event}: {label}"),
                    State::On,
                    file,
                    format!("{root_ptr}/{event}/{gi}/hooks/{hi}"),
                )
                .logical(label)
                .detail(json!({
                    "event": event,
                    "matcher": matcher,
                    "type": h.get("type"),
                    "command": mask::mask_line(cmd),
                    "timeout": h.get("timeout"),
                }));
                c.push(e);
            }
        }
    }
}

/// Короткое имя хука: имя исполняемого файла первой команды (`& 'C:/x/ctxkit.exe' --lang ru` → `ctxkit`).
fn hook_label(cmd: &str) -> String {
    const RUNNERS: [&str; 8] = [
        "node",
        "python",
        "python3",
        "pwsh",
        "powershell",
        "bash",
        "sh",
        "cmd",
    ];
    let stem = |t: &str| {
        let base = t.rsplit(['/', '\\']).next().unwrap_or(t).to_owned();
        base.rsplit_once('.')
            .map_or(base.clone(), |(s, _)| s.to_owned())
    };
    cmd.split_whitespace()
        .map(|t| t.trim_matches(|c| c == '\'' || c == '"' || c == '&'))
        .filter(|t| !t.is_empty() && !t.starts_with('-'))
        .map(stem)
        .find(|s| !RUNNERS.contains(&s.to_ascii_lowercase().as_str()))
        .unwrap_or_else(|| "hook".to_owned())
}

/// Заменяет путь домашнего каталога на `~` во всех строках (команды хуков и MCP содержат абсолютные пути).
fn scrub(v: &mut Value, forms: &[String]) {
    match v {
        Value::String(s) => {
            for f in forms {
                if s.contains(f.as_str()) {
                    *s = s.replace(f.as_str(), "~");
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| scrub(x, forms)),
        Value::Object(o) => o.values_mut().for_each(|x| scrub(x, forms)),
        _ => {}
    }
}

pub fn scan(home: &Path) -> ScanResult {
    let mut c = Ctx {
        home: home.to_path_buf(),
        entities: Vec::new(),
        warnings: Vec::new(),
    };
    claude_code::scan(&mut c);
    codex::scan(&mut c);

    let raw = home.to_string_lossy().into_owned();
    let forms = vec![raw.clone(), raw.replace('\\', "/")];
    for e in &mut c.entities {
        scrub(&mut e.detail, &forms);
        if let Some(n) = e.note.as_mut() {
            let mut v = Value::String(std::mem::take(n));
            scrub(&mut v, &forms);
            *n = v.as_str().unwrap_or_default().to_owned();
        }
    }
    ScanResult {
        entities: c.entities,
        warnings: c.warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::hook_label;

    #[test]
    fn labels() {
        assert_eq!(
            hook_label("& 'C:/Users/x/.claude/hooks/ctxkit.exe' --dsh --lang ru"),
            "ctxkit"
        );
        assert_eq!(
            hook_label("node C:\\h\\no-inline-backslash.mjs"),
            "no-inline-backslash"
        );
        assert_eq!(
            hook_label("pwsh -NoProfile -File C:/h/temp-sweep.ps1"),
            "temp-sweep"
        );
        assert_eq!(hook_label(""), "hook");
    }
}
