//! Установка скила Claude Code в `~/.claude/skills/<имя>` (R2) с журналом и откатом.
//!
//! Источник main кладёт заранее в `<бэкапы>/staging/<id>` (клон GitHub или копия папки): от окна приходят только
//! `id` этого каталога (hex), путь внутри него и имя. Ядро само проверяет дерево (без ссылок, `.git` и лишнего размера),
//! пишет его копию в каталог операции, ставит через временный каталог рядом с целью и сверяет хеш дерева.
//! Откат: если скил с тех пор не меняли, каталог уходит в бэкап операции отката, а не удаляется насовсем.

use super::{need_level, new_op_dir, now_ms, sha, tilde, write_manifest, Applied, Manifest, Plan};
use crate::model::{Client, Kind};
use std::path::{Path, PathBuf};

const MAX_FILES: usize = 1000;
const MAX_BYTES: u64 = 50 << 20;

/// Имя каталога скила: буквы, цифры, `.`, `_`, `-`; без `..`. `synced` и `anthropic-skills` Claude Code занял сам.
pub fn valid_name(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
        && !n.contains("..")
        && !n.eq_ignore_ascii_case("synced")
        && !n.to_ascii_lowercase().starts_with("anthropic-skills")
}

/// `id` каталога подготовки: 32 hex, его выбирает main.
fn valid_stage(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Путь внутри клона: пусто или сегменты из безопасных знаков через `/`.
fn valid_sub(sub: &str) -> bool {
    sub.is_empty()
        || (sub.len() <= 200
            && sub.split('/').all(|s| {
                !s.is_empty()
                    && s != "."
                    && s != ".."
                    && s != ".git"
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
            }))
}

fn bad(ru: &str, en: &str) -> String {
    if crate::i18n::is_en() { en } else { ru }.to_owned()
}

pub(super) fn target(home: &Path, name: &str) -> Option<PathBuf> {
    valid_name(name).then(|| home.join(".claude").join("skills").join(name))
}

/// Файлы дерева по порядку: `(путь через /, полный путь, размер)`. Ссылки и точки повторной обработки — отказ, `.git` пропускается.
fn walk(root: &Path) -> Result<Vec<(String, PathBuf, u64)>, String> {
    let mut out = Vec::new();
    let mut total = 0u64;
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        let rd = std::fs::read_dir(&dir).map_err(|_| {
            bad(
                "каталог скила не прочитан",
                "could not read the skill directory",
            )
        })?;
        for e in rd {
            let e = e.map_err(|e| e.to_string())?;
            let name = e.file_name().to_string_lossy().into_owned();
            let ft = std::fs::symlink_metadata(e.path())
                .map_err(|e| e.to_string())?
                .file_type();
            if ft.is_symlink() {
                return Err(bad(
                    &format!("в скиле есть символьная ссылка: {rel}{name}"),
                    &format!("the skill contains a symbolic link: {rel}{name}"),
                ));
            }
            let r = format!("{rel}{name}");
            if ft.is_dir() {
                if name != ".git" {
                    stack.push((e.path(), format!("{r}/")));
                }
            } else {
                let len = e.metadata().map_err(|e| e.to_string())?.len();
                total += len;
                out.push((r, e.path(), len));
                if out.len() > MAX_FILES || total > MAX_BYTES {
                    return Err(bad(
                        "скил слишком большой: больше 1000 файлов или 50 МБ",
                        "the skill is too large: more than 1000 files or 50 MB",
                    ));
                }
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Хеш дерева: пути и содержимое по порядку.
fn tree_sha(files: &[(String, PathBuf, u64)]) -> Result<String, String> {
    let mut buf = Vec::new();
    for (rel, path, _) in files {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        buf.extend_from_slice(rel.as_bytes());
        buf.push(0);
        buf.extend_from_slice(sha(&bytes).as_bytes());
        buf.push(b'\n');
    }
    Ok(sha(&buf))
}

pub(super) fn dir_sha(dir: &Path) -> Option<String> {
    walk(dir).ok().and_then(|f| tree_sha(&f).ok())
}

fn copy_files(files: &[(String, PathBuf, u64)], to: &Path) -> Result<(), String> {
    for (rel, path, _) in files {
        let dest = to.join(rel);
        if let Some(p) = dest.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::copy(path, &dest).map_err(|e| {
            bad(
                &format!("файл скила не скопирован: {e}"),
                &format!("a skill file was not copied: {e}"),
            )
        })?;
    }
    Ok(())
}

struct Checked {
    plan: Plan,
    files: Vec<(String, PathBuf, u64)>,
    target: PathBuf,
    stage_root: PathBuf,
}

fn check(home: &Path, store: &Path, stage: &str, sub: &str, name: &str) -> Result<Checked, String> {
    if !valid_stage(stage) || !valid_sub(sub) {
        return Err(bad(
            "неверные параметры установки скила",
            "invalid skill installation parameters",
        ));
    }
    let target = target(home, name).ok_or_else(|| {
        bad(
            "имя скила: буквы, цифры, `.`, `_`, `-`, до 64 знаков; `synced` и `anthropic-skills` заняты",
            "skill name: letters, digits, `.`, `_`, `-`, up to 64 characters; `synced` and `anthropic-skills` are reserved",
        )
    })?;
    let stage_root = store.join("staging").join(stage);
    let src = if sub.is_empty() {
        stage_root.clone()
    } else {
        stage_root.join(sub)
    };
    if !src.join("SKILL.md").is_file() {
        return Err(bad(
            "источник не подготовлен или в нём нет SKILL.md: начните заново",
            "the source is not prepared or has no SKILL.md: start over",
        ));
    }
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(bad(
            &format!("скил «{name}» уже есть: Loadout его не перезаписывает"),
            &format!("skill “{name}” already exists: Loadout does not overwrite it"),
        ));
    }
    let files = walk(&src)?;
    let total: u64 = files.iter().map(|f| f.2).sum();
    let mut notes = vec![bad(
        &format!("файлов: {}, всего {} КБ", files.len(), total.div_ceil(1024)),
        &format!(
            "files: {}, {} KB in total",
            files.len(),
            total.div_ceil(1024)
        ),
    )];
    let text = |r: &str| {
        let l = r.to_ascii_lowercase();
        [".md", ".txt", ".json", ".yaml", ".yml", ".csv"]
            .iter()
            .any(|x| l.ends_with(x))
            || !l.contains('.')
    };
    let code: Vec<&str> = files
        .iter()
        .map(|f| f.0.as_str())
        .filter(|r| !text(r))
        .collect();
    if !code.is_empty() {
        notes.push(bad(
            &format!(
                "есть файлы кода, Claude может их запускать: {}",
                code.iter().take(8).copied().collect::<Vec<_>>().join(", ")
            ),
            &format!(
                "contains code files Claude may run: {}",
                code.iter().take(8).copied().collect::<Vec<_>>().join(", ")
            ),
        ));
    }
    let listed: Vec<&str> = files.iter().map(|f| f.0.as_str()).take(15).collect();
    notes.push(listed.join(", ") + if files.len() > 15 { " …" } else { "" });
    let plan = Plan {
        op: "installSkill".into(),
        level: "R2".into(),
        entity: String::new(),
        client: Client::ClaudeCode,
        kind: Kind::Skill,
        name: name.to_owned(),
        file: format!("{}/", tilde(home, &target)),
        pointer: String::new(),
        enable: true,
        from: bad("нет записи", "no entry"),
        to: bad("установлен", "installed"),
        noop: false,
        affects: Vec::new(),
        notes,
        trash: String::new(),
        base_sha: tree_sha(&files)?,
    };
    Ok(Checked {
        plan,
        files,
        target,
        stage_root,
    })
}

pub fn plan(
    home: &Path,
    store: Option<&Path>,
    stage: &str,
    sub: &str,
    name: &str,
) -> Result<Plan, String> {
    let store = store.ok_or_else(|| bad("запись выключена", "writing is off"))?;
    check(home, store, stage, sub, name).map(|c| c.plan)
}

#[allow(clippy::too_many_arguments)]
pub fn apply(
    home: &Path,
    store: &Path,
    stage: &str,
    sub: &str,
    name: &str,
    base_sha: Option<&str>,
    max_level: &str,
) -> Result<Applied, String> {
    need_level("R2", max_level)?;
    let c = check(home, store, stage, sub, name)?;
    if base_sha.is_some_and(|b| b != c.plan.base_sha) {
        return Err(bad(
            "источник изменился после предпросмотра: постройте план заново",
            "the source changed after the preview: build the plan again",
        ));
    }
    let (id, dir) = new_op_dir(store)?;
    let fail = |e: String| {
        let _ = std::fs::remove_dir_all(&dir);
        Err(e)
    };
    // копия того, что ставим: журнал показывает, что именно было установлено, даже после отката
    if let Err(e) = copy_files(&c.files, &dir.join("skill")) {
        return fail(e);
    }
    let p = &c.plan;
    let m = Manifest {
        version: 2,
        id: id.clone(),
        time: now_ms(),
        op: "installSkill".into(),
        of: None,
        batch: None,
        level: "R2".into(),
        entity: String::new(),
        inverse_enable: None,
        trash_id: None,
        trash_before: None,
        path: c.target.to_string_lossy().into_owned(),
        sha_before: String::new(),
        sha_after: p.base_sha.clone(),
        client: Client::ClaudeCode.slug().into(),
        kind: "skill".into(),
        name: name.to_owned(),
        pointer: String::new(),
        file: p.file.clone(),
        from: p.from.clone(),
        to: p.to.clone(),
    };
    if let Err(e) = write_manifest(&dir, &m) {
        return fail(e);
    }
    // временный каталог рядом с `skills/` (тот же том, `rename` атомарен), но не внутри: за `skills/` следит Claude Code
    let claude = home.join(".claude");
    let tmp = claude.join(format!(".{name}.loadout.tmp"));
    let _ = std::fs::remove_dir_all(&tmp);
    let placed = copy_files(&c.files, &tmp)
        .and_then(|()| std::fs::create_dir_all(claude.join("skills")).map_err(|e| e.to_string()))
        .and_then(|()| {
            if std::fs::symlink_metadata(&c.target).is_ok() {
                return Err(bad(
                    "скил с этим именем появился во время установки",
                    "a skill with this name appeared during installation",
                ));
            }
            std::fs::rename(&tmp, &c.target).map_err(|e| e.to_string())
        });
    if let Err(e) = placed {
        let _ = std::fs::remove_dir_all(&tmp);
        return fail(bad(
            &format!("скил не установлен: {e}"),
            &format!("the skill was not installed: {e}"),
        ));
    }
    let _ = std::fs::remove_dir_all(&c.stage_root);
    if dir_sha(&c.target).as_deref() != Some(p.base_sha.as_str()) {
        return Err(bad(
            "скил изменён другим процессом сразу после установки: проверьте результат, строка журнала сохранена",
            "the skill was changed by another process right after installation: check the result; the journal entry is kept",
        ));
    }
    Ok(Applied {
        op: id,
        entity: String::new(),
        from: p.from.clone(),
        to: p.to.clone(),
    })
}

/// Можно ли откатить установку: скил на месте и не менялся. Путь берётся из имени, а не из манифеста.
pub(super) fn can_rollback(home: &Path, m: &Manifest) -> bool {
    target(home, &m.name).and_then(|t| dir_sha(&t)).as_deref() == Some(m.sha_after.as_str())
}

pub(super) fn rollback(
    home: &Path,
    store: &Path,
    op: &str,
    m: &Manifest,
) -> Result<Applied, String> {
    // манифест лежит в каталоге пользователя: цель пересчитываем из проверенного имени
    let target = target(home, &m.name)
        .ok_or_else(|| bad("манифест повреждён", "the manifest is corrupted"))?;
    let files = walk(&target).map_err(|_| {
        bad(
            "скила нет на месте: откатывать нечего",
            "the skill is not in place: nothing to roll back",
        )
    })?;
    if tree_sha(&files)? != m.sha_after {
        return Err(bad(
            "скил изменился после установки: откат унёс бы чужие правки",
            "the skill changed after installation: the rollback would take away someone else's edits",
        ));
    }
    let (id, dir) = new_op_dir(store)?;
    let fail = |e: String| {
        let _ = std::fs::remove_dir_all(&dir);
        Err(e)
    };
    // удаление = перенос в бэкап: сначала копия, потом каталог убирается
    if let Err(e) = copy_files(&files, &dir.join("removed")) {
        return fail(e);
    }
    let r = Manifest {
        id: id.clone(),
        time: now_ms(),
        op: "rollback".into(),
        of: Some(op.to_owned()),
        path: target.to_string_lossy().into_owned(),
        sha_before: m.sha_after.clone(),
        sha_after: String::new(),
        from: m.to.clone(),
        to: m.from.clone(),
        ..m.clone()
    };
    if let Err(e) = write_manifest(&dir, &r) {
        return fail(e);
    }
    std::fs::remove_dir_all(&target).map_err(|e| {
        bad(
            &format!("каталог скила не убран: {e}; копия лежит в бэкапе операции"),
            &format!("the skill directory was not removed: {e}; a copy is in the operation backup"),
        )
    })?;
    Ok(Applied {
        op: id,
        entity: String::new(),
        from: r.from,
        to: r.to,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_paths_are_checked() {
        for ok in ["demo", "my-skill_1.2", "A1"] {
            assert!(valid_name(ok), "{ok}");
        }
        for no in [
            "",
            "../x",
            "a/b",
            "a..b",
            ".hidden",
            "-x",
            "Synced",
            "anthropic-skills-x",
            "a b",
            &"x".repeat(65),
        ] {
            assert!(!valid_name(no), "{no}");
        }
        assert!(valid_sub("") && valid_sub("skills/demo"));
        for no in ["..", "a/../b", "/a", "a//b", ".git/x", "a\\b", "a b"] {
            assert!(!valid_sub(no), "{no}");
        }
        assert!(
            valid_stage(&"a".repeat(32)) && !valid_stage("../x") && !valid_stage(&"g".repeat(32))
        );
    }
}
