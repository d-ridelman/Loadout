//! Скил: запасная копия, когда `rename` каталога невозможен (`~/.claude/skills` на другом томе), скил под ссылкой,
//! точки повторной обработки в дереве и ветки неполного возврата при откате.

use super::skill::{self, AFTER_BACKUP, NO_RENAME};
use super::{journal, rollback};
use std::fs;
use std::path::{Path, PathBuf};

const STAGE: &str = "0123456789abcdef0123456789abcdef";

struct Env {
    top: PathBuf,
    home: PathBuf,
    store: PathBuf,
}

impl Drop for Env {
    fn drop(&mut self) {
        NO_RENAME.with(|c| c.set(false));
        AFTER_BACKUP.with(|h| *h.borrow_mut() = None);
        let _ = fs::remove_dir_all(&self.top);
    }
}

/// Дом и каталог бэкапов; источник скила `demo` (два файла) лежит в `staging/<id>`, как его кладёт main.
fn env(tag: &str) -> Env {
    let top = std::env::temp_dir().join(format!("loadout-skt-{}-{tag}", std::process::id()));
    let _ = fs::remove_dir_all(&top);
    let (home, store) = (top.join("home"), top.join("backups"));
    let stage = store.join("staging").join(STAGE);
    fs::create_dir_all(&stage).unwrap();
    fs::create_dir_all(home.join(".claude")).unwrap();
    fs::write(stage.join("SKILL.md"), "---\nname: demo\n---\n").unwrap();
    fs::write(stage.join("a.txt"), "один").unwrap();
    Env { top, home, store }
}

fn install(e: &Env) -> Result<super::Applied, String> {
    skill::apply(&e.home, &e.store, STAGE, "", "demo", None, "R2")
}

fn target(e: &Env) -> PathBuf {
    e.home.join(".claude").join("skills").join("demo")
}

fn no_leftovers(e: &Env) {
    let left = fs::read_dir(e.home.join(".claude"))
        .unwrap()
        .flatten()
        .any(|f| f.file_name().to_string_lossy().contains("loadout"));
    assert!(!left, "временные каталоги не остались");
}

/// Папка-ссылка (junction) `link` → `to`; прав администратора не требует.
#[cfg(windows)]
fn junction(link: &Path, to: &Path) {
    let st = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(to)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(st.success(), "mklink /J не удался");
}

/// Файл, занятый как чужим процессом: `share` — что он разрешает другим (0 — ничего, 1 — только читать).
#[cfg(windows)]
fn lock(path: &Path, share: u32) -> std::fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(share)
        .open(path)
        .unwrap()
}

/// `skills/` на другом томе: `rename` каталога невозможен, скил ставится копией, а откат уносит его без `rename`.
#[test]
fn install_and_rollback_work_by_copying_when_rename_is_impossible() {
    let e = env("copy");
    NO_RENAME.with(|c| c.set(true));
    let done = install(&e).unwrap();
    assert_eq!(
        fs::read_to_string(target(&e).join("a.txt")).unwrap(),
        "один"
    );
    assert!(target(&e).join("SKILL.md").is_file());
    no_leftovers(&e);
    assert!(journal(&e.home, &e.store)[0].can_rollback);

    let back = rollback(&e.home, &e.store, &done.op, "R2").unwrap();
    assert!(!target(&e).exists(), "скил убран без rename");
    no_leftovers(&e);
    // копия удалённого лежит в каталоге операции отката
    assert_eq!(
        fs::read_to_string(e.store.join(&back.op).join("removed").join("a.txt")).unwrap(),
        "один"
    );
}

/// Каталог `skills` — ссылка (junction) в другое место: скил встаёт по ссылке и откатывается.
#[cfg(windows)]
#[test]
fn skills_dir_that_is_a_junction_is_supported() {
    let e = env("junction-skills");
    let elsewhere = e.top.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    junction(&e.home.join(".claude").join("skills"), &elsewhere);
    let done = install(&e).unwrap();
    assert!(elsewhere.join("demo").join("a.txt").is_file());
    rollback(&e.home, &e.store, &done.op, "R2").unwrap();
    assert!(!elsewhere.join("demo").exists());
}

/// Junction внутри дерева скила отвергается так же, как символьная ссылка: иначе копия утащила бы чужие файлы.
#[cfg(windows)]
#[test]
fn junction_inside_the_skill_tree_is_refused() {
    let e = env("junction-tree");
    let outside = e.top.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "чужое").unwrap();
    let stage = e.store.join("staging").join(STAGE);
    junction(&stage.join("link"), &outside);
    let err = skill::plan(&e.home, Some(&e.store), STAGE, "", "demo").unwrap_err();
    assert!(err.contains("ссылка"), "{err}");
    assert!(install(&e).is_err());
    assert!(!target(&e).exists());
    // и в уже установленном дереве: откат отказывает, а не уносит содержимое ссылки
    let e2 = env("junction-installed");
    let done = install(&e2).unwrap();
    let outside = e2.top.join("outside");
    fs::create_dir_all(&outside).unwrap();
    junction(&target(&e2).join("link"), &outside);
    assert!(rollback(&e2.home, &e2.store, &done.op, "R2").is_err());
    assert!(outside.is_dir() && target(&e2).join("a.txt").is_file());
}

/// Файл скила занят без права удаления: удалить дерево целиком нельзя, откат возвращает всё, что убрал, и говорит об этом.
#[cfg(windows)]
#[test]
fn rollback_puts_the_skill_back_when_a_file_cannot_be_deleted() {
    let e = env("locked");
    let done = install(&e).unwrap();
    let a = target(&e).join("a.txt");
    // занятие файла после копии в бэкап: читать его можно, удалять нет
    let held = std::rc::Rc::new(std::cell::RefCell::new(None));
    let slot = held.clone();
    AFTER_BACKUP
        .with(|h| *h.borrow_mut() = Some(Box::new(move || *slot.borrow_mut() = Some(lock(&a, 1)))));
    NO_RENAME.with(|c| c.set(true));
    let err = rollback(&e.home, &e.store, &done.op, "R2").unwrap_err();
    assert!(err.contains("скил на месте"), "{err}");
    assert_eq!(
        fs::read_to_string(target(&e).join("a.txt")).unwrap(),
        "один"
    );
    assert!(
        target(&e).join("SKILL.md").is_file(),
        "удалённое вернулось из копии"
    );
    // откатом это не стало: в журнале одна установка, она всё ещё откатываема
    let j = journal(&e.home, &e.store);
    assert_eq!(j.len(), 1);
    assert!(!j[0].rolled_back);
    drop(held.borrow_mut().take());
}

/// Файл занят полностью: вернуть его нельзя. Откат не выдаёт себя за выполненный и называет путь полной копии.
#[cfg(windows)]
#[test]
fn rollback_names_the_full_copy_when_the_skill_cannot_be_restored() {
    let e = env("locked-hard");
    let done = install(&e).unwrap();
    let a = target(&e).join("a.txt");
    let held = std::rc::Rc::new(std::cell::RefCell::new(None));
    let slot = held.clone();
    AFTER_BACKUP
        .with(|h| *h.borrow_mut() = Some(Box::new(move || *slot.borrow_mut() = Some(lock(&a, 0)))));
    NO_RENAME.with(|c| c.set(true));
    let err = rollback(&e.home, &e.store, &done.op, "R2").unwrap_err();
    assert!(
        err.contains("не полностью") && err.contains("полная копия"),
        "{err}"
    );
    // полная копия на месте, и по тому же пути её называет ошибка
    let copies: Vec<PathBuf> = fs::read_dir(&e.store)
        .unwrap()
        .flatten()
        .map(|d| d.path().join("removed"))
        .filter(|p| p.is_dir())
        .collect();
    assert_eq!(copies.len(), 1);
    assert_eq!(fs::read_to_string(copies[0].join("a.txt")).unwrap(), "один");
    assert!(copies[0].join("SKILL.md").is_file());
    // строки отката в журнале нет: недоделанное удаление не выглядит откатом
    let j = journal(&e.home, &e.store);
    assert_eq!(j.len(), 1);
    assert!(!j[0].rolled_back && j[0].op == "installSkill");
    drop(held.borrow_mut().take());
}
