//! `loadout serve`: постоянный процесс для окна. JSON-RPC по stdio, по одному сообщению в строке, и сторож файлов.
//!
//! Протокол (stdout только под JSON, всё остальное в stderr):
//! - запрос `{"id":N,"method":"scan"|"snapshot"|"status"}`; ответ `{"id":N,"result":…}` или `{"id":N,"error":{"message":…}}`;
//! - уведомление `ready` после запуска сторожа и `changed` при смысловом изменении скана; в `changed` только id записей.
//!
//! Методов с путями от страницы нет. EOF на stdin завершает процесс, иначе на Windows он пережил бы окно.

use loadout_core::diff::diff;
use loadout_core::model::ScanResult;
use loadout_core::watch::Targets;
use notify::event::ModifyKind;
use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

/// Тишина, после которой пачка событий считается законченной.
const DEBOUNCE: Duration = Duration::from_millis(300);
/// Предел ожидания, если события идут без перерыва (`.claude.json` переписывается постоянно).
const MAX_WAIT: Duration = Duration::from_secs(2);
const IDLE: Duration = Duration::from_secs(3600);

enum Msg {
    Request(String),
    Eof,
    Fs(notify::Result<Event>),
}

/// Одно сообщение — одна строка со сбросом буфера. Закрытый stdout означает, что окна нет: выходим.
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
}

impl Server {
    fn new(home: &Path, watcher: Option<RecommendedWatcher>) -> Self {
        let last = loadout_core::scan(home);
        let targets = Targets::from_scan(home, &last);
        let mut s = Server {
            home: home.to_path_buf(),
            last,
            targets,
            watcher,
            watched: BTreeMap::new(),
            seq: 0,
        };
        s.sync_watches(false);
        s
    }

    /// Каталог из набора исчез или переименован: его подписка мертва, даже если каталог тут же создали заново.
    fn forget_watch(&mut self, path: &Path) {
        if self.watched.remove(path).is_some() {
            if let Some(w) = self.watcher.as_mut() {
                let _ = w.unwatch(path);
            }
        }
    }

    /// Приводит набор слушаемых каталогов к `targets`. Ошибка слежения не фатальна: путь мог исчезнуть.
    /// `reset` сбрасывает все подписки: после ошибки сторожа неизвестно, какие из них живы.
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
                Err(e) => eprintln!("сторож: не удалось слушать каталог: {e}"),
            }
        }
    }

    /// Новый скан; события шлются только при смысловом отличии от прошлого.
    fn rescan(&mut self, announce: bool, reset: bool) {
        let new = loadout_core::scan(&self.home);
        // набор путей пересобирается на каждом скане, даже без смысловых изменений: каталог мог появиться или исчезнуть
        self.targets = Targets::from_scan(&self.home, &new);
        self.sync_watches(reset);
        let d = diff(&self.last, &new);
        if d.is_empty() {
            return;
        }
        self.last = new;
        if announce {
            self.seq += 1;
            // в событии только id записей и признаки изменений: путей и значений в нём нет
            let mut params = serde_json::to_value(&d).unwrap_or_else(|_| json!({}));
            params["seq"] = json!(self.seq);
            send(&json!({ "jsonrpc": "2.0", "method": "changed", "params": params }));
        }
    }

    fn handle(&mut self, line: &str) {
        let Ok(req) = serde_json::from_str::<Value>(line) else {
            send(&json!({ "jsonrpc": "2.0", "id": null, "error": { "message": "не JSON" } }));
            return;
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let reply = match req.get("method").and_then(Value::as_str) {
            // `scan` и `snapshot` отдают одно и то же; `scan` сначала перечитывает диск и не шлёт `changed` тому, кто спросил сам
            Some("scan") => {
                self.rescan(false, false);
                json!({ "result": &self.last })
            }
            Some("snapshot") => json!({ "result": &self.last }),
            Some("status") => {
                json!({ "result": { "watching": self.watched.len(), "seq": self.seq } })
            }
            Some(other) => {
                json!({ "error": { "message": format!("неизвестный метод: {other:.40}") } })
            }
            None => json!({ "error": { "message": "нет метода" } }),
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
        // побайтово: невалидный UTF-8 в строке — ошибка запроса, а не конец работы
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

pub fn run(home: &Path) {
    let (tx, rx): (Sender<Msg>, Receiver<Msg>) = mpsc::channel();
    let tx_fs = tx.clone();
    let watcher = recommended_watcher(move |res| {
        let _ = tx_fs.send(Msg::Fs(res));
    })
    .map_err(|e| eprintln!("сторож не запущен: {e}"))
    .ok();
    spawn_stdin_reader(tx);

    let mut server = Server::new(home, watcher);
    send(
        &json!({ "jsonrpc": "2.0", "method": "ready", "params": { "watching": server.watched.len() } }),
    );

    // (когда пришло первое событие пачки, когда последнее, нужно ли пересоздать все подписки)
    let mut dirty: Option<(Instant, Instant, bool)> = None;
    let mark = |dirty: &mut Option<(Instant, Instant, bool)>, reset: bool| {
        let now = Instant::now();
        let (first, _, was) = dirty.unwrap_or((now, now, false));
        *dirty = Some((first, now, was || reset));
    };
    loop {
        // срок проверяем в начале каждого шага: поток запросов не должен откладывать скан дольше MAX_WAIT
        if let Some((first, last, reset)) = dirty {
            let due = (last + DEBOUNCE).min(first + MAX_WAIT);
            if due <= Instant::now() {
                dirty = None;
                server.rescan(true, reset);
                continue;
            }
        }
        let wait = dirty.map_or(IDLE, |(first, last, _)| {
            (last + DEBOUNCE)
                .min(first + MAX_WAIT)
                .saturating_duration_since(Instant::now())
        });
        match rx.recv_timeout(wait) {
            Ok(Msg::Request(line)) => server.handle(&line),
            Ok(Msg::Eof) | Err(RecvTimeoutError::Disconnected) => break,
            Ok(Msg::Fs(Ok(ev))) => {
                if ev.kind.is_access() {
                    continue;
                }
                // каталог создан, удалён или переименован: подписка на удалённый мертва, даже если его создали заново
                let structural = ev.kind.is_create()
                    || ev.kind.is_remove()
                    || matches!(ev.kind, EventKind::Modify(ModifyKind::Name(_)));
                if ev.kind.is_remove() || matches!(ev.kind, EventKind::Modify(ModifyKind::Name(_)))
                {
                    for p in &ev.paths {
                        server.forget_watch(p);
                    }
                }
                if ev.paths.iter().any(|p| {
                    server.targets.is_relevant(p) || (structural && server.targets.is_fixed(p))
                }) {
                    mark(&mut dirty, false);
                }
            }
            // любая ошибка сторожа — повод перечитать диск: событие могло потеряться, а подписки — умереть
            Ok(Msg::Fs(Err(e))) => {
                eprintln!("сторож: {e}");
                mark(&mut dirty, true);
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}
