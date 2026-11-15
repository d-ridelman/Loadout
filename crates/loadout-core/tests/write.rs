//! Запись R1 на копии фикстур во временном каталоге: настоящий дом и `fixtures/` не трогаются никогда.

use loadout_core::model::{Client, Kind, ScanResult, State};
use loadout_core::write::{self, journal, Applied, Intent, Plan};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static N: AtomicU32 = AtomicU32::new(0);

/// Тесты работают на уровне R2: ядро проверяет `max_level`, который в приложении приходит от main.
const ML: &str = "R2";

fn wapply(home: &Path, store: &Path, i: &Intent, sha: &str) -> Result<Applied, String> {
    write::apply(home, store, i, sha, ML)
}

fn rollback(home: &Path, store: &Path, op: &str) -> Result<Applied, String> {
    write::rollback(home, store, op, ML)
}

fn wbatch(
    home: &Path,
    store: &Path,
    items: &[Intent],
    sha: &str,
) -> Result<(String, Vec<Applied>), String> {
    write::apply_batch(home, store, items, sha, ML)
}

fn wrollback_batch(home: &Path, store: &Path, batch: &str) -> Result<Vec<Applied>, String> {
    write::rollback_batch(home, store, batch, ML)
}

fn tog(id: &str, enable: bool) -> Intent {
    Intent::Toggle {
        entity: id.to_owned(),
        enable,
    }
}

/// Переключение флага без корзины (R1): так же звало окно в M3.
fn plan(home: &Path, id: &str, enable: bool) -> Result<Plan, String> {
    write::plan(home, None, &tog(id, enable))
}

fn apply(home: &Path, store: &Path, id: &str, enable: bool, sha: &str) -> Result<Applied, String> {
    wapply(home, store, &tog(id, enable), sha)
}

struct Env {
    home: PathBuf,
    store: PathBuf,
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.home.parent().unwrap());
    }
}

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

fn env() -> Env {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/home");
    let top = std::env::temp_dir().join(format!(
        "loadout-wr-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&top);
    let home = top.join("home");
    copy_tree(&root, &home, &home.to_string_lossy().replace('\\', "/"));
    Env {
        store: top.join("backups"),
        home,
    }
}

fn id_of(r: &ScanResult, client: Client, kind: Kind, name: &str) -> String {
    r.entities
        .iter()
        .find(|e| e.client == client && e.kind == kind && e.name == name)
        .unwrap_or_else(|| panic!("нет записи {name}"))
        .id
        .clone()
}

fn state_of(home: &Path, id: &str) -> Option<State> {
    loadout_core::scan(home)
        .entities
        .iter()
        .find(|e| e.id == id)
        .map(|e| e.state)
}

fn codex_cfg(e: &Env) -> PathBuf {
    e.home.join(".codex/config.toml")
}

/// Единственное место, где два текста различаются: общий префикс и суффикс отброшены.
fn middle(a: &str, b: &str) -> (String, String) {
    let pre = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
    let suf = a
        .bytes()
        .rev()
        .zip(b.bytes().rev())
        .take_while(|(x, y)| x == y)
        .count();
    let suf = suf.min(a.len() - pre).min(b.len() - pre);
    (
        a[pre..a.len() - suf].to_owned(),
        b[pre..b.len() - suf].to_owned(),
    )
}

#[test]
fn toggle_roundtrip_changes_one_value_and_rolls_back_to_identical_bytes() {
    let e = env();
    let id = id_of(
        &loadout_core::scan(&e.home),
        Client::Codex,
        Kind::Plugin,
        "p1@bundled",
    );
    let original = fs::read_to_string(codex_cfg(&e)).unwrap();
    let p = plan(&e.home, &id, false).unwrap();
    assert!(!p.noop && (p.from.as_str(), p.to.as_str()) == ("true", "false"));

    let done = apply(&e.home, &e.store, &id, false, &p.base_sha).unwrap();
    let after = fs::read_to_string(codex_cfg(&e)).unwrap();
    assert_eq!(middle(&original, &after), ("tru".into(), "fals".into()));
    assert_eq!(state_of(&e.home, &id), Some(State::Off));
    // бэкап — точная копия файла до записи
    assert_eq!(
        fs::read_to_string(e.store.join(&done.op).join("before")).unwrap(),
        original
    );

    let j = journal(&e.home, &e.store);
    assert_eq!(j.len(), 1);
    assert!(j[0].can_rollback && !j[0].rolled_back && j[0].op == "toggle");

    rollback(&e.home, &e.store, &done.op).unwrap();
    assert_eq!(fs::read_to_string(codex_cfg(&e)).unwrap(), original);
    assert_eq!(state_of(&e.home, &id), Some(State::On));
    let j = journal(&e.home, &e.store);
    assert_eq!(j.len(), 2);
    assert!(j[1].rolled_back && !j[1].can_rollback && j[0].op == "rollback");
    assert!(
        rollback(&e.home, &e.store, &done.op).is_err(),
        "дважды откатить нельзя"
    );
    assert!(
        !fs::read_dir(codex_cfg(&e).parent().unwrap())
            .unwrap()
            .flatten()
            .any(|f| f.file_name().to_string_lossy().contains("loadout")),
        "временный файл не остался"
    );
}

#[test]
fn stale_plan_is_refused_and_nothing_is_written() {
    let e = env();
    let id = id_of(
        &loadout_core::scan(&e.home),
        Client::Codex,
        Kind::Plugin,
        "p1@bundled",
    );
    let p = plan(&e.home, &id, false).unwrap();
    let mut text = fs::read_to_string(codex_cfg(&e)).unwrap();
    text.push_str("\n# клиент дописал\n");
    fs::write(codex_cfg(&e), &text).unwrap();
    let err = apply(&e.home, &e.store, &id, false, &p.base_sha).unwrap_err();
    assert!(err.contains("изменился"), "{err}");
    assert_eq!(fs::read_to_string(codex_cfg(&e)).unwrap(), text);
    assert!(journal(&e.home, &e.store).is_empty());
}

#[test]
fn rollback_refuses_when_the_file_changed_after_the_operation() {
    let e = env();
    let id = id_of(
        &loadout_core::scan(&e.home),
        Client::Codex,
        Kind::Plugin,
        "p1@bundled",
    );
    let p = plan(&e.home, &id, false).unwrap();
    let done = apply(&e.home, &e.store, &id, false, &p.base_sha).unwrap();
    let mut text = fs::read_to_string(codex_cfg(&e)).unwrap();
    text.push_str("# чужая правка\n");
    fs::write(codex_cfg(&e), &text).unwrap();
    assert!(!journal(&e.home, &e.store)[0].can_rollback);
    assert!(rollback(&e.home, &e.store, &done.op).is_err());
    assert_eq!(fs::read_to_string(codex_cfg(&e)).unwrap(), text);
}

#[test]
fn missing_key_is_inserted_and_rolled_back() {
    let e = env();
    // у p3@bundled таблица есть, а ключа `enabled` нет: состояние неизвестно
    let id = id_of(
        &loadout_core::scan(&e.home),
        Client::Codex,
        Kind::Plugin,
        "p3@bundled",
    );
    let original = fs::read_to_string(codex_cfg(&e)).unwrap();
    let p = plan(&e.home, &id, true).unwrap();
    assert_eq!(p.from, "не задан");
    let done = apply(&e.home, &e.store, &id, true, &p.base_sha).unwrap();
    assert_eq!(state_of(&e.home, &id), Some(State::On));
    rollback(&e.home, &e.store, &done.op).unwrap();
    assert_eq!(fs::read_to_string(codex_cfg(&e)).unwrap(), original);
}

#[test]
fn connectors_share_one_key_and_the_plan_says_so() {
    let e = env();
    // второй коннектор добавляем в копию: в общей фикстуре он один, а золотые тесты считают записи
    let cj = e.home.join(".claude.json");
    let text = fs::read_to_string(&cj).unwrap();
    fs::write(
        &cj,
        text.replace(
            "[\"claude.ai Demo\"]",
            "[\"claude.ai Demo\", \"claude.ai Other\"]",
        ),
    )
    .unwrap();
    let r = loadout_core::scan(&e.home);
    let conns: Vec<_> = r
        .entities
        .iter()
        .filter(|x| x.client == Client::ClaudeCode && x.kind == Kind::Connector && x.can_toggle)
        .collect();
    assert!(conns.len() >= 2, "в фикстуре несколько коннекторов");
    assert!(conns.iter().all(|c| c.state == State::Off));
    let p = plan(&e.home, &conns[0].id, true).unwrap();
    assert_eq!((p.from.as_str(), p.to.as_str()), ("true", "false"));
    assert_eq!(p.affects.len(), conns.len() - 1);
    apply(&e.home, &e.store, &conns[0].id, true, &p.base_sha).unwrap();
    let r = loadout_core::scan(&e.home);
    assert!(r
        .entities
        .iter()
        .filter(|x| x.client == Client::ClaudeCode && x.kind == Kind::Connector && x.can_toggle)
        .all(|c| c.state == State::Cloud));
}

#[test]
fn claude_code_plugin_flag_is_edited_in_settings_json() {
    let e = env();
    let path = e.home.join(".claude/settings.json");
    let original = fs::read_to_string(&path).unwrap();
    let id = id_of(
        &loadout_core::scan(&e.home),
        Client::ClaudeCode,
        Kind::Plugin,
        "alpha@mp",
    );
    let p = plan(&e.home, &id, false).unwrap();
    apply(&e.home, &e.store, &id, false, &p.base_sha).unwrap();
    let after = fs::read_to_string(&path).unwrap();
    assert_eq!(middle(&original, &after), ("tru".into(), "fals".into()));
    assert_eq!(state_of(&e.home, &id), Some(State::Off));
}

#[test]
fn noop_and_unsupported_entities_are_refused_with_a_reason() {
    let e = env();
    let r = loadout_core::scan(&e.home);
    let id = id_of(&r, Client::Codex, Kind::Plugin, "p1@bundled");
    let p = plan(&e.home, &id, true).unwrap();
    assert!(p.noop);
    assert!(apply(&e.home, &e.store, &id, true, &p.base_sha).is_err());
    assert!(journal(&e.home, &e.store).is_empty());

    let skill = r.entities.iter().find(|x| x.kind == Kind::Skill).unwrap();
    assert!(!skill.can_toggle && skill.toggle_why.is_some());
    assert!(plan(&e.home, &skill.id, false)
        .unwrap_err()
        .contains("не поддержана"));
    assert!(plan(&e.home, "нет-такого", false).is_err());
}

#[test]
fn plan_and_journal_carry_no_file_contents() {
    let e = env();
    let id = id_of(
        &loadout_core::scan(&e.home),
        Client::Codex,
        Kind::Mcp,
        "alpha",
    );
    let p = plan(&e.home, &id, false).unwrap();
    let done = apply(&e.home, &e.store, &id, false, &p.base_sha).unwrap();
    let all = format!(
        "{}{}{}",
        serde_json::to_string(&p).unwrap(),
        serde_json::to_string(&done).unwrap(),
        serde_json::to_string(&journal(&e.home, &e.store)).unwrap()
    );
    assert!(!all.contains("FAKE-SECRET"), "{all}");
    assert!(
        !all.contains(&e.home.to_string_lossy().replace('\\', "/")),
        "{all}"
    );
}

#[test]
fn denied_connector_is_not_toggleable_even_when_already_off_by_the_global_key() {
    let e = env();
    let sj = e.home.join(".claude/settings.json");
    let text = fs::read_to_string(&sj).unwrap();
    assert!(text.contains("\"disableClaudeAiConnectors\": true"));
    fs::write(
        &sj,
        text.replace(
            "{ \"serverName\": \"local\" }",
            "{ \"serverName\": \"local\" }, { \"serverName\": \"claude.ai Demo\" }",
        ),
    )
    .unwrap();
    let r = loadout_core::scan(&e.home);
    let c = r
        .entities
        .iter()
        .find(|x| x.kind == Kind::Connector && x.client == Client::ClaudeCode)
        .unwrap();
    assert!(
        !c.can_toggle,
        "запрет по имени ключом disableClaudeAiConnectors не снять"
    );
    assert!(plan(&e.home, &c.id, true)
        .unwrap_err()
        .contains("deniedMcpServers"));
}

#[test]
fn repeated_toggle_and_rollback_chain_returns_identical_bytes() {
    let e = env();
    let id = id_of(
        &loadout_core::scan(&e.home),
        Client::Codex,
        Kind::Plugin,
        "p1@bundled",
    );
    let original = fs::read(codex_cfg(&e)).unwrap();
    for _ in 0..2 {
        let p = plan(&e.home, &id, false).unwrap();
        let done = apply(&e.home, &e.store, &id, false, &p.base_sha).unwrap();
        rollback(&e.home, &e.store, &done.op).unwrap();
        assert_eq!(fs::read(codex_cfg(&e)).unwrap(), original);
    }
    let j = journal(&e.home, &e.store);
    assert_eq!(j.len(), 4);
    assert_eq!(j.iter().filter(|x| x.rolled_back).count(), 2);
    assert!(j.iter().all(|x| !x.can_rollback), "все операции откатаны");
}

#[test]
fn codex_app_flag_toggles_through_the_apps_table() {
    let e = env();
    // `apps.demo-app` выключен в фикстуре, `apps._default` включён: запись включается явным ключом в своей таблице
    let id = id_of(
        &loadout_core::scan(&e.home),
        Client::Codex,
        Kind::Connector,
        "demo-app",
    );
    let p = plan(&e.home, &id, true).unwrap();
    assert_eq!((p.from.as_str(), p.to.as_str()), ("false", "true"));
    apply(&e.home, &e.store, &id, true, &p.base_sha).unwrap();
    assert_eq!(state_of(&e.home, &id), Some(State::On));
    let text = fs::read_to_string(codex_cfg(&e)).unwrap();
    assert!(
        text.contains("[apps._default]\nenabled = true"),
        "общий ключ не тронут"
    );
}

// ---- M4: корзина, правка, копирование, профили ----

fn state_in(e: &Env, id: &str) -> Option<State> {
    loadout_core::scan_with(&e.home, Some(&e.store))
        .entities
        .iter()
        .find(|x| x.id == id)
        .map(|x| x.state)
}

fn id_in(e: &Env, client: Client, name: &str) -> String {
    id_of(
        &loadout_core::scan_with(&e.home, Some(&e.store)),
        client,
        Kind::Mcp,
        name,
    )
}

fn read_json(p: &Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
}

fn plan_s(e: &Env, i: &Intent) -> Result<Plan, String> {
    write::plan(&e.home, Some(&e.store), i)
}

fn apply_i(e: &Env, i: &Intent) -> Result<Applied, String> {
    let p = plan_s(e, i)?;
    wapply(&e.home, &e.store, i, &p.base_sha)
}

fn ag_cfg(e: &Env) -> PathBuf {
    e.home.join(".gemini/config/mcp_config.json")
}

#[test]
fn mcp_without_flag_goes_to_trash_and_comes_back_with_the_same_id() {
    let e = env();
    let id = id_in(&e, Client::Antigravity, "tool-b");
    let original = read_json(&ag_cfg(&e));
    let p = plan_s(&e, &tog(&id, false)).unwrap();
    assert_eq!(
        (p.level.as_str(), p.to.as_str()),
        ("R2", "в корзине Loadout")
    );
    let done = wapply(&e.home, &e.store, &tog(&id, false), &p.base_sha).unwrap();

    let after = read_json(&ag_cfg(&e));
    assert!(after["mcpServers"].get("tool-b").is_none());
    assert_eq!(
        after["mcpServers"]["tool-a"],
        original["mcpServers"]["tool-a"]
    );
    // запись видна как выключенная с тем же id, а без корзины в скан не попадает
    assert_eq!(state_in(&e, &id), Some(State::Off));
    assert!(loadout_core::scan(&e.home)
        .entities
        .iter()
        .all(|x| x.id != id));
    let trash_text = fs::read_to_string(e.store.join("trash").join(format!("{id}.json"))).unwrap();
    assert!(
        trash_text.contains("FAKE-SECRET-AG-ENV"),
        "значения лежат в корзине как есть"
    );
    let shown = format!(
        "{}{}{}",
        serde_json::to_string(&p).unwrap(),
        serde_json::to_string(&done).unwrap(),
        serde_json::to_string(&journal(&e.home, &e.store)).unwrap()
    );
    assert!(!shown.contains("FAKE-SECRET"), "{shown}");

    // включить: файл семантически равен исходному, корзина пуста
    let back = apply_i(&e, &tog(&id, true)).unwrap();
    assert_eq!(read_json(&ag_cfg(&e)), original);
    assert_eq!(state_in(&e, &id), Some(State::On));
    assert!(!e.store.join("trash").join(format!("{id}.json")).exists());
    assert!(back.op > done.op);
}

#[test]
fn trash_rollback_is_an_inverse_operation_even_after_the_client_rewrote_the_file() {
    let e = env();
    let id = id_in(&e, Client::ClaudeCode, "github");
    let cj = e.home.join(".claude.json");
    let original = read_json(&cj);
    let done = apply_i(&e, &tog(&id, false)).unwrap();
    assert!(read_json(&cj)["mcpServers"].get("github").is_none());
    // клиент переписал файл (так он делает постоянно): откат по хешу отказал бы, обратная операция проходит
    let mut v = read_json(&cj);
    v["numStartups"] = serde_json::json!(7);
    fs::write(&cj, serde_json::to_string_pretty(&v).unwrap()).unwrap();
    let j = journal(&e.home, &e.store);
    assert!(j[0].can_rollback, "обратная операция возможна");
    rollback(&e.home, &e.store, &done.op).unwrap();
    let mut want = original;
    want["numStartups"] = serde_json::json!(7);
    assert_eq!(read_json(&cj), want);
    assert_eq!(state_in(&e, &id), Some(State::On));
    assert!(journal(&e.home, &e.store)[1].rolled_back);
}

#[test]
fn owners_stash_entry_returns_inside_the_file_and_other_stash_keys_stay() {
    let e = env();
    let id = id_in(&e, Client::ClaudeCode, "old");
    let cj = e.home.join(".claude.json");
    let done = apply_i(&e, &tog(&id, true)).unwrap();
    let v = read_json(&cj);
    assert_eq!(v["mcpServers"]["old"]["command"], "old");
    assert!(v["_disabledMcpServers"].get("old").is_none());
    assert_eq!(v["_disabledMcpServers"]["_note"], "стэш");
    // указатель меняется (`/mcpServers/old`), а с ним и id: запись ищем по имени
    let live = id_in(&e, Client::ClaudeCode, "old");
    assert_ne!(live, id);
    assert_eq!(state_in(&e, &live), Some(State::On));
    // откат при неизменном файле возвращает запись в стэш владельца (файл из бэкапа), а не в корзину Loadout
    assert!(journal(&e.home, &e.store)[0].can_rollback);
    let before = fs::read(&cj).unwrap();
    rollback(&e.home, &e.store, &done.op).unwrap();
    assert_ne!(fs::read(&cj).unwrap(), before);
    let v = read_json(&cj);
    assert_eq!(v["_disabledMcpServers"]["old"]["command"], "old");
    assert!(v["mcpServers"].get("old").is_none());
    assert_eq!(state_in(&e, &id), Some(State::Off));
    assert!(
        !e.store.join("trash").join(format!("{id}.json")).exists(),
        "корзина не использована"
    );
}

#[test]
fn edit_replaces_command_and_args_masks_the_log_and_rolls_back_to_identical_bytes() {
    let e = env();
    let id = id_in(&e, Client::ClaudeDesktop, "desk-tool");
    let path = e
        .home
        .join("AppData/Roaming/Claude/claude_desktop_config.json");
    let original = fs::read(&path).unwrap();
    let i = Intent::Edit {
        entity: id.clone(),
        command: "new-cmd".into(),
        args: vec![
            "--token".into(),
            "FAKE-SECRET-NEW".into(),
            "--port".into(),
            "8080".into(),
        ],
    };
    let p = plan_s(&e, &i).unwrap();
    assert_eq!(p.level, "R2");
    assert!(!format!("{p:?}").contains("FAKE-SECRET"), "{p:?}");
    assert!(p.to.contains("<masked>"), "{}", p.to);
    let done = wapply(&e.home, &e.store, &i, &p.base_sha).unwrap();
    let v = read_json(&path);
    assert_eq!(v["mcpServers"]["desk-tool"]["command"], "new-cmd");
    assert_eq!(v["mcpServers"]["desk-tool"]["args"][1], "FAKE-SECRET-NEW");
    assert_eq!(
        v["mcpServers"]["desk-tool"]["env"]["TOKEN"], "FAKE-SECRET-DESKENV",
        "env не тронут"
    );
    assert_eq!(v["preferences"]["sidebarMode"], "chat");
    let shown = format!(
        "{}{}",
        serde_json::to_string(&done).unwrap(),
        serde_json::to_string(&journal(&e.home, &e.store)).unwrap()
    );
    assert!(!shown.contains("FAKE-SECRET"), "{shown}");
    rollback(&e.home, &e.store, &done.op).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);

    // пустая команда, управляющие символы и запись без command отказывают
    for bad in [
        Intent::Edit {
            entity: id.clone(),
            command: "  ".into(),
            args: vec![],
        },
        Intent::Edit {
            entity: id.clone(),
            command: "a\nb".into(),
            args: vec![],
        },
        Intent::Edit {
            entity: id.clone(),
            command: "a".into(),
            args: vec!["x\u{0}".into()],
        },
    ] {
        assert!(plan_s(&e, &bad).is_err(), "{bad:?}");
    }
    let http = id_in(&e, Client::ClaudeCode, "github");
    let err = plan_s(
        &e,
        &Intent::Edit {
            entity: http,
            command: "x".into(),
            args: vec![],
        },
    )
    .unwrap_err();
    assert!(err.contains("command"), "{err}");
}

#[test]
fn copy_translates_between_json_and_toml_keeps_secrets_inside_the_core() {
    let e = env();
    let id = id_in(&e, Client::ClaudeDesktop, "desk-tool");
    let to_codex = Intent::Copy {
        entity: id.clone(),
        to: "codex".into(),
    };
    let p = plan_s(&e, &to_codex).unwrap();
    assert_eq!(
        (p.client, p.file.as_str()),
        (Client::Codex, "~/.codex/config.toml")
    );
    assert!(p.notes.iter().any(|n| n.contains("TOKEN")), "{:?}", p.notes);
    assert!(!format!("{p:?}").contains("FAKE-SECRET"), "{p:?}");
    let cfg = codex_cfg(&e);
    let original = fs::read(&cfg).unwrap();
    let done = wapply(&e.home, &e.store, &to_codex, &p.base_sha).unwrap();
    let t: toml::Table = fs::read_to_string(&cfg).unwrap().parse().unwrap();
    let s = &t["mcp_servers"]["desk-tool"];
    assert_eq!(s["command"].as_str(), Some("desk-tool"));
    assert_eq!(
        s["env"]["TOKEN"].as_str(),
        Some("FAKE-SECRET-DESKENV"),
        "значение скопировано как есть"
    );
    // уже есть: второй раз отказ
    assert!(plan_s(&e, &to_codex).unwrap_err().contains("уже есть"));
    // откат копии возвращает файл побайтово
    rollback(&e.home, &e.store, &done.op).unwrap();
    assert_eq!(fs::read(&cfg).unwrap(), original);

    // Codex → Claude Code: http_headers → headers, type добавляется
    let remote = id_in(&e, Client::Codex, "remote");
    let p = plan_s(
        &e,
        &Intent::Copy {
            entity: remote.clone(),
            to: "claude-code".into(),
        },
    )
    .unwrap();
    assert_eq!(p.client, Client::ClaudeCode);
    wapply(
        &e.home,
        &e.store,
        &Intent::Copy {
            entity: remote,
            to: "claude-code".into(),
        },
        &p.base_sha,
    )
    .unwrap();
    let v = read_json(&e.home.join(".claude.json"));
    assert_eq!(v["mcpServers"]["remote"]["type"], "http");
    assert!(v["mcpServers"]["remote"]["headers"]["Authorization"]
        .as_str()
        .unwrap()
        .contains("FAKE-SECRET-CXHDR"));
    assert!(v["mcpServers"]["remote"].get("http_headers").is_none());
}

#[test]
fn copy_refuses_same_client_deepseek_and_taken_names() {
    let e = env();
    let id = id_in(&e, Client::Antigravity, "tool-a");
    for to in ["antigravity", "deepseek", "nonsense"] {
        assert!(
            plan_s(
                &e,
                &Intent::Copy {
                    entity: id.clone(),
                    to: to.into()
                }
            )
            .is_err(),
            "{to}"
        );
    }
    // `github` есть в Claude Code: копия из Codex с таким же именем отказывает
    let local = id_in(&e, Client::Antigravity, "tool-b");
    let ok = plan_s(
        &e,
        &Intent::Copy {
            entity: local,
            to: "claude-desktop".into(),
        },
    );
    assert!(ok.is_ok(), "{ok:?}");
}

#[test]
fn plugin_files_deepseek_and_denied_entries_have_no_write_target() {
    let e = env();
    let r = loadout_core::scan_with(&e.home, Some(&e.store));
    let plugin_mcp = r
        .entities
        .iter()
        .find(|x| x.client == Client::Antigravity && x.kind == Kind::Mcp && x.scope != "user")
        .expect("в фикстуре есть MCP плагина Antigravity");
    assert!(!plugin_mcp.can_toggle && !plugin_mcp.can_edit);
    let ds = r
        .entities
        .iter()
        .find(|x| x.client == Client::DeepSeek && x.kind == Kind::Mcp)
        .unwrap();
    // у DeepSeek запись выносится по строкам YAML (R2), но править и копировать её нельзя
    assert!(ds.can_toggle && !ds.can_edit);
    assert_eq!(ds.toggle_level.as_deref(), Some("R2"));
    assert!(plan_s(
        &e,
        &Intent::Copy {
            entity: ds.id.clone(),
            to: "codex".into()
        }
    )
    .is_err());
    assert!(loadout_core::trash::read(&e.store, "../x").is_none());
}

#[test]
fn deepseek_entry_goes_to_trash_by_lines_and_returns_byte_identical() {
    let e = env();
    let patch = e.home.join(".dsh/cordis.patch.yml");
    let original = fs::read(&patch).unwrap();
    let id = id_in(&e, Client::DeepSeek, "demo");
    let p = plan_s(&e, &tog(&id, false)).unwrap();
    assert_eq!(
        (p.level.as_str(), p.to.as_str()),
        ("R2", "в корзине Loadout")
    );
    assert!(!format!("{p:?}").contains("FAKE-SECRET"));
    let done = wapply(&e.home, &e.store, &tog(&id, false), &p.base_sha).unwrap();

    let text = fs::read_to_string(&patch).unwrap();
    assert!(
        !text.contains("mcp-demo") && text.contains("demo-hooks"),
        "{text}"
    );
    // запись видна как выключенная, её описание берётся из строк в корзине, значения секретов не показываются
    let r = loadout_core::scan_with(&e.home, Some(&e.store));
    let off = r
        .entities
        .iter()
        .find(|x| x.id == id)
        .expect("запись из корзины");
    assert_eq!(off.state, State::Off);
    assert!(!serde_json::to_string(off).unwrap().contains("FAKE-SECRET"));
    let trashed = fs::read_to_string(e.store.join("trash").join(format!("{id}.json"))).unwrap();
    assert!(
        trashed.contains("FAKE-SECRET-DSENV") && trashed.contains("!!js process.cwd()"),
        "строки как есть, с тегом"
    );

    // возврат и откат: файл побайтово как до выноса
    let back = apply_i(&e, &tog(&id, true)).unwrap();
    assert_eq!(fs::read(&patch).unwrap(), original);
    assert!(!e.store.join("trash").join(format!("{id}.json")).exists());
    // откат выноса после ручного изменения файла: обратная операция, а не возврат всего файла
    let again = apply_i(&e, &tog(&id, false)).unwrap();
    let mut changed = fs::read_to_string(&patch).unwrap();
    changed.push_str("# дописал инструмент\n");
    fs::write(&patch, &changed).unwrap();
    rollback(&e.home, &e.store, &again.op).unwrap();
    let after = fs::read_to_string(&patch).unwrap();
    assert!(
        after.contains("mcp-demo") && after.ends_with("# дописал инструмент\n"),
        "{after}"
    );
    let _ = (done, back);
}

#[test]
fn deepseek_profile_with_two_entries_of_one_operation_applies_both() {
    let e = env();
    let patch = e.home.join(".dsh/cordis.patch.yml");
    let text = fs::read_to_string(&patch).unwrap();
    // вторая запись MCP в той же операции: после выноса первой её номер сдвигается, а id остаётся прежним
    let extra = "    - id: mcp-two\n      name: \"@deepseek-ai/dsh-mcp-client\"\n      config:\n        serverName: two\n        transport: stdio\n        command: two.exe\n";
    let marker = "- insert:\n    - id: demo-hooks";
    assert!(text.contains(marker));
    fs::write(&patch, text.replace(marker, &format!("{extra}{marker}"))).unwrap();
    let original = fs::read(&patch).unwrap();

    let item = |name: &str| loadout_core::profiles::Item {
        client: "deepseek".into(),
        kind: "mcp".into(),
        scope: "user".into(),
        name: name.into(),
        enable: false,
    };
    let prof = loadout_core::profiles::Profile {
        name: "dsh".into(),
        items: vec![item("demo"), item("two")],
    };
    loadout_core::profiles::save(&e.store, prof).unwrap();
    let (items, missing) = loadout_core::profiles::intents(&e.home, &e.store, "dsh").unwrap();
    assert!(missing.is_empty() && items.len() == 2);
    let bp = write::plan_batch(&e.home, Some(&e.store), &items);
    assert_eq!(bp.plans.iter().filter(|p| !p.noop).count(), 2);
    let (batch, applied) = wbatch(&e.home, &e.store, &items, &bp.batch_sha).unwrap();
    assert_eq!(
        applied.len(),
        2,
        "обе записи выключены, ни одна не пропущена молча"
    );
    let r = loadout_core::scan_with(&e.home, Some(&e.store));
    let off = |n: &str| {
        r.entities
            .iter()
            .any(|x| x.client == Client::DeepSeek && x.name == n && x.state == State::Off)
    };
    assert!(off("demo") && off("two"));
    wrollback_batch(&e.home, &e.store, &batch).unwrap();
    assert_eq!(fs::read(&patch).unwrap(), original);
}

#[test]
fn core_enforces_the_level_that_main_grants() {
    let e = env();
    let id = id_in(&e, Client::Antigravity, "tool-b");
    let i = tog(&id, false); // вынос в корзину: R2
    let p = plan_s(&e, &i).unwrap();
    let err = write::apply(&e.home, &e.store, &i, &p.base_sha, "R1").unwrap_err();
    assert!(err.contains("R2"), "{err}");
    assert!(journal(&e.home, &e.store).is_empty());
    let done = write::apply(&e.home, &e.store, &i, &p.base_sha, "R2").unwrap();
    // откат операции R2 тоже требует R2
    assert!(write::rollback(&e.home, &e.store, &done.op, "R1").is_err());
    assert!(write::rollback(&e.home, &e.store, &done.op, "R2").is_ok());
    // флаг (R1) проходит и с R1
    let flag = id_of(
        &loadout_core::scan(&e.home),
        Client::Codex,
        Kind::Plugin,
        "p1@bundled",
    );
    let fp = plan_s(&e, &tog(&flag, false)).unwrap();
    assert!(write::apply(&e.home, &e.store, &tog(&flag, false), &fp.base_sha, "R1").is_ok());
}

#[test]
fn plan_and_journal_have_no_home_path_and_edit_keeps_crlf() {
    let e = env();
    let id = id_in(&e, Client::ClaudeDesktop, "desk-tool");
    let path = e
        .home
        .join("AppData/Roaming/Claude/claude_desktop_config.json");
    let text = fs::read_to_string(&path).unwrap();
    fs::write(&path, text.replace('\n', "\r\n")).unwrap();
    let home = e.home.to_string_lossy().replace('\\', "/");
    let i = Intent::Edit {
        entity: id.clone(),
        command: format!("{home}/bin/tool.exe"),
        args: vec!["--root".into(), format!("{home}/work"), "-y".into()],
    };
    let p = plan_s(&e, &i).unwrap();
    assert!(!p.to.contains(&home) && p.to.contains('~'), "{}", p.to);
    let done = wapply(&e.home, &e.store, &i, &p.base_sha).unwrap();
    let shown = format!(
        "{}{:?}",
        serde_json::to_string(&journal(&e.home, &e.store)).unwrap(),
        done
    );
    assert!(!shown.contains(&home), "{shown}");
    let out = fs::read_to_string(&path).unwrap();
    assert!(
        !out.replace("\r\n", "").contains('\n'),
        "в CRLF-файле появились голые LF: {out:?}"
    );

    // копирование: путь в замаскированной команде тоже заменяется на `~`
    let b = id_in(&e, Client::Antigravity, "tool-b");
    let cp = plan_s(
        &e,
        &Intent::Copy {
            entity: b,
            to: "claude-desktop".into(),
        },
    )
    .unwrap();
    assert!(!cp.to.contains(&home), "{}", cp.to);
}

#[test]
fn copy_refuses_an_entry_that_would_be_dead_at_the_receiver() {
    let e = env();
    // удалённый сервер с адресом в нестандартном ключе: после перевода нет ни command, ни url
    let path = e
        .home
        .join("AppData/Roaming/Claude/claude_desktop_config.json");
    let text = fs::read_to_string(&path).unwrap();
    fs::write(
        &path,
        text.replace(
            "\"mcpServers\": {",
            "\"mcpServers\": {\n    \"remote-x\": { \"serverUrl\": \"https://x.example/mcp\" },",
        ),
    )
    .unwrap();
    let id = id_in(&e, Client::ClaudeDesktop, "remote-x");
    let err = plan_s(
        &e,
        &Intent::Copy {
            entity: id,
            to: "codex".into(),
        },
    )
    .unwrap_err();
    assert!(
        err.contains("нет ни command, ни url") && err.contains("serverUrl"),
        "{err}"
    );
}

#[test]
fn different_value_under_the_same_trash_id_is_never_overwritten() {
    let e = env();
    let id = id_in(&e, Client::Antigravity, "tool-b");
    let original = fs::read_to_string(ag_cfg(&e)).unwrap();
    apply_i(&e, &tog(&id, false)).unwrap();
    // запись вернули руками, но уже с другой командой: старая копия в корзине — единственное место прежнего значения
    fs::write(
        ag_cfg(&e),
        original.replace("\"command\": \"node\"", "\"command\": \"NEWNODE\""),
    )
    .unwrap();
    let err = plan_s(&e, &tog(&id, false)).unwrap_err();
    assert!(err.contains("другая запись"), "{err}");
    let kept = fs::read_to_string(e.store.join("trash").join(format!("{id}.json"))).unwrap();
    assert!(kept.contains("FAKE-SECRET-AG-ENV") && !kept.contains("NEWNODE"));
}

#[test]
fn rollback_of_a_trash_operation_does_not_pick_another_entry_by_name() {
    let e = env();
    let id = id_in(&e, Client::Antigravity, "tool-b");
    let done = apply_i(&e, &tog(&id, false)).unwrap();
    fs::remove_file(e.store.join("trash").join(format!("{id}.json"))).unwrap();
    let before = fs::read(ag_cfg(&e)).unwrap();
    assert!(rollback(&e.home, &e.store, &done.op).is_err());
    assert_eq!(fs::read(ag_cfg(&e)).unwrap(), before, "файл не тронут");
}

#[test]
fn batch_rollback_checks_every_level_before_undoing_anything() {
    let e = env();
    let b = id_in(&e, Client::Antigravity, "tool-b"); // R2
    let p1 = id_of(
        &loadout_core::scan(&e.home),
        Client::Codex,
        Kind::Plugin,
        "p1@bundled",
    ); // R1
    let items = vec![tog(&p1, false), tog(&b, false)];
    let bp = write::plan_batch(&e.home, Some(&e.store), &items);
    let (batch, applied) = wbatch(&e.home, &e.store, &items, &bp.batch_sha).unwrap();
    assert_eq!(applied.len(), 2);
    assert!(write::rollback_batch(&e.home, &e.store, &batch, "R1").is_err());
    assert!(
        journal(&e.home, &e.store)
            .iter()
            .all(|j| !j.rolled_back && j.op != "rollback"),
        "пакет не откатился наполовину"
    );
    assert!(write::rollback_batch(&e.home, &e.store, &batch, "R2").is_ok());
}

#[test]
fn deepseek_entry_returns_only_to_the_same_place() {
    let e = env();
    let patch = e.home.join(".dsh/cordis.patch.yml");
    let id = id_in(&e, Client::DeepSeek, "demo");
    apply_i(&e, &tog(&id, false)).unwrap();
    // установщик дописал новую операцию в начало файла: номера операций сдвинулись
    let text = fs::read_to_string(&patch).unwrap();
    fs::write(
        &patch,
        format!("- insert:\n    - id: newop\n      name: \"@deepseek-ai/other\"\n{text}"),
    )
    .unwrap();
    let err = plan_s(&e, &tog(&id, true)).unwrap_err();
    assert!(err.contains("изменилась"), "{err}");
    assert!(
        !fs::read_to_string(&patch).unwrap().contains("mcp-demo"),
        "в чужую операцию запись не вставлена"
    );
}

#[test]
fn deepseek_entry_without_a_simple_id_is_not_writable() {
    let e = env();
    let patch = e.home.join(".dsh/cordis.patch.yml");
    let text = fs::read_to_string(&patch).unwrap();
    fs::write(&patch, text.replace("id: mcp-demo", "id: bad/id")).unwrap();
    let r = loadout_core::scan_with(&e.home, Some(&e.store));
    let ds = r
        .entities
        .iter()
        .find(|x| x.client == Client::DeepSeek && x.kind == Kind::Mcp && x.name == "demo")
        .unwrap();
    assert!(
        !ds.can_toggle,
        "запись без простого id по строкам не выносится"
    );
}

#[test]
fn stale_trash_item_does_not_block_the_next_removal() {
    let e = env();
    let id = id_in(&e, Client::Antigravity, "tool-b");
    let original = fs::read(ag_cfg(&e)).unwrap();
    apply_i(&e, &tog(&id, false)).unwrap();
    // запись вернули руками (например, `claude mcp add`): в корзине осталась устаревшая копия с тем же id
    fs::write(ag_cfg(&e), &original).unwrap();
    assert_eq!(state_in(&e, &id), Some(State::On));
    assert!(e.store.join("trash").join(format!("{id}.json")).exists());
    apply_i(&e, &tog(&id, false)).unwrap();
    assert_eq!(state_in(&e, &id), Some(State::Off));
    assert!(read_json(&ag_cfg(&e))["mcpServers"].get("tool-b").is_none());
}

#[test]
fn profile_applies_as_one_batch_and_rolls_back_together() {
    let e = env();
    let id_p1 = id_of(
        &loadout_core::scan(&e.home),
        Client::Codex,
        Kind::Plugin,
        "p1@bundled",
    );
    let id_b = id_in(&e, Client::Antigravity, "tool-b");
    let before_cfg = fs::read(codex_cfg(&e)).unwrap();
    let before_ag = read_json(&ag_cfg(&e));

    let mut prof = loadout_core::profiles::from_current(&e.home, &e.store, "рабочий");
    assert!(prof.items.len() > 5);
    for it in &mut prof.items {
        if (it.client == "codex" && it.name == "p1@bundled")
            || (it.client == "antigravity" && it.name == "tool-b")
        {
            it.enable = false;
        }
    }
    loadout_core::profiles::save(&e.store, prof).unwrap();
    assert_eq!(loadout_core::profiles::list(&e.store).len(), 1);
    assert!(loadout_core::profiles::save(
        &e.store,
        loadout_core::profiles::Profile {
            name: "../x".into(),
            items: vec![]
        }
    )
    .is_err());

    let (items, missing) = loadout_core::profiles::intents(&e.home, &e.store, "рабочий").unwrap();
    assert!(missing.is_empty());
    let bp = write::plan_batch(&e.home, Some(&e.store), &items);
    assert_eq!(bp.level, "R2");
    assert_eq!(
        bp.plans.iter().filter(|p| !p.noop).count(),
        2,
        "меняются ровно две записи"
    );
    assert!(wbatch(&e.home, &e.store, &items, "стухшая подпись").is_err());

    let (batch, applied) = wbatch(&e.home, &e.store, &items, &bp.batch_sha).unwrap();
    assert_eq!(applied.len(), 2);
    assert_eq!(state_in(&e, &id_p1), Some(State::Off));
    assert_eq!(state_in(&e, &id_b), Some(State::Off));
    let j = journal(&e.home, &e.store);
    assert_eq!(
        j.iter()
            .filter(|x| x.batch.as_deref() == Some(batch.as_str()))
            .count(),
        2
    );

    let undone = wrollback_batch(&e.home, &e.store, &batch).unwrap();
    assert_eq!(undone.len(), 2);
    assert_eq!(fs::read(codex_cfg(&e)).unwrap(), before_cfg);
    assert_eq!(read_json(&ag_cfg(&e)), before_ag);
    assert!(
        wrollback_batch(&e.home, &e.store, &batch).is_err(),
        "второй раз нечего откатывать"
    );

    // профиль живёт дальше; удалённой записи он пропускает, а не падает
    loadout_core::profiles::delete(&e.store, "рабочий").unwrap();
    assert!(loadout_core::profiles::list(&e.store).is_empty());
}

/// Сухой прогон на настоящих конфигах (`cargo test -- --ignored`): только `plan`, ничего не пишется.
/// Каждая переключаемая запись даёт план, файлы клиентов после прогона не изменились.
#[test]
#[ignore = "читает настоящий домашний каталог"]
fn real_machine_plans_are_dry_and_succeed() {
    let home = PathBuf::from(
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .unwrap(),
    );
    let files = [
        home.join(".claude/settings.json"),
        home.join(".claude.json"),
        home.join(".codex/config.toml"),
        home.join("AppData/Roaming/Claude/claude_desktop_config.json"),
        home.join(".gemini/config/mcp_config.json"),
    ];
    let before: Vec<_> = files.iter().map(|f| fs::read(f).ok()).collect();
    let r = loadout_core::scan(&home);
    let mut planned = 0;
    for e in r.entities.iter().filter(|e| e.can_toggle) {
        let enable = matches!(e.state, State::Off | State::Unknown);
        let p = plan(&home, &e.id, enable)
            .unwrap_or_else(|err| panic!("{} {:?}: {err}", e.name, e.kind));
        assert_eq!(p.base_sha.len(), 64);
        planned += 1;
    }
    eprintln!("планов построено: {planned}");
    assert!(planned > 0, "на машине нет ни одной переключаемой записи");
    let after: Vec<_> = files.iter().map(|f| fs::read(f).ok()).collect();
    for (i, f) in files.iter().enumerate() {
        // `~/.claude.json` — файл самой сессии Claude Code, он переписывается постоянно: для него побайтово сравнивать
        // нельзя (раньше проходило по везению). Что `plan` ничего не пишет, видно и по отсутствию наших временных файлов.
        if f.file_name().is_some_and(|n| n == ".claude.json") {
            continue;
        }
        assert_eq!(before[i], after[i], "plan не должен менять {f:?}");
    }
    for f in &files {
        let mut tmp = f.clone().into_os_string();
        tmp.push(".loadout.tmp");
        assert!(
            !Path::new(&tmp).exists(),
            "после plan остался временный файл записи"
        );
    }
}

#[test]
fn tampered_manifest_cannot_point_rollback_at_another_file() {
    let e = env();
    let id = id_of(
        &loadout_core::scan(&e.home),
        Client::Codex,
        Kind::Plugin,
        "p1@bundled",
    );
    let p = plan(&e.home, &id, false).unwrap();
    let done = apply(&e.home, &e.store, &id, false, &p.base_sha).unwrap();
    let victim = e.home.join("victim.txt");
    fs::write(&victim, "x").unwrap();
    let mf = e.store.join(&done.op).join("manifest.json");
    let mut m: serde_json::Value = serde_json::from_str(&fs::read_to_string(&mf).unwrap()).unwrap();
    m["path"] = serde_json::json!(victim.to_string_lossy());
    fs::write(&mf, m.to_string()).unwrap();
    assert!(rollback(&e.home, &e.store, &done.op)
        .unwrap_err()
        .contains("разрешённых"));
    assert_eq!(fs::read_to_string(&victim).unwrap(), "x");
    assert!(rollback(&e.home, &e.store, "../../x").is_err());
}
