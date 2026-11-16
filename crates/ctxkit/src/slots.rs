//! Policy `build_slots`: `ctxkit check` takes one of N machine-wide slots before it starts a build, so a
//! shared machine never runs more than N checks at once.
//!
//! A slot is the file `<temp>/ctxkit-slots/slot-<n>.lock`, held with an operating-system lock for as long as
//! the process lives: when it exits, panics, is killed or hits Ctrl+C the system lets go, so a dead process
//! never keeps a slot and there is no pid-reuse guesswork. A sidecar `slot-<n>.info` holds the owner's pid
//! and start time (the lock file itself cannot be read by others on Windows). A holder older than two
//! hours counts as hung: its slot is treated as free and an extra slot file is used instead.
//! Anything that goes wrong with the files (cannot create the folder, cannot open a lock) means no slot is
//! taken and the check runs at once: a broken slot folder must never hang a build.
use crate::Lang;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MAX_WAIT: Duration = Duration::from_secs(10 * 60);
const REPORT_EVERY: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(250);
const HUNG_AFTER_SECS: u64 = 2 * 60 * 60;

/// A taken slot; dropping it (also on a panic) releases it.
pub struct Slot {
    _lock: File,
    info: PathBuf,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let _ = fs::write(&self.info, "");
    }
}

pub fn dir() -> PathBuf {
    std::env::temp_dir().join("ctxkit-slots")
}

pub fn wait_message(lang: Lang, busy: usize) -> String {
    match lang {
        Lang::En => format!("waiting for a build slot ({busy} busy)"),
        Lang::Ru => format!("жду слот сборки ({busy} занято)"),
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

enum Take {
    Got(Slot),
    /// Held by a live process; `hung` when its recorded start is over two hours old.
    Busy {
        hung: bool,
    },
    /// The files cannot be used at all.
    Broken,
}

fn take(dir: &Path, n: usize) -> Take {
    let lock = dir.join(format!("slot-{n}.lock"));
    let info = dir.join(format!("slot-{n}.info"));
    let Ok(file) = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock)
    else {
        return Take::Broken;
    };
    match file.try_lock() {
        Ok(()) => {
            let _ = fs::write(&info, format!("{}\n{}\n", std::process::id(), now_secs()));
            Take::Got(Slot { _lock: file, info })
        }
        Err(TryLockError::WouldBlock) => {
            let started = fs::read_to_string(&info)
                .ok()
                .and_then(|s| s.lines().nth(1).and_then(|l| l.trim().parse::<u64>().ok()));
            Take::Busy {
                hung: started.is_some_and(|s| now_secs().saturating_sub(s) > HUNG_AFTER_SECS),
            }
        }
        Err(TryLockError::Error(_)) => Take::Broken,
    }
}

/// Takes one of `limit` slots in `dir`, waiting up to `max_wait` (`report(busy)` is called at once and then
/// every 15 s while waiting). `None`: no slot was taken, run anyway.
pub fn acquire(
    dir: &Path,
    limit: usize,
    max_wait: Duration,
    report: &mut dyn FnMut(usize),
) -> Option<Slot> {
    fs::create_dir_all(dir).ok()?;
    let start = Instant::now();
    let mut last_report: Option<Instant> = None;
    loop {
        let (mut busy, mut hung) = (0, 0);
        for n in 0..limit {
            match take(dir, n) {
                Take::Got(s) => return Some(s),
                Take::Busy { hung: true } => hung += 1,
                Take::Busy { hung: false } => busy += 1,
                Take::Broken => return None,
            }
        }
        // a hung holder does not count: the extra slot files after the limit stand in for it
        for n in limit..limit + hung {
            match take(dir, n) {
                Take::Got(s) => return Some(s),
                Take::Busy { .. } => {}
                Take::Broken => return None,
            }
        }
        if start.elapsed() >= max_wait {
            return None;
        }
        if last_report.is_none_or(|t| t.elapsed() >= REPORT_EVERY) {
            report(busy);
            last_report = Some(Instant::now());
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn temp(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("ctxkit-slots-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn quick(d: &Path, limit: usize) -> Option<Slot> {
        acquire(d, limit, Duration::from_millis(150), &mut |_| {})
    }

    #[test]
    fn never_more_slots_than_the_limit_at_once() {
        let d = Arc::new(temp("limit"));
        let (now, peak) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let (d, now, peak) = (d.clone(), now.clone(), peak.clone());
                std::thread::spawn(move || {
                    let slot =
                        acquire(&d, 2, Duration::from_secs(30), &mut |_| {}).expect("a slot");
                    let n = now.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(n, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(120));
                    now.fetch_sub(1, Ordering::SeqCst);
                    drop(slot);
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(
            peak.load(Ordering::SeqCst),
            2,
            "the limit is reached and never exceeded"
        );
        let _ = fs::remove_dir_all(&*d);
    }

    #[test]
    fn a_dropped_slot_is_free_at_once_and_a_full_house_times_out() {
        let d = temp("drop");
        let a = quick(&d, 1).expect("first");
        let started = Instant::now();
        assert!(quick(&d, 1).is_none(), "the only slot is taken");
        assert!(started.elapsed() >= Duration::from_millis(100));
        drop(a);
        assert!(quick(&d, 1).is_some());
        // a slot of the limit's second place is free while the first is held
        let (b, c) = (quick(&d, 2).unwrap(), quick(&d, 2).unwrap());
        assert!(quick(&d, 2).is_none());
        drop((b, c));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn files_left_by_a_dead_process_do_not_hold_a_slot() {
        let d = temp("dead");
        fs::create_dir_all(&d).unwrap();
        // what a killed `ctxkit check` leaves: the files, no lock, an old pid inside
        fs::write(d.join("slot-0.lock"), "").unwrap();
        fs::write(d.join("slot-0.info"), "999999\n1\n").unwrap();
        let s = quick(&d, 1).expect("the dead holder's slot is free");
        let info = fs::read_to_string(d.join("slot-0.info")).unwrap();
        assert!(
            info.starts_with(&format!("{}\n", std::process::id())),
            "{info}"
        );
        drop(s);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_holder_over_two_hours_old_counts_as_hung_and_garbage_info_does_not_free_a_slot() {
        let d = temp("hung");
        let a = quick(&d, 1).unwrap();
        // the live holder claims a start three hours ago: its slot is treated as free, an extra slot is used
        let old = now_secs() - 3 * 60 * 60;
        fs::write(d.join("slot-0.info"), format!("1\n{old}\n")).unwrap();
        let extra = quick(&d, 1).expect("extra slot beside the hung holder");
        assert!(d.join("slot-1.lock").exists());
        assert!(quick(&d, 1).is_none(), "the extra slot is taken now");
        drop(extra);
        // a young holder with an unreadable info file still holds its slot
        fs::write(d.join("slot-0.info"), "not a number\n").unwrap();
        assert!(quick(&d, 1).is_none());
        fs::remove_file(d.join("slot-0.info")).unwrap();
        assert!(quick(&d, 1).is_none());
        drop(a);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn broken_files_never_hang_the_build() {
        let d = temp("broken");
        fs::create_dir_all(d.join("slot-0.lock")).unwrap(); // a folder where the lock file should be
        let started = Instant::now();
        let got = acquire(&d, 2, Duration::from_secs(30), &mut |_| {});
        assert!(got.is_none() && started.elapsed() < Duration::from_secs(5));
        // the slot folder itself cannot be made: a file stands in its place
        let f = temp("file");
        fs::write(&f, "x").unwrap();
        assert!(acquire(&f.join("slots"), 2, Duration::from_secs(30), &mut |_| {}).is_none());
        let _ = fs::remove_dir_all(&d);
        let _ = fs::remove_file(&f);
    }

    #[test]
    fn the_wait_is_reported_at_once_with_the_busy_count_in_both_languages() {
        let d = temp("report");
        let _a = quick(&d, 1).unwrap();
        let mut seen = Vec::new();
        let none = acquire(&d, 1, Duration::from_millis(100), &mut |n| seen.push(n));
        assert!(none.is_none());
        assert_eq!(seen, [1], "once at the start, the next report is 15 s away");
        assert_eq!(wait_message(Lang::Ru, 2), "жду слот сборки (2 занято)");
        assert_eq!(
            wait_message(Lang::En, 2),
            "waiting for a build slot (2 busy)"
        );
        let _ = fs::remove_dir_all(&d);
    }
}
