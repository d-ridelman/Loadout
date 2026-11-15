//! Golden-проверки сканера на обезличенных фикстурах (`fixtures/home`).
//! Фикстура копируется во временный каталог, где `{HOME}` заменяется на настоящий путь:
//! сканер проверяет существование `installPath`, а абсолютные пути в файлах клиентов настоящие.

use loadout_core::model::{Client, Kind, ScanResult, State};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static N: AtomicU32 = AtomicU32::new(0);

struct Home(PathBuf);

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn copy_tree(from: &Path, to: &Path, home: &str) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if src.is_dir() {
            copy_tree(&src, &dst, home);
        } else {
            // `{HOME_UPPER}` — тот же путь в другом регистре: так Windows-клиенты иногда пишут пути проектов.
            let text = fs::read_to_string(&src)
                .unwrap()
                .replace("{HOME_UPPER}", &home.to_uppercase())
                .replace("{HOME}", home);
            fs::write(&dst, text).unwrap();
        }
    }
}

fn fixture_home() -> Home {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/home");
    let tmp = std::env::temp_dir().join(format!(
        "loadout-fx-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&tmp);
    copy_tree(&root, &tmp, &tmp.to_string_lossy().replace('\\', "/"));
    Home(tmp)
}

fn count(r: &ScanResult, client: Client, kind: Kind, state: State) -> usize {
    r.entities
        .iter()
        .filter(|e| e.client == client && e.kind == kind && e.state == state)
        .count()
}

fn state_of(r: &ScanResult, client: Client, kind: Kind, name: &str) -> Vec<State> {
    r.entities
        .iter()
        .filter(|e| e.client == client && e.kind == kind && e.name == name)
        .map(|e| e.state)
        .collect()
}

#[test]
fn claude_code_inventory() {
    let h = fixture_home();
    let r = loadout_core::scan(&h.0);
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    let c = Client::ClaudeCode;

    assert_eq!(state_of(&r, c, Kind::Plugin, "alpha@mp"), [State::On]);
    assert_eq!(state_of(&r, c, Kind::Plugin, "beta@mp"), [State::Off]);
    assert_eq!(
        state_of(&r, c, Kind::Plugin, "dup@mp"),
        [State::Stale, State::Stale],
        "две записи с разными версиями"
    );
    assert_eq!(
        state_of(&r, c, Kind::Plugin, "lost@mp"),
        [State::Broken],
        "installPath не существует"
    );
    assert_eq!(
        state_of(&r, c, Kind::Plugin, "ghost@mp"),
        [State::Broken],
        "включён, но не установлен"
    );
    assert_eq!(
        state_of(&r, c, Kind::Plugin, "proj@mp"),
        [State::Unknown],
        "флаг проекта M0 не читает"
    );
    assert_eq!(count(&r, c, Kind::Marketplace, State::On), 1);

    assert_eq!(
        count(&r, c, Kind::Connector, State::Off),
        1,
        "коннектор claude.ai погашен ключом disableClaudeAiConnectors"
    );
    assert_eq!(
        count(&r, c, Kind::Mcp, State::On),
        3,
        "github, pm и pu; local запрещён в deniedMcpServers"
    );
    let local = r
        .entities
        .iter()
        .find(|e| e.client == c && e.kind == Kind::Mcp && e.name == "local")
        .expect("local");
    assert_eq!(local.state, State::Off, "запрет по serverName");
    assert_eq!(
        count(&r, c, Kind::Mcp, State::Off),
        3,
        "old и old2 из стэша плюс local"
    );
    assert!(
        r.entities
            .iter()
            .any(|e| e.name == "pu" && e.scope == "project:~/work/up"),
        "путь проекта в другом регистре приведён к ~"
    );
    assert!(
        !r.entities.iter().any(|e| e.name == "_note"),
        "`_note` в стэше не сервер"
    );

    assert_eq!(
        count(&r, c, Kind::Skill, State::On),
        2,
        "synced/ без SKILL.md пропущен"
    );
    let odd = r
        .entities
        .iter()
        .find(|e| e.name == "other-name")
        .expect("имя берётся из frontmatter");
    assert!(odd.note.is_some(), "расхождение каталога и имени отмечено");
    assert_eq!(count(&r, c, Kind::Agent, State::On), 1);
    assert_eq!(count(&r, c, Kind::Hook, State::On), 3);
    let post = r
        .entities
        .iter()
        .find(|e| e.name.starts_with("PostToolUse"))
        .unwrap();
    assert_eq!(
        post.name, "PostToolUse: post",
        "метка хука не содержит ни секрета, ни переменной окружения"
    );
}

#[test]
fn codex_inventory() {
    let h = fixture_home();
    let r = loadout_core::scan(&h.0);
    let c = Client::Codex;

    assert_eq!(count(&r, c, Kind::Plugin, State::On), 1);
    assert_eq!(count(&r, c, Kind::Plugin, State::Off), 1);
    assert_eq!(
        count(&r, c, Kind::Plugin, State::Unknown),
        1,
        "таблица без enabled"
    );
    assert_eq!(count(&r, c, Kind::Marketplace, State::On), 1);
    assert_eq!(count(&r, c, Kind::Mcp, State::On), 2);
    assert_eq!(count(&r, c, Kind::Mcp, State::Off), 1, "enabled = false");
    assert_eq!(count(&r, c, Kind::Hook, State::On), 2);
    assert_eq!(count(&r, c, Kind::Skill, State::On), 2);
    assert!(
        r.entities
            .iter()
            .any(|e| e.client == c && e.kind == Kind::Skill && e.scope == "builtin"),
        ".system → builtin"
    );
    assert_eq!(count(&r, c, Kind::Connector, State::Cloud), 1);
    assert_eq!(
        count(&r, c, Kind::Connector, State::Off),
        1,
        "[apps.demo-app] enabled = false; `apps._default` не запись"
    );
    assert!(
        r.entities
            .iter()
            .any(|e| e.client == c && e.kind == Kind::Hook && e.logical_key == "orca-agent-hooks"),
        "хук-обёртка в каталоге agent-hooks получает групповой logicalKey"
    );
}

#[test]
fn secrets_and_home_path_never_leak() {
    let h = fixture_home();
    let json = serde_json::to_string(&loadout_core::scan(&h.0)).unwrap();
    assert!(!json.contains("FAKE-SECRET"), "секрет попал в вывод");
    let home = h.0.to_string_lossy().into_owned();
    for variant in [
        home.clone(),
        home.replace('\\', "/"),
        home.replace('\\', "\\\\"),
    ] {
        assert!(
            !json.contains(&variant),
            "путь домашнего каталога попал в вывод: {variant}"
        );
    }
    assert!(
        json.contains("API_KEY") && json.contains("Authorization"),
        "имена ключей видны, значения нет"
    );
}

#[test]
fn ids_are_unique_and_stable() {
    let (a, b) = (fixture_home(), fixture_home());
    let (ra, rb) = (loadout_core::scan(&a.0), loadout_core::scan(&b.0));
    let ids = |r: &ScanResult| r.entities.iter().map(|e| e.id.clone()).collect::<Vec<_>>();
    let uniq: HashSet<_> = ids(&ra).into_iter().collect();
    assert_eq!(uniq.len(), ra.entities.len(), "id уникальны");
    assert_eq!(
        ids(&ra),
        ids(&rb),
        "id не зависят от временного каталога и порядка запуска"
    );
}

#[test]
fn same_hook_links_across_clients() {
    let h = fixture_home();
    let r = loadout_core::scan(&h.0);
    let clients: HashSet<_> = r
        .entities
        .iter()
        .filter(|e| e.kind == Kind::Hook && e.logical_key == "guard")
        .map(|e| e.client)
        .collect();
    assert_eq!(
        clients.len(),
        3,
        "хук guard найден в Claude Code, Codex и Antigravity под одним logicalKey"
    );
}

#[test]
fn antigravity_inventory() {
    let h = fixture_home();
    let r = loadout_core::scan(&h.0);
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    let c = Client::Antigravity;

    assert_eq!(
        count(&r, c, Kind::Mcp, State::On),
        3,
        "tool-a, tool-b и p1-server из плагина"
    );
    assert!(r
        .entities
        .iter()
        .any(|e| e.client == c && e.name == "p1-server" && e.scope == "plugin:p1"));
    assert_eq!(
        count(&r, c, Kind::Hook, State::On),
        1,
        "hooks.json: группа → событие → хуки"
    );
    let p1 = r
        .entities
        .iter()
        .find(|e| e.client == c && e.kind == Kind::Plugin)
        .expect("плагин p1");
    assert_eq!(
        (p1.name.as_str(), p1.version.as_deref()),
        ("p1", Some("1.2.0"))
    );
    assert_eq!(
        count(&r, c, Kind::Skill, State::On),
        3,
        "user, плагин, встроенный"
    );
    assert!(r
        .entities
        .iter()
        .any(|e| e.client == c && e.kind == Kind::Skill && e.scope == "builtin"));
}

#[test]
fn claude_desktop_inventory() {
    let h = fixture_home();
    let r = loadout_core::scan(&h.0);
    let c = Client::ClaudeDesktop;
    assert_eq!(count(&r, c, Kind::Mcp, State::On), 1);
    assert_eq!(
        r.entities.iter().filter(|e| e.client == c).count(),
        1,
        "настройки `preferences` не сущности"
    );
}

/// Файл dsh содержит `cwd: !!js process.cwd()`. Тег не исполняется и не должен ронять разбор.
#[test]
fn deepseek_inventory_with_js_tag() {
    let h = fixture_home();
    let r = loadout_core::scan(&h.0);
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    let c = Client::DeepSeek;

    let mcp: Vec<_> = r
        .entities
        .iter()
        .filter(|e| e.client == c && e.kind == Kind::Mcp)
        .collect();
    assert_eq!(mcp.len(), 1);
    assert_eq!(mcp[0].name, "demo", "имя берётся из config.serverName");
    assert_eq!(mcp[0].detail["transport"], "stdio");
    assert_eq!(
        count(&r, c, Kind::Hook, State::On),
        2,
        "хуки из файла, на который указывает configPath"
    );
    assert_eq!(
        count(&r, c, Kind::Plugin, State::On),
        1,
        "прочие плагины dsh"
    );
    let plugin = r
        .entities
        .iter()
        .find(|e| e.client == c && e.kind == Kind::Plugin)
        .expect("плагин dsh");
    assert_eq!(
        plugin.logical_key, "@deepseek-ai/dsh-something",
        "ведущая @ областного пакета не отбрасывается: пустой ключ склеил бы все такие плагины"
    );
    assert_eq!(count(&r, c, Kind::Skill, State::On), 1);
}

#[test]
fn deepseek_hook_path_outside_home_is_refused() {
    let h = fixture_home();
    let cfg = h.0.join(".dsh/cordis.patch.yml");
    let text = fs::read_to_string(&cfg).unwrap();
    // configPath, который выводит из домашнего каталога через `..`
    fs::write(
        &cfg,
        text.replace("/.dsh/ctxkit-hooks.json", "/../../etc/hooks.json"),
    )
    .unwrap();
    let r = loadout_core::scan(&h.0);
    assert_eq!(count(&r, Client::DeepSeek, Kind::Hook, State::On), 0);
    assert!(
        r.warnings.iter().any(|w| w.contains("вне домашнего")),
        "{:?}",
        r.warnings
    );
}

#[test]
fn deepseek_yaml_guard_refuses_alias_bombs_and_deep_nesting() {
    for (yaml, why) in [
        ("a: &a [x, x]\nb: &b [*a, *a]\nc: [*b, *b]\n", "алиасы"),
        (
            &format!("k: {}{}\n", "[".repeat(100), "]".repeat(100)),
            "вложенность",
        ),
        (&format!("{}k: 1\n", " ".repeat(300)), "вложенность"),
    ] {
        let h = fixture_home();
        fs::write(h.0.join(".dsh/cordis.patch.yml"), yaml).unwrap();
        let r = loadout_core::scan(&h.0);
        assert!(
            r.warnings.iter().any(|w| w.contains(why)),
            "{why}: {:?}",
            r.warnings
        );
        assert_eq!(count(&r, Client::DeepSeek, Kind::Mcp, State::On), 0);
    }
}

#[test]
fn deepseek_relative_config_path_is_refused() {
    let h = fixture_home();
    let cfg = h.0.join(".dsh/cordis.patch.yml");
    let text = fs::read_to_string(&cfg).unwrap();
    fs::write(
        &cfg,
        text.replace("{HOME}", "~")
            .replace(&h.0.to_string_lossy().replace('\\', "/"), "~"),
    )
    .unwrap();
    let r = loadout_core::scan(&h.0);
    assert_eq!(
        count(&r, Client::DeepSeek, Kind::Hook, State::On),
        0,
        "`~/…` читалось бы относительно рабочего каталога процесса"
    );
    assert!(r.warnings.iter().any(|w| w.contains("вне домашнего")));
}

#[test]
fn same_hooks_file_in_user_and_profile_patch_gets_distinct_ids_and_scopes() {
    let h = fixture_home();
    let user = fs::read_to_string(h.0.join(".dsh/cordis.patch.yml")).unwrap();
    fs::write(h.0.join(".dsh/profiles/default/cordis.patch.yml"), user).unwrap();
    let r = loadout_core::scan(&h.0);
    let hooks: Vec<_> = r
        .entities
        .iter()
        .filter(|e| e.client == Client::DeepSeek && e.kind == Kind::Hook)
        .collect();
    assert_eq!(hooks.len(), 4, "две области по два хука");
    let ids: HashSet<_> = hooks.iter().map(|e| &e.id).collect();
    assert_eq!(ids.len(), 4, "id уникальны");
    assert!(hooks.iter().any(|e| e.scope == "profile:default"));
    let all: HashSet<_> = r.entities.iter().map(|e| &e.id).collect();
    assert_eq!(all.len(), r.entities.len());
}

#[test]
fn secret_looking_names_from_files_do_not_reach_output() {
    let h = fixture_home();
    let token = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    fs::write(
        h.0.join(".claude/agents/leaky.md"),
        format!("---\nname: {token}\n---\n"),
    )
    .unwrap();
    // ключ группы хуков Antigravity и идентификатор приложения Codex тоже строки из файлов
    let hooks = fs::read_to_string(h.0.join(".gemini/config/hooks.json")).unwrap();
    fs::write(
        h.0.join(".gemini/config/hooks.json"),
        hooks.replace("\"ctxkit\"", &format!("\"{token}\"")),
    )
    .unwrap();
    let cfg = fs::read_to_string(h.0.join(".codex/config.toml")).unwrap();
    fs::write(
        h.0.join(".codex/config.toml"),
        cfg.replace("demo-app", token),
    )
    .unwrap();
    let json = serde_json::to_string(&loadout_core::scan(&h.0)).unwrap();
    assert!(!json.contains(token), "токен из имени попал в вывод");
}

#[test]
fn missing_home_is_not_an_error() {
    let r = loadout_core::scan(Path::new("Z:/definitely/not/here"));
    assert!(r.entities.is_empty() && r.warnings.is_empty());
}
