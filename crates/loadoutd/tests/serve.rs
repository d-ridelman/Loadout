//! Интеграционные проверки `loadout serve`: JSON-RPC по stdio и сторож файлов. Каждый тест поднимает свой процесс
//! на копии фикстуры (`fixtures/home` с подставленным `{HOME}`).

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
    /// Уведомления, пришедшие, пока ждали ответ на запрос.
    parked: Vec<Value>,
    next_id: u64,
}

impl Server {
    fn start() -> Server {
        Server::start_with(|_| {})
    }

    /// Ядро с каталогом бэкапов рядом с копией фикстуры: методы записи включены.
    fn start_writable() -> Server {
        Server::launch(|_| {}, true)
    }

    /// `prep` правит копию фикстуры до запуска ядра (например, убирает каталог клиента).
    fn start_with(prep: impl FnOnce(&Path)) -> Server {
        Server::launch(prep, false)
    }

    fn launch(prep: impl FnOnce(&Path), writable: bool) -> Server {
        // имя без случайных букв и цифр: ядро скрывает токеноподобные сегменты путей
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
        cmd.args(["serve", "--home"]).arg(&home);
        if writable {
            cmd.arg("--backups").arg(home.with_extension("backups"));
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("loadout serve запускается");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                // всё, что попадает в stdout, обязано быть одним JSON-сообщением в строке
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
            .expect("сервер сообщает `ready` после запуска сторожа");
        assert!(
            ready["params"]["watching"].as_u64().unwrap_or(0) > 0,
            "сторож слушает хотя бы один каталог"
        );
        s
    }

    fn recv(&mut self, timeout: Duration) -> Option<Value> {
        match self.rx.recv_timeout(timeout) {
            Ok(Ok(v)) => Some(v),
            Ok(Err(bad)) => panic!("в stdout не JSON: {bad}"),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => None,
        }
    }

    /// Ждёт уведомление с методом `method`; остальные уведомления откладывает.
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

    /// Ждёт `changed`, у которого `field` — непустой список (или `true`); прочие `changed` пропускает.
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
        let stdin = self.stdin.as_mut().expect("stdin открыт");
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
        panic!("нет ответа на {method}");
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
        "без правок скан и снимок совпадают"
    );
    let status = s.call("status");
    assert!(status["result"]["watching"].as_u64().unwrap_or(0) > 0);
    let unknown = s.call("rm -rf");
    assert!(
        unknown["error"]["message"].is_string(),
        "неизвестный метод — ошибка, процесс жив: {unknown}"
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
        .expect("правка включённого плагина даёт `changed`");
    let changed = ev["params"]["changed"]
        .as_array()
        .expect("список изменённых id");
    assert!(!changed.is_empty(), "{ev}");
    let raw = ev.to_string();
    assert!(
        !raw.contains(&s.home.to_string_lossy().replace('\\', "/")) && !raw.contains("config.toml"),
        "в событии нет путей: {raw}"
    );
    // снимок уже содержит новое состояние
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
        fs::write(&cfg, &text).unwrap(); // то же содержимое: файл переписан, скан тот же
        std::thread::sleep(Duration::from_millis(150));
    }
    assert!(
        s.wait_method("changed", Duration::from_secs(3)).is_none(),
        "переписывание без смысловых изменений не шлёт `changed`"
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
        .expect("новый скил даёт `changed`");
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
    // каталог скилов исчез и тут же вернулся с тем же содержимым (как при `git checkout`): скан тот же, `changed` нет,
    // но подписка на старый каталог мертва, и сторож обязан подписаться снова
    let aside = s.home.join("skills-aside"); // вне слушаемых каталогов
    copy_tree(&skills, &aside, "");
    fs::remove_dir_all(&skills).unwrap();
    copy_tree(&aside, &skills, "");
    std::thread::sleep(Duration::from_millis(800));
    fs::create_dir_all(skills.join("first")).unwrap();
    fs::write(skills.join("first/SKILL.md"), SKILL).unwrap();
    assert!(
        s.wait_changed_with("added", Duration::from_secs(10))
            .is_some(),
        "скил в пересозданном каталоге замечен"
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
        "и следующий скил тоже: подписка живая"
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
        "клиент, поставленный после запуска ядра, замечен"
    );
}

#[test]
fn client_directory_with_unwatched_parent_is_noticed() {
    // `.gemini/config` (Antigravity): родитель `.gemini` сам не слушается, пока его нет; Claude Desktop — то же с `AppData/Roaming`
    let aside = std::env::temp_dir().join(format!("loadout-aside-{}", std::process::id()));
    let _ = fs::remove_dir_all(&aside);
    let mut s = Server::start_with(|h| {
        copy_tree(&h.join(".gemini"), &aside, "");
        fs::remove_dir_all(h.join(".gemini")).unwrap();
    });
    // сначала появляется только родитель, `config` — позже: слушать нужно ближайшего существующего предка
    fs::create_dir_all(s.home.join(".gemini")).unwrap();
    std::thread::sleep(Duration::from_millis(800));
    copy_tree(&aside, &s.home.join(".gemini"), "");
    let ev = s.wait_changed_with("added", Duration::from_secs(10));
    let _ = fs::remove_dir_all(&aside);
    assert!(
        ev.is_some(),
        "Antigravity, поставленный после запуска ядра, замечен"
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
        "новая запись каталога удалённых плагинов замечена"
    );
}

#[test]
fn new_backup_file_changes_facts() {
    let mut s = Server::start();
    fs::write(s.home.join(".codex/config.toml.bak-extra"), "x").unwrap();
    assert!(
        s.wait_changed_with("factsChanged", Duration::from_secs(10))
            .is_some(),
        "новая резервная копия меняет факты"
    );
}

#[test]
fn invalid_utf8_line_does_not_kill_the_server() {
    let mut s = Server::start();
    let stdin = s.stdin.as_mut().unwrap();
    stdin.write_all(b"\xff\xfe{\n").unwrap();
    stdin.flush().unwrap();
    assert!(
        s.call("snapshot")["result"].is_object(),
        "процесс жив и отвечает"
    );
    assert!(
        s.parked.iter().any(|m| m["error"]["message"].is_string()),
        "битая строка получила ошибку: {:?}",
        s.parked
    );
}

#[test]
fn request_flood_does_not_postpone_the_rescan() {
    let mut s = Server::start();
    let cfg = s.home.join(".codex/config.toml");
    let text = fs::read_to_string(&cfg).unwrap();
    // очередь запросов не пустеет несколько секунд: скан обязан пройти по сроку, а не после неё
    let mut stdin = s.stdin.take().unwrap();
    let flood = std::thread::spawn(move || {
        let line = b"{\"id\":1,\"method\":\"status\"}\n".repeat(1000);
        for _ in 0..100 {
            if stdin.write_all(&line).is_err() {
                break;
            }
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
    let (c, l) = (
        changed_at.expect("`changed` пришёл"),
        last_at.expect("ответ на последний запрос пришёл"),
    );
    assert!(
        c < l,
        "`changed` (сообщение {c}) пришёл только после всего потока запросов (последний ответ {l})"
    );
}

#[test]
fn closing_stdin_stops_the_process() {
    let mut s = Server::start();
    s.stdin = None; // EOF
    let end = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = s.child.try_wait().unwrap() {
            assert!(status.success(), "выход по EOF без ошибки: {status}");
            return;
        }
        assert!(Instant::now() < end, "процесс пережил закрытие stdin");
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
    assert_eq!(plan["result"]["to"], "false", "{plan}");
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
    // `changed` приходит сразу после записи, не дожидаясь сторожа
    let ev = s
        .wait_method("changed", Duration::from_secs(5))
        .expect("changed после записи");
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
    assert!(s.call("snapshot")["result"].is_object(), "процесс жив");
}
