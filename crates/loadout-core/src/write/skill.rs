//! Installing a Claude Code skill into `~/.claude/skills/<name>` (R2) with a journal and rollback.
//!
//! main stages the source in advance in `<backups>/staging/<id>` (a GitHub clone or a folder copy): the window sends only
//! the `id` of that directory (hex), a path inside it and a name. The core checks the tree itself (no links, no `.git`, no excess size),
//! writes its copy into the operation directory, installs via a temp directory next to the target and verifies the tree hash.
//! Rollback: if the skill has not changed since, the directory goes to the rollback operation's backup rather than being deleted for good.

use super::{need_level, new_op_dir, now_ms, sha, tilde, write_manifest, Applied, Manifest, Plan};
use crate::model::{Client, CopyFrom, Kind, ScanResult};
use crate::projects::Project;
use std::path::{Path, PathBuf};

const MAX_FILES: usize = 1000;
const MAX_BYTES: u64 = 50 << 20;

/// Skill directory name: letters, digits, `.`, `_`, `-`; no `..`. `synced` and `anthropic-skills` are taken by Claude Code itself.
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

/// `id` of the staging directory: 32 hex, chosen by main.
fn valid_stage(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Path inside the clone: empty or segments of safe characters joined by `/`.
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

/// An install or a copy of a skill folder (rolled back as a folder, not as a file).
pub(super) fn is_folder_op(m: &Manifest) -> bool {
    m.kind == "skill" && (m.op == "installSkill" || m.op == "copy")
}

/// The folder a copy lands in: one the client reads and Loadout scans (docs/TRANSFER.en.md, «Skills»).
fn skill_root(home: &Path, client: Client, project: Option<&Project>) -> Option<PathBuf> {
    Some(match (project, client) {
        (_, Client::ClaudeDesktop) => return None,
        (None, Client::ClaudeCode) => home.join(".claude/skills"),
        (None, Client::Codex) => home.join(".codex/skills"),
        (None, Client::Antigravity) => home.join(".gemini/config/skills"),
        (None, Client::DeepSeek) => home.join(".dsh/skills"),
        (None, Client::OpenCode) => home.join(crate::opencode::DIR).join("skills"),
        (Some(p), Client::ClaudeCode) => p.dir.join(".claude/skills"),
        // shared by Codex, Antigravity, DeepSeek and OpenCode
        (Some(p), _) => p.dir.join(".agents/skills"),
    })
}

/// Every folder the client takes skills from, for the name check: a copy must not shadow or duplicate a skill.
fn reads(home: &Path, client: Client, project: Option<&Project>) -> Vec<PathBuf> {
    let user: Vec<PathBuf> = match client {
        Client::ClaudeCode => vec![home.join(".claude/skills")],
        Client::ClaudeDesktop => vec![],
        Client::Codex => vec![home.join(".codex/skills"), home.join(".agents/skills")],
        Client::Antigravity => vec![
            home.join(".gemini/config/skills"),
            home.join(".gemini/antigravity/skills"),
        ],
        Client::DeepSeek => vec![home.join(".dsh/skills"), home.join(".agents/skills")],
        Client::OpenCode => {
            let d = home.join(crate::opencode::DIR);
            vec![
                d.join("skills"),
                d.join("skill"),
                home.join(".claude/skills"),
                home.join(".agents/skills"),
            ]
        }
    };
    let mut all = user;
    if let Some(p) = project {
        for (dir, clients) in crate::projects::SKILL_DIRS {
            if clients.contains(&client) {
                all.push(p.dir.join(dir));
            }
        }
    }
    all
}

/// The installed folder of an install or copy line: the client and the project come from the manifest, the path is
/// computed again (the manifest lives in the user's directory and is not trusted).
fn target_of(home: &Path, m: &Manifest) -> Option<PathBuf> {
    if !valid_name(&m.name) {
        return None;
    }
    let client = Client::from_slug(&m.client).unwrap_or(Client::ClaudeCode);
    let project = if m.project.is_empty() {
        None
    } else {
        Some(crate::projects::find(home, &m.project)?)
    };
    let target = skill_root(home, client, project.as_ref())?.join(&m.name);
    // as on the write: a project folder that became a junction since does not lead the rollback outside the project
    match &project {
        Some(p) if super::transfer::inside(p, &target).is_err() => None,
        _ => Some(target),
    }
}

/// Tree files in order: `(path with /, full path, size)`. Links and reparse points are refused, `.git` is skipped.
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
            // On Windows `is_symlink` is also true for a junction (a reparse point with the name-surrogate bit): checked
            // by the test `junction_inside_the_skill_tree_is_refused`. Other reparse points (cloud placeholders) are not links and go as files.
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

/// Tree hash: paths and content in order. `digest` gives the hash of one file (path, size).
fn tree_sha_by(
    files: &[(String, PathBuf, u64)],
    digest: impl Fn(&Path, u64) -> Result<String, String>,
) -> Result<String, String> {
    let mut buf = Vec::new();
    for (rel, path, len) in files {
        buf.extend_from_slice(rel.as_bytes());
        buf.push(0);
        buf.extend_from_slice(digest(path, *len)?.as_bytes());
        buf.push(b'\n');
    }
    Ok(sha(&buf))
}

fn tree_sha(files: &[(String, PathBuf, u64)]) -> Result<String, String> {
    tree_sha_by(files, |path, _| {
        std::fs::read(path)
            .map(|b| sha(&b))
            .map_err(|e| e.to_string())
    })
}

/// File hashes already computed by this process: key is the path, value is (mtime, size, hash).
/// Needed only to display the journal (`can_rollback` on each of 200 rows); install and rollback hash anew.
/// shortcut: the journal will not notice an edit that keeps the size within mtime precision, but rollback recomputes anyway.
static FILE_SHA: std::sync::Mutex<Option<ShaCache>> = std::sync::Mutex::new(None);
type ShaCache = std::collections::HashMap<PathBuf, (std::time::SystemTime, u64, String)>;

#[cfg(test)]
thread_local! {
    /// How many files `cached_digest` actually read on this thread (test "the second display reads no files").
    pub(super) static DISK_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn cached_digest(path: &Path, len: u64) -> Result<String, String> {
    let mtime = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map_err(|e| e.to_string())?;
    let mut guard = FILE_SHA.lock().unwrap_or_else(|p| p.into_inner());
    let cache = guard.get_or_insert_with(Default::default);
    if let Some((t, l, h)) = cache.get(path) {
        if *t == mtime && *l == len {
            return Ok(h.clone());
        }
    }
    #[cfg(test)]
    DISK_READS.with(|c| c.set(c.get() + 1));
    let h = sha(&std::fs::read(path).map_err(|e| e.to_string())?);
    if cache.len() >= 20_000 {
        cache.clear();
    }
    cache.insert(path.to_path_buf(), (mtime, len, h.clone()));
    Ok(h)
}

pub(super) fn dir_sha(dir: &Path) -> Option<String> {
    walk(dir).ok().and_then(|f| tree_sha(&f).ok())
}

// Test seams: `NO_RENAME` imitates `skills/` on another volume (directory `rename` fails), and `AFTER_BACKUP`
// is called in rollback after the skill is copied to backup and before deletion (the test locks a file there, as a foreign process would).
#[cfg(test)]
type Hook = Box<dyn Fn()>;
#[cfg(test)]
thread_local! {
    pub(super) static NO_RENAME: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(super) static AFTER_BACKUP: std::cell::RefCell<Option<Hook>> =
        const { std::cell::RefCell::new(None) };
}

fn rename_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    if NO_RENAME.with(std::cell::Cell::get) {
        return Err(std::io::Error::other("rename disabled by the test"));
    }
    std::fs::rename(from, to)
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

pub(super) struct Checked {
    pub(super) plan: Plan,
    files: Vec<(String, PathBuf, u64)>,
    target: PathBuf,
    /// The staging folder of an install from GitHub or a folder (removed after the install); none for a copy.
    stage_root: Option<PathBuf>,
    op: &'static str,
    client: Client,
    project: String,
}

/// Size, warnings and the file list of a skill tree, for the plan.
fn tree_notes(src: &Path, files: &[(String, PathBuf, u64)]) -> Vec<String> {
    let total: u64 = files.iter().map(|f| f.2).sum();
    let mut notes = vec![bad(
        &format!("файлов: {}, всего {} КБ", files.len(), total.div_ceil(1024)),
        &format!(
            "files: {}, {} KB in total",
            files.len(),
            total.div_ceil(1024)
        ),
    )];
    // text only by file name extension; no extension (a script with a shebang) counts as code
    let text = |r: &str| {
        let l = r.rsplit('/').next().unwrap_or(r).to_ascii_lowercase();
        [".md", ".txt", ".json", ".yaml", ".yml", ".csv"]
            .iter()
            .any(|x| l.ends_with(x))
    };
    // SKILL.md can run commands itself (`` !`…` ``) and suppress permission prompts (`allowed-tools`)
    let md = std::fs::read_to_string(src.join("SKILL.md")).unwrap_or_default();
    // per the skills docs: a `` !`command` `` line and a ```` ```! ```` block run when the skill is invoked, without a prompt
    if md.contains("!`") || md.contains("```!") || md.contains("allowed-tools") {
        notes.push(bad(
            "SKILL.md запускает команды или разрешает инструменты без запроса (!`…`, allowed-tools): прочитайте его до установки",
            "SKILL.md runs commands or allows tools without asking (!`…`, allowed-tools): read it before installing",
        ));
    }
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
    notes
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
    let notes = tree_notes(&src, &files);
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
        warn: Vec::new(),
        trash: String::new(),
        base_sha: tree_sha(&files)?,
    };
    Ok(Checked {
        plan,
        files,
        target,
        stage_root: Some(stage_root),
        op: "installSkill",
        client: Client::ClaudeCode,
        project: String::new(),
    })
}

/// Frontmatter keys only Claude Code understands (Claude Code docs, skills); the other clients ignore them.
const CLAUDE_ONLY: [&str; 13] = [
    "allowed-tools",
    "disallowed-tools",
    "context",
    "agent",
    "hooks",
    "paths",
    "shell",
    "model",
    "effort",
    "arguments",
    "argument-hint",
    "when_to_use",
    "background",
];

/// A copy of a skill folder to another client, in the same place (user or the entry's project).
pub(super) fn copy_check(
    home: &Path,
    scan: &ScanResult,
    id: &str,
    to: &str,
) -> Result<Checked, String> {
    let e = super::find(scan, id)?;
    let dest = super::transfer::dest_of(e, to)?;
    let Some(CopyFrom::Dir(src)) = &e.copy_from else {
        return Err(bad(
            "у скила нет папки, которую можно скопировать",
            "the skill has no folder to copy",
        ));
    };
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| valid_name(n))
        .ok_or_else(|| {
            bad(
                "имя папки скила недопустимо для копирования",
                "the skill folder name is not valid for copying",
            )
        })?;
    let place = super::transfer::place_of(home, e)?;
    let root = skill_root(home, dest, place.as_ref()).ok_or_else(|| {
        bad(
            "у этого клиента нет папки скилов",
            "this client has no skills folder",
        )
    })?;
    if let Some(p) = &place {
        super::transfer::inside(p, &root)?;
    }
    for d in reads(home, dest, place.as_ref()) {
        if std::fs::symlink_metadata(d.join(&name)).is_ok() {
            return Err(bad(
                &format!(
                    "у получателя уже есть скил «{name}» ({}): Loadout его не перезаписывает",
                    tilde(home, &d)
                ),
                &format!(
                    "the target already has a skill “{name}” ({}): Loadout does not overwrite it",
                    tilde(home, &d)
                ),
            ));
        }
    }
    if !src.join("SKILL.md").is_file() {
        return Err(bad(
            "в папке скила нет SKILL.md",
            "the skill folder has no SKILL.md",
        ));
    }
    let files = walk(src)?;
    let fm = crate::frontmatter::read(&src.join("SKILL.md")).unwrap_or_default();
    let desc = fm
        .get("description")
        .map(|d| d.trim().to_owned())
        .unwrap_or_default();
    let fm_name = fm.get("name").cloned().unwrap_or_else(|| name.clone());
    // what would make the target drop the skill: refused, not copied as a dead folder
    if desc.is_empty() && matches!(dest, Client::Codex | Client::Antigravity | Client::DeepSeek) {
        return Err(bad(
            "у скила пустое description: получатель такой скил не загрузит",
            "the skill has an empty description: the target would not load it",
        ));
    }
    let kebab = !fm_name.is_empty()
        && fm_name.split('-').all(|w| {
            !w.is_empty()
                && w.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        });
    if dest == Client::DeepSeek && !kebab {
        return Err(bad(
            &format!(
                "DeepSeek отбрасывает скил, у которого name не в kebab-case: «{}»",
                crate::mask::scrub_words(&fm_name)
            ),
            &format!(
                "DeepSeek drops a skill whose name is not kebab-case: “{}”",
                crate::mask::scrub_words(&fm_name)
            ),
        ));
    }
    let mut notes = tree_notes(src, &files);
    let mut warn = Vec::new();
    if dest != Client::ClaudeCode {
        let only: Vec<&str> = CLAUDE_ONLY
            .iter()
            .copied()
            .filter(|k| fm.contains_key(*k))
            .collect();
        if !only.is_empty() {
            notes.push(bad(
                &format!(
                    "Ключи {} понимает только Claude Code: получатель их пропустит.",
                    only.join(", ")
                ),
                &format!(
                    "Only Claude Code understands the keys {}: the target skips them.",
                    only.join(", ")
                ),
            ));
        }
        let md = std::fs::read_to_string(src.join("SKILL.md")).unwrap_or_default();
        if md.contains("!`") || md.contains("```!") || md.contains("${CLAUDE_") {
            warn.push(bad(
                "SKILL.md опирается на возможности Claude Code (строки !`…`, ${CLAUDE_…}): у получателя они не выполнятся и не раскроются, проверьте скил после копирования",
                "SKILL.md relies on Claude Code features (!`…` lines, ${CLAUDE_…}): the target neither runs nor expands them, check the skill after copying",
            ));
        }
    }
    match (&place, dest) {
        (Some(_), Client::Codex | Client::Antigravity | Client::DeepSeek | Client::OpenCode) => notes.push(bad(
            "Папку .agents/skills проекта читают Codex, Antigravity, DeepSeek и OpenCode: скил появится у всех четырёх.",
            "The project's .agents/skills folder is read by Codex, Antigravity, DeepSeek and OpenCode: the skill appears in all four.",
        )),
        (None, Client::Codex) => notes.push(bad(
            "~/.codex/skills Codex считает устаревшей папкой, но читает; её же видит Loadout.",
            "Codex deems ~/.codex/skills a deprecated folder but reads it; Loadout sees it too.",
        )),
        _ => {}
    }
    notes.push(bad(
        "Это отдельная копия: правки исходного скила в неё не попадут.",
        "This is a separate copy: edits of the source skill do not reach it.",
    ));
    let target = root.join(&name);
    let plan = Plan {
        op: "copy".into(),
        level: "R2".into(),
        entity: e.id.clone(),
        client: dest,
        kind: Kind::Skill,
        name: name.clone(),
        file: crate::scrub_home(home, &format!("{}/", tilde(home, &target))),
        pointer: String::new(),
        enable: true,
        from: bad("нет записи", "no entry"),
        to: crate::scrub_home(home, &crate::tr!("копия: {}", "copy: {}", tilde(home, src))),
        noop: false,
        affects: Vec::new(),
        notes: notes.iter().map(|n| crate::scrub_home(home, n)).collect(),
        warn,
        trash: String::new(),
        base_sha: tree_sha(&files)?,
    };
    Ok(Checked {
        plan,
        files,
        target,
        stage_root: None,
        op: "copy",
        client: dest,
        project: place.map(|p| p.id).unwrap_or_default(),
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
    install(store, c, base_sha, None)
}

/// Puts the checked tree into place: a backup copy and the manifest first, then a temp folder next to the skills folder
/// and one `rename`, then the tree hash is checked.
pub(super) fn install(
    store: &Path,
    c: Checked,
    base_sha: Option<&str>,
    batch: Option<&str>,
) -> Result<Applied, String> {
    if base_sha.is_some_and(|b| b != c.plan.base_sha) {
        return Err(bad(
            "источник изменился после предпросмотра: постройте план заново",
            "the source changed after the preview: build the plan again",
        ));
    }
    let name = c.plan.name.clone();
    let (id, dir) = new_op_dir(store)?;
    let fail = |e: String| {
        let _ = std::fs::remove_dir_all(&dir);
        Err(e)
    };
    // a copy of what we install: the journal shows what exactly was installed, even after rollback
    if let Err(e) = copy_files(&c.files, &dir.join("skill")) {
        return fail(e);
    }
    let p = &c.plan;
    // temp directory next to `skills/` (same volume, `rename` is atomic), but not inside: clients watch `skills/`
    let (Some(root), Some(outer)) = (c.target.parent(), c.target.parent().and_then(Path::parent))
    else {
        return fail(super::empty_path());
    };
    // the folders this copy creates (`<p>/.agents`, `<p>/.agents/skills`): the rollback removes them again when empty
    let (made_root, made_outer) = (!root.exists(), !outer.exists());
    let m = Manifest {
        version: 2,
        id: id.clone(),
        time: now_ms(),
        op: c.op.into(),
        of: None,
        batch: batch.map(str::to_owned),
        level: "R2".into(),
        entity: p.entity.clone(),
        inverse_enable: None,
        trash_id: None,
        trash_before: None,
        path: c.target.to_string_lossy().into_owned(),
        sha_before: String::new(),
        sha_after: p.base_sha.clone(),
        client: c.client.slug().into(),
        kind: "skill".into(),
        name: name.clone(),
        pointer: String::new(),
        file: p.file.clone(),
        from: p.from.clone(),
        to: p.to.clone(),
        project: c.project.clone(),
        // for a skill folder: `mkdir` is the skills folder, `created` the one above it
        created: made_outer,
        mkdir: made_root,
    };
    if let Err(e) = write_manifest(&dir, &m) {
        return fail(e);
    }
    let tmp = outer.join(format!(".{name}.loadout.tmp"));
    let _ = std::fs::remove_dir_all(&tmp);
    let placed = copy_files(&c.files, &tmp)
        .and_then(|()| std::fs::create_dir_all(root).map_err(|e| e.to_string()))
        .and_then(|()| {
            if std::fs::symlink_metadata(&c.target).is_ok() {
                return Err(bad(
                    "скил с этим именем появился во время установки",
                    "a skill with this name appeared during installation",
                ));
            }
            if rename_dir(&tmp, &c.target).is_ok() {
                return Ok(());
            }
            // `skills` is a link to another volume: `rename` will not work, copy into place. `create_dir` refuses if the directory
            // has already appeared: we neither overwrite nor delete foreign data; one we created is removed on failure
            std::fs::create_dir(&c.target).map_err(|e| e.to_string())?;
            copy_files(&c.files, &c.target).inspect_err(|_| {
                let _ = std::fs::remove_dir_all(&c.target);
            })
        });
    let _ = std::fs::remove_dir_all(&tmp);
    if let Err(e) = placed {
        // the folders made for this copy go too (only empty ones: `remove_dir` refuses otherwise)
        if made_root {
            let _ = std::fs::remove_dir(root);
        }
        if made_outer {
            let _ = std::fs::remove_dir(outer);
        }
        return fail(bad(
            &format!("скил не установлен: {e}"),
            &format!("the skill was not installed: {e}"),
        ));
    }
    if let Some(stage) = &c.stage_root {
        let _ = std::fs::remove_dir_all(stage);
    }
    if dir_sha(&c.target).as_deref() != Some(p.base_sha.as_str()) {
        return Err(bad(
            "скил изменён другим процессом сразу после установки: проверьте результат, строка журнала сохранена",
            "the skill was changed by another process right after installation: check the result; the journal entry is kept",
        ));
    }
    Ok(Applied {
        op: id,
        entity: p.entity.clone(),
        from: p.from.clone(),
        to: p.to.clone(),
    })
}

/// Whether the install can be rolled back: the skill is in place and unchanged. The path comes from the name, not from the manifest.
pub(super) fn can_rollback(home: &Path, m: &Manifest) -> bool {
    target_of(home, m)
        .and_then(|t| walk(&t).ok())
        .and_then(|f| tree_sha_by(&f, cached_digest).ok())
        .as_deref()
        == Some(m.sha_after.as_str())
}

pub(super) fn rollback(
    home: &Path,
    store: &Path,
    op: &str,
    m: &Manifest,
) -> Result<Applied, String> {
    // the manifest lives in the user's directory: recompute the target from the verified name, client and project
    let target = target_of(home, m).ok_or_else(|| {
        bad(
            "манифест повреждён или проекта больше нет в списке известных",
            "the manifest is corrupted, or the project is no longer among the known ones",
        )
    })?;
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
    // delete = move to backup: first a copy, then the directory is removed
    if let Err(e) = copy_files(&files, &dir.join("removed")) {
        return fail(e);
    }
    #[cfg(test)]
    AFTER_BACKUP.with(|h| {
        if let Some(hook) = h.borrow().as_ref() {
            hook();
        }
    });
    // First the directory leaves its place (one `rename` if on the same volume), and only then is the journal line written:
    // an unfinished deletion must not look like a rollback. If deletion failed, restore what was deleted from the copy.
    // next to the skills folder, as on install (`~/.claude`, `<p>/.agents` …)
    let outer = target
        .parent()
        .and_then(Path::parent)
        .ok_or_else(super::empty_path)?;
    let gone = outer.join(format!(".{}.loadout.removed", m.name));
    let _ = std::fs::remove_dir_all(&gone);
    let moved = rename_dir(&target, &gone).is_ok();
    // Restore after a failed rollback. Copies everything it can, not stopping at a busy file. If it cannot restore everything,
    // the copy stays in the operation directory, and the error names its path (it has no journal line).
    let restore = |why: String| -> Result<Applied, String> {
        let whole = if moved {
            std::fs::rename(&gone, &target).is_ok()
        } else {
            walk(&dir.join("removed")).is_ok_and(|back| {
                back.iter().fold(true, |ok, (rel, path, _)| {
                    let dest = target.join(rel);
                    // a file counts as matching only if it was read on both sides
                    let same = matches!(
                        (std::fs::read(&dest), std::fs::read(path)),
                        (Ok(a), Ok(b)) if a == b
                    );
                    let done = same
                        || dest
                            .parent()
                            .is_some_and(|p| std::fs::create_dir_all(p).is_ok())
                            && std::fs::copy(path, &dest).is_ok();
                    ok && done
                })
            })
        };
        if whole {
            return fail(bad(
                &format!("откат не выполнен: {why}; скил на месте"),
                &format!("the rollback did not happen: {why}; the skill is in place"),
            ));
        }
        // the manifest may have been written: without it the operation does not look like a rollback in the journal, the copy stays
        let _ = std::fs::remove_file(dir.join("manifest.json"));
        let copy = tilde(home, &dir.join("removed"));
        Err(bad(
            &format!("откат не выполнен: {why}; скил вернулся не полностью, полная копия: {copy}"),
            &format!("the rollback did not happen: {why}; the skill was not fully restored, a full copy is in {copy}"),
        ))
    };
    if !moved {
        if let Err(e) = std::fs::remove_dir_all(&target) {
            return restore(e.to_string());
        }
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
        return restore(e);
    }
    // the copy is already in the operation's backup: a temp directory that was not fully removed does no harm
    let _ = std::fs::remove_dir_all(&gone);
    // folders the install created go too, only when empty (`remove_dir` refuses otherwise)
    if m.mkdir {
        if let Some(root) = target.parent() {
            let _ = std::fs::remove_dir(root);
        }
    }
    if m.created {
        let _ = std::fs::remove_dir(outer);
    }
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

    pub(super) fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("loadout-skill-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Manifest of an installed skill: only the name and the "after" hash are needed.
    pub(super) fn manifest(name: &str, sha_after: String) -> Manifest {
        Manifest {
            version: 2,
            id: "1731700000000-00".into(),
            time: 0,
            op: "installSkill".into(),
            of: None,
            batch: None,
            level: "R2".into(),
            entity: String::new(),
            inverse_enable: None,
            trash_id: None,
            trash_before: None,
            path: String::new(),
            sha_before: String::new(),
            sha_after,
            client: "claude-code".into(),
            kind: "skill".into(),
            name: name.into(),
            pointer: String::new(),
            file: String::new(),
            from: String::new(),
            to: String::new(),
            project: String::new(),
            created: false,
            mkdir: false,
        }
    }

    /// A home with skill `demo` made of two files.
    pub(super) fn home_with_skill(tag: &str) -> (PathBuf, PathBuf) {
        let home = tmp(tag);
        let dir = home.join(".claude").join("skills").join("demo");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: demo\n---\n").unwrap();
        std::fs::write(dir.join("a.txt"), "один").unwrap();
        (home, dir)
    }

    #[test]
    fn journal_hashes_each_skill_file_once_until_it_changes() {
        let (home, dir) = home_with_skill("cache");
        let m = manifest("demo", dir_sha(&dir).unwrap());
        let reads = || DISK_READS.with(std::cell::Cell::get);
        assert!(can_rollback(&home, &m));
        assert_eq!(reads(), 2, "the first display reads both files");
        for _ in 0..3 {
            assert!(can_rollback(&home, &m));
        }
        assert_eq!(reads(), 2, "a repeated display does not read the files");
        // editing one file (different size and time): the display notices it and rereads only that file
        std::fs::write(dir.join("a.txt"), "изменён").unwrap();
        assert!(!can_rollback(&home, &m));
        assert_eq!(reads(), 3);
        let _ = std::fs::remove_dir_all(&home);
    }

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
