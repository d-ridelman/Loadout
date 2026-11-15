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

    /// `prep` правит копию фикстуры до запуска ядра (например, убирает каталог клиента).
    fn start_with(prep: impl FnOnce(&Path)) -> Server {
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

        let mut child = Command::new(env!("CARGO_BIN_EXE_loadout"))
            .args(["serve", "--home"])
            .arg(&home)
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
        let id = self.next_id;
        self.next_id += 1;
        let line = json!({ "id": id, "method": method }).to_string();
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
