//! Что слушать сторожу файлов и какие события считать значимыми. Сам `notify` подключён в `loadoutd`: ядро знает
//! только пути и правила, поэтому проверяется без файловой системы.
//!
//! Правила (CONCEPT.md §7): только известные конфиги и каталоги скилов; `plugins/cache`, `sessions`, `projects` и
//! подобные огромные каталоги не слушаем. Каталоги слушаются нерекурсивно с фильтром по имени файла: замена файла
//! через переименование рвёт наблюдение за самим файлом, а за каталогом — нет.

use crate::model::ScanResult;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

/// Один слушаемый каталог.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub recursive: bool,
    /// Значимо любое событие прямого потомка (каталоги, где записи — это подкаталоги), а не только известные имена.
    pub any_child: bool,
}

/// Имена файлов, изменение которых меняет результат скана.
const KNOWN_NAMES: [&str; 12] = [
    ".claude.json",
    "settings.json",
    "settings.local.json",
    "installed_plugins.json",
    "known_marketplaces.json",
    "config.toml",
    "hooks.json",
    "mcp_config.json",
    "plugin.json",
    "claude_desktop_config.json",
    "cordis.patch.yml",
    "skill.md",
];

/// (каталог относительно дома, рекурсивно, значим любой потомок)
const FIXED: [(&str, bool, bool); 19] = [
    (".", false, false), // `.claude.json` лежит в корне дома: события отфильтрует имя файла
    (".claude", false, false),
    (".claude/plugins", false, false),
    (".claude/skills", true, false),
    (".claude/agents", false, true),
    (".claude/commands", false, true),
    ("AppData/Roaming/Claude", false, false),
    (".codex", false, false),
    (".codex/skills", true, false),
    (".codex/plugins/cache/openai-curated-remote", false, true),
    (".gemini/config", false, false),
    (".gemini/config/plugins", false, true),
    (".gemini/config/skills", true, false),
    (".dsh", false, false),
    (".dsh/skills", true, false),
    (".dsh/profiles", false, true),
    (".gemini/antigravity/builtin/skills", true, false),
    (".gemini/antigravity-cli/builtin/skills", true, false),
    (".claude/plugins/marketplaces", false, true),
];

#[derive(Debug, Clone, Default)]
pub struct Targets {
    pub dirs: BTreeMap<PathBuf, Target>,
    /// Файлы, из которых собраны записи (в том числе динамические: `configPath` хуков dsh), в нормальном виде.
    files: HashSet<String>,
}

fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_ascii_lowercase()
}

/// Имена, события по которым никогда не значимы: копии, временные файлы, базы, чужие репозитории.
fn is_noise(n: &str) -> bool {
    n.contains("/node_modules/")
        || n.contains("/.git/")
        || n.contains("/plugins/cache/")
        || n.contains(".bak")
        || n.ends_with(".tmp")
        || n.ends_with(".lock")
        || n.contains(".tmp-")
        || n.contains(".sqlite")
        || n.ends_with(".log")
        || n.ends_with(".jsonl")
}

impl Targets {
    /// Каталоги и файлы по результату скана: постоянный набор плюс родители всех файлов, из которых собраны записи.
    pub fn from_scan(home: &Path, scan: &ScanResult) -> Self {
        let mut t = Targets::default();
        for (rel, recursive, any_child) in FIXED {
            let dir = if rel == "." {
                home.to_path_buf()
            } else {
                home.join(rel)
            };
            if dir.is_dir() {
                t.dirs.insert(
                    dir,
                    Target {
                        recursive,
                        any_child,
                    },
                );
            }
        }
        // профили dsh: свои патчи в `profiles/<имя>/`
        if let Ok(rd) = std::fs::read_dir(home.join(".dsh/profiles")) {
            for e in rd.flatten().filter(|e| e.path().is_dir()) {
                if e.file_name() != "node_modules" {
                    t.dirs.entry(e.path()).or_insert(Target {
                        recursive: false,
                        any_child: false,
                    });
                }
            }
        }
        for e in &scan.entities {
            let Some(rest) = e.origin.file.strip_prefix("~/") else {
                continue;
            };
            let file = home.join(rest);
            t.files.insert(norm(&file));
            if let Some(parent) = file.parent().filter(|p| p.is_dir()) {
                t.dirs.entry(parent.to_path_buf()).or_insert(Target {
                    recursive: false,
                    any_child: false,
                });
            }
        }
        t
    }

    /// Значимо ли событие по этому пути.
    pub fn is_relevant(&self, path: &Path) -> bool {
        let n = norm(path);
        if is_noise(&n) {
            return false;
        }
        if self.files.contains(&n) {
            return true;
        }
        let name = n.rsplit('/').next().unwrap_or("");
        if KNOWN_NAMES.contains(&name) {
            return true;
        }
        // потомок каталога, где значима любая запись (`plugins/<имя>/`, `profiles/<имя>/`, `agents/*.md`)
        let parent = path.parent();
        self.dirs
            .iter()
            .any(|(d, t)| t.any_child && parent.is_some_and(|p| norm(p) == norm(d)))
            // рекурсивные каталоги скилов: значимо появление и удаление скила и правка его `.md`
            || self.dirs.iter().any(|(d, t)| t.recursive && n.starts_with(&norm(d)) && (name.ends_with(".md") || path.extension().is_none()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Client, Entity, Kind, State};
    use std::fs;

    fn home() -> PathBuf {
        let h = std::env::temp_dir().join(format!("loadout-watch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&h);
        for d in [
            ".claude/skills",
            ".claude/plugins",
            ".codex",
            ".dsh/profiles/default",
            "extra",
        ] {
            fs::create_dir_all(h.join(d)).unwrap();
        }
        h
    }

    #[test]
    fn known_configs_are_relevant_and_noise_is_not() {
        let h = home();
        let t = Targets::from_scan(&h, &ScanResult::default());
        for rel in [
            ".claude.json",
            ".claude/settings.json",
            ".codex/config.toml",
            ".claude/plugins/installed_plugins.json",
            ".dsh/cordis.patch.yml",
        ] {
            assert!(t.is_relevant(&h.join(rel)), "{rel}");
        }
        for rel in [
            ".codex/config.toml.bak-1",
            ".claude/history.jsonl",
            ".codex/logs_2.sqlite-wal",
            ".claude/plugins/cache/mp/x/plugin.json",
            ".claude/settings.json.tmp",
            "node_modules/x/plugin.json",
        ] {
            assert!(!t.is_relevant(&h.join(rel)), "{rel}");
        }
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn dynamic_origin_files_extend_the_targets() {
        let h = home();
        let scan = ScanResult {
            entities: vec![Entity::new(
                Client::DeepSeek,
                Kind::Hook,
                "user",
                "h",
                State::On,
                "~/extra/my-hooks.json",
                "/hooks",
            )],
            ..ScanResult::default()
        };
        let t = Targets::from_scan(&h, &scan);
        assert!(
            t.dirs.contains_key(&h.join("extra")),
            "родитель файла хуков слушается"
        );
        assert!(t.is_relevant(&h.join("extra/my-hooks.json")));
        assert!(
            !t.is_relevant(&h.join("extra/other.json")),
            "чужие файлы в том же каталоге не значимы"
        );
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn new_skill_directory_and_md_are_relevant() {
        let h = home();
        let t = Targets::from_scan(&h, &ScanResult::default());
        assert!(
            t.is_relevant(&h.join(".claude/skills/new-skill")),
            "каталог скила"
        );
        assert!(t.is_relevant(&h.join(".claude/skills/new-skill/SKILL.md")));
        assert!(
            !t.is_relevant(&h.join(".claude/skills/new-skill/scripts/run.py")),
            "скрипты внутри скила не значимы"
        );
        let _ = fs::remove_dir_all(&h);
    }
}
