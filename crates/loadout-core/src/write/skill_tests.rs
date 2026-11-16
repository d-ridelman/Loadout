//! Skill: fallback copy when a directory `rename` is impossible (`~/.claude/skills` on another volume), a skill under a link,
//! reparse points in the tree and the branches of an incomplete restore on rollback.

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

/// Home and backups directory; the source of skill `demo` (two files) sits in `staging/<id>`, as main places it.
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
    assert!(!left, "no temp directories left");
}

/// Junction folder `link` → `to`; does not need administrator rights.
#[cfg(windows)]
fn junction(link: &Path, to: &Path) {
    let st = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(to)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(st.success(), "mklink /J failed");
}

/// A file held as if by a foreign process: `share` is what it allows others (0 is nothing, 1 is read only).
#[cfg(windows)]
fn lock(path: &Path, share: u32) -> std::fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(share)
        .open(path)
        .unwrap()
}

/// `skills/` on another volume: directory `rename` is impossible, the skill is installed by copying, and rollback removes it without `rename`.
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
    assert!(!target(&e).exists(), "the skill was removed without rename");
    no_leftovers(&e);
    // the copy of the deleted skill is in the rollback operation's directory
    assert_eq!(
        fs::read_to_string(e.store.join(&back.op).join("removed").join("a.txt")).unwrap(),
        "один"
    );
}

/// The `skills` directory is a link (junction) elsewhere: the skill is installed through the link and rolled back.
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

/// A junction inside the skill tree is refused like a symlink: otherwise the copy would drag in foreign files.
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
    // and in an already installed tree: rollback refuses rather than removing the link's contents
    let e2 = env("junction-installed");
    let done = install(&e2).unwrap();
    let outside = e2.top.join("outside");
    fs::create_dir_all(&outside).unwrap();
    junction(&target(&e2).join("link"), &outside);
    assert!(rollback(&e2.home, &e2.store, &done.op, "R2").is_err());
    assert!(outside.is_dir() && target(&e2).join("a.txt").is_file());
}

/// A skill file is held without delete rights: the whole tree cannot be deleted, rollback restores everything it removed and says so.
#[cfg(windows)]
#[test]
fn rollback_puts_the_skill_back_when_a_file_cannot_be_deleted() {
    let e = env("locked");
    let done = install(&e).unwrap();
    let a = target(&e).join("a.txt");
    // file held after the copy to backup: it can be read, not deleted
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
        "the deleted files came back from the copy"
    );
    // this did not count as a rollback: the journal has one install, still rollbackable
    let j = journal(&e.home, &e.store);
    assert_eq!(j.len(), 1);
    assert!(!j[0].rolled_back);
    drop(held.borrow_mut().take());
}

/// A file is held completely: it cannot be restored. Rollback does not pose as done and names the path of the full copy.
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
    // the full copy is in place, and the error names it by the same path
    let copies: Vec<PathBuf> = fs::read_dir(&e.store)
        .unwrap()
        .flatten()
        .map(|d| d.path().join("removed"))
        .filter(|p| p.is_dir())
        .collect();
    assert_eq!(copies.len(), 1);
    assert_eq!(fs::read_to_string(copies[0].join("a.txt")).unwrap(), "один");
    assert!(copies[0].join("SKILL.md").is_file());
    // there is no rollback line in the journal: an unfinished deletion does not look like a rollback
    let j = journal(&e.home, &e.store);
    assert_eq!(j.len(), 1);
    assert!(!j[0].rolled_back && j[0].op == "installSkill");
    drop(held.borrow_mut().take());
}
