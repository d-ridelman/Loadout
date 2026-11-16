//! `loadout serve`: a long-running process for the window. JSON-RPC over stdio, one message per line, plus a file watcher.
//!
//! Protocol (stdout carries only JSON, everything else goes to stderr):
//! - request `{"id":N,"method":"scan"|"snapshot"|"status"}`, and for R1 writes `plan`/`apply`/`journal`/`rollback`
//!   (only the entry id and the desired state, see `loadout_core::write`; without `--backups` writing is disabled); response `{"id":N,"result":…}` or `{"id":N,"error":{"message":…}}`;
//! - notification `ready` after the watcher starts and `changed` on a semantic change of the scan; `changed` carries only entry ids.
//!
//! No method takes paths from the page. EOF on stdin ends the process, otherwise on Windows it would outlive the window.

use loadout_core::diff::diff;
use loadout_core::model::ScanResult;
use loadout_core::watch::Targets;
use loadout_core::write;
use notify::event::ModifyKind;
use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

/// JSON-RPC protocol version: bumped on incompatible changes to methods and response shapes. The window, `context-toolkit` and other
/// shells check it via `ready` and `status` (see CONCEPT.md §13).
const PROTOCOL: u32 = 1;

/// Quiet period after which a batch of events is considered finished.
const DEBOUNCE: Duration = Duration::from_millis(300);
/// Waiting limit when events keep coming without a pause (`.claude.json` is rewritten constantly).
const MAX_WAIT: Duration = Duration::from_secs(2);
/// A scan triggered only by `~/.claude.json` events runs at most once per this interval: on a machine with Claude Code running the file
/// is rewritten every few seconds, and a full scan costs 50–100 ms (CONCEPT.md §7, 0 % CPU when idle).
const NOISY_MIN: Duration = Duration::from_secs(10);
const IDLE: Duration = Duration::from_secs(3600);

enum Msg {
    Request(String),
    Eof,
    Fs(notify::Result<Event>),
}

/// One message is one line, with a buffer flush. A closed stdout means the window is gone: exit.
fn send(v: &Value) {
    let mut out = std::io::stdout().lock();
    if writeln!(out, "{v}").and_then(|()| out.flush()).is_err() {
        std::process::exit(0);
    }
}

struct Server {
    home: PathBuf,
    last: ScanResult,
    targets: Targets,
    watcher: Option<RecommendedWatcher>,
    watched: BTreeMap<PathBuf, RecursiveMode>,
    seq: u64,
    /// Directory of backups and the journal; without it writing is disabled.
    backups: Option<PathBuf>,
}

impl Server {
    fn new(home: &Path, backups: Option<PathBuf>, watcher: Option<RecommendedWatcher>) -> Self {
        let last = loadout_core::scan_with(home, backups.as_deref());
        let targets = Targets::from_scan(home, &last);
        let mut s = Server {
            home: home.to_path_buf(),
            last,
            targets,
            watcher,
            watched: BTreeMap::new(),
            seq: 0,
            backups,
        };
        s.sync_watches(false);
        s
    }

    /// A directory from the set vanished or was renamed: its subscription is dead even if the directory was immediately recreated.
    fn forget_watch(&mut self, path: &Path) {
        if self.watched.remove(path).is_some() {
            if let Some(w) = self.watcher.as_mut() {
                let _ = w.unwatch(path);
            }
        }
    }

    /// Brings the set of watched directories in line with `targets`. A watch error is not fatal: the path may have vanished.
    /// `reset` drops all subscriptions: after a watcher error it is unknown which of them are still alive.
    fn sync_watches(&mut self, reset: bool) {
        let Some(w) = self.watcher.as_mut() else {
            return;
        };
        if reset {
            for path in std::mem::take(&mut self.watched).into_keys() {
                let _ = w.unwatch(&path);
            }
        }
        let want: BTreeMap<PathBuf, RecursiveMode> = self
            .targets
            .dirs
            .iter()
            .map(|(p, t)| {
                (
                    p.clone(),
                    if t.recursive {
                        RecursiveMode::Recursive
                    } else {
                        RecursiveMode::NonRecursive
                    },
                )
            })
            .collect();
        for path in self
            .watched
            .keys()
            .filter(|p| !want.contains_key(*p))
            .cloned()
            .collect::<Vec<_>>()
        {
            let _ = w.unwatch(&path);
            self.watched.remove(&path);
        }
        for (path, mode) in want {
            if self.watched.get(&path) == Some(&mode) {
                continue;
            }
            if self.watched.contains_key(&path) {
                let _ = w.unwatch(&path);
            }
            match w.watch(&path, mode) {
                Ok(()) => {
                    self.watched.insert(path, mode);
                }
                Err(e) => eprintln!(
                    "{}",
                    loadout_core::tr!(
                        "сторож: не удалось слушать каталог: {e}",
                        "watcher: cannot watch the directory: {e}"
                    )
                ),
            }
        }
    }

    /// A new scan; events are sent only when it differs semantically from the previous one.
    fn rescan(&mut self, announce: bool, reset: bool) {
        let new = loadout_core::scan_with(&self.home, self.backups.as_deref());
        // the set of paths is rebuilt on every scan, even without semantic changes: a directory may have appeared or vanished
        self.targets = Targets::from_scan(&self.home, &new);
        self.sync_watches(reset);
        let d = diff(&self.last, &new);
        if d.is_empty() {
            return;
        }
        self.last = new;
        if announce {
            self.seq += 1;
            // the event carries only entry ids and change flags: no paths or values in it
            let mut params = serde_json::to_value(&d).unwrap_or_else(|_| json!({}));
            params["seq"] = json!(self.seq);
            send(&json!({ "jsonrpc": "2.0", "method": "changed", "params": params }));
        }
    }

    /// Write methods (R1). They accept only the entry id and the desired state: no paths from the page, the core finds the target itself.
    /// Without `--backups` files cannot be changed. The window always passes the directory, and the right to write comes from `maxLevel`
    /// (R1 or R2), which main sends in the same request as the write; the core itself refuses if the operation needs
    /// a higher level.
    fn write_method(&mut self, method: &str, p: &Value) -> Result<Value, String> {
        let str_of = |k: &str| {
            p.get(k)
                .and_then(Value::as_str)
                .ok_or_else(|| loadout_core::tr!("нет параметра {k}", "missing parameter {k}"))
        };
        let store = || {
            self.backups.clone().ok_or_else(|| {
                loadout_core::tr!(
                    "запись выключена: ядро запущено без каталога бэкапов",
                    "writing is off: the core was started without a backups directory"
                )
            })
        };
        fn json<T: serde::Serialize>(v: &T) -> Result<Value, String> {
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        // Intent: `op` defaults to `toggle` (that is how the window called it in M3); unknown fields and variants are a parse error.
        let intent = || -> Result<write::Intent, String> {
            let mut v = p.clone();
            if let Some(o) = v.as_object_mut() {
                o.entry("op").or_insert(json!("toggle"));
            }
            serde_json::from_value(v).map_err(|_| {
                loadout_core::tr!("неверные параметры намерения", "invalid intent parameters")
            })
        };
        // The highest write level main allowed for this call; without the parameter only flags (R1).
        // An unknown value that was sent (`R0`, `r2`, a number) is a refusal: a level error must not unlock writing.
        let max_level = || -> Result<&str, String> {
            match p.get("maxLevel") {
                None | Some(Value::Null) => Ok("R1"),
                Some(Value::String(l)) if l == "R1" || l == "R2" => Ok(l.as_str()),
                Some(_) => Err(loadout_core::tr!("неверный maxLevel", "invalid maxLevel")),
            }
        };
        let profile_name = || {
            str_of("name").and_then(|n| {
                if loadout_core::profiles::valid_name(n) {
                    Ok(n.to_owned())
                } else {
                    Err(loadout_core::tr!(
                        "недопустимое имя профиля",
                        "invalid profile name"
                    ))
                }
            })
        };
        let out = match method {
            "plan" => json(&write::plan(
                &self.home,
                self.backups.as_deref(),
                &intent()?,
            )?)?,
            "journal" => json(&write::journal(&self.home, &store()?))?,
            // cleanup of old backups (the last 100 operations and those not older than 90 days); the window asks for it with an explicit button
            "pruneBackups" => json(&write::prune_backups(&store()?))?,
            "apply" => json(&write::apply(
                &self.home,
                &store()?,
                &intent()?,
                str_of("baseSha")?,
                max_level()?,
            )?)?,
            "rollback" => json(&write::rollback(
                &self.home,
                &store()?,
                str_of("op")?,
                max_level()?,
            )?)?,
            "rollbackBatch" => json(&write::rollback_batch(
                &self.home,
                &store()?,
                str_of("batch")?,
                max_level()?,
            )?)?,
            "profiles" => json(&loadout_core::profiles::list(&store()?)?)?,
            "profileSave" => {
                let name = profile_name()?;
                let profile = match p.get("items") {
                    // without `items` the profile is captured from the current state
                    None | Some(Value::Null) => {
                        loadout_core::profiles::from_current(&self.home, &store()?, &name)
                    }
                    Some(items) => loadout_core::profiles::Profile {
                        name,
                        items: serde_json::from_value(items.clone()).map_err(|_| {
                            loadout_core::tr!("неверные записи профиля", "invalid profile entries")
                        })?,
                    },
                };
                loadout_core::profiles::save(&store()?, profile)?;
                json(&loadout_core::profiles::list(&store()?)?)?
            }
            "profileDelete" => {
                loadout_core::profiles::delete(&store()?, &profile_name()?)?;
                json(&loadout_core::profiles::list(&store()?)?)?
            }
            // an explicit action by the owner (a button in the window): a corrupted profiles.json is set aside rather than overwritten
            "profilesQuarantine" => json(&loadout_core::profiles::quarantine(&store()?)?)?,
            "planProfile" => {
                let st = store()?;
                let (items, missing) =
                    loadout_core::profiles::intents(&self.home, &st, &profile_name()?)?;
                let mut bp = write::plan_batch(&self.home, Some(&st), &items);
                bp.skipped.extend(missing);
                json(&bp)?
            }
            "applyProfile" => {
                let st = store()?;
                let (items, _) =
                    loadout_core::profiles::intents(&self.home, &st, &profile_name()?)?;
                let (batch, applied) =
                    write::apply_batch(&self.home, &st, &items, str_of("batchSha")?, max_level()?)?;
                json(&json!({ "batch": batch, "applied": applied }))?
            }
            _ => return Err(loadout_core::tr!("неизвестный метод", "unknown method")),
        };
        if matches!(
            method,
            "apply" | "rollback" | "rollbackBatch" | "applyProfile"
        ) {
            // the window learns about the change right away, not after the watcher fires
            self.rescan(true, false);
        }
        Ok(out)
    }

    fn handle(&mut self, line: &str) {
        let Ok(req) = serde_json::from_str::<Value>(line) else {
            send(
                &json!({ "jsonrpc": "2.0", "id": null, "error": { "message": loadout_core::tr!("не JSON", "not JSON") } }),
            );
            return;
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let reply = match req.get("method").and_then(Value::as_str) {
            // `scan` and `snapshot` return the same thing; `scan` rereads the disk first and does not send `changed` to whoever asked itself
            Some("scan") => {
                self.rescan(false, false);
                json!({ "result": &self.last })
            }
            Some("snapshot") => json!({ "result": &self.last }),
            Some("status") => {
                json!({ "result": { "watching": self.watched.len(), "seq": self.seq, "writable": self.backups.is_some(), "protocol": PROTOCOL } })
            }
            Some(
                m @ ("plan" | "apply" | "journal" | "rollback" | "rollbackBatch" | "profiles"
                | "profileSave" | "profileDelete" | "planProfile" | "applyProfile"
                | "profilesQuarantine" | "pruneBackups"),
            ) => match self.write_method(m, req.get("params").unwrap_or(&Value::Null)) {
                Ok(v) => json!({ "result": v }),
                Err(e) => json!({ "error": { "message": e } }),
            },
            Some(other) => {
                json!({ "error": { "message": loadout_core::tr!("неизвестный метод: {other:.40}", "unknown method: {other:.40}") } })
            }
            None => json!({ "error": { "message": loadout_core::tr!("нет метода", "no method") } }),
        };
        let mut msg = json!({ "jsonrpc": "2.0", "id": id });
        if let (Some(m), Some(r)) = (msg.as_object_mut(), reply.as_object()) {
            m.extend(r.clone());
        }
        send(&msg);
    }
}

fn spawn_stdin_reader(tx: Sender<Msg>) {
    std::thread::spawn(move || {
        // byte by byte: invalid UTF-8 in a line is a request error, not the end of the run
        for line in std::io::stdin().lock().split(b'\n') {
            let Ok(l) = line else { break };
            if tx
                .send(Msg::Request(String::from_utf8_lossy(&l).into_owned()))
                .is_err()
            {
                break;
            }
        }
        let _ = tx.send(Msg::Eof);
    });
}

pub fn run(home: &Path, backups: Option<PathBuf>) {
    let (tx, rx): (Sender<Msg>, Receiver<Msg>) = mpsc::channel();
    let tx_fs = tx.clone();
    let watcher = recommended_watcher(move |res| {
        let _ = tx_fs.send(Msg::Fs(res));
    })
    .map_err(|e| {
        eprintln!(
            "{}",
            loadout_core::tr!("сторож не запущен: {e}", "watcher not started: {e}")
        )
    })
    .ok();
    spawn_stdin_reader(tx);

    let mut server = Server::new(home, backups, watcher);
    send(
        &json!({ "jsonrpc": "2.0", "method": "ready", "params": { "watching": server.watched.len(), "protocol": PROTOCOL } }),
    );

    // (first event of the batch, last, whether to recreate subscriptions, whether all events of the batch are "noisy")
    type Dirty = Option<(Instant, Instant, bool, bool)>;
    let mut dirty: Dirty = None;
    let mark = |dirty: &mut Dirty, reset: bool, noisy: bool| {
        let now = Instant::now();
        let (first, _, was, was_noisy) = dirty.unwrap_or((now, now, false, true));
        *dirty = Some((first, now, was || reset, was_noisy && noisy));
    };
    // When a batch must go to a scan: after the quiet period, but no later than MAX_WAIT; a "noisy" batch (only `~/.claude.json`,
    // which a running Claude Code rewrites constantly) triggers at most one scan per NOISY_MIN.
    let due_of = |first: Instant, last: Instant, reset: bool, noisy: bool, last_scan: Instant| {
        let due = (last + DEBOUNCE).min(first + MAX_WAIT);
        if noisy && !reset {
            due.max(last_scan + NOISY_MIN)
        } else {
            due
        }
    };
    let mut last_scan = Instant::now();
    loop {
        // check the deadline at the start of every step: a stream of requests must not delay the scan beyond MAX_WAIT
        if let Some((first, last, reset, noisy)) = dirty {
            if due_of(first, last, reset, noisy, last_scan) <= Instant::now() {
                dirty = None;
                server.rescan(true, reset);
                last_scan = Instant::now();
                continue;
            }
        }
        let wait = dirty.map_or(IDLE, |(first, last, reset, noisy)| {
            due_of(first, last, reset, noisy, last_scan).saturating_duration_since(Instant::now())
        });
        match rx.recv_timeout(wait) {
            Ok(Msg::Request(line)) => server.handle(&line),
            Ok(Msg::Eof) | Err(RecvTimeoutError::Disconnected) => break,
            Ok(Msg::Fs(Ok(ev))) => {
                if ev.kind.is_access() {
                    continue;
                }
                // a directory was created, removed or renamed: a subscription to a removed one is dead even if it was recreated
                let structural = ev.kind.is_create()
                    || ev.kind.is_remove()
                    || matches!(ev.kind, EventKind::Modify(ModifyKind::Name(_)));
                if ev.kind.is_remove() || matches!(ev.kind, EventKind::Modify(ModifyKind::Name(_)))
                {
                    for p in &ev.paths {
                        server.forget_watch(p);
                    }
                }
                let relevant: Vec<&PathBuf> = ev
                    .paths
                    .iter()
                    .filter(|p| {
                        server.targets.is_relevant(p) || (structural && server.targets.is_fixed(p))
                    })
                    .collect();
                if !relevant.is_empty() {
                    let noisy = !structural
                        && relevant
                            .iter()
                            .all(|p| p.file_name().is_some_and(|n| n == ".claude.json"));
                    mark(&mut dirty, false, noisy);
                }
            }
            // any watcher error is a reason to reread the disk: an event may have been lost and subscriptions may have died
            Ok(Msg::Fs(Err(e))) => {
                eprintln!("{}", loadout_core::tr!("сторож: {e}", "watcher: {e}"));
                mark(&mut dirty, true, false);
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}
