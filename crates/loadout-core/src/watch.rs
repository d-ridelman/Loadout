//! Что слушать сторожу файлов и какие события считать значимыми. Сам `notify` подключён в `loadoutd`: ядро знает
//! только пути и правила, поэтому проверяется без файловой системы.
//!
//! Правила (CONCEPT.md §7): только известные конфиги и каталоги скилов; `plugins/cache`, `sessions`, `projects` и
//! подобные огромные каталоги не слушаем. Каталоги слушаются нерекурсивно с фильтром по имени файла: замена файла
//! через переименование рвёт наблюдение за самим файлом, а за каталогом — нет.

use crate::facts::{is_backup_name, BACKUP_DIRS};
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
    /// Постоянные каталоги (даже ещё не созданные) и родители файлов-источников: их появление и исчезновение значимо.
    fixed: HashSet<String>,
    /// Каталоги клиентов, где считаются резервные копии (факты): появление `*.bak*` рядом с конфигом значимо.
    backup_dirs: HashSet<String>,
}

fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_ascii_lowercase()
}

/// Имена, события по которым никогда не значимы: копии, временные файлы, базы, чужие репозитории.
fn is_noise(n: &str) -> bool {
    n.contains("/node_modules/")
        || n.contains("/.git/")
        // кеш плагинов огромен, кроме удалённого каталога Codex: там записи — это подкаталоги
        || (n.contains("/plugins/cache/") && !n.contains("/plugins/cache/openai-curated-remote"))
        || n.contains(".bak")
        || n.ends_with(".tmp")
        || n.ends_with(".lock")
        || n.contains(".tmp-")
        || n.contains(".sqlite")
        || n.ends_with(".log")
        || n.ends_with(".jsonl")
}

/// Ближайший существующий предок отсутствующего каталога; несуществующие промежуточные предки кладёт в `fixed`,
/// чтобы их создание считалось значимым. Выше домашнего каталога не поднимается.
fn nearest_existing_ancestor(
    home: &Path,
    dir: &Path,
    fixed: &mut HashSet<String>,
) -> Option<PathBuf> {
    let mut anc = dir.parent()?;
    while anc != home && !anc.is_dir() {
        fixed.insert(norm(anc));
        anc = anc.parent()?;
    }
    anc.is_dir().then(|| anc.to_path_buf())
}

impl Targets {
    /// Каталоги и файлы по результату скана: постоянный набор плюс родители всех файлов, из которых собраны записи.
    pub fn from_scan(home: &Path, scan: &ScanResult) -> Self {
        let mut t = Targets::default();
        for (_, rel) in BACKUP_DIRS {
            t.backup_dirs.insert(norm(&home.join(rel)));
        }
        for (rel, recursive, any_child) in FIXED {
            let dir = if rel == "." {
                home.to_path_buf()
            } else {
                home.join(rel)
            };
            if rel != "." {
                t.fixed.insert(norm(&dir));
            }
            if dir.is_dir() {
                t.dirs.insert(
                    dir,
                    Target {
                        recursive,
                        any_child,
                    },
                );
            } else if let Some(ancestor) = nearest_existing_ancestor(home, &dir, &mut t.fixed) {
                // каталога ещё нет (клиент поставят позже): его появление увидит только ближайший существующий предок
                t.dirs.entry(ancestor).or_insert(Target {
                    recursive: false,
                    any_child: false,
                });
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
            if let Some(parent) = file.parent() {
                t.fixed.insert(norm(parent));
                if parent.is_dir() {
                    t.dirs.entry(parent.to_path_buf()).or_insert(Target {
                        recursive: false,
                        any_child: false,
                    });
                }
            }
        }
        for p in t.dirs.keys() {
            t.fixed.insert(norm(p));
        }
        t
    }

    /// Это сам постоянный или слушаемый каталог: его создание, удаление и переименование значимы
    /// (создание — новый клиент или каталог скилов, удаление — подписка на каталог умерла).
    pub fn is_fixed(&self, path: &Path) -> bool {
        self.fixed.contains(&norm(path))
    }

    /// Значимо ли событие по этому пути.
    pub fn is_relevant(&self, path: &Path) -> bool {
        let n = norm(path);
        // резервные копии не шум, а факт для Доктора, но только прямые потомки каталогов клиентов
        if path
            .file_name()
            .is_some_and(|f| is_backup_name(&f.to_string_lossy()))
            && path
                .parent()
                .is_some_and(|p| self.backup_dirs.contains(&norm(p)))
        {
            return true;
        }
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
        // свой каталог у каждого теста: они идут параллельно и стирают каталог при подготовке
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let h = std::env::temp_dir().join(format!(
            "loadout-watch-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&h);
        for d in [
            ".claude/skills",
            ".claude/plugins",
            ".codex/plugins/cache/openai-curated-remote",
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
            "extra/config.toml.bak-1",
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
    fn fixed_dirs_missing_at_start_are_relevant_when_they_appear() {
        let h = home(); // `.gemini/config` и `.claude/agents` не созданы
        let t = Targets::from_scan(&h, &ScanResult::default());
        for rel in [
            ".gemini/config",
            ".claude/agents",
            ".claude/skills",
            ".codex",
        ] {
            assert!(t.is_fixed(&h.join(rel)), "{rel}");
        }
        assert!(!t.is_fixed(&h.join(".claude/history")));
        assert!(
            !t.is_fixed(&h.join(".claude/skills/new-skill")),
            "потомок — не постоянный каталог"
        );
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn missing_dir_is_watched_through_its_nearest_existing_ancestor() {
        let h = home();
        fs::create_dir_all(h.join(".gemini")).unwrap(); // `.gemini/config` ещё нет
        let t = Targets::from_scan(&h, &ScanResult::default());
        assert!(t.dirs.contains_key(&h.join(".gemini")), "предок слушается");
        assert!(
            t.is_fixed(&h.join(".gemini/config")),
            "появление config значимо"
        );
        // `AppData/Roaming` нет совсем: промежуточные каталоги значимы, слушается дом
        assert!(t.is_fixed(&h.join("AppData")) && t.is_fixed(&h.join("AppData/Roaming")));
        assert!(t.dirs.contains_key(&h));
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn curated_remote_cache_is_not_noise_but_the_rest_of_the_cache_is() {
        let h = home();
        let t = Targets::from_scan(&h, &ScanResult::default());
        assert!(t.is_relevant(&h.join(".codex/plugins/cache/openai-curated-remote/github")));
        assert!(!t.is_relevant(&h.join(".claude/plugins/cache/mp/x/plugin.json")));
        let _ = fs::remove_dir_all(&h);
    }

    #[test]
    fn backups_next_to_client_configs_are_relevant_only_there() {
        let h = home();
        let t = Targets::from_scan(&h, &ScanResult::default());
        assert!(t.is_relevant(&h.join(".codex/config.toml.bak-1")));
        assert!(t.is_relevant(&h.join(".claude/settings.json.backup")));
        assert!(
            !t.is_relevant(&h.join(".claude/plugins/foo.json.bak")),
            "не прямой потомок каталога клиента"
        );
        assert!(!t.is_relevant(&h.join("extra/x.bak")));
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
