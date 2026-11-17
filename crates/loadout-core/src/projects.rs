//! Known projects: the folders that Claude Code (`~/.claude.json` → `projects`) and Codex (`[projects."…"]` in
//! `~/.codex/config.toml`) remember. The full scan does not open them (the owner has over a hundred, and the matrix would
//! change beyond recognition); one project is scanned on request, for copying its entries to another client.
//!
//! The window never sends a project path: only the opaque `id` from this list, which the core resolves again for every
//! plan, write and rollback. A folder that is the home folder itself is not a project (its `.claude/skills` is the user's).

use crate::model::{self, Client, CopyFrom, Kind, ScanResult};
use crate::{claude_code, codex, opencode, scan_mcp_servers, scan_skills, Ctx};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct Project {
    pub id: String,
    pub dir: PathBuf,
    /// The key under `projects` in `~/.claude.json`, as written there: a Claude Code local-scope copy lands under it.
    pub claude_key: Option<String>,
    /// Codex reads `<p>/.codex/config.toml` only in a trusted project.
    pub codex_trusted: bool,
}

fn norm(p: &Path) -> String {
    p.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

/// The id of a project folder: stable across scans, the same for both spellings of one folder.
pub(crate) fn id_of(dir: &Path) -> String {
    model::fnv1a(&["project", &norm(dir)])
}

pub fn known(home: &Path) -> Vec<Project> {
    let mut out: Vec<Project> = Vec::new();
    let home_n = norm(home);
    let mut add = |raw: &str, claude: bool, trusted: bool| {
        let Some(dir) = claude_code::project_dir(raw) else {
            return;
        };
        let n = norm(&dir);
        if n == home_n || !dir.is_dir() {
            return;
        }
        if let Some(p) = out.iter_mut().find(|p| norm(&p.dir) == n) {
            if claude && p.claude_key.is_none() {
                p.claude_key = Some(raw.to_owned());
            }
            p.codex_trusted |= trusted;
            return;
        }
        out.push(Project {
            id: id_of(&dir),
            dir,
            claude_key: claude.then(|| raw.to_owned()),
            codex_trusted: trusted,
        });
    };
    let claude: Option<Value> = std::fs::read_to_string(home.join(".claude.json"))
        .ok()
        .and_then(|t| serde_json::from_str(t.strip_prefix('\u{feff}').unwrap_or(&t)).ok());
    for key in claude
        .as_ref()
        .and_then(|v| v.get("projects"))
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|m| m.keys())
    {
        add(key, true, false);
    }
    for (key, trusted) in codex::projects(home) {
        add(&key, false, trusted);
    }
    out.sort_by_key(|p| norm(&p.dir));
    out
}

pub fn find(home: &Path, id: &str) -> Option<Project> {
    known(home).into_iter().find(|p| p.id == id)
}

/// The list for the window: id and the folder as shown (`~/…`, the home path scrubbed).
pub fn listing(home: &Path) -> Value {
    Value::Array(
        known(home)
            .iter()
            .map(|p| {
                json!({
                    "id": p.id,
                    "path": crate::scrub_home(home, &crate::tilde(home, &p.dir)),
                    "claude": p.claude_key.is_some(),
                    "codex": p.codex_trusted,
                })
            })
            .collect(),
    )
}

/// Project skill folders and the clients that read each (docs/TRANSFER.en.md §1).
pub(crate) const SKILL_DIRS: [(&str, &[Client]); 7] = [
    (".claude/skills", &[Client::ClaudeCode, Client::OpenCode]),
    (
        ".agents/skills",
        &[
            Client::Codex,
            Client::Antigravity,
            Client::DeepSeek,
            Client::OpenCode,
        ],
    ),
    (".codex/skills", &[Client::Codex]),
    (".agent/skills", &[Client::Antigravity]),
    (".dsh/skills", &[Client::DeepSeek]),
    (".opencode/skills", &[Client::OpenCode]),
    (".opencode/skill", &[Client::OpenCode]),
];

/// Entries of one project, all read only: write targets become copy sources.
pub fn scan(home: &Path, p: &Project) -> ScanResult {
    let mut c = Ctx {
        home: home.to_path_buf(),
        entities: Vec::new(),
        warnings: Vec::new(),
        opencode_system: None,
    };
    let scope = format!("project:{}", c.tilde(&p.dir));
    // Claude Code: the shared `.mcp.json` and the private local scope in `~/.claude.json`
    let shared = p.dir.join(".mcp.json");
    if let Some(v) = c.read_json(&shared) {
        let file = c.tilde(&shared);
        scan_mcp_servers(
            &mut c,
            Client::ClaudeCode,
            &file,
            "/mcpServers",
            &scope,
            v.get("mcpServers"),
            Some(&shared),
        );
    }
    if let Some(key) = &p.claude_key {
        let claude_json = home.join(".claude.json");
        if let Some(v) = c.read_json(&claude_json) {
            for (name, cfg) in v
                .pointer(&format!("/projects/{}/mcpServers", crate::esc_ptr(key)))
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
            {
                let e = claude_code::local_mcp(&c, &claude_json, key, name, cfg);
                c.push(e);
            }
        }
    }
    for (dir, clients) in SKILL_DIRS {
        for client in clients {
            scan_skills(&mut c, *client, &p.dir.join(dir), &scope);
        }
    }
    let toml = p.dir.join(".codex/config.toml");
    if let Some(text) = c.read_text(&toml) {
        match text.parse::<toml::Table>() {
            Ok(t) => {
                let root = serde_json::to_value(&t).unwrap_or(Value::Null);
                let shown = c.tilde(&toml);
                let first = c.entities.len();
                codex::mcp_servers(&mut c, &root, &toml, &shown, &scope);
                if !p.codex_trusted {
                    for e in &mut c.entities[first..] {
                        e.note = Some(crate::tr!(
                            "проект не отмечен доверенным в Codex: этот файл Codex не читает",
                            "the project is not trusted in Codex: Codex does not read this file"
                        ));
                    }
                }
            }
            Err(_) => c
                .warnings
                .push(crate::tr!("{}: не TOML", "{}: not TOML", c.tilde(&toml))),
        }
    }
    for f in opencode::FILES {
        opencode::project_mcp(&mut c, &p.dir.join(f), &scope);
    }
    for e in &mut c.entities {
        e.project = Some(p.id.clone());
        e.target = None;
        if let Some(s) = e.src.take() {
            e.copy_from.get_or_insert(CopyFrom::Entry(s));
        }
        if e.kind == Kind::Skill
            && e.client == Client::OpenCode
            && e.origin.file.contains("/.claude/skills/")
        {
            e.note = Some(crate::tr!(
                "OpenCode читает и .claude/skills проекта",
                "OpenCode also reads the project's .claude/skills"
            ));
        }
    }
    crate::finish(home, &mut c);
    ScanResult {
        entities: c.entities,
        warnings: c.warnings,
        facts: Default::default(),
    }
}
