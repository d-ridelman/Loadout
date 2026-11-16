//! Backup storage through the real pipeline: cleanup before a write, refusal to roll back a deleted operation, lazy journal.

use super::race_tests::{env, toggle, Env};
use super::retention::{JOURNAL_MAX, KEEP_OPS};
use super::{apply, journal, now_ms, plan, prune_backups, rollback};
use std::fs;

fn op_dirs(e: &Env) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(&e.store)
        .unwrap()
        .flatten()
        .filter(|d| d.path().is_dir())
        .map(|d| d.file_name().to_string_lossy().into_owned())
        .filter(|n| n.as_bytes().get(13) == Some(&b'-'))
        .collect();
    v.sort();
    v
}

/// `n` operation directories "just before now"; each has a copy of the `template` manifest with their ids.
fn fake_ops(e: &Env, n: u64, template: Option<&str>) -> Vec<String> {
    let base = now_ms() - 60_000;
    (0..n)
        .map(|i| {
            let id = format!("{:013}-00", base + i);
            fs::create_dir_all(e.store.join(&id)).unwrap();
            fs::write(e.store.join(&id).join("before"), "секрет").unwrap();
            if let Some(t) = template {
                let mut m: serde_json::Value = serde_json::from_str(t).unwrap();
                m["id"] = serde_json::json!(id);
                fs::write(e.store.join(&id).join("manifest.json"), m.to_string()).unwrap();
            }
            id
        })
        .collect()
}

#[test]
fn a_write_prunes_old_operations_first_and_rolling_back_a_pruned_one_is_refused_clearly() {
    let e = env("ret-write");
    let fakes = fake_ops(&e, 120, None);
    let i = toggle(&e, false);
    let p = plan(&e.home, Some(&e.store), &i).unwrap();
    let done = apply(&e.home, &e.store, &i, &p.base_sha, "R2").unwrap();
    // after writing the operations exactly KEEP_OPS remain: the oldest are gone, the new one is in place
    let left = op_dirs(&e);
    assert_eq!(left.len(), KEEP_OPS, "{}", left.len());
    assert!(left.contains(&done.op) && !left.contains(&fakes[0]) && left.contains(&fakes[119]));
    // rollback of a deleted one: a clear refusal, not "not found"
    let err = rollback(&e.home, &e.store, &fakes[0], "R2").unwrap_err();
    assert!(err.contains("удалена очисткой"), "{err}");
    // an operation that never existed is newer than the marker: the former refusal
    let err = rollback(&e.home, &e.store, "9999999999999-00", "R2").unwrap_err();
    assert!(err.contains("не найдена"), "{err}");
    // and our own operation rolls back as before
    rollback(&e.home, &e.store, &done.op, "R2").unwrap();
}

#[test]
fn the_cleanup_command_keeps_the_last_n_and_reports_counts() {
    let e = env("ret-cmd");
    fake_ops(&e, 130, None);
    fs::create_dir_all(e.store.join("trash")).unwrap();
    fs::write(e.store.join("trash").join("x.json"), "{}").unwrap();
    let r = prune_backups(&e.store);
    assert_eq!((r.removed, r.kept), (30, KEEP_OPS));
    assert_eq!(op_dirs(&e).len(), KEEP_OPS);
    assert!(
        e.store.join("trash").join("x.json").is_file(),
        "the trash is not cleaned"
    );
    assert_eq!(prune_backups(&e.store).removed, 0);
}

#[test]
fn the_journal_shows_the_newest_200_and_ignores_other_directories() {
    let e = env("ret-journal");
    let i = toggle(&e, false);
    let p = plan(&e.home, Some(&e.store), &i).unwrap();
    let done = apply(&e.home, &e.store, &i, &p.base_sha, "R2").unwrap();
    let template = fs::read_to_string(e.store.join(&done.op).join("manifest.json")).unwrap();
    fake_ops(&e, 250, Some(&template));
    fs::create_dir_all(e.store.join("staging").join("a")).unwrap();
    // a directory whose name looks like an operation but not in form is in neither the journal nor the count
    fs::create_dir_all(e.store.join("1731700000000")).unwrap();
    let j = journal(&e.home, &e.store);
    assert_eq!(j.len(), JOURNAL_MAX);
    assert!(j.windows(2).all(|w| w[0].id > w[1].id), "newest first");
    assert_eq!(
        j[0].id, done.op,
        "the real operation is newer than the forged ones"
    );
    assert!(j.iter().all(|r| r.id.len() == 16));
}
