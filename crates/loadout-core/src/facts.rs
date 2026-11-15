//! Факты о каталогах клиентов, которые не вписываются в записи: только счётчики, без имён файлов.
//! Выводы («свалка бэкапов», «битые ссылки») делает Доктор в одном месте, в окне (`app/src/renderer/doctor.ts`).

use crate::model::Client;
use serde::Serialize;
use std::fs;
use std::path::Path;

/// Сколько резервных копий (`*.bak*`, `*.backup`, `*.recovery`) лежит в каталоге клиента верхнего уровня.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFact {
    pub client: Client,
    pub dir: String,
    pub count: usize,
}

/// Сколько ссылок (junction, symlink) указывает в никуда.
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

/// Каталоги, где хозяйничают сторонние установщики и копятся резервные копии (проверено на этой машине).
const BACKUP_DIRS: [(Client, &str); 4] = [
    (Client::ClaudeCode, ".claude"),
    (Client::Codex, ".codex"),
    (Client::Antigravity, ".gemini/config"),
    (Client::DeepSeek, ".dsh"),
];

fn is_backup_name(name: &str) -> bool {
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
    // Пакеты dsh лежат в `profiles/node_modules/@deepseek-ai` как junction'ы в кеш `npx`; кеш чистится, ссылки остаются.
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
