//! Race with a client: the file is changed between writing the temp file and `rename`. The `BEFORE_SWAP` callback exists only in the crate's
//! tests, so the tests are here and not in `tests/`.

use super::{apply, journal, rollback, Intent, BEFORE_SWAP};
use crate::model::{Client, Kind};
use std::fs;
use std::path::{Path, PathBuf};

pub(super) struct Env {
    pub(super) top: PathBuf,
    pub(super) home: PathBuf,
    pub(super) store: PathBuf,
}

impl Drop for Env {
    fn drop(&mut self) {
        BEFORE_SWAP.with(|h| *h.borrow_mut() = None);
        let _ = fs::remove_dir_all(&self.top);
    }
}

pub(super) fn env(tag: &str) -> Env {
    let top = std::env::temp_dir().join(format!("loadout-race-{}-{tag}", std::process::id()));
    let _ = fs::remove_dir_all(&top);
    let home = top.join("home");
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::write(
        home.join(".codex/config.toml"),
        "[plugins.\"p1@bundled\"]\nenabled = true\n",
    )
    .unwrap();
    Env {
        store: top.join("backups"),
        home,
        top,
    }
}

pub(super) fn cfg(e: &Env) -> PathBuf {
    e.home.join(".codex/config.toml")
}

pub(super) fn toggle(e: &Env, enable: bool) -> Intent {
    let scan = crate::scan(&e.home);
    let id = scan
        .entities
        .iter()
        .find(|x| x.client == Client::Codex && x.kind == Kind::Plugin && x.name == "p1@bundled")
        .unwrap()
        .id
        .clone();
    Intent::Toggle { entity: id, enable }
}

/// Callback: before the swap the client appends its own line.
fn client_writes(text: &'static str) {
    BEFORE_SWAP.with(|h| {
        *h.borrow_mut() = Some(Box::new(move |p: &Path| {
            let mut s = fs::read_to_string(p).unwrap();
            s.push_str(text);
            fs::write(p, s).unwrap();
        }));
    });
}

fn no_tmp(e: &Env) {
    let left = fs::read_dir(cfg(e).parent().unwrap())
        .unwrap()
        .flatten()
        .any(|f| f.file_name().to_string_lossy().contains("loadout"));
    assert!(!left, "the temp file did not remain");
}

/// Temp files of killed cores (other pids) older than ten minutes are removed on the next write, fresh ones stay.
#[test]
fn stale_temp_files_of_dead_cores_are_cleaned_but_fresh_ones_stay() {
    let e = env("stale-tmp");
    let dir = cfg(&e).parent().unwrap().to_owned();
    let stale = dir.join("config.toml.loadout.4242.tmp");
    let fresh = dir.join("config.toml.loadout.4343.tmp");
    let other = dir.join("other.toml.loadout.1.tmp");
    for f in [&stale, &fresh, &other] {
        fs::write(f, "секрет").unwrap();
    }
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    for f in [&stale, &other] {
        fs::File::options()
            .write(true)
            .open(f)
            .unwrap()
            .set_modified(old)
            .unwrap();
    }
    let i = toggle(&e, false);
    let p = super::plan(&e.home, Some(&e.store), &i).unwrap();
    apply(&e.home, &e.store, &i, &p.base_sha, "R2").unwrap();
    assert!(!stale.exists(), "the old temp file was removed");
    assert!(
        fresh.exists(),
        "the fresh one (another core's write) is untouched"
    );
    assert!(
        other.exists(),
        "foreign files with a different name are not touched"
    );
}

#[test]
fn commit_refuses_when_the_file_changes_right_before_the_swap() {
    let e = env("commit");
    let i = toggle(&e, false);
    let plan = super::plan(&e.home, Some(&e.store), &i).unwrap();
    client_writes("# клиент успел\n");
    let err = apply(&e.home, &e.store, &i, &plan.base_sha, "R2").unwrap_err();
    assert!(err.contains("перед заменой"), "{err}");
    // the client's write is intact, ours did not land, no journal line and no operation directory
    let text = fs::read_to_string(cfg(&e)).unwrap();
    assert!(text.ends_with("# клиент успел\n") && text.contains("enabled = true"));
    assert!(journal(&e.home, &e.store).is_empty());
    no_tmp(&e);
}

#[test]
fn rollback_refuses_when_the_file_changes_right_before_the_swap() {
    let e = env("rollback");
    let i = toggle(&e, false);
    let plan = super::plan(&e.home, Some(&e.store), &i).unwrap();
    let done = apply(&e.home, &e.store, &i, &plan.base_sha, "R2").unwrap();
    client_writes("# клиент успел\n");
    let err = rollback(&e.home, &e.store, &done.op, "R2").unwrap_err();
    assert!(err.contains("перед заменой"), "{err}");
    let text = fs::read_to_string(cfg(&e)).unwrap();
    assert!(text.ends_with("# клиент успел\n") && text.contains("enabled = false"));
    // this did not count as a rollback: the original operation is still one and is listed as not rolled back
    let j = journal(&e.home, &e.store);
    assert_eq!(j.len(), 1);
    assert!(!j[0].rolled_back);
    no_tmp(&e);
}
