//! Integration checks for `loadout serve`: JSON-RPC over stdio and the file watcher. Each test starts its own process
//! on a copy of the fixture (`fixtures/home` with `{HOME}` substituted).

use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

static N: AtomicU32 = AtomicU32::new(0);

fn copy_tree(from: &Path, to: &Path, home: &str) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if src.is_dir() {
            copy_tree(&src, &dst, home);
        } else {
            let text = fs::read_to_string(&src)
                .unwrap()
                .replace("{HOME_UPPER}", &home.to_uppercase())
                .replace("{HOME}", home);
            fs::write(&dst, text).unwrap();
        }
    }
}

struct Server {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<Result<Value, String>>,
    home: PathBuf,
    /// Notifications that arrived while waiting for a response to a request.
    parked: Vec<Value>,
    next_id: u64,
}

impl Server {
    fn start() -> Server {
        Server::start_with(|_| {})
    }

    /// A core with a backups directory next to the fixture copy: write methods are enabled.
    fn start_writable() -> Server {
        Server::launch(|_| {}, true)
    }

    /// `prep` edits the fixture copy before the core starts (for example, removes a client directory).
    fn start_with(prep: impl FnOnce(&Path)) -> Server {
        Server::launch(prep, false)
    }

    /// A core with English messages (`--lang en`) and a backups directory.
    fn start_en() -> Server {
        Server::launch_lang(|_| {}, true, "en")
    }

    fn launch(prep: impl FnOnce(&Path), writable: bool) -> Server {
        Server::launch_lang(prep, writable, "ru")
    }

    fn launch_lang(prep: impl FnOnce(&Path), writable: bool, lang: &str) -> Server {
        // a name without random letters and digits: the core hides token-like path segments
        let home = std::env::temp_dir().join(format!(
            "loadout-serve-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&home);
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/home");
        copy_tree(&root, &home, &home.to_string_lossy().replace('\\', "/"));
        prep(&home);

        let mut cmd = Command::new(env!("CARGO_BIN_EXE_loadout"));
        cmd.args(["serve", "--lang", lang, "--home"]).arg(&home);
        if writable {
            cmd.arg("--backups").arg(home.with_extension("backups"));
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("loadout serve starts");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                // everything that reaches stdout must be exactly one JSON message per line
                let _ = tx.send(
                    serde_json::from_str::<Value>(&line).map_err(|e| format!("{e}: {line:.80}")),
                );
            }
        });
        let mut s = Server {
            child,
            stdin,
            rx,
            home,
            parked: Vec::new(),
            next_id: 1,
        };
        let ready = s
            .wait_method("ready", Duration::from_secs(20))
            .expect("the server reports `ready` after the watcher starts");
        assert!(
            ready["params"]["watching"].as_u64().unwrap_or(0) > 0,
            "the watcher listens to at least one directory"
        );
        s
    }

    fn recv(&mut self, timeout: Duration) -> Option<Value> {
        match self.rx.recv_timeout(timeout) {
            Ok(Ok(v)) => Some(v),
            Ok(Err(bad)) => panic!("stdout is not JSON: {bad}"),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => None,
        }
    }

    /// Waits for a notification with method `method`; other notifications are parked.
    fn wait_method(&mut self, method: &str, within: Duration) -> Option<Value> {
        if let Some(i) = self.parked.iter().position(|m| m["method"] == method) {
            return Some(self.parked.remove(i));
        }
        let end = Instant::now() + within;
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match self.recv(left) {
                Some(m) if m["method"] == method => return Some(m),
                Some(m) => self.parked.push(m),
                None => break,
            }
        }
        None
    }

    /// Waits for a `changed` whose `field` is a non-empty list (or `true`); other `changed` are skipped.
    fn wait_changed_with(&mut self, field: &str, within: Duration) -> Option<Value> {
        let end = Instant::now() + within;
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            let ev = self.wait_method("changed", left)?;
            let v = &ev["params"][field];
            if v.as_array().is_some_and(|a| !a.is_empty()) || v == &json!(true) {
                return Some(ev);
            }
        }
        None
    }

    fn call(&mut self, method: &str) -> Value {
        self.call_with(method, Value::Null)
    }

    fn call_with(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let line = json!({ "id": id, "method": method, "params": params }).to_string();
        let stdin = self.stdin.as_mut().expect("stdin is open");
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
        let end = Instant::now() + Duration::from_secs(20);
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match self.recv(left) {
                Some(m) if m["id"] == id => return m,
                Some(m) => self.parked.push(m),
                None => break,
            }
        }
        panic!("no response to {method}");
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stdin = None;
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.home);
        let _ = fs::remove_dir_all(self.home.with_extension("backups"));
    }
}

#[test]
fn snapshot_scan_and_status_answer_over_jsonrpc() {
    let mut s = Server::start();
    let snap = s.call("snapshot");
    assert!(
        snap["result"]["entities"]
            .as_array()
            .is_some_and(|a| a.len() > 10),
        "{snap}"
    );
    let scan = s.call("scan");
    assert_eq!(
        scan["result"]["entities"], snap["result"]["entities"],
        "without edits the scan and the snapshot match"
    );
    let status = s.call("status");
    assert!(status["result"]["watching"].as_u64().unwrap_or(0) > 0);
    let unknown = s.call("rm -rf");
    assert!(
        unknown["error"]["message"].is_string(),
        "an unknown method is an error and the process stays alive: {unknown}"
    );
    assert!(s.call("snapshot")["result"].is_object());
}

#[test]
fn real_change_produces_changed_without_raw_paths() {
    let mut s = Server::start();
    let cfg = s.home.join(".codex/config.toml");
    let text = fs::read_to_string(&cfg).unwrap();
    assert!(text.contains("enabled = true"));
    fs::write(&cfg, text.replacen("enabled = true", "enabled = false", 1)).unwrap();

    let ev = s
        .wait_method("changed", Duration::from_secs(10))
        .expect("editing an enabled plugin yields `changed`");
    let changed = ev["params"]["changed"]
        .as_array()
        .expect("list of changed ids");
    assert!(!changed.is_empty(), "{ev}");
    let raw = ev.to_string();
    assert!(
        !raw.contains(&s.home.to_string_lossy().replace('\\', "/")) && !raw.contains("config.toml"),
        "the event contains no paths: {raw}"
    );
    // the snapshot already contains the new state
    let snap = s.call("snapshot");
    let p1 = snap["result"]["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["client"] == "codex" && e["name"] == "p1@bundled")
        .unwrap();
    assert_eq!(p1["state"], "off");
}

#[test]
fn rewrite_without_semantic_change_is_silent() {
    let mut s = Server::start();
    let cfg = s.home.join(".codex/config.toml");
    let text = fs::read_to_string(&cfg).unwrap();
    for _ in 0..3 {
        fs::write(&cfg, &text).unwrap(); // same content: the file is rewritten, the scan is the same
        std::thread::sleep(Duration::from_millis(150));
    }
    assert!(
        s.wait_method("changed", Duration::from_secs(3)).is_none(),
        "a rewrite without semantic changes does not send `changed`"
    );
}

#[test]
fn new_skill_directory_is_noticed() {
    let mut s = Server::start();
    let dir = s.home.join(".claude/skills/fresh-skill");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        "---\nname: fresh-skill\ndescription: новый\n---\n",
    )
    .unwrap();
    let ev = s
        .wait_method("changed", Duration::from_secs(10))
        .expect("a new skill yields `changed`");
    assert!(
        !ev["params"]["added"].as_array().unwrap().is_empty(),
        "{ev}"
    );
}

const SKILL: &str = "---\nname: fresh-skill\ndescription: новый\n---\n";

#[test]
fn recreated_directory_stays_watched() {
    let mut s = Server::start();
    let skills = s.home.join(".claude/skills");
    // the skills directory vanished and immediately came back with the same content (as with `git checkout`): the scan is the same, no `changed`,
    // but the subscription to the old directory is dead, and the watcher must subscribe again
    let aside = s.home.join("skills-aside"); // outside the watched directories
    copy_tree(&skills, &aside, "");
    fs::remove_dir_all(&skills).unwrap();
    copy_tree(&aside, &skills, "");
    std::thread::sleep(Duration::from_millis(800));
    fs::create_dir_all(skills.join("first")).unwrap();
    fs::write(skills.join("first/SKILL.md"), SKILL).unwrap();
    assert!(
        s.wait_changed_with("added", Duration::from_secs(10))
            .is_some(),
        "a skill in the recreated directory is noticed"
    );
    fs::create_dir_all(skills.join("second")).unwrap();
    fs::write(
        skills.join("second/SKILL.md"),
        SKILL.replace("fresh", "second"),
    )
    .unwrap();
    assert!(
        s.wait_changed_with("added", Duration::from_secs(10))
            .is_some(),
        "and the next skill too: the subscription is alive"
    );
}

#[test]
fn client_directory_created_after_start_is_noticed() {
    let mut saved = String::new();
    let mut s = Server::start_with(|h| {
        saved = fs::read_to_string(h.join(".codex/config.toml")).unwrap();
        fs::remove_dir_all(h.join(".codex")).unwrap();
    });
    let dir = s.home.join(".codex");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("config.toml"), saved).unwrap();
    assert!(
        s.wait_changed_with("added", Duration::from_secs(10))
            .is_some(),
        "a client installed after the core started is noticed"
    );
}

#[test]
fn client_directory_with_unwatched_parent_is_noticed() {
    // `.gemini/config` (Antigravity): the parent `.gemini` itself is not watched while it does not exist; Claude Desktop is the same with `AppData/Roaming`
    let aside = std::env::temp_dir().join(format!("loadout-aside-{}", std::process::id()));
    let _ = fs::remove_dir_all(&aside);
    let mut s = Server::start_with(|h| {
        copy_tree(&h.join(".gemini"), &aside, "");
        fs::remove_dir_all(h.join(".gemini")).unwrap();
    });
    // first only the parent appears, `config` comes later: the nearest existing ancestor has to be watched
    fs::create_dir_all(s.home.join(".gemini")).unwrap();
    std::thread::sleep(Duration::from_millis(800));
    copy_tree(&aside, &s.home.join(".gemini"), "");
    let ev = s.wait_changed_with("added", Duration::from_secs(10));
    let _ = fs::remove_dir_all(&aside);
    assert!(
        ev.is_some(),
        "Antigravity installed after the core started is noticed"
    );
}

#[test]
fn new_remote_catalog_entry_is_noticed() {
    let mut s = Server::start();
    fs::create_dir_all(
        s.home
            .join(".codex/plugins/cache/openai-curated-remote/gmail"),
    )
    .unwrap();
    assert!(
        s.wait_changed_with("added", Duration::from_secs(10))
            .is_some(),
        "a new entry in the remote plugins directory is noticed"
    );
}

#[test]
fn new_backup_file_changes_facts() {
    let mut s = Server::start();
    fs::write(s.home.join(".codex/config.toml.bak-extra"), "x").unwrap();
    assert!(
        s.wait_changed_with("factsChanged", Duration::from_secs(10))
            .is_some(),
        "a new backup changes the facts"
    );
}

/// English language of the core (`--lang en`): errors, plan notes and the words `from`/`to` without a single Cyrillic letter,
/// a garbage language value does not crash the process and falls back to Russian.
#[test]
fn english_core_speaks_english_and_a_bad_lang_falls_back_to_russian() {
    let has_cyr = |v: &Value| {
        v.to_string()
            .chars()
            .any(|c| ('а'..='я').contains(&c) || ('А'..='Я').contains(&c) || c == 'ё')
    };
    let mut s = Server::start_en();
    // core error: the plan parameters are invalid
    let bad = s.call_with(
        "plan",
        json!({"op": "toggle", "entity": "nope", "enable": true}),
    );
    assert!(bad["error"]["message"].is_string(), "{bad}");
    assert!(!has_cyr(&bad), "the error is in English: {bad}");
    let unknown = s.call("no_such_method");
    assert!(!has_cyr(&unknown), "{unknown}");
    // the plan of a real entry: the words from/to and notes
    let snap = s.call("snapshot");
    let id = snap["result"]["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == "mcp" && e["canToggle"] == true)
        .and_then(|e| e["id"].as_str())
        .expect("there is an MCP that can be toggled")
        .to_owned();
    let plan = s.call_with(
        "plan",
        json!({"op": "toggle", "entity": id, "enable": false}),
    );
    assert!(plan["result"].is_object(), "{plan}");
    assert!(!has_cyr(&plan), "the plan is in English: {plan}");
    drop(s);

    // garbage language value: Russian, the process is alive
    let home = std::env::temp_dir().join("loadout-serve-badlang");
    let _ = fs::remove_dir_all(&home);
    copy_tree(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/home"),
        &home,
        &home.to_string_lossy().replace('\\', "/"),
    );
    let out = Command::new(env!("CARGO_BIN_EXE_loadout"))
        .args(["serve", "--lang", "xx", "--home"])
        .arg(&home)
        .stdin(Stdio::null())
        .output()
        .expect("starts");
    assert!(
        out.status.success(),
        "a garbage --lang does not crash the process"
    );
    let _ = fs::remove_dir_all(&home);
}

#[test]
fn invalid_utf8_line_does_not_kill_the_server() {
    let mut s = Server::start();
    let stdin = s.stdin.as_mut().unwrap();
    stdin.write_all(b"\xff\xfe{\n").unwrap();
    stdin.flush().unwrap();
    assert!(
        s.call("snapshot")["result"].is_object(),
        "the process is alive and responding"
    );
    assert!(
        s.parked.iter().any(|m| m["error"]["message"].is_string()),
        "the broken line got an error: {:?}",
        s.parked
    );
}

#[test]
fn request_flood_does_not_postpone_the_rescan() {
    let mut s = Server::start();
    let cfg = s.home.join(".codex/config.toml");
    let text = fs::read_to_string(&cfg).unwrap();
    // Requests flow continuously for seconds: the scan must run on schedule (300 ms of quiet or 2 s), not after the flood. The request
    // is heavy for the core (a write plan is a full scan, tens of ms), the response is short; they arrive slightly faster than
    // they are processed, but not in a burst: a file event goes into the same queue, and a burst of hundreds of requests that arrived before
    // it would legitimately be processed earlier (there is one queue, in arrival order). A light `status` on a fast machine ended the flood
    // before the scan deadline, and the check verified nothing.
    let id = s.call("snapshot")["result"]["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == "mcp" && e["canToggle"] == true)
        .and_then(|e| e["id"].as_str())
        .expect("there is an MCP that can be toggled")
        .to_owned();
    let mut stdin = s.stdin.take().unwrap();
    let flood = std::thread::spawn(move || {
        let line = format!(
            "{{\"id\":1,\"method\":\"plan\",\"params\":{{\"op\":\"toggle\",\"entity\":\"{id}\",\"enable\":false}}}}\n"
        )
        .into_bytes();
        for _ in 0..150 {
            if stdin.write_all(&line).is_err() || stdin.flush().is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = stdin.write_all(b"{\"id\":999999999,\"method\":\"status\"}\n");
        let _ = stdin.flush();
        stdin
    });
    std::thread::sleep(Duration::from_millis(50));
    fs::write(&cfg, text.replacen("enabled = true", "enabled = false", 1)).unwrap();

    let (mut changed_at, mut last_at, mut n) = (None, None, 0u64);
    let end = Instant::now() + Duration::from_secs(60);
    while last_at.is_none() && Instant::now() < end {
        let Some(m) = s.recv(Duration::from_secs(10)) else {
            break;
        };
        n += 1;
        if m["method"] == "changed" && changed_at.is_none() {
            changed_at = Some(n);
        }
        if m["id"] == 999_999_999 {
            last_at = Some(n);
        }
    }
    s.stdin = flood.join().ok();
    let l = last_at.expect("the response to the last request arrived");
    let c = changed_at.expect("`changed` arrived");
    assert!(
        c < l,
        "`changed` (message {c}) arrived only after the whole flood of requests (last response {l})"
    );
}

#[test]
fn closing_stdin_stops_the_process() {
    let mut s = Server::start();
    s.stdin = None; // EOF
    let end = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = s.child.try_wait().unwrap() {
            assert!(status.success(), "exit on EOF without an error: {status}");
            return;
        }
        assert!(Instant::now() < end, "the process outlived closing stdin");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn entity_id(snap: &Value, client: &str, name: &str) -> String {
    snap["result"]["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["client"] == client && e["name"] == name)
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn write_methods_refuse_without_backups_but_plan_works() {
    let mut s = Server::start();
    let id = entity_id(&s.call("snapshot"), "codex", "p1@bundled");
    let plan = s.call_with("plan", json!({ "entity": id, "enable": false }));
    assert_eq!(plan["result"]["to"], "выключено", "{plan}");
    for (m, p) in [
        (
            "apply",
            json!({ "entity": id, "enable": false, "baseSha": plan["result"]["baseSha"] }),
        ),
        ("journal", json!({})),
        ("rollback", json!({ "op": "0" })),
    ] {
        let r = s.call_with(m, p);
        assert!(
            r["error"]["message"]
                .as_str()
                .unwrap()
                .contains("запись выключена"),
            "{m}: {r}"
        );
    }
    assert_eq!(s.call("status")["result"]["writable"], false);
}

#[test]
fn toggle_and_rollback_over_jsonrpc_announce_changes_without_paths() {
    let mut s = Server::start_writable();
    assert_eq!(s.call("status")["result"]["writable"], true);
    let id = entity_id(&s.call("snapshot"), "codex", "p1@bundled");
    let cfg = s.home.join(".codex/config.toml");
    let original = fs::read_to_string(&cfg).unwrap();

    let plan = s.call_with("plan", json!({ "entity": id, "enable": false }));
    let base = plan["result"]["baseSha"].clone();
    let done = s.call_with(
        "apply",
        json!({ "entity": id, "enable": false, "baseSha": base }),
    );
    assert!(done["result"]["op"].is_string(), "{done}");
    // `changed` arrives right after the write, without waiting for the watcher
    let ev = s
        .wait_method("changed", Duration::from_secs(5))
        .expect("changed after the write");
    assert!(
        ev["params"]["changed"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| *x == json!(id)),
        "{ev}"
    );
    assert_eq!(
        fs::read_to_string(&cfg)
            .unwrap()
            .matches("enabled = false")
            .count(),
        original.matches("enabled = false").count() + 1
    );

    let journal = s.call("journal");
    let rows = journal["result"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{journal}");
    assert_eq!(rows[0]["canRollback"], true);
    let back = s.call_with("rollback", json!({ "op": done["result"]["op"] }));
    assert!(back["result"]["op"].is_string(), "{back}");
    assert_eq!(fs::read_to_string(&cfg).unwrap(), original);

    let home = s.home.to_string_lossy().replace('\\', "/");
    let all = format!("{plan}{done}{journal}{back}");
    assert!(
        !all.contains(&home) && !all.contains("FAKE-SECRET"),
        "{all}"
    );
}

#[test]
fn write_methods_validate_params() {
    let mut s = Server::start_writable();
    let id = entity_id(&s.call("snapshot"), "codex", "p1@bundled");
    for (m, p) in [
        ("plan", json!({ "enable": true })),
        ("plan", json!({ "entity": id })),
        ("plan", json!({ "entity": "нет-такого", "enable": true })),
        ("apply", json!({ "entity": id, "enable": false })),
        (
            "apply",
            json!({ "entity": id, "enable": false, "baseSha": "00" }),
        ),
        ("rollback", json!({ "op": "../x" })),
        ("rollback", json!({})),
    ] {
        let r = s.call_with(m, p.clone());
        assert!(r["error"]["message"].is_string(), "{m} {p}: {r}");
    }
    assert!(
        s.call("snapshot")["result"].is_object(),
        "the process is alive"
    );
}

#[test]
fn trash_edit_and_copy_work_over_jsonrpc_and_the_secret_never_leaves_the_core() {
    let mut s = Server::start_writable();
    let snap = s.call("snapshot");
    let id = entity_id(&snap, "antigravity", "tool-b");
    let e = snap["result"]["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == json!(id))
        .unwrap();
    assert_eq!(e["canToggle"], true);
    assert_eq!(e["canEdit"], true);

    // moving to the trash: R2, the entry stays in the list as disabled with the same id
    let plan = s.call_with(
        "plan",
        json!({ "op": "toggle", "entity": id, "enable": false }),
    );
    assert_eq!(plan["result"]["level"], "R2", "{plan}");
    // without main's permission (maxLevel) an R2 operation does not pass, so the core checks the level too
    let denied = s.call_with(
        "apply",
        json!({ "op": "toggle", "entity": id, "enable": false, "baseSha": plan["result"]["baseSha"] }),
    );
    assert!(
        denied["error"]["message"].as_str().unwrap().contains("R2"),
        "{denied}"
    );
    // a garbage level value is a refusal, not a silent R1
    for bad in [json!("R0"), json!("r2"), json!(2), json!("")] {
        let r = s.call_with(
            "apply",
            json!({ "op": "toggle", "entity": id, "enable": false, "baseSha": plan["result"]["baseSha"], "maxLevel": bad }),
        );
        assert!(
            r["error"]["message"].as_str().unwrap().contains("maxLevel"),
            "{bad}: {r}"
        );
    }
    let done = s.call_with(
        "apply",
        json!({ "op": "toggle", "entity": id, "enable": false, "baseSha": plan["result"]["baseSha"], "maxLevel": "R2" }),
    );
    assert!(done["result"]["op"].is_string(), "{done}");
    s.wait_method("changed", Duration::from_secs(5))
        .expect("changed after the removal");
    let after = s.call("snapshot");
    let e = after["result"]["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == json!(id))
        .expect("the entry from the trash is visible with the same id");
    assert_eq!(e["state"], "off");

    // edit and copy (R2): the responses contain no secret values
    let id_a = entity_id(&s.call("snapshot"), "antigravity", "tool-a");
    let edit =
        json!({ "op": "edit", "entity": id_a, "command": "npx", "args": ["-y", "tool-a-mcp@2"] });
    let p = s.call_with("plan", edit.clone());
    assert_eq!(p["result"]["op"], "edit", "{p}");
    let mut ap = edit.clone();
    ap["baseSha"] = p["result"]["baseSha"].clone();
    ap["maxLevel"] = json!("R2");
    let d = s.call_with("apply", ap);
    assert!(d["result"]["op"].is_string(), "{d}");
    let copy = json!({ "op": "copy", "entity": id_a, "to": "codex" });
    let p = s.call_with("plan", copy.clone());
    assert_eq!(p["result"]["client"], "codex", "{p}");
    let bad = s.call_with("plan", json!({ "op": "delete", "entity": id_a }));
    assert!(
        bad["error"]["message"].is_string(),
        "an unknown operation does not pass: {bad}"
    );

    let all = format!("{plan}{done}{p}{d}{}", s.call("journal"));
    assert!(!all.contains("FAKE-SECRET"), "{all}");
    assert!(
        !all.contains(&s.home.to_string_lossy().replace('\\', "/")),
        "{all}"
    );
}

#[test]
fn profiles_save_plan_apply_and_roll_back_over_jsonrpc() {
    let mut s = Server::start_writable();
    let saved = s.call_with("profileSave", json!({ "name": "рабочий" }));
    let list = saved["result"].as_array().expect("list of profiles");
    assert_eq!(list.len(), 1, "{saved}");
    let mut items = list[0]["items"].clone();
    for it in items.as_array_mut().unwrap() {
        if it["client"] == "codex" && it["name"] == "p1@bundled" {
            it["enable"] = json!(false);
        }
    }
    s.call_with("profileSave", json!({ "name": "рабочий", "items": items }));
    assert!(s.call_with("profileSave", json!({ "name": "../x" }))["error"].is_object());

    let bp = s.call_with("planProfile", json!({ "name": "рабочий" }));
    let plans = bp["result"]["plans"].as_array().unwrap();
    assert_eq!(
        plans.iter().filter(|p| p["noop"] == false).count(),
        1,
        "{bp}"
    );
    let ap = s.call_with(
        "applyProfile",
        json!({ "name": "рабочий", "batchSha": bp["result"]["batchSha"], "maxLevel": "R2" }),
    );
    let batch = ap["result"]["batch"].clone();
    assert_eq!(ap["result"]["applied"].as_array().unwrap().len(), 1, "{ap}");
    let rb = s.call_with("rollbackBatch", json!({ "batch": batch, "maxLevel": "R2" }));
    assert_eq!(rb["result"].as_array().unwrap().len(), 1, "{rb}");
    let del = s.call_with("profileDelete", json!({ "name": "рабочий" }));
    assert_eq!(del["result"].as_array().unwrap().len(), 0);
}

/// "Operation" directories with old IDs: cleanup by age removes them all, the trash and the rest remain.
#[test]
fn old_backups_are_pruned_by_the_rpc_method_and_by_the_prune_command() {
    let mut s = Server::start_writable();
    let store = s.home.with_extension("backups");
    for dir in ["trash", "0000000000001-00", "0000000000002-00"] {
        fs::create_dir_all(store.join(dir)).unwrap();
    }
    fs::write(store.join("0000000000001-00").join("before"), "секрет").unwrap();
    let r = s.call("pruneBackups");
    assert_eq!(r["result"], json!({ "removed": 2, "kept": 0 }), "{r}");
    assert!(store.join("trash").is_dir() && !store.join("0000000000001-00").exists());

    fs::create_dir_all(store.join("0000000000003-00")).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_loadout"))
        .args(["prune", "--backups"])
        .arg(&store)
        .output()
        .expect("loadout prune starts");
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("удалено операций: 1"));
    assert!(!store.join("0000000000003-00").exists());
    // without a backups directory the command refuses instead of creating it
    let missing = Command::new(env!("CARGO_BIN_EXE_loadout"))
        .args(["prune", "--backups"])
        .arg(store.join("нет"))
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(2));
}

/// Without `--backups` the command uses `%APPDATA%\<name from app/package.json>\backups`: that is how Electron names `userData`.
#[test]
fn prune_defaults_to_the_electron_user_data_dir_named_after_the_package() {
    let pkg: Value = serde_json::from_str(
        &fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/package.json"))
            .unwrap(),
    )
    .unwrap();
    let name = pkg["name"].as_str().unwrap();
    assert!(
        pkg.get("productName").is_none(),
        "with productName in package.json the data directory name differs: fix APP_DATA_DIR and the texts"
    );
    let appdata = std::env::temp_dir().join(format!("loadout-appdata-{}", std::process::id()));
    let dir = appdata.join(name).join("backups").join("0000000000001-00");
    fs::create_dir_all(&dir).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_loadout"))
        .arg("prune")
        .env("APPDATA", &appdata)
        .output()
        .unwrap();
    let _ = fs::remove_dir_all(&appdata);
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("удалено операций: 1"),
        "{out:?}"
    );
}

#[test]
fn broken_profiles_file_is_an_error_over_jsonrpc_and_is_set_aside_on_request() {
    let mut s = Server::start_writable();
    s.call_with("profileSave", json!({ "name": "рабочий" }));
    let file = s.home.with_extension("backups").join("profiles.json");
    fs::write(&file, "{ битый").unwrap();
    for call in [
        s.call("profiles"),
        s.call_with("profileSave", json!({ "name": "новый" })),
        s.call_with("profileDelete", json!({ "name": "рабочий" })),
    ] {
        assert!(
            call["error"]["message"]
                .as_str()
                .is_some_and(|m| m.contains("profiles.json")),
            "{call}"
        );
    }
    assert_eq!(fs::read_to_string(&file).unwrap(), "{ битый");
    let q = s.call("profilesQuarantine");
    let name = q["result"].as_str().expect("name of the set-aside file");
    assert!(name.starts_with("profiles.json.broken-"), "{q}");
    assert!(!file.exists());
    assert_eq!(s.call("profiles")["result"].as_array().unwrap().len(), 0);
    assert!(s.call("profilesQuarantine")["error"].is_object());
}

#[test]
fn claude_json_rewrites_are_scanned_at_most_every_ten_seconds_but_other_files_are_not_delayed() {
    let mut s = Server::start();
    let cj = s.home.join(".claude.json");
    let text = fs::read_to_string(&cj).unwrap();
    assert!(text.contains("\"command\": \"old\""));
    fs::write(
        &cj,
        text.replace("\"command\": \"old\"", "\"command\": \"older\""),
    )
    .unwrap();
    // a noisy file: the scan comes no sooner than NOISY_MIN after the previous one (within 4 s the window does not see it)
    assert!(
        s.wait_method("changed", Duration::from_secs(4)).is_none(),
        "a change to ~/.claude.json must not be scanned immediately"
    );
    let ev = s
        .wait_method("changed", Duration::from_secs(12))
        .expect("but the change is noticed in the end");
    assert!(
        !ev["params"]["changed"].as_array().unwrap().is_empty(),
        "{ev}"
    );
    // a regular file (Codex `config.toml`) goes with the normal delay, the noisy limit does not apply to it
    let cfg = s.home.join(".codex/config.toml");
    let t = fs::read_to_string(&cfg).unwrap();
    fs::write(&cfg, t.replacen("enabled = true", "enabled = false", 1)).unwrap();
    assert!(
        s.wait_method("changed", Duration::from_secs(5)).is_some(),
        "an edit of config.toml must arrive within seconds"
    );
}
