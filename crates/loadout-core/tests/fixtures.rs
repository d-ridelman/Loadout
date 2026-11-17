//! Golden checks of the scanner on anonymised fixtures (`fixtures/home`).
//! The fixture is copied to a temporary directory where `{HOME}` is replaced with the real path:
//! the scanner checks that `installPath` exists, and absolute paths in client files are real.

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
            // `{HOME_UPPER}` is the same path in a different case: Windows clients sometimes write project paths that way.
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
        "two entries with different versions"
    );
    // the note is shown as is in the window: no number + noun that would need inflecting ("2 версий")
    let dup_note = r
        .entities
        .iter()
        .find(|e| e.name == "dup@mp")
        .and_then(|e| e.note.clone())
        .unwrap_or_default();
    assert_eq!(dup_note, "в области user записано версий: 2", "{dup_note}");
    assert_eq!(
        state_of(&r, c, Kind::Plugin, "lost@mp"),
        [State::Broken],
        "installPath does not exist"
    );
    assert_eq!(
        state_of(&r, c, Kind::Plugin, "ghost@mp"),
        [State::Broken],
        "enabled but not installed"
    );
    assert_eq!(
        state_of(&r, c, Kind::Plugin, "proj@mp"),
        [State::Unknown],
        "the project directory does not exist: its settings cannot be read"
    );
    assert_eq!(count(&r, c, Kind::Marketplace, State::On), 1);

    assert_eq!(
        count(&r, c, Kind::Connector, State::Off),
        1,
        "the claude.ai connector is switched off by the disableClaudeAiConnectors key"
    );
    assert_eq!(
        count(&r, c, Kind::Mcp, State::On),
        3,
        "github, pm and pu; local is denied in deniedMcpServers"
    );
    let local = r
        .entities
        .iter()
        .find(|e| e.client == c && e.kind == Kind::Mcp && e.name == "local")
        .expect("local");
    assert_eq!(local.state, State::Off, "denied by serverName");
    assert_eq!(
        count(&r, c, Kind::Mcp, State::Off),
        3,
        "old and old2 from the stash plus local"
    );
    assert!(
        r.entities
            .iter()
            .any(|e| e.name == "pu" && e.scope == "project:~/work/up"),
        "a project path in a different case is normalised to ~"
    );
    assert!(
        !r.entities.iter().any(|e| e.name == "_note"),
        "`_note` in the stash is not a server"
    );

    assert_eq!(
        count(&r, c, Kind::Skill, State::On),
        2,
        "synced/ without SKILL.md is skipped"
    );
    let odd = r
        .entities
        .iter()
        .find(|e| e.name == "other-name")
        .expect("the name is taken from frontmatter");
    assert!(odd.note.is_some(), "the directory/name mismatch is noted");
    assert_eq!(count(&r, c, Kind::Agent, State::On), 1);
    assert_eq!(count(&r, c, Kind::Hook, State::On), 3);
    let post = r
        .entities
        .iter()
        .find(|e| e.name.starts_with("PostToolUse"))
        .unwrap();
    assert_eq!(
        post.name, "PostToolUse: post",
        "the hook label contains neither a secret nor an environment variable"
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
        "table without enabled"
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
        "[apps.demo-app] enabled = false; `apps._default` is not an entry"
    );
    assert!(
        r.entities
            .iter()
            .any(|e| e.client == c && e.kind == Kind::Hook && e.logical_key == "orca-agent-hooks"),
        "a wrapper hook in the agent-hooks directory gets a group logicalKey"
    );
}

#[test]
fn secrets_and_home_path_never_leak() {
    let h = fixture_home();
    let json = serde_json::to_string(&loadout_core::scan(&h.0)).unwrap();
    assert!(
        !json.contains("FAKE-SECRET"),
        "secret leaked into the output"
    );
    let home = h.0.to_string_lossy().into_owned();
    for variant in [
        home.clone(),
        home.replace('\\', "/"),
        home.replace('\\', "\\\\"),
    ] {
        assert!(
            !json.contains(&variant),
            "home directory path leaked into the output: {variant}"
        );
    }
    assert!(
        json.contains("API_KEY") && json.contains("Authorization"),
        "key names are visible, the value is not"
    );
}

#[test]
fn ids_are_unique_and_stable() {
    let (a, b) = (fixture_home(), fixture_home());
    let (ra, rb) = (loadout_core::scan(&a.0), loadout_core::scan(&b.0));
    let ids = |r: &ScanResult| r.entities.iter().map(|e| e.id.clone()).collect::<Vec<_>>();
    let uniq: HashSet<_> = ids(&ra).into_iter().collect();
    assert_eq!(uniq.len(), ra.entities.len(), "ids are unique");
    assert_eq!(
        ids(&ra),
        ids(&rb),
        "ids do not depend on the temporary directory or the run order"
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
        "hook guard is found in Claude Code, Codex and Antigravity under one logicalKey"
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
        "tool-a, tool-b and p1-server from the plugin"
    );
    assert!(r
        .entities
        .iter()
        .any(|e| e.client == c && e.name == "p1-server" && e.scope == "plugin:p1"));
    assert_eq!(
        count(&r, c, Kind::Hook, State::On),
        1,
        "hooks.json: group → event → hooks"
    );
    let p1 = r
        .entities
        .iter()
        .find(|e| e.client == c && e.kind == Kind::Plugin)
        .expect("plugin p1");
    assert_eq!(
        (p1.name.as_str(), p1.version.as_deref()),
        ("p1", Some("1.2.0"))
    );
    assert_eq!(
        count(&r, c, Kind::Skill, State::On),
        3,
        "user, plugin, built-in"
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
        "`preferences` settings are not entities"
    );
}

/// The dsh file contains `cwd: !!js process.cwd()`. The tag is not executed and must not break parsing.
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
    assert_eq!(
        mcp[0].name, "demo",
        "the name is taken from config.serverName"
    );
    assert_eq!(mcp[0].detail["transport"], "stdio");
    assert_eq!(
        count(&r, c, Kind::Hook, State::On),
        2,
        "hooks from the file that configPath points to"
    );
    assert_eq!(
        count(&r, c, Kind::Plugin, State::On),
        1,
        "other dsh plugins"
    );
    let plugin = r
        .entities
        .iter()
        .find(|e| e.client == c && e.kind == Kind::Plugin)
        .expect("plugin dsh");
    assert_eq!(
        plugin.logical_key, "@deepseek-ai/dsh-something",
        "the leading @ of a scoped package is not dropped: an empty key would merge all such plugins"
    );
    assert_eq!(count(&r, c, Kind::Skill, State::On), 1);
}

#[test]
fn deepseek_hook_path_outside_home_is_refused() {
    let h = fixture_home();
    let cfg = h.0.join(".dsh/cordis.patch.yml");
    let text = fs::read_to_string(&cfg).unwrap();
    // configPath that leaves the home directory via `..`
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
        "`~/…` would be read relative to the process working directory"
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
    assert_eq!(hooks.len(), 4, "two scopes with two hooks each");
    let ids: HashSet<_> = hooks.iter().map(|e| &e.id).collect();
    assert_eq!(ids.len(), 4, "ids are unique");
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
    // the Antigravity hook group key and the Codex app identifier are also strings from files
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
    assert!(
        !json.contains(token),
        "token from the name leaked into the output"
    );
}

/// A home built inside the test: `(relative path, content)`, `{HOME}` is replaced with the real path.
fn synthetic_home(files: &[(&str, &str)]) -> Home {
    let tmp = std::env::temp_dir().join(format!(
        "loadout-syn-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&tmp);
    let home = tmp.to_string_lossy().replace('\\', "/");
    for (rel, text) in files {
        let p = tmp.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text.replace("{HOME}", &home)).unwrap();
    }
    Home(tmp)
}

fn plugin<'a>(r: &'a ScanResult, name: &str) -> &'a loadout_core::model::Entity {
    r.entities
        .iter()
        .find(|e| e.client == Client::ClaudeCode && e.kind == Kind::Plugin && e.name == name)
        .unwrap_or_else(|| panic!("{name}"))
}

/// The enable flag of a project/local plugin merges user < project < local settings of its `projectPath`
/// (Claude Code docs, plugins/loading: "Find where a plugin is enabled"); no entry anywhere means `defaultEnabled`.
#[test]
fn project_and_local_plugins_read_the_project_settings() {
    let rec = |scope: &str, project: &str, dir: &str| {
        format!(
            r#"[{{ "scope": "{scope}", "projectPath": "{project}", "installPath": "{{HOME}}/.claude/plugins/cache/mp/{dir}/1", "version": "1" }}]"#
        )
    };
    let installed = format!(
        r#"{{ "version": 2, "plugins": {{
            "pa@mp": {}, "pb@mp": {}, "pc@mp": {}, "pd@mp": {}, "pe@mp": {}, "pf@mp": {}, "pg@mp": {},
            "pu@mp": [{{ "scope": "user", "installPath": "{{HOME}}/.claude/plugins/cache/mp/pu/1", "version": "1" }}]
        }} }}"#,
        rec("project", "{HOME}/work/a", "pa"),
        rec("local", "{HOME}/work/a", "pb"),
        rec("project", "{HOME}", "pc"),
        rec("local", "{HOME}/work/a", "pd"),
        rec("project", "{HOME}/work/a", "pe"),
        rec("project", "../work/a", "pf"),
        rec("project", "{HOME}/work/gone", "pg"),
    );
    let h = synthetic_home(&[
        (".claude/plugins/installed_plugins.json", &installed),
        (
            ".claude/settings.json",
            r#"{ "enabledPlugins": { "pc@mp": false, "pu@mp": true, "pa@mp": false } }"#,
        ),
        (
            "work/a/.claude/settings.json",
            r#"{ "enabledPlugins": { "pa@mp": true, "pb@mp": true, "pu@mp": false } }"#,
        ),
        (
            "work/a/.claude/settings.local.json",
            r#"{ "enabledPlugins": { "pb@mp": false } }"#,
        ),
        (".claude/plugins/cache/mp/pa/1/.keep", ""),
        (".claude/plugins/cache/mp/pb/1/.keep", ""),
        (".claude/plugins/cache/mp/pc/1/.keep", ""),
        (
            ".claude/plugins/cache/mp/pd/1/.claude-plugin/plugin.json",
            r#"{ "name": "pd", "defaultEnabled": false }"#,
        ),
        (".claude/plugins/cache/mp/pe/1/.keep", ""),
        (".claude/plugins/cache/mp/pf/1/.keep", ""),
        (".claude/plugins/cache/mp/pg/1/.keep", ""),
        (".claude/plugins/cache/mp/pu/1/.keep", ""),
    ]);
    let r = loadout_core::scan(&h.0);
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    let st = |n: &str| plugin(&r, n).state;
    assert_eq!(
        st("pa@mp"),
        State::On,
        "project settings override user settings"
    );
    assert_eq!(
        st("pb@mp"),
        State::Off,
        "local settings override project settings"
    );
    assert_eq!(
        st("pc@mp"),
        State::Off,
        "projectPath = home: the project file is ~/.claude/settings.json"
    );
    assert_eq!(
        st("pd@mp"),
        State::Off,
        "no entry: defaultEnabled from the manifest"
    );
    assert_eq!(
        st("pe@mp"),
        State::On,
        "no entry, no manifest: defaultEnabled is true"
    );
    assert_eq!(
        st("pf@mp"),
        State::Unknown,
        "a relative projectPath is not read"
    );
    assert_eq!(st("pg@mp"), State::Unknown, "the project directory is gone");
    assert_eq!(st("pu@mp"), State::On, "a user plugin shows the user flag");
    let pb = plugin(&r, "pb@mp");
    assert!(
        pb.note
            .as_deref()
            .is_some_and(|n| n.contains("~/work/a/.claude/settings.local.json")),
        "the note names the file the flag came from: {:?}",
        pb.note
    );
    for n in ["pa@mp", "pb@mp", "pc@mp", "pd@mp", "pe@mp"] {
        assert!(
            !plugin(&r, n).can_toggle,
            "{n}: project/local is display only"
        );
    }
}

/// A project settings file that cannot be read is not "no entry": the state stays unknown, not `defaultEnabled`.
#[test]
fn an_unreadable_project_settings_file_leaves_the_plugin_unknown() {
    let h = synthetic_home(&[
        (
            ".claude/plugins/installed_plugins.json",
            r#"{ "plugins": { "pa@mp": [{ "scope": "project", "projectPath": "{HOME}/work/a", "installPath": "{HOME}/.claude/plugins/cache/mp/pa/1" }] } }"#,
        ),
        (".claude/plugins/cache/mp/pa/1/.keep", ""),
        ("work/a/.claude/settings.json", "{ not json"),
    ]);
    let r = loadout_core::scan(&h.0);
    assert_eq!(plugin(&r, "pa@mp").state, State::Unknown);
    assert_eq!(r.warnings.len(), 1, "{:?}", r.warnings);
}

/// `skillOverrides` (Claude Code docs, settings-reference): `"off"` hides the skill, the other three values keep it.
#[test]
fn skill_overrides_turn_user_skills_off() {
    let skill = |n: &str| {
        (
            format!(".claude/skills/{n}/SKILL.md"),
            format!("---\nname: {n}\n---\n"),
        )
    };
    let s = ["s-off", "s-name", "s-user", "s-on", "s-free"].map(skill);
    let mut files: Vec<(&str, &str)> = s.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    files.push((
        ".claude/settings.json",
        r#"{ "skillOverrides": { "s-off": "off", "s-name": "name-only", "s-user": "user-invocable-only", "s-on": "on" } }"#,
    ));
    let h = synthetic_home(&files);
    let r = loadout_core::scan(&h.0);
    let get = |n: &str| {
        r.entities
            .iter()
            .find(|e| e.client == Client::ClaudeCode && e.kind == Kind::Skill && e.name == n)
            .unwrap_or_else(|| panic!("{n}"))
    };
    assert_eq!(get("s-off").state, State::Off);
    assert!(get("s-off").note.is_some());
    for n in ["s-name", "s-user", "s-on", "s-free"] {
        assert_eq!(get(n).state, State::On, "{n}");
    }
    assert!(get("s-name").note.is_some() && get("s-user").note.is_some());
    assert!(get("s-on").note.is_none() && get("s-free").note.is_none());
}

/// A long skill directory name with a digit is a file system name, not a token: the 2a audit saw it masked in the path and the note.
#[test]
fn long_skill_directory_names_are_not_masked() {
    let dir = "context7-documentation-lookup-v2";
    let h = synthetic_home(&[(
        &format!(".claude/skills/{dir}/SKILL.md"),
        "---\nname: docs-lookup\n---\n",
    )]);
    let r = loadout_core::scan(&h.0);
    let e = r
        .entities
        .iter()
        .find(|e| e.kind == Kind::Skill)
        .expect("skill");
    assert_eq!(e.name, "docs-lookup");
    assert_eq!(e.origin.file, format!("~/.claude/skills/{dir}/SKILL.md"));
    assert!(
        e.note.as_deref().is_some_and(|n| n.contains(dir)),
        "{:?}",
        e.note
    );
}

/// The Antigravity app and its CLI ship the same built-in skills: one entry per name, not two `builtin` rows.
#[test]
fn antigravity_builtin_skills_are_not_listed_twice() {
    let md = |n: &str| format!("---\nname: {n}\n---\n");
    let (b1, b2) = (md("b1"), md("b2"));
    let h = synthetic_home(&[
        (".gemini/antigravity/builtin/skills/b1/SKILL.md", &b1),
        (".gemini/antigravity-cli/builtin/skills/b1/SKILL.md", &b1),
        (".gemini/antigravity-cli/builtin/skills/b2/SKILL.md", &b2),
    ]);
    let r = loadout_core::scan(&h.0);
    let names: Vec<&str> = r
        .entities
        .iter()
        .filter(|e| e.client == Client::Antigravity && e.scope == "builtin")
        .map(|e| e.name.as_str())
        .collect();
    assert_eq!(names, ["b1", "b2"]);
    let b1 = r.entities.iter().find(|e| e.name == "b1").unwrap();
    assert!(
        b1.note
            .as_deref()
            .is_some_and(|n| n.contains("antigravity-cli")),
        "{:?}",
        b1.note
    );
}

/// Codex keeps a remote plugin under its id (`app-<hex>`); the human name is in the cached manifest
/// `<plugin>/<version>/.codex-plugin/plugin.json` → `interface.displayName` (Codex source, core-plugins/manifest.rs).
#[test]
fn codex_remote_plugins_carry_the_manifest_display_name() {
    let root = ".codex/plugins/cache/openai-curated-remote";
    let h = synthetic_home(&[
        (
            &format!("{root}/app-69f0dc45ab12/8a1b2c3d/.codex-plugin/plugin.json"),
            r#"{ "name": "github", "interface": { "displayName": "GitHub" } }"#,
        ),
        (
            &format!("{root}/app-0b1c2d3e4f56/1.0.0/.codex-plugin/plugin.json"),
            r#"{ "name": "linear" }"#,
        ),
        (
            &format!("{root}/app-aa11bb22cc33/1/.codex-plugin/plugin.json"),
            r#"{ "name": "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" }"#,
        ),
        (&format!("{root}/app-ffee00112233/.keep"), ""),
        (
            &format!("{root}/app-123456abcdef/1/.codex-plugin/plugin.json"),
            "{ broken",
        ),
        (
            &format!("{root}/app-123456abcdef/1/.claude-plugin/plugin.json"),
            r#"{ "name": "fallback" }"#,
        ),
    ]);
    let r = loadout_core::scan(&h.0);
    let shown = |id: &str| {
        let e = r
            .entities
            .iter()
            .find(|e| e.client == Client::Codex && e.name == id)
            .unwrap_or_else(|| panic!("{id}"));
        e.detail
            .get("displayName")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    };
    assert_eq!(shown("app-69f0dc45ab12").as_deref(), Some("GitHub"));
    assert_eq!(
        shown("app-0b1c2d3e4f56").as_deref(),
        Some("linear"),
        "falls back to name"
    );
    assert_eq!(
        shown("app-aa11bb22cc33"),
        None,
        "a token-like name is dropped"
    );
    assert_eq!(shown("app-ffee00112233"), None, "no manifest");
    assert_eq!(
        shown("app-123456abcdef").as_deref(),
        Some("fallback"),
        "a broken .codex-plugin manifest falls back to .claude-plugin"
    );
}

/// Version directories (`1.9.0`, `1.10.0`, sha prefixes) do not sort as strings: the newest manifest names the plugin.
#[test]
fn codex_remote_plugin_name_comes_from_the_newest_manifest() {
    let root = ".codex/plugins/cache/openai-curated-remote/app-1a2b3c4d5e6f";
    let (old, new) = (
        format!("{root}/1.9.0/.codex-plugin/plugin.json"),
        format!("{root}/1.10.0/.codex-plugin/plugin.json"),
    );
    let h = synthetic_home(&[
        (&old, r#"{ "name": "old-name" }"#),
        (&new, r#"{ "name": "new-name" }"#),
    ]);
    let day = std::time::Duration::from_secs(86_400);
    let at = |rel: &str, t: std::time::SystemTime| {
        fs::File::options()
            .write(true)
            .open(h.0.join(rel))
            .unwrap()
            .set_modified(t)
            .unwrap();
    };
    let now = std::time::SystemTime::now();
    at(&old, now - day * 2);
    at(&new, now - day);
    let r = loadout_core::scan(&h.0);
    let e = r
        .entities
        .iter()
        .find(|e| e.name == "app-1a2b3c4d5e6f")
        .unwrap();
    assert_eq!(e.detail["displayName"], "new-name");
}

/// `/skills` saves to `settings.local.json`; it outranks `~/.claude/settings.json` key by key (docs, settings precedence).
#[test]
fn skill_overrides_in_settings_local_outrank_user_settings() {
    let skill = |n: &str| {
        (
            format!(".claude/skills/{n}/SKILL.md"),
            format!("---\nname: {n}\n---\n"),
        )
    };
    let s = ["s-a", "s-b", "s-c", "s-d"].map(skill);
    let mut files: Vec<(&str, &str)> = s.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    files.push((
        ".claude/settings.json",
        r#"{ "skillOverrides": { "s-a": "off", "s-b": "name-only", "s-d": "off" } }"#,
    ));
    files.push((
        ".claude/settings.local.json",
        r#"{ "skillOverrides": { "s-a": "on", "s-b": "off", "s-c": "off" } }"#,
    ));
    let h = synthetic_home(&files);
    let r = loadout_core::scan(&h.0);
    let get = |n: &str| {
        r.entities
            .iter()
            .find(|e| e.client == Client::ClaudeCode && e.kind == Kind::Skill && e.name == n)
            .unwrap_or_else(|| panic!("{n}"))
    };
    let note = |n: &str| get(n).note.clone().unwrap_or_default();
    assert_eq!(
        get("s-a").state,
        State::On,
        "local \"on\" outranks user \"off\""
    );
    assert_eq!(
        get("s-b").state,
        State::Off,
        "local \"off\" outranks user \"name-only\""
    );
    assert!(
        note("s-b").contains("settings.local.json"),
        "{}",
        note("s-b")
    );
    assert_eq!(get("s-c").state, State::Off, "only in local");
    assert!(
        note("s-c").contains("settings.local.json"),
        "{}",
        note("s-c")
    );
    assert_eq!(
        get("s-d").state,
        State::Off,
        "only in user settings: it still applies"
    );
    assert!(
        note("s-d").contains("~/.claude/settings.json"),
        "{}",
        note("s-d")
    );
}

#[test]
fn opencode_inventory_from_a_jsonc_v2_config() {
    let h = fixture_home();
    let r = loadout_core::scan(&h.0);
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    let c = Client::OpenCode;
    let one = |kind: Kind, name: &str| {
        r.entities
            .iter()
            .find(|e| e.client == c && e.kind == kind && e.name == name)
            .unwrap_or_else(|| panic!("{kind:?} {name}"))
    };
    let tool = one(Kind::Mcp, "tool-a");
    assert_eq!(tool.state, State::On);
    assert_eq!(tool.origin.pointer, "/mcp/servers/tool-a");
    assert_eq!(
        tool.toggle_level.as_deref(),
        Some("R1"),
        "a flag, not the trash"
    );
    assert!(tool.can_edit);
    assert_eq!(tool.detail["command"], "npx");
    assert_eq!(tool.detail["envKeys"], serde_json::json!(["API_KEY"]));
    assert!(
        r.entities
            .iter()
            .any(|e| e.client == Client::Antigravity && e.logical_key == tool.logical_key),
        "one row with the Antigravity server"
    );
    let remote = one(Kind::Mcp, "oc-remote");
    assert_eq!(remote.state, State::Off, "`disabled: true`");
    assert_eq!(remote.detail["transport"], "http");
    assert_eq!(
        remote.detail["headerKeys"],
        serde_json::json!(["Authorization"])
    );
    assert_eq!(one(Kind::Agent, "reviewer").state, State::Off);
    assert_eq!(one(Kind::Agent, "planner").state, State::On);
    one(Kind::Command, "ship");
    one(Kind::Command, "review");
    let p = one(Kind::Plugin, "opencode-acme-plugin");
    assert_eq!(p.version.as_deref(), Some("1.2.0"));
    one(Kind::Plugin, "@acme/opencode-plugin");
    one(Kind::Plugin, "status");
    one(Kind::Skill, "oc-skill");
    assert_eq!(r.entities.iter().filter(|e| e.client == c).count(), 10);
}

#[test]
fn opencode_v1_config_uses_enabled_and_singular_keys() {
    let h = synthetic_home(&[(
        ".config/opencode/opencode.json",
        r#"{ "mcp": { "a": { "type": "local", "command": ["x"], "enabled": false }, "b": { "type": "remote", "url": "https://h.example.com/mcp" } },
             "agent": { "old": { "disable": true } }, "command": { "c": { "template": "t" } }, "plugin": [["./plugin/local.ts", { "k": 1 }]] }"#,
    )]);
    let r = loadout_core::scan(&h.0);
    assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    let c = Client::OpenCode;
    assert_eq!(state_of(&r, c, Kind::Mcp, "a"), vec![State::Off]);
    assert_eq!(state_of(&r, c, Kind::Mcp, "b"), vec![State::On]);
    assert_eq!(state_of(&r, c, Kind::Agent, "old"), vec![State::Off]);
    assert_eq!(state_of(&r, c, Kind::Command, "c"), vec![State::On]);
    assert_eq!(state_of(&r, c, Kind::Plugin, "local"), vec![State::On]);
    let a = r.entities.iter().find(|e| e.name == "a").unwrap();
    assert_eq!(a.origin.pointer, "/mcp/a");
}

#[test]
fn missing_home_is_not_an_error() {
    let r = loadout_core::scan(Path::new("Z:/definitely/not/here"));
    assert!(r.entities.is_empty() && r.warnings.is_empty());
}
