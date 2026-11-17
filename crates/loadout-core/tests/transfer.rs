//! Copying skills, hooks and MCP servers between clients, globally and inside a known project, on a copy of the fixtures
//! in a temporary directory: the real home and `fixtures/` are never touched.

use loadout_core::model::{Client, Entity, Kind, ScanResult};
use loadout_core::projects;
use loadout_core::write::{self, journal, Intent};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static N: AtomicU32 = AtomicU32::new(0);
const ML: &str = "R2";

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
        "loadout-tr-{}-{}",
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

fn find<'a>(r: &'a ScanResult, client: Client, kind: Kind, name: &str) -> &'a Entity {
    r.entities
        .iter()
        .find(|e| e.client == client && e.kind == kind && e.name.contains(name))
        .unwrap_or_else(|| panic!("no entry {name}"))
}

fn copy(id: &str, to: &str, project: &str) -> Intent {
    Intent::Copy {
        entity: id.to_owned(),
        to: to.to_owned(),
        project: project.to_owned(),
    }
}

fn run(e: &Env, i: &Intent) -> Result<(write::Plan, String), String> {
    let p = write::plan(&e.home, Some(&e.store), i)?;
    let a = write::apply(&e.home, &e.store, i, &p.base_sha, ML)?;
    Ok((p, a.op))
}

fn tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for x in fs::read_dir(&d).unwrap().flatten() {
            if x.path().is_dir() {
                stack.push(x.path());
            } else {
                let rel = x
                    .path()
                    .strip_prefix(dir)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                out.push((rel, fs::read(x.path()).unwrap()));
            }
        }
    }
    out.sort();
    out
}

fn app(e: &Env) -> projects::Project {
    projects::known(&e.home)
        .into_iter()
        .find(|p| p.dir.ends_with("work/app"))
        .expect("the fixture project work/app is known")
}

#[test]
fn a_skill_folder_copies_to_codex_and_the_rollback_removes_it() {
    let e = env();
    let r = loadout_core::scan(&e.home);
    let s = find(&r, Client::ClaudeCode, Kind::Skill, "demo-skill");
    assert!(s.can_copy);
    assert!(s.copy_why.contains_key("claude-desktop") && s.copy_why.contains_key("opencode"));
    let (p, op) = run(&e, &copy(&s.id, "codex", "")).unwrap();
    assert_eq!(
        (p.op.as_str(), p.level.as_str(), p.kind),
        ("copy", "R2", Kind::Skill)
    );
    assert_eq!(p.file, "~/.codex/skills/demo-skill/");
    let dst = e.home.join(".codex/skills/demo-skill");
    assert_eq!(tree(&dst), tree(&e.home.join(".claude/skills/demo-skill")));
    let after = loadout_core::scan(&e.home);
    assert!(after
        .entities
        .iter()
        .any(|x| x.client == Client::Codex && x.kind == Kind::Skill && x.name == "demo-skill"));
    let row = journal(&e.home, &e.store)
        .into_iter()
        .find(|j| j.id == op)
        .unwrap();
    assert!(row.can_rollback, "{:?}", row.why);
    assert_eq!(row.client, "codex");
    write::rollback(&e.home, &e.store, &op, ML).unwrap();
    assert!(!dst.exists());
    // the temp folders next to the skills folder are gone too
    let left: Vec<_> = fs::read_dir(e.home.join(".codex"))
        .unwrap()
        .flatten()
        .filter(|x| x.file_name().to_string_lossy().contains(".loadout."))
        .collect();
    assert!(left.is_empty());
}

#[test]
fn a_skill_copy_is_refused_where_it_would_duplicate_or_be_lost() {
    let e = env();
    let r = loadout_core::scan(&e.home);
    let s = find(&r, Client::ClaudeCode, Kind::Skill, "demo-skill");
    for to in ["claude-desktop", "opencode"] {
        assert!(
            write::plan(&e.home, Some(&e.store), &copy(&s.id, to, "")).is_err(),
            "{to}"
        );
    }
    // Codex also reads `~/.agents/skills`: a skill of that name there is a taken name
    fs::create_dir_all(e.home.join(".agents/skills/demo-skill")).unwrap();
    let err = write::plan(&e.home, Some(&e.store), &copy(&s.id, "codex", "")).unwrap_err();
    assert!(err.contains(".agents/skills"), "{err}");
    // DeepSeek reads it too; Antigravity does not
    assert!(write::plan(&e.home, Some(&e.store), &copy(&s.id, "deepseek", "")).is_err());
    assert!(write::plan(&e.home, Some(&e.store), &copy(&s.id, "antigravity", "")).is_ok());
    // a frontmatter name that is not kebab-case would be dropped by DeepSeek
    let odd = find(&r, Client::ClaudeCode, Kind::Skill, "other-name");
    fs::remove_dir_all(e.home.join(".agents")).unwrap();
    assert!(write::plan(&e.home, Some(&e.store), &copy(&odd.id, "deepseek", "")).is_ok());
    fs::write(
        e.home.join(".claude/skills/odd/SKILL.md"),
        "---\nname: Other_Name\ndescription: x\n---\n",
    )
    .unwrap();
    let r = loadout_core::scan(&e.home);
    let odd = find(&r, Client::ClaudeCode, Kind::Skill, "Other_Name");
    let err = write::plan(&e.home, Some(&e.store), &copy(&odd.id, "deepseek", "")).unwrap_err();
    assert!(err.contains("kebab"), "{err}");
}

#[test]
fn a_hook_copies_from_claude_code_to_codex_and_rolls_back_byte_for_byte() {
    let e = env();
    let hooks = e.home.join(".codex/hooks.json");
    let before = fs::read(&hooks).unwrap();
    let r = loadout_core::scan(&e.home);
    let h = r
        .entities
        .iter()
        .find(|x| {
            x.client == Client::ClaudeCode
                && x.kind == Kind::Hook
                && x.name.starts_with("PreToolUse")
        })
        .unwrap();
    for to in ["antigravity", "opencode", "deepseek", "claude-desktop"] {
        assert!(h.copy_why.contains_key(to), "{to}");
        assert!(write::plan(&e.home, Some(&e.store), &copy(&h.id, to, "")).is_err());
    }
    let (p, op) = run(&e, &copy(&h.id, "codex", "")).unwrap();
    let shown = serde_json::to_string(&p).unwrap();
    assert!(!shown.contains("FAKE-SECRET"), "{shown}");
    assert_eq!(p.pointer, "/hooks/PreToolUse/1");
    assert!(p.warn.iter().any(|w| w.contains("/hooks")), "{:?}", p.warn);
    let v: serde_json::Value = serde_json::from_slice(&fs::read(&hooks).unwrap()).unwrap();
    let added = &v["hooks"]["PreToolUse"][1];
    assert_eq!(added["matcher"], "Bash");
    assert!(added["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .contains("FAKE-SECRET-HOOK"));
    assert_eq!(added["hooks"][0]["timeout"], 5);
    // the same command again is a taken hook
    assert!(write::plan(&e.home, Some(&e.store), &copy(&h.id, "codex", "")).is_err());
    write::rollback(&e.home, &e.store, &op, ML).unwrap();
    assert_eq!(fs::read(&hooks).unwrap(), before);
}

#[test]
fn a_codex_hook_copies_to_claude_code_into_a_new_event_key() {
    let e = env();
    let settings = e.home.join(".claude/settings.json");
    let before = fs::read(&settings).unwrap();
    let r = loadout_core::scan(&e.home);
    let h = r
        .entities
        .iter()
        .find(|x| x.client == Client::Codex && x.kind == Kind::Hook && x.name.starts_with("Stop"))
        .unwrap();
    let (_, op) = run(&e, &copy(&h.id, "claude-code", "")).unwrap();
    let v: serde_json::Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    assert!(v["hooks"]["Stop"][0]["matcher"].is_null());
    assert!(v["hooks"]["Stop"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .ends_with("codex-hook.cmd"));
    // the other keys of the file are where they were
    assert_eq!(v["enabledPlugins"]["alpha@mp"], true);
    write::rollback(&e.home, &e.store, &op, ML).unwrap();
    assert_eq!(fs::read(&settings).unwrap(), before);
}

#[test]
fn a_missing_codex_hooks_file_is_created_and_the_rollback_removes_it() {
    let e = env();
    let hooks = e.home.join(".codex/hooks.json");
    fs::remove_file(&hooks).unwrap();
    let r = loadout_core::scan(&e.home);
    let h = r
        .entities
        .iter()
        .find(|x| {
            x.client == Client::ClaudeCode
                && x.kind == Kind::Hook
                && x.name.starts_with("SessionStart")
        })
        .unwrap();
    let (p, op) = run(&e, &copy(&h.id, "codex", "")).unwrap();
    assert!(p
        .notes
        .iter()
        .any(|n| n.contains("создаст") || n.contains("creates")));
    let v: serde_json::Value = serde_json::from_slice(&fs::read(&hooks).unwrap()).unwrap();
    assert!(v["hooks"]["SessionStart"][0]["hooks"][0]["command"].is_string());
    write::rollback(&e.home, &e.store, &op, ML).unwrap();
    assert!(!hooks.exists());
    assert!(
        e.home.join(".codex").is_dir(),
        "a folder that existed stays"
    );
}

#[test]
fn context_toolkit_hooks_are_not_copied() {
    let e = env();
    let settings = e.home.join(".claude/settings.json");
    let text = fs::read_to_string(&settings).unwrap().replace(
        "pwsh -File",
        "C:/x/.claude/hooks/context-toolkit.exe --lang ru && pwsh -File",
    );
    fs::write(&settings, text).unwrap();
    let r = loadout_core::scan(&e.home);
    let h = r
        .entities
        .iter()
        .find(|x| {
            x.client == Client::ClaudeCode
                && x.kind == Kind::Hook
                && x.name.starts_with("SessionStart")
        })
        .unwrap();
    let err = write::plan(&e.home, Some(&e.store), &copy(&h.id, "codex", "")).unwrap_err();
    assert!(err.contains("Context Toolkit"), "{err}");
}

#[test]
fn known_projects_come_from_claude_code_and_skip_missing_folders() {
    let e = env();
    let all = projects::known(&e.home);
    // `work/proj` and `work/up` are in `.claude.json`, but only `work/app` exists in the fixture
    assert_eq!(all.len(), 1, "{all:?}");
    let p = &all[0];
    assert!(p.claude_key.is_some() && !p.codex_trusted);
    let list = projects::listing(&e.home).to_string();
    assert!(list.contains("~/work/app") && !list.contains(&*e.home.to_string_lossy()));
    let s = projects::scan(&e.home, p);
    let mcp = find(&s, Client::ClaudeCode, Kind::Mcp, "shared-tool");
    assert!(mcp.can_copy && !mcp.can_edit && !mcp.can_toggle);
    assert_eq!(mcp.project.as_deref(), Some(p.id.as_str()));
    assert!(!serde_json::to_string(&s).unwrap().contains("FAKE-SECRET"));
    // a Claude Code project skill is also seen by OpenCode (it reads `.claude/skills`)
    assert!(s
        .entities
        .iter()
        .any(|x| x.client == Client::OpenCode && x.kind == Kind::Skill && x.name == "app-skill"));
}

#[test]
fn a_project_mcp_server_copies_to_a_new_codex_project_config_and_the_rollback_removes_it() {
    let e = env();
    let p = app(&e);
    let s = projects::scan(&e.home, &p);
    let m = find(&s, Client::ClaudeCode, Kind::Mcp, "shared-tool");
    let i = copy(&m.id, "codex", &p.id);
    let (plan, op) = run(&e, &i).unwrap();
    assert_eq!(plan.file, "~/work/app/.codex/config.toml");
    assert!(plan
        .notes
        .iter()
        .any(|n| n.contains("доверенным") || n.contains("trusted")));
    assert!(
        !plan.warn.is_empty(),
        "values of env go into a project folder"
    );
    assert!(!serde_json::to_string(&plan)
        .unwrap()
        .contains("FAKE-SECRET"));
    let cfg = p.dir.join(".codex/config.toml");
    let text = fs::read_to_string(&cfg).unwrap();
    assert!(
        text.contains("[mcp_servers.shared-tool]") && text.contains("FAKE-SECRET-PROJ"),
        "{text}"
    );
    // the Codex entry of the project now holds the name: copying it back to Claude Code is a taken name
    let s = projects::scan(&e.home, &p);
    let cx = find(&s, Client::Codex, Kind::Mcp, "shared-tool");
    assert!(write::plan(&e.home, Some(&e.store), &copy(&cx.id, "claude-code", &p.id)).is_err());
    // unsupported project targets say why
    for to in ["antigravity", "claude-desktop", "deepseek"] {
        assert!(m.copy_why.contains_key(to), "{to}");
    }
    write::rollback(&e.home, &e.store, &op, ML).unwrap();
    assert!(!cfg.exists());
    assert!(
        !p.dir.join(".codex").exists(),
        "the folder the copy created is removed"
    );
}

#[test]
fn a_project_codex_server_copies_to_the_claude_code_local_scope() {
    let e = env();
    let p = app(&e);
    fs::create_dir_all(p.dir.join(".codex")).unwrap();
    fs::write(
        p.dir.join(".codex/config.toml"),
        "[mcp_servers.cx-only]\ncommand = \"cx\"\n",
    )
    .unwrap();
    let claude = e.home.join(".claude.json");
    let before = fs::read(&claude).unwrap();
    let s = projects::scan(&e.home, &p);
    let m = find(&s, Client::Codex, Kind::Mcp, "cx-only");
    let (plan, op) = run(&e, &copy(&m.id, "claude-code", &p.id)).unwrap();
    assert!(
        plan.notes.iter().any(|n| n.contains("local")),
        "{:?}",
        plan.notes
    );
    let v: serde_json::Value = serde_json::from_slice(&fs::read(&claude).unwrap()).unwrap();
    let key = p.claude_key.clone().unwrap();
    assert_eq!(
        v["projects"][&key]["mcpServers"]["cx-only"]["command"],
        "cx"
    );
    // the main scan sees it in the project's scope
    let r = loadout_core::scan(&e.home);
    assert!(r.entities.iter().any(|x| x.client == Client::ClaudeCode
        && x.name == "cx-only"
        && x.scope.starts_with("project:")));
    write::rollback(&e.home, &e.store, &op, ML).unwrap();
    assert_eq!(fs::read(&claude).unwrap(), before);
}

#[test]
fn a_project_skill_copies_to_the_shared_agents_folder() {
    let e = env();
    let p = app(&e);
    let s = projects::scan(&e.home, &p);
    let k = find(&s, Client::ClaudeCode, Kind::Skill, "app-skill");
    assert!(
        k.copy_why.contains_key("opencode"),
        "OpenCode already reads .claude/skills"
    );
    let (plan, op) = run(&e, &copy(&k.id, "codex", &p.id)).unwrap();
    assert_eq!(plan.file, "~/work/app/.agents/skills/app-skill/");
    assert!(plan.notes.iter().any(|n| n.contains("Antigravity")));
    let s = projects::scan(&e.home, &p);
    for c in [Client::Codex, Client::Antigravity, Client::DeepSeek] {
        assert!(
            s.entities
                .iter()
                .any(|x| x.client == c && x.name == "app-skill"),
            "{c:?}"
        );
    }
    // Antigravity reads the same folder: a second copy is a taken name
    assert!(write::plan(&e.home, Some(&e.store), &copy(&k.id, "antigravity", &p.id)).is_err());
    write::rollback(&e.home, &e.store, &op, ML).unwrap();
    assert!(
        !p.dir.join(".agents").exists(),
        "the folders the copy created are removed"
    );
}

#[test]
fn a_batch_copies_several_kinds_and_rolls_back_as_a_whole() {
    let e = env();
    let cfg = e.home.join(".codex/config.toml");
    let hooks = e.home.join(".codex/hooks.json");
    let (cfg0, hooks0) = (fs::read(&cfg).unwrap(), fs::read(&hooks).unwrap());
    let r = loadout_core::scan(&e.home);
    let skill = find(&r, Client::ClaudeCode, Kind::Skill, "demo-skill");
    let mcp = r
        .entities
        .iter()
        .find(|x| x.client == Client::ClaudeCode && x.kind == Kind::Mcp && x.name == "github")
        .unwrap();
    let hook = r
        .entities
        .iter()
        .find(|x| {
            x.client == Client::ClaudeCode
                && x.kind == Kind::Hook
                && x.name.starts_with("SessionStart")
        })
        .unwrap();
    let desk = find(&r, Client::ClaudeCode, Kind::Skill, "other-name");
    let items = vec![
        copy(&skill.id, "codex", ""),
        copy(&mcp.id, "codex", ""),
        copy(&hook.id, "codex", ""),
        copy(&desk.id, "claude-desktop", ""),
    ];
    let bp = write::plan_batch(&e.home, Some(&e.store), &items);
    assert_eq!(bp.plans.len(), 3);
    assert_eq!(bp.skipped.len(), 1);
    assert!(
        bp.skipped[0].contains("other-name") && bp.skipped[0].contains("Desktop"),
        "{:?}",
        bp.skipped
    );
    let (batch, done) = write::apply_batch(&e.home, &e.store, &items, &bp.batch_sha, ML).unwrap();
    assert_eq!(done.len(), 3);
    assert!(e.home.join(".codex/skills/demo-skill/SKILL.md").is_file());
    write::rollback_batch(&e.home, &e.store, &batch, ML).unwrap();
    assert_eq!(fs::read(&cfg).unwrap(), cfg0);
    assert_eq!(fs::read(&hooks).unwrap(), hooks0);
    assert!(!e.home.join(".codex/skills/demo-skill").exists());
}

#[test]
fn a_plugin_is_never_copied_and_every_target_says_why() {
    let e = env();
    let r = loadout_core::scan(&e.home);
    let pl = r
        .entities
        .iter()
        .find(|x| x.client == Client::ClaudeCode && x.kind == Kind::Plugin)
        .unwrap();
    assert_eq!(pl.copy_why.len(), 5);
    assert!(pl.copy_why["antigravity"].contains("agy plugin import claude"));
    assert!(write::plan(&e.home, Some(&e.store), &copy(&pl.id, "codex", "")).is_err());
}
