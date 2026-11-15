//! Гонка с клиентом: файл меняют между записью временного файла и `rename`. Колбэк `BEFORE_SWAP` есть только в тестах
//! крейта, поэтому тесты здесь, а не в `tests/`.

use super::{apply, journal, rollback, Intent, BEFORE_SWAP};
use crate::model::{Client, Kind};
use std::fs;
use std::path::{Path, PathBuf};

struct Env {
    top: PathBuf,
    home: PathBuf,
    store: PathBuf,
}

impl Drop for Env {
    fn drop(&mut self) {
        BEFORE_SWAP.with(|h| *h.borrow_mut() = None);
        let _ = fs::remove_dir_all(&self.top);
    }
}

fn env(tag: &str) -> Env {
    let top = std::env::temp_dir().join(format!("loadout-race-{}-{tag}", std::process::id()));
    let _ = fs::remove_dir_all(&top);
    let home = top.join("home");
    fs::create_dir_all(home.join(".codex")).unwrap();
    fs::write(
        home.join(".codex/config.toml"),
        "[plugins.\"p1@bundled\"]\nenabled = true\n",
    )
    .unwrap();
    Env {
        store: top.join("backups"),
        home,
        top,
    }
}

fn cfg(e: &Env) -> PathBuf {
    e.home.join(".codex/config.toml")
}

fn toggle(e: &Env, enable: bool) -> Intent {
    let scan = crate::scan(&e.home);
    let id = scan
        .entities
        .iter()
        .find(|x| x.client == Client::Codex && x.kind == Kind::Plugin && x.name == "p1@bundled")
        .unwrap()
        .id
        .clone();
    Intent::Toggle { entity: id, enable }
}

/// Колбэк: перед заменой клиент дописывает свою строку.
fn client_writes(text: &'static str) {
    BEFORE_SWAP.with(|h| {
        *h.borrow_mut() = Some(Box::new(move |p: &Path| {
            let mut s = fs::read_to_string(p).unwrap();
            s.push_str(text);
            fs::write(p, s).unwrap();
        }));
    });
}

fn no_tmp(e: &Env) {
    let left = fs::read_dir(cfg(e).parent().unwrap())
        .unwrap()
        .flatten()
        .any(|f| f.file_name().to_string_lossy().contains("loadout"));
    assert!(!left, "временный файл не остался");
}

#[test]
fn commit_refuses_when_the_file_changes_right_before_the_swap() {
    let e = env("commit");
    let i = toggle(&e, false);
    let plan = super::plan(&e.home, Some(&e.store), &i).unwrap();
    client_writes("# клиент успел\n");
    let err = apply(&e.home, &e.store, &i, &plan.base_sha, "R2").unwrap_err();
    assert!(err.contains("перед заменой"), "{err}");
    // клиентская запись цела, наша не пришла, строки журнала и каталога операции нет
    let text = fs::read_to_string(cfg(&e)).unwrap();
    assert!(text.ends_with("# клиент успел\n") && text.contains("enabled = true"));
    assert!(journal(&e.home, &e.store).is_empty());
    no_tmp(&e);
}

#[test]
fn rollback_refuses_when_the_file_changes_right_before_the_swap() {
    let e = env("rollback");
    let i = toggle(&e, false);
    let plan = super::plan(&e.home, Some(&e.store), &i).unwrap();
    let done = apply(&e.home, &e.store, &i, &plan.base_sha, "R2").unwrap();
    client_writes("# клиент успел\n");
    let err = rollback(&e.home, &e.store, &done.op, "R2").unwrap_err();
    assert!(err.contains("перед заменой"), "{err}");
    let text = fs::read_to_string(cfg(&e)).unwrap();
    assert!(text.ends_with("# клиент успел\n") && text.contains("enabled = false"));
    // откатом это не стало: исходная операция по-прежнему одна и числится не откатанной
    let j = journal(&e.home, &e.store);
    assert_eq!(j.len(), 1);
    assert!(!j[0].rolled_back);
    no_tmp(&e);
}
