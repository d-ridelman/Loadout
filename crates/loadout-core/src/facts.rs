//! Facts about client directories that do not fit into entries: counters only, no file names.
//! Conclusions ("backup dump", "broken links") are drawn by the Doctor in one place, in the window (`app/src/renderer/doctor.ts`).

use crate::model::Client;
use serde::Serialize;
use std::fs;
use std::path::Path;

/// How many backup copies (`*.bak*`, `*.backup`, `*.recovery`) lie in the top level of a client directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFact {
    pub client: Client,
    pub dir: String,
    pub count: usize,
}

/// How many links (junction, symlink) point nowhere.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkFact {
    pub client: Client,
    pub dir: String,
    pub broken: usize,
    pub total: usize,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub backups: Vec<BackupFact>,
    pub broken_links: Vec<LinkFact>,
}

/// Directories where third-party installers run wild and backup copies pile up (checked on this machine).
pub const BACKUP_DIRS: [(Client, &str); 5] = [
    (Client::ClaudeCode, ".claude"),
    (Client::Codex, ".codex"),
    (Client::Antigravity, ".gemini/config"),
    (Client::DeepSeek, ".dsh"),
    (Client::OpenCode, ".config/opencode"),
];

pub fn is_backup_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains(".bak")
        || n.ends_with(".backup")
        || n.contains(".backup.")
        || n.ends_with(".recovery")
}

pub fn collect(home: &Path) -> Facts {
    let mut facts = Facts::default();
    for (client, rel) in BACKUP_DIRS {
        let Ok(rd) = fs::read_dir(home.join(rel)) else {
            continue;
        };
        let count = rd
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter(|e| is_backup_name(&e.file_name().to_string_lossy()))
            .count();
        if count > 0 {
            facts.backups.push(BackupFact {
                client,
                dir: format!("~/{rel}"),
                count,
            });
        }
    }
    // dsh packages lie in `profiles/node_modules/@deepseek-ai` as junctions into the `npx` cache; the cache gets cleaned, the links stay.
    let pkgs = home.join(".dsh/profiles/node_modules/@deepseek-ai");
    if let Ok(rd) = fs::read_dir(&pkgs) {
        let (mut total, mut broken) = (0, 0);
        for e in rd.flatten() {
            let p = e.path();
            if fs::read_link(&p).is_ok() {
                total += 1;
                if fs::metadata(&p).is_err() {
                    broken += 1;
                }
            }
        }
        if total > 0 {
            facts.broken_links.push(LinkFact {
                client: Client::DeepSeek,
                dir: "~/.dsh/profiles/node_modules/@deepseek-ai".to_owned(),
                broken,
                total,
            });
        }
    }
    facts
}

#[cfg(test)]
mod tests {
    use super::is_backup_name;

    #[test]
    fn backup_names() {
        for n in [
            "config.toml.bak",
            "cordis.patch.yml.glidehand-20261113-190220.bak",
            "mcp_config.json.rea.backup.4774417d.recovery",
            "x.json.backup",
        ] {
            assert!(is_backup_name(n), "{n}");
        }
        for n in ["config.toml", "hooks.json", "backups", "notes.md"] {
            assert!(!is_backup_name(n), "{n}");
        }
    }
}
