//! Storage of operation backups (CONCEPT.md §5, "Copies and secrets"). The operation directory `<ms>-<nn>` holds a copy of the client config
//! in full, in plain text, so it lives a limited time: the last [`KEEP_OPS`] operations and not older than [`KEEP_DAYS`] days.
//! Everything is computed from the directory name, the manifest is not read. Old directories go before a new write and on the
//! cleanup command. Trash (`trash/`) is untouched: it holds the only copy of a moved entry, which is live state, not history.

use serde::Serialize;
use std::path::Path;

/// How many of the latest operations to keep. The value is duplicated in the window text (`app/src/shared/backups.ts`), a test checks it.
pub const KEEP_OPS: usize = 100;
/// How many days to keep operations. Same.
pub const KEEP_DAYS: u64 = 90;
/// How many of the latest operations the journal parses: the rest are not read.
pub const JOURNAL_MAX: usize = 200;

const DAY_MS: u64 = 86_400_000;
/// A file in the backups directory: the largest id of a deleted operation. It makes rollback answer "deleted", not "not found".
const MARK: &str = "pruned";

/// Operation directory: 13 digits of time in ms, a hyphen, 2 digits of counter (this is how `new_op_dir` names them).
pub(super) fn is_op_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 16
        && b[13] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 13 || c.is_ascii_digit())
}

/// Operation ids, newest first. Reads only directory names: `trash`, `staging` and files are discarded.
pub(super) fn op_ids(store: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(store) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| is_op_id(n))
        .collect();
    ids.sort_unstable_by(|a, b| b.cmp(a));
    ids
}

fn id_ms(id: &str) -> u64 {
    id[..13].parse().unwrap_or(0)
}

/// Cleanup result: how many operation directories were deleted and how many remain.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pruned {
    pub removed: usize,
    pub kept: usize,
}

/// The profile bundle of an operation (`batch` in the manifest), if present and readable.
fn batch_of(store: &Path, id: &str) -> Option<String> {
    let text = std::fs::read_to_string(store.join(id).join("manifest.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("batch")?.as_str().map(str::to_owned)
}

/// Keeps the first `keep` operations (newest first) not older than [`KEEP_DAYS`] at the moment `now`. The rest is deleted, except:
/// - everything not older than the oldest of `protect` (an operation's rollback and a bundle's rollback are newer than the operations
///   themselves, their rows are needed so the journal knows about the rollback);
/// - the tail of a profile bundle whose beginning was kept: a bundle is not cut in the middle, otherwise its rollback would become partial;
/// - a full skill copy after an incomplete rollback (a directory without a manifest but with `removed/`): only age deletes it.
///
/// A failure to delete one directory does not stop the others.
pub(super) fn prune_at(store: &Path, keep: usize, now: u64, protect: &[String]) -> Pruned {
    let floor = protect.iter().min();
    let ids = op_ids(store);
    let (mut removed, mut kept, mut newest_gone) = (0, 0, String::new());
    let mut last_kept: Option<&String> = None;
    let mut batch: Option<Option<String>> = None; // bundle of the last kept operation, read at the first candidate
    let mut cut = false; // bundle boundary passed: no more joining bundles
    for (i, id) in ids.iter().enumerate() {
        let aged = now.saturating_sub(id_ms(id)) > KEEP_DAYS * DAY_MS;
        if (i < keep && !aged) || floor.is_some_and(|f| id >= f) {
            kept += 1;
            last_kept = Some(id);
            continue;
        }
        if !cut {
            let head = batch.get_or_insert_with(|| last_kept.and_then(|k| batch_of(store, k)));
            if head.is_some() && batch_of(store, id) == *head {
                kept += 1;
                last_kept = Some(id);
                continue;
            }
            cut = true;
        }
        let dir = store.join(id);
        let skill_copy = !dir.join("manifest.json").exists() && dir.join("removed").is_dir();
        if (skill_copy && !aged) || std::fs::remove_dir_all(&dir).is_err() {
            kept += 1;
        } else {
            removed += 1;
            newest_gone = newest_gone.max(id.clone());
        }
    }
    if !newest_gone.is_empty() && newest_gone > pruned_mark(store).unwrap_or_default() {
        let _ = std::fs::write(store.join(MARK), newest_gone);
    }
    Pruned { removed, kept }
}

/// Before a new write: after it there must be no more than [`KEEP_OPS`] operations. Errors do not block the write itself.
pub(super) fn before_write(store: &Path, protect: &[String]) {
    prune_at(store, KEEP_OPS - 1, super::now_ms(), protect);
}

/// Cleanup command: keeps the last [`KEEP_OPS`] and not older than [`KEEP_DAYS`].
pub fn prune(store: &Path) -> Pruned {
    prune_at(store, KEEP_OPS, super::now_ms(), &[])
}

fn pruned_mark(store: &Path) -> Option<String> {
    std::fs::read_to_string(store.join(MARK))
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| is_op_id(s))
}

/// The operation was already deleted by cleanup (its id is not newer than the last deleted one).
pub(super) fn was_pruned(store: &Path, id: &str) -> bool {
    is_op_id(id) && pruned_mark(store).is_some_and(|m| id <= m.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("loadout-ret-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("trash")).unwrap();
        std::fs::create_dir_all(d.join("staging")).unwrap();
        std::fs::write(d.join("profiles.json"), "{}").unwrap();
        d
    }

    fn op(d: &Path, ms: u64, n: u32) -> String {
        let id = format!("{ms:013}-{n:02}");
        std::fs::create_dir_all(d.join(&id)).unwrap();
        std::fs::write(d.join(&id).join("before"), "секрет").unwrap();
        id
    }

    /// The window text names the same numbers the core keeps.
    #[test]
    fn window_text_uses_the_same_limits() {
        let ts = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/src/shared/backups.ts"),
        )
        .unwrap();
        assert!(ts.contains(&format!("BACKUP_KEEP_OPS = {KEEP_OPS}\n")));
        assert!(ts.contains(&format!("BACKUP_KEEP_DAYS = {KEEP_DAYS}\n")));
    }

    #[test]
    fn ids_are_recognised_by_name_only() {
        assert!(is_op_id("1731700000000-00") && is_op_id("0000000000001-99"));
        for no in [
            "trash",
            "staging",
            "1731700000000",
            "1731700000000-0",
            "x731700000000-00",
            "1731700000000_00",
            "",
        ] {
            assert!(!is_op_id(no), "{no}");
        }
    }

    #[test]
    fn keeps_the_last_n_and_drops_older_than_the_age_limit_but_not_trash_or_profiles() {
        let d = store("keep");
        let now = 200 * DAY_MS;
        // 5 fresh, 3 of them within the limit N=3; one more older than 90 days with free space
        let ids: Vec<String> = (0..5).map(|i| op(&d, now - 1000 + i, 0)).collect();
        let r = prune_at(&d, 3, now, &[]);
        assert_eq!(
            r,
            Pruned {
                removed: 2,
                kept: 3
            }
        );
        assert!(!d.join(&ids[0]).exists() && !d.join(&ids[1]).exists() && d.join(&ids[2]).exists());
        // the marker knows the newest of the deleted
        assert!(was_pruned(&d, &ids[1]) && was_pruned(&d, &ids[0]) && !was_pruned(&d, &ids[2]));
        // by age: one operation older than 90 days goes, even when the count limit is not exhausted
        let old = op(&d, now - 91 * DAY_MS, 0);
        let edge = op(&d, now - 90 * DAY_MS, 0);
        assert_eq!(prune_at(&d, 10, now, &[]).removed, 1);
        assert!(!d.join(&old).exists() && d.join(&edge).exists());
        // trash, staging and profiles untouched
        assert!(
            d.join("trash").is_dir()
                && d.join("staging").is_dir()
                && d.join("profiles.json").is_file()
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn protected_ops_survive_and_the_mark_never_goes_back() {
        let d = store("protect");
        let now = 300 * DAY_MS;
        let (a, b, c) = (
            op(&d, now - 30, 0),
            op(&d, now - 20, 0),
            op(&d, now - 10, 0),
        );
        // protected `b`: it and everything newer than it (its rollback) stay, older than it is deleted
        let r = prune_at(&d, 1, now, std::slice::from_ref(&b));
        assert_eq!(
            r,
            Pruned {
                removed: 1,
                kept: 2
            }
        );
        assert!(!d.join(&a).exists() && d.join(&b).exists() && d.join(&c).exists());
        assert!(was_pruned(&d, &a) && !was_pruned(&d, &b));
        // the next run without protection only moves the marker forward
        prune_at(&d, 0, now, &[]);
        assert!(was_pruned(&d, &c));
        let _ = std::fs::remove_dir_all(&d);
    }

    fn with_batch(d: &Path, id: &str, batch: &str) {
        std::fs::write(
            d.join(id).join("manifest.json"),
            format!(r#"{{"batch":"{batch}"}}"#),
        )
        .unwrap();
    }

    /// A profile bundle is not cut at the boundary: a bundle rollback must not become partial.
    #[test]
    fn a_batch_is_not_cut_in_the_middle() {
        let d = store("batch");
        let now = 400 * DAY_MS;
        let single = op(&d, now - 500, 0);
        let members: Vec<String> = (0..5).map(|i| op(&d, now - 400 + i, 0)).collect();
        for m in &members {
            with_batch(&d, m, "1");
        }
        let newest = op(&d, now - 10, 0);
        // limit 3 falls inside the bundle (newest + two members): the other members stay, a single one older than the bundle goes
        let r = prune_at(&d, 3, now, &[]);
        assert_eq!(
            r,
            Pruned {
                removed: 1,
                kept: 6
            }
        );
        assert!(members.iter().all(|m| d.join(m).exists()));
        assert!(d.join(&newest).exists() && !d.join(&single).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A full skill copy after an incomplete rollback (a directory without a manifest, with `removed/`) goes only by age.
    #[test]
    fn a_skill_copy_left_by_a_failed_rollback_goes_only_by_age() {
        let d = store("skillcopy");
        let now = 500 * DAY_MS;
        let copy = op(&d, now - 40, 0);
        std::fs::create_dir_all(d.join(&copy).join("removed")).unwrap();
        let junk = op(&d, now - 30, 0); // a failed operation without a manifest and without a skill copy
        let newest = op(&d, now - 20, 0);
        let r = prune_at(&d, 1, now, &[]);
        assert_eq!(
            r,
            Pruned {
                removed: 1,
                kept: 2
            }
        );
        assert!(d.join(&copy).exists() && !d.join(&junk).exists() && d.join(&newest).exists());
        // after 90 days it goes too
        assert_eq!(prune_at(&d, 10, now + 91 * DAY_MS, &[]).removed, 2);
        assert!(!d.join(&copy).exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
