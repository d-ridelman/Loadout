//! Запись R1 на копии фикстур во временном каталоге: настоящий дом и `fixtures/` не трогаются никогда.

use loadout_core::model::{Client, Kind, ScanResult, State};
use loadout_core::write::{apply, journal, plan, rollback};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static N: AtomicU32 = AtomicU32::new(0);

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
    assert!(plan(&e.home, &skill.id, false).unwrap_err().contains("R2"));
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
        home.join(".codex/config.toml"),
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
    assert_eq!(before, after, "plan не должен менять файлы");
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
