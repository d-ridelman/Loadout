//! R1 and R2 writes (CONCEPT.md §5): plan, preview, optimistic locking, backup, atomic write, verification, rollback.
//!
//! Outward there is only an intent (`Intent`: entry id and what to do with it): the write target (path and raw key) is taken
//! from a fresh scan inside the core, the page supplies no paths. The plan and journal hold no file contents: only the sanitized
//! name and pointer, the old and new value of one key (commands go through masking) and the `env` key names.
//!
//! Levels: R1 is a boolean flag; R2 is moving to trash and restoring, editing an MCP command, copying between clients.

use crate::edit;
use crate::mask;
use crate::model::{Client, Entity, Format, Kind, ScanResult, Source, State, Target, TargetKind};
use crate::tilde;
use crate::trash;
use crate::yaml_edit;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub mod retention;
pub mod skill;
pub(crate) mod transfer;

pub use retention::{prune as prune_backups, Pruned};

#[cfg(test)]
mod race_tests;
#[cfg(test)]
mod retention_tests;
#[cfg(test)]
mod skill_tests;

/// Why an entry cannot be toggled (shown in the inspector).
pub fn why_not(e: &Entity) -> String {
    match (e.client, e.kind) {
        (Client::ClaudeCode, Kind::Plugin) if e.state == State::Broken => {
            crate::tr!(
                "плагин не установлен: переключать нечего",
                "plugin is not installed: nothing to toggle"
            )
        }
        (Client::ClaudeCode, Kind::Plugin) => {
            crate::tr!(
                "плагин установлен не в области user: его флаг включения лежит в настройках проекта (или в управляемых), а их Loadout только читает",
                "the plugin is not installed in scope user: its enable flag is in the project (or managed) settings, which Loadout only reads"
            )
        }
        (Client::Codex, Kind::Connector) => {
            crate::tr!(
                "запись кеша каталога удалённых плагинов, а не подключение",
                "an entry of the remote plugin catalog cache, not a connection"
            )
        }
        (Client::ClaudeCode, Kind::Connector) => {
            crate::tr!(
                "запрещён в deniedMcpServers по имени: ключ disableClaudeAiConnectors этого не снимает",
                "denied by name in deniedMcpServers: the disableClaudeAiConnectors key does not lift this"
            )
        }
        (Client::DeepSeek, Kind::Mcp) => {
            crate::tr!(
                "запись не определилась как блок `- id: …` в cordis.patch.yml: вынос по строкам для неё не поддержан",
                "the entry was not recognized as a `- id: …` block in cordis.patch.yml: line-based removal is not supported for it"
            )
        }
        (Client::OpenCode, _) if e.scope == "managed" => crate::tr!(
            "запись из системного конфига OpenCode (%ProgramData%\\opencode): его меняет администратор, Loadout только читает",
            "an entry of the OpenCode system config (%ProgramData%\\opencode): an administrator changes it, Loadout only reads it"
        ),
        (_, Kind::Mcp) => crate::tr!(
            "запись лежит в проекте или в плагине: их файлы Loadout не правит",
            "the entry is in a project or a plugin: Loadout does not edit their files"
        ),
        _ => crate::tr!(
            "правка записей этого типа не поддержана",
            "editing entries of this type is not supported"
        ),
    }
}

fn enabled(s: State) -> Option<bool> {
    match s {
        State::On | State::Stale | State::Cloud => Some(true),
        State::Off => Some(false),
        State::Broken | State::Unknown => None,
    }
}

/// Only these client files may be written, whatever path the entry or manifest holds.
/// Loadout never writes to `antigravity/mcp/*` or plugin files.
fn allowed(home: &Path, file: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").to_lowercase();
    let fixed = [
        ".claude/settings.json",
        ".claude.json",
        ".codex/config.toml",
        ".codex/hooks.json",
        "AppData/Roaming/Claude/claude_desktop_config.json",
        ".gemini/config/mcp_config.json",
        ".config/opencode/opencode.json",
        ".config/opencode/opencode.jsonc",
    ]
    .iter()
    .any(|rel| norm(&home.join(rel)) == norm(file));
    // DeepSeek: the user's patch and profile patches `~/.dsh/profiles/<name>/cordis.patch.yml`
    let dsh = norm(&home.join(".dsh"));
    let patch = norm(file)
        .strip_prefix(&format!("{dsh}/"))
        .is_some_and(|rest| {
            rest == "cordis.patch.yml"
                || rest
                    .strip_prefix("profiles/")
                    .and_then(|r| r.strip_suffix("/cordis.patch.yml"))
                    .is_some_and(|n| !n.is_empty() && !n.contains('/') && n != "node_modules")
        });
    fixed || patch || transfer::project_file(home, file).is_some()
}

pub(crate) fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// What the user wants to do. All fields come from the window, so they are validated when the plan is built.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Intent {
    /// Enable or disable an entry (flag, trash or stash: the core picks by target).
    Toggle { entity: String, enable: bool },
    /// Replace the MCP `command` and `args` entirely. The window does not receive the old values.
    Edit {
        entity: String,
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
    /// Copy an MCP server, a skill or a hook to another client (`to` is the client's short name), in the same place:
    /// a user entry to the user scope, a project entry to the same project. `project` is the opaque id of the project
    /// the entry was found in (`projects.rs`); empty for an entry of the full scan.
    Copy {
        entity: String,
        to: String,
        #[serde(default)]
        project: String,
    },
    /// Add a new MCP server to a client: local (`command`, `args`, `env`) or remote (`url`).
    /// The `env` values are typed by the user; they do not reach the plan or journal, only the key names.
    Add {
        to: String,
        name: String,
        #[serde(default)]
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        url: String,
        #[serde(default)]
        env: Vec<EnvPair>,
    },
    /// Install a Claude Code skill from the staging directory `<backups>/staging/<stage>` (filled by main).
    InstallSkill {
        stage: String,
        #[serde(default)]
        sub: String,
        name: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EnvPair {
    pub key: String,
    pub value: String,
}

impl Intent {
    fn entity(&self) -> &str {
        match self {
            Intent::Toggle { entity, .. }
            | Intent::Edit { entity, .. }
            | Intent::Copy { entity, .. } => entity,
            Intent::Add { .. } | Intent::InstallSkill { .. } => "",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// `toggle`, `edit` or `copy`.
    pub op: String,
    /// Which write level is needed: `R1` or `R2`.
    pub level: String,
    pub entity: String,
    /// The client whose file we write to (for copying, the target).
    pub client: Client,
    pub kind: Kind,
    pub name: String,
    pub file: String,
    pub pointer: String,
    pub enable: bool,
    /// Value before and after: `true`/`false`, "enabled", "in Loadout trash" or a masked command.
    pub from: String,
    pub to: String,
    /// The entry is already in the desired state, nothing to write.
    pub noop: bool,
    /// Other entries changed by the same key (all `disableClaudeAiConnectors` connectors).
    pub affects: Vec<String>,
    /// What to know before confirming (what is not carried over, which `env` keys are copied).
    pub notes: Vec<String>,
    /// Notes the window highlights: a risk to read before confirming (secrets landing in a project folder, a hook
    /// that will not run until trusted).
    pub warn: Vec<String>,
    /// Loadout trash: `out` moves the entry into it, `in` returns it from it, empty means untouched.
    /// The window picks the button label by this field, not by the text of `from`/`to` (it depends on the language).
    pub trash: String,
    pub base_sha: String,
}

struct TrashChange {
    id: String,
    before: Option<trash::Item>,
    after: Option<trash::Item>,
}

struct Prepared {
    plan: Plan,
    entity: String,
    file: PathBuf,
    old: Vec<u8>,
    new: Vec<u8>,
    trash: Option<TrashChange>,
    /// For moved and restored entries rollback is the inverse operation, not a restore of the whole file.
    inverse_enable: Option<bool>,
    /// The file does not exist yet (`old` is empty): the write creates it, and the rollback removes it.
    created: bool,
}

fn find<'a>(scan: &'a ScanResult, id: &str) -> Result<&'a Entity, String> {
    scan.entities.iter().find(|e| e.id == id).ok_or_else(|| {
        crate::tr!(
            "запись не найдена: обновите список",
            "entry not found: refresh the list"
        )
    })
}

/// A client file: from the allow list and not a symlink (the write would replace the link, not the file behind it).
fn guard_file(home: &Path, file: &Path) -> Result<(), String> {
    if !allowed(home, file) {
        return Err(crate::tr!(
            "файл не входит в список разрешённых для записи",
            "the file is not on the list of files allowed for writing"
        ));
    }
    match std::fs::symlink_metadata(file) {
        Ok(m) if m.file_type().is_symlink() => Err(crate::tr!(
            "файл клиента — символьная ссылка: запись заменила бы ссылку, а не файл",
            "the client file is a symbolic link: writing would replace the link, not the file"
        )),
        _ => Ok(()),
    }
}

fn read_text(file: &Path) -> Result<(Vec<u8>, String), String> {
    let old = std::fs::read(file)
        .map_err(|_| crate::tr!("файл клиента не прочитан", "could not read the client file"))?;
    let text = String::from_utf8(old.clone())
        .map_err(|_| crate::tr!("файл клиента не в UTF-8", "the client file is not UTF-8"))?;
    Ok((old, text))
}

fn masked_line(tokens: &[String]) -> String {
    mask::join_line(&mask::mask_args(tokens))
}

fn tokens_of(entry: &Value) -> Vec<String> {
    let mut t: Vec<String> = entry
        .get("command")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .into_iter()
        .collect();
    if let Some(a) = entry.get("args").and_then(Value::as_array) {
        t.extend(a.iter().filter_map(|x| x.as_str().map(str::to_owned)));
    }
    t
}

/// The place a write lands, as the plan, the journal and the inspector name it: the real file (`~` form) and the key in it.
/// The entry's `origin` is where the scan found it, which for Claude Code plugins and connectors is another file.
pub(crate) fn locate(
    home: &Path,
    file: &Path,
    format: Format,
    path: &[String],
    entry: &Entity,
) -> (String, String) {
    let pointer = match format {
        Format::Json => path
            .iter()
            .map(|k| format!("/{}", crate::esc_ptr(k)))
            .collect(),
        Format::Toml => path
            .iter()
            .map(|k| crate::codex::toml_key(k))
            .collect::<Vec<_>>()
            .join("."),
        // DeepSeek's path is positional (operation and entry numbers): the scan pointer names the entry
        Format::Yaml => entry.origin.pointer.clone(),
    };
    (tilde(home, file), pointer)
}

/// Where switching `e` writes. Coming back from the owner's stash lands in `mcpServers`, not in the stash key.
pub(crate) fn toggle_place(home: &Path, e: &Entity, t: &Target) -> (String, String) {
    match (&t.kind, t.path.last()) {
        (TargetKind::Restore(Source::Stash(_)), Some(key)) => locate(
            home,
            &t.file,
            t.format,
            &["mcpServers".to_owned(), key.clone()],
            e,
        ),
        _ => locate(home, &t.file, t.format, &t.path, e),
    }
}

fn plan_for(e: &Entity, op: &str, level: &str, at: (String, String), old: &[u8]) -> Plan {
    let (file, pointer) = at;
    Plan {
        op: op.to_owned(),
        level: level.to_owned(),
        entity: e.id.clone(),
        client: e.client,
        kind: e.kind,
        name: e.name.clone(),
        file,
        pointer,
        enable: true,
        from: String::new(),
        to: String::new(),
        noop: false,
        affects: Vec::new(),
        notes: Vec::new(),
        warn: Vec::new(),
        trash: String::new(),
        base_sha: sha(old),
    }
}

fn empty_path() -> String {
    crate::tr!("пустой путь", "empty path")
}

fn cannot_restore(e: impl std::fmt::Display) -> String {
    crate::tr!(
        "вернуть запись нельзя: {e}",
        "cannot restore the entry: {e}"
    )
}

fn target_file_missing() -> String {
    crate::tr!(
        "файл клиента-получателя не найден: клиент не установлен",
        "the target client file was not found: the client is not installed"
    )
}

fn entry_missing() -> String {
    crate::tr!("записи нет в файле", "the entry is not in the file")
}

fn bad_yaml_path() -> String {
    crate::tr!("неверный путь записи YAML", "invalid YAML entry path")
}

/// Operation index and entry index from a DeepSeek target path (`[oi, "insert", ei]`).
fn yaml_pos(path: &[String]) -> Result<(usize, usize), String> {
    match path {
        [oi, k, ei] if k == "insert" => Ok((
            oi.parse().map_err(|_| bad_yaml_path())?,
            ei.parse().map_err(|_| bad_yaml_path())?,
        )),
        _ => Err(bad_yaml_path()),
    }
}

fn prep_toggle(
    home: &Path,
    store: Option<&Path>,
    scan: &ScanResult,
    id: &str,
    enable: bool,
) -> Result<Prepared, String> {
    let e = find(scan, id)?;
    let t = e.target.clone().ok_or_else(|| why_not(e))?;
    guard_file(home, &t.file)?;
    let (old, text) = read_text(&t.file)?;
    let mut plan = plan_for(e, "toggle", "R1", toggle_place(home, e, &t), &old);
    plan.enable = enable;
    let mut new = old.clone();
    let (mut trash, mut inverse) = (None, None);
    match &t.kind {
        TargetKind::Flag => {
            let cur = edit::get_bool(t.format, &text, &t.path)?;
            // `disableClaudeAiConnectors: true` means "disabled"
            let want = enable != t.inverted;
            plan.noop = cur == Some(want) || (cur.is_none() && enabled(e.state) == Some(enable));
            // Words "enabled/disabled" rather than the key value: for `disableClaudeAiConnectors`, `true` means "disabled".
            let word = |on: bool| {
                if on {
                    crate::tr!("включено", "enabled")
                } else {
                    crate::tr!("выключено", "disabled")
                }
            };
            plan.from = cur.map_or_else(
                || crate::tr!("не задан", "not set"),
                |b| word(b != t.inverted),
            );
            plan.to = word(enable);
            if !plan.noop {
                new = edit::set_bool(t.format, &text, &t.path, want)?.into_bytes();
            }
            plan.affects = scan
                .entities
                .iter()
                .filter(|o| {
                    o.id != e.id
                        && o.target
                            .as_ref()
                            .is_some_and(|x| x.file == t.file && x.path == t.path)
                })
                .map(|o| o.id.clone())
                .collect();
        }
        TargetKind::Cut => {
            plan.level = "R2".into();
            plan.noop = enable;
            plan.from = crate::tr!("включено", "enabled");
            plan.to = if enable {
                crate::tr!("включено", "enabled")
            } else {
                crate::tr!("в корзине Loadout", "in Loadout trash")
            };
            if !enable {
                plan.trash = "out".into();
                let (key, parent) = t.path.split_last().ok_or_else(empty_path)?;
                let stale = store.and_then(|s| trash::read(s, &e.id));
                let ((nt, raw), anchor) = match t.format {
                    Format::Yaml => {
                        let (oi, ei) = yaml_pos(&t.path)?;
                        let anchor = yaml_edit::anchor_of(&text, oi, ei)?;
                        (yaml_edit::cut(&text, oi, ei)?, anchor)
                    }
                    // the next key, so the return puts the entry back in its place, not at the end
                    _ => (
                        edit::cut_json(&text, &t.path)?,
                        edit::next_key(&text, &t.path)?,
                    ),
                };
                // A copy with this id in the trash while the entry is alive in the file is a trace of an earlier move (entry restored by hand).
                // The same text can be overwritten (the earlier copy stays in the manifest), a different one cannot: it would be lost.
                if stale.as_ref().is_some_and(|s| s.value != raw) {
                    return Err(crate::tr!(
                        "в корзине уже лежит другая запись с этим id: верните её (включите) или разберитесь вручную, иначе она потеряется",
                        "Loadout trash already holds a different entry with this id: restore it (enable) or sort it out manually, otherwise it will be lost"
                    ));
                }
                new = nt.into_bytes();
                trash = Some(TrashChange {
                    id: e.id.clone(),
                    before: stale,
                    after: Some(trash::Item {
                        anchor,
                        id: e.id.clone(),
                        format: if t.format == Format::Yaml {
                            "yaml"
                        } else {
                            "json"
                        }
                        .to_owned(),
                        client: e.client.slug().to_owned(),
                        scope: e.scope.clone(),
                        name: e.name.clone(),
                        file: e.origin.file.clone(),
                        pointer: e.origin.pointer.clone(),
                        path: t.file.to_string_lossy().into_owned(),
                        parent: parent.to_vec(),
                        key: key.clone(),
                        value: raw,
                        time: now_ms(),
                    }),
                });
                inverse = Some(true);
                plan.notes.push(crate::tr!(
                    "Запись вырезается из файла клиента и лежит в корзине Loadout; клиент её больше не запускает. Включение вернёт её на то же место.",
                    "The entry is cut out of the client file and kept in Loadout trash; the client no longer launches it. Enabling puts it back in the same place."
                ));
            }
        }
        TargetKind::Restore(src) => {
            plan.level = "R2".into();
            plan.noop = !enable;
            if matches!(src, Source::Trash(_)) {
                plan.trash = "in".into();
            }
            plan.from = match src {
                Source::Trash(_) => crate::tr!("в корзине Loadout", "in Loadout trash"),
                Source::Stash(_) => crate::tr!("в стэше владельца", "in the owner's stash"),
            };
            plan.to = if enable {
                crate::tr!("включено", "enabled")
            } else {
                plan.from.clone()
            };
            if enable {
                let (base, raw, live, before) = match src {
                    Source::Trash(tid) => {
                        let s = store.ok_or_else(|| {
                            crate::tr!(
                                "корзина недоступна: ядро запущено без каталога бэкапов",
                                "trash is unavailable: the core runs without a backup directory"
                            )
                        })?;
                        let it = trash::read(s, tid).ok_or_else(|| {
                            crate::tr!("запись корзины не найдена", "trash entry not found")
                        })?;
                        if Path::new(&it.path) != t.file {
                            return Err(crate::tr!(
                                "запись корзины относится к другому файлу",
                                "the trash entry belongs to a different file"
                            ));
                        }
                        let mut live = it.parent.clone();
                        live.push(it.key.clone());
                        let raw = it.value.clone();
                        if it.format == "yaml" {
                            // put the DeepSeek lines back in their former place in the list (`yaml_edit::put` checks the result)
                            let (oi, ei) = yaml_pos(&t.path)?;
                            yaml_edit::check_anchor(&text, oi, it.anchor.as_deref())
                                .map_err(cannot_restore)?;
                            let put =
                                yaml_edit::put(&text, oi, ei, &raw).map_err(cannot_restore)?;
                            trash = Some(TrashChange {
                                id: tid.clone(),
                                before: Some(it),
                                after: None,
                            });
                            return Ok(Prepared {
                                plan,
                                entity: e.id.clone(),
                                file: t.file,
                                old,
                                new: put.into_bytes(),
                                trash,
                                inverse_enable: Some(false),
                                created: false,
                            });
                        }
                        let before = it.anchor.clone();
                        trash = Some(TrashChange {
                            id: tid.clone(),
                            before: Some(it),
                            after: None,
                        });
                        (text.clone(), raw, live, before)
                    }
                    Source::Stash(_) => {
                        plan.notes.push(crate::tr!(
                            "Запись переносится из {} в mcpServers того же файла.",
                            "The entry moves from {} to mcpServers in the same file.",
                            t.path.first().map_or("", String::as_str)
                        ));
                        let (nt, raw) = edit::cut_json(&text, &t.path)?;
                        let key = t.path.last().ok_or_else(empty_path)?.clone();
                        (nt, raw, vec!["mcpServers".to_owned(), key], None)
                    }
                };
                new = edit::put_raw_json(&base, &live, &raw, false, before.as_deref())
                    .map_err(cannot_restore)?
                    .into_bytes();
                inverse = Some(false);
            }
        }
    }
    Ok(Prepared {
        plan,
        entity: e.id.clone(),
        file: t.file,
        old,
        new,
        trash,
        inverse_enable: inverse,
        created: false,
    })
}

fn clean_arg(s: &str) -> bool {
    s.len() <= 500 && !s.chars().any(char::is_control)
}

fn prep_edit(
    home: &Path,
    scan: &ScanResult,
    id: &str,
    command: &str,
    args: &[String],
) -> Result<Prepared, String> {
    let e = find(scan, id)?;
    let s = e.src.clone().ok_or_else(|| {
        crate::tr!(
            "запись нельзя править: она не в файле клиента",
            "the entry cannot be edited: it is not in a client file"
        )
    })?;
    guard_file(home, &s.file)?;
    if command.trim().is_empty() || !clean_arg(command) {
        return Err(crate::tr!(
            "команда пустая, слишком длинная или с управляющими символами",
            "the command is empty, too long, or contains control characters"
        ));
    }
    if args.len() > 64 || !args.iter().all(|a| clean_arg(a)) {
        return Err(crate::tr!(
            "аргументы: не больше 64, до 500 знаков, без управляющих символов",
            "arguments: at most 64, up to 500 characters each, no control characters"
        ));
    }
    let (old, text) = read_text(&s.file)?;
    let raw = edit::get_value(s.format, &text, &s.path)?.ok_or_else(entry_missing)?;
    let opencode = e.client == Client::OpenCode;
    let entry = if opencode {
        crate::opencode::to_common(&raw)
    } else {
        raw
    };
    if entry.get("command").and_then(Value::as_str).is_none() {
        return Err(crate::tr!(
            "у записи нет command: это не локальный сервер (адрес править нельзя)",
            "the entry has no command: it is not a local server (the address cannot be edited)"
        ));
    }
    let key = |k: &str| {
        let mut p = s.path.clone();
        p.push(k.to_owned());
        p
    };
    let mut new_text = if opencode {
        // OpenCode keeps the program and its arguments in one `command` array
        let mut all = vec![command.to_owned()];
        all.extend(args.iter().cloned());
        edit::put_value(s.format, &text, &key("command"), &json!(all), true)?
    } else {
        edit::put_value(s.format, &text, &key("command"), &json!(command), true)?
    };
    if !opencode && (!args.is_empty() || entry.get("args").is_some()) {
        new_text = edit::put_value(s.format, &new_text, &key("args"), &json!(args), true)?;
    }
    let at = locate(home, &s.file, s.format, &s.path, e);
    let mut plan = plan_for(e, "edit", "R2", at, &old);
    plan.from = masked_line(&tokens_of(&entry));
    let mut now = vec![command.to_owned()];
    now.extend(args.iter().cloned());
    plan.to = masked_line(&now);
    plan.noop = new_text.as_bytes() == old.as_slice();
    plan.notes.push(crate::tr!(
        "Заменяются только command и args; env и заголовки не меняются. Секретные на вид значения в предпросмотре и журнале скрыты.",
        "Only command and args are replaced; env and headers are unchanged. Secret-looking values are hidden in the preview and the journal."
    ));
    Ok(Prepared {
        plan,
        entity: e.id.clone(),
        file: s.file,
        old,
        new: new_text.into_bytes(),
        trash: None,
        inverse_enable: None,
        created: false,
    })
}

/// File, format and key holding MCP entries for the target client.
fn client_target(home: &Path, c: Client) -> Option<(PathBuf, Format, &'static str)> {
    Some(match c {
        Client::ClaudeCode => (home.join(".claude.json"), Format::Json, "mcpServers"),
        Client::ClaudeDesktop => (
            home.join("AppData/Roaming/Claude/claude_desktop_config.json"),
            Format::Json,
            "mcpServers",
        ),
        Client::Antigravity => (
            home.join(".gemini/config/mcp_config.json"),
            Format::Json,
            "mcpServers",
        ),
        Client::Codex => (home.join(".codex/config.toml"), Format::Toml, "mcp_servers"),
        // the key path depends on the file's schema generation: see `mcp_root`
        Client::OpenCode => {
            let dir = home.join(crate::opencode::DIR);
            let file = crate::opencode::FILES
                .iter()
                .map(|f| dir.join(f))
                .find(|p| p.is_file())
                .unwrap_or_else(|| dir.join(crate::opencode::FILES[0]));
            (file, Format::Json, "mcp")
        }
        Client::DeepSeek => return None,
    })
}

/// Keys from the target file's root to its MCP object.
fn mcp_root(dest: Client, root: &str, text: &str) -> Result<Vec<String>, String> {
    if dest == Client::OpenCode {
        crate::opencode::servers_path_of(text)
    } else {
        Ok(vec![root.to_owned()])
    }
}

/// A translated entry as the target client writes it.
fn written_as(dest: Client, value: &Value) -> Value {
    if dest == Client::OpenCode {
        crate::opencode::from_common(value)
    } else {
        value.clone()
    }
}

fn prep_add(
    home: &Path,
    scan: &ScanResult,
    a: (&str, &str, &str, &[String], &str, &[EnvPair]),
) -> Result<Prepared, String> {
    let (to, name, command, args, url, env) = a;
    let dest =
        Client::from_slug(to).ok_or_else(|| crate::tr!("неизвестный клиент", "unknown client"))?;
    let (file, format, root) = client_target(home, dest).ok_or_else(|| {
        crate::tr!(
            "в этого клиента добавлять нельзя: формат файла не поддержан",
            "adding to this client is not possible: the file format is not supported"
        )
    })?;
    guard_file(home, &file)?;
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || mask::safe_name(name).is_none()
    {
        return Err(crate::tr!(
            "имя: до 64 знаков из букв, цифр, `-`, `_` и `.`",
            "name: up to 64 characters: letters, digits, `-`, `_` and `.`"
        ));
    }
    let remote = !url.trim().is_empty();
    let local = !command.trim().is_empty();
    if remote == local {
        return Err(crate::tr!(
            "нужен либо command (локальный сервер), либо url (удалённый), но не оба сразу",
            "either command (local server) or url (remote) is required, but not both"
        ));
    }
    let mut value = serde_json::Map::new();
    let mut shown: Vec<String>;
    if local {
        if !clean_arg(command) || args.len() > 64 || !args.iter().all(|a| clean_arg(a)) {
            return Err(crate::tr!(
                "команда и аргументы: до 500 знаков, без управляющих символов, аргументов не больше 64",
                "command and arguments: up to 500 characters, no control characters, at most 64 arguments"
            ));
        }
        value.insert("command".into(), json!(command.trim()));
        if !args.is_empty() {
            value.insert("args".into(), json!(args));
        }
        if env.len() > 30 {
            return Err(crate::tr!(
                "слишком много переменных окружения",
                "too many environment variables"
            ));
        }
        let mut envm = serde_json::Map::new();
        for p in env {
            let ok = !p.key.is_empty()
                && p.key.len() <= 64
                && p.key.chars().enumerate().all(|(i, c)| {
                    c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
                });
            if !ok || !clean_arg(&p.value) || envm.contains_key(&p.key) {
                // the name is not printed in the message: a pasted secret could have ended up there
                return Err(crate::tr!(
                    "переменная окружения: имя из букв, цифр и `_` (до 64), значение без управляющих символов, без повторов",
                    "environment variable: name of letters, digits and `_` (up to 64), value without control characters, no duplicates"
                ));
            }
            envm.insert(p.key.clone(), json!(p.value));
        }
        if !envm.is_empty() {
            value.insert("env".into(), Value::Object(envm));
        }
        shown = vec![command.trim().to_owned()];
        shown.extend(args.iter().cloned());
    } else {
        let u = url.trim();
        // The remote server form is verified only for Claude Code (`type: http` + `url`), Codex (`url`) and OpenCode
        // (`type: remote` + `url`); shortcut: Desktop and Antigravity, after checking against their documentation
        if !matches!(dest, Client::ClaudeCode | Client::Codex | Client::OpenCode) {
            return Err(crate::tr!(
                "удалённый сервер можно добавить только в Claude Code, Codex и OpenCode: форма записи у остальных клиентов не проверена",
                "a remote server can only be added to Claude Code, Codex and OpenCode: the entry format for other clients has not been verified"
            ));
        }
        let host = u.split_once("://").map_or("", |(_, rest)| {
            rest.split(['/', '?', '#']).next().unwrap_or("")
        });
        let valid = (u.starts_with("https://") || u.starts_with("http://"))
            && !host.is_empty()
            && !host.starts_with(['@', ':'])
            && u.len() <= 500
            && !u.chars().any(|c| c.is_control() || c.is_whitespace());
        if !valid || !env.is_empty() {
            return Err(crate::tr!(
                "адрес: http:// или https:// без пробелов, для удалённого сервера env не задаётся",
                "address: http:// or https:// without spaces; env is not set for a remote server"
            ));
        }
        value.insert("url".into(), json!(u));
        if dest == Client::ClaudeCode {
            value.insert("type".into(), json!("http"));
        }
        shown = vec![u.to_owned()];
    }
    let (old, text) = read_text(&file).map_err(|_| target_file_missing())?;
    let mut path = mcp_root(dest, root, &text)?;
    path.push(name.to_owned());
    if edit::get_value(format, &text, &path)?.is_some()
        || scan
            .entities
            .iter()
            .any(|o| o.client == dest && o.kind == Kind::Mcp && o.scope == "user" && o.name == name)
    {
        return Err(crate::tr!(
            "у этого клиента уже есть запись с таким именем",
            "this client already has an entry with this name"
        ));
    }
    let new_text = edit::put_value(
        format,
        &text,
        &path,
        &written_as(dest, &Value::Object(value)),
        false,
    )?;
    let env_keys: Vec<String> = env.iter().map(|p| mask::scrub_words(&p.key)).collect();
    let mut notes = vec![crate::tr!(
        "Новая запись добавляется в конфиг клиента; клиент подхватит её при следующем запуске.",
        "The new entry is added to the client config; the client picks it up on its next launch."
    )];
    if !env_keys.is_empty() {
        notes.push(crate::tr!(
            "Переменные окружения: {}. Значения записываются как введены и в окне больше не показываются.",
            "Environment variables: {}. Values are written as entered and are no longer shown in the window.",
            env_keys.join(", ")
        ));
    }
    let pointer = match format {
        Format::Toml => crate::codex::toml_key(root) + "." + &crate::codex::toml_key(name),
        _ => path
            .iter()
            .map(|k| format!("/{}", crate::esc_ptr(k)))
            .collect(),
    };
    let plan = Plan {
        op: "add".into(),
        level: "R2".into(),
        entity: String::new(),
        client: dest,
        kind: Kind::Mcp,
        name: name.to_owned(),
        file: tilde(home, &file),
        pointer,
        enable: true,
        from: crate::tr!("нет записи", "no entry"),
        to: crate::tr!("добавить: {}", "add: {}", masked_line(&shown)),
        noop: false,
        affects: Vec::new(),
        notes,
        warn: Vec::new(),
        trash: String::new(),
        base_sha: sha(&old),
    };
    Ok(Prepared {
        plan,
        entity: String::new(),
        file,
        old,
        new: new_text.into_bytes(),
        trash: None,
        inverse_enable: None,
        created: false,
    })
}

fn prepare(
    home: &Path,
    store: Option<&Path>,
    scan: &ScanResult,
    i: &Intent,
) -> Result<Prepared, String> {
    let mut p = prepare_raw(home, store, scan, i)?;
    // The plan and journal receive the typed command and copied arguments: the home directory path in them becomes `~`
    for s in [&mut p.plan.from, &mut p.plan.to, &mut p.plan.file] {
        *s = crate::scrub_home(home, s);
    }
    // the key comes from the file, like the scan pointer: token-like words in it are hidden the same way (see `Entity::fs_named`)
    p.plan.pointer = crate::scrub_home(home, &p.plan.pointer);
    if !scan.entities.iter().any(|e| e.id == p.entity && e.fs_named) {
        p.plan.pointer = mask::scrub_words(&p.plan.pointer);
    }
    for n in &mut p.plan.notes {
        *n = crate::scrub_home(home, n);
    }
    Ok(p)
}

fn prepare_raw(
    home: &Path,
    store: Option<&Path>,
    scan: &ScanResult,
    i: &Intent,
) -> Result<Prepared, String> {
    match i {
        Intent::Toggle { entity, enable } => prep_toggle(home, store, scan, entity, *enable),
        Intent::Edit {
            entity,
            command,
            args,
        } => prep_edit(home, scan, entity, command, args),
        Intent::Copy { entity, to, .. } => transfer::prep_copy(home, scan, entity, to),
        Intent::Add {
            to,
            name,
            command,
            args,
            url,
            env,
        } => prep_add(home, scan, (to, name, command, args, url, env)),
        Intent::InstallSkill { .. } => Err(crate::tr!(
            "установка скила не входит в пакет",
            "skill installation is not part of a batch"
        )),
    }
}

/// The scan an intent is checked against: the full one, plus the entries of the project a copy comes from.
fn scan_for(home: &Path, store: Option<&Path>, i: &Intent) -> Result<ScanResult, String> {
    let mut scan = crate::scan_with(home, store);
    if let Intent::Copy { project, .. } = i {
        if !project.is_empty() {
            let p = crate::projects::find(home, project).ok_or_else(|| {
                crate::tr!(
                    "проект не найден: обновите список",
                    "project not found: refresh the list"
                )
            })?;
            scan.entities
                .extend(crate::projects::scan(home, &p).entities);
        }
    }
    Ok(scan)
}

/// A copy of a skill: a folder, not a key in a file, so it goes through `skill.rs`.
fn skill_copy(scan: &ScanResult, i: &Intent) -> bool {
    matches!(i, Intent::Copy { entity, .. }
        if scan.entities.iter().any(|e| e.id == *entity && e.kind == Kind::Skill))
}

/// The plan of any intent that a batch may hold.
fn plan_in(
    home: &Path,
    store: Option<&Path>,
    scan: &ScanResult,
    i: &Intent,
) -> Result<Plan, String> {
    match i {
        Intent::Copy { entity, to, .. } if skill_copy(scan, i) => {
            skill::copy_check(home, scan, entity, to).map(|c| c.plan)
        }
        _ => prepare(home, store, scan, i).map(|p| p.plan),
    }
}

/// Preview: writes nothing.
pub fn plan(home: &Path, store: Option<&Path>, i: &Intent) -> Result<Plan, String> {
    if let Intent::InstallSkill { stage, sub, name } = i {
        return skill::plan(home, store, stage, sub, name);
    }
    let scan = scan_for(home, store, i)?;
    plan_in(home, store, &scan, i)
}

fn level_r1() -> String {
    "R1".to_owned()
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    id: String,
    time: u64,
    /// `toggle`, `edit`, `copy` or `rollback`.
    op: String,
    of: Option<String>,
    #[serde(default)]
    batch: Option<String>,
    /// Which write level the operation required (`R1`, `R2`): rollback needs the same one.
    #[serde(default = "level_r1")]
    level: String,
    /// Id of the entry the operation applied to (rollback of trash operations is built from it).
    #[serde(default)]
    entity: String,
    /// Which `enable` value brings the entry back (only for move to and restore from trash).
    #[serde(default)]
    inverse_enable: Option<bool>,
    /// Trash state before the operation: on file rollback it is restored too.
    #[serde(default)]
    trash_id: Option<String>,
    #[serde(default)]
    trash_before: Option<trash::Item>,
    path: String,
    sha_before: String,
    sha_after: String,
    client: String,
    kind: String,
    name: String,
    pointer: String,
    file: String,
    from: String,
    to: String,
    /// The opaque id of the project a skill copy went to: its rollback finds the folder again from the project list.
    #[serde(default)]
    project: String,
    /// The operation created the file (it did not exist): the rollback removes it instead of restoring `before`.
    #[serde(default)]
    created: bool,
    /// The operation also created the file's folder (`<p>/.codex`): the rollback removes it if it is empty.
    #[serde(default)]
    mkdir: bool,
}

/// Journal line: the manifest without the real path.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub time: u64,
    pub op: String,
    pub of: Option<String>,
    pub batch: Option<String>,
    pub level: String,
    pub client: String,
    pub kind: String,
    pub name: String,
    pub pointer: String,
    pub file: String,
    pub from: String,
    pub to: String,
    pub rolled_back: bool,
    pub can_rollback: bool,
    /// Why the operation cannot be rolled back (none for a rollback line itself): the window shows it as text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// What the rollback leaves when that is not the line's `from` (the preview shows it as "after").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollback_to: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub op: String,
    pub entity: String,
    pub from: String,
    pub to: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(0))
}

fn backup_not_written(e: std::io::Error) -> String {
    crate::tr!("бэкап не записан: {e}", "backup not written: {e}")
}

/// New operation directory: name from time and a counter, sorts as a string.
fn new_op_dir(store: &Path) -> Result<(String, PathBuf), String> {
    let unavailable = |e: std::io::Error| {
        crate::tr!(
            "каталог бэкапов недоступен: {e}",
            "backup directory is unavailable: {e}"
        )
    };
    std::fs::create_dir_all(store).map_err(unavailable)?;
    let ms = now_ms();
    for n in 0..100 {
        let id = format!("{ms:013}-{n:02}");
        match std::fs::create_dir(store.join(&id)) {
            Ok(()) => return Ok((id.clone(), store.join(id))),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(unavailable(e)),
        }
    }
    Err(crate::tr!(
        "не удалось выбрать имя каталога бэкапа",
        "could not pick a name for the backup directory"
    ))
}

/// Temp files of killed cores: each pid has its own name, and without cleanup such a file (a full copy of the config, with secrets)
/// would stay next to the real one forever. `<file>.loadout.*.tmp` older than ten minutes are removed; a fresh foreign file,
/// another core's write in progress, is left alone.
fn clean_stale_tmp(file: &Path) {
    let (Some(dir), Some(name)) = (file.parent(), file.file_name()) else {
        return;
    };
    let prefix = format!("{}.loadout.", name.to_string_lossy());
    let old = |p: &Path| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(600))
    };
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if n.starts_with(&prefix) && n.ends_with(".tmp") && old(&e.path()) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

// Seam for race tests: the callback is invoked between writing the temp file and checking against the expected content.
#[cfg(test)]
type Hook = Box<dyn Fn(&Path)>;
#[cfg(test)]
thread_local! {
    pub(crate) static BEFORE_SWAP: std::cell::RefCell<Option<Hook>> =
        const { std::cell::RefCell::new(None) };
}

/// Temp file alongside: the same volume, so `rename` is atomic. The name `<file>.loadout.<pid>.tmp` ends in `.tmp`
/// (the watcher does not see it), and the pid keeps two cores from writing to the same temp file.
/// Right before `rename` the file is checked against `expect` (what it was at plan time): if a client managed to rewrite it
/// while the backup and temp file were being written, there is no replacement and nothing is written.
fn atomic_write(file: &Path, bytes: &[u8], expect: Option<&[u8]>) -> Result<(), String> {
    use std::io::Write;
    clean_stale_tmp(file);
    let mut name = file.as_os_str().to_owned();
    name.push(format!(".loadout.{}.tmp", std::process::id()));
    let tmp = PathBuf::from(name);
    let res = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        #[cfg(test)]
        BEFORE_SWAP.with(|h| {
            if let Some(hook) = h.borrow().as_ref() {
                hook(file);
            }
        });
        // `None`: the file is being created and must still be absent (a rename would replace one that appeared)
        let now = std::fs::read(file).ok();
        if now.as_deref() != expect || (expect.is_none() && std::fs::symlink_metadata(file).is_ok())
        {
            return Err(std::io::Error::other(crate::tr!(
                "файл изменился перед заменой: его переписал другой процесс, запись отменена, повторите",
                "the file changed just before the swap: another process rewrote it; nothing was written, try again"
            )));
        }
        // a client may briefly have the file open without replace permission: retry a few times
        let mut last = Ok(());
        for _ in 0..5 {
            last = std::fs::rename(&tmp, file);
            if last.is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(60));
        }
        last
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res.map_err(|e| crate::tr!("запись не удалась: {e}", "write failed: {e}"))
}

/// Write with `sync_all`: the backup and manifest must reach disk before the client file changes.
pub(crate) fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::File::create(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

fn write_manifest(dir: &Path, m: &Manifest) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?;
    write_synced(&dir.join("manifest.json"), &json)
        .map_err(|e| crate::tr!("манифест не записан: {e}", "manifest not written: {e}"))
}

/// Short type name (`mcp`, `plugin`…), as in JSON.
pub fn kind_name(k: Kind) -> String {
    serde_json::to_value(k)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// Common write pipeline: backup → manifest → (trash) → temp file and `rename` → verification.
fn commit(
    store: &Path,
    p: Prepared,
    op: &str,
    of: Option<String>,
    batch: Option<&str>,
) -> Result<Applied, String> {
    let (id, dir) = new_op_dir(store)?;
    let fail = |e: String| {
        let _ = std::fs::remove_dir_all(&dir);
        Err(e)
    };
    if let Err(e) = write_synced(&dir.join("before"), &p.old) {
        return fail(backup_not_written(e));
    }
    // a second time right before writing: between plan and backup the client could have rewritten the file
    // (or, for a new file, created it)
    let expect = (!p.created).then_some(p.old.as_slice());
    if std::fs::read(&p.file).ok().as_deref() != expect
        || (p.created && std::fs::symlink_metadata(&p.file).is_ok())
    {
        return fail(crate::tr!(
            "файл изменился во время записи бэкапа: повторите",
            "the file changed while the backup was being written: try again"
        ));
    }
    let parent = p.file.parent().map(Path::to_path_buf);
    let mkdir = p.created && parent.as_ref().is_some_and(|d| !d.exists());
    let m = Manifest {
        version: 2,
        id: id.clone(),
        time: now_ms(),
        op: op.to_owned(),
        of,
        batch: batch.map(str::to_owned),
        level: p.plan.level.clone(),
        entity: p.entity.clone(),
        inverse_enable: p.inverse_enable,
        trash_id: p.trash.as_ref().map(|t| t.id.clone()),
        trash_before: p.trash.as_ref().and_then(|t| t.before.clone()),
        path: p.file.to_string_lossy().into_owned(),
        sha_before: p.plan.base_sha.clone(),
        sha_after: sha(&p.new),
        client: p.plan.client.slug().into(),
        kind: kind_name(p.plan.kind),
        name: p.plan.name.clone(),
        pointer: p.plan.pointer.clone(),
        file: p.plan.file.clone(),
        from: p.plan.from.clone(),
        to: p.plan.to.clone(),
        project: String::new(),
        created: p.created,
        mkdir,
    };
    if let Err(e) = write_manifest(&dir, &m) {
        return fail(e);
    }
    // move to trash: first the entry text goes to the trash, and only then is it cut from the file (otherwise a failure loses the entry)
    if let Some(item) = p.trash.as_ref().and_then(|t| t.after.as_ref()) {
        if let Err(e) = trash::write(store, item) {
            return fail(e);
        }
    }
    if let (true, Some(d)) = (mkdir, parent.as_ref()) {
        if let Err(e) = std::fs::create_dir_all(d) {
            return fail(crate::tr!("запись не удалась: {e}", "write failed: {e}"));
        }
    }
    if let Err(e) = atomic_write(&p.file, &p.new, expect) {
        if let (true, Some(d)) = (mkdir, parent.as_ref()) {
            let _ = std::fs::remove_dir(d);
        }
        // the move did not happen: the trash returns to its former state (no new copy, the stale one stays in place)
        if let Some(t) = p.trash.as_ref().filter(|t| t.after.is_some()) {
            match &t.before {
                None => trash::remove(store, &t.id),
                Some(old) => {
                    let _ = trash::write(store, old);
                }
            }
        }
        return fail(e);
    }
    // restore: the entry is already back in the file, now remove its copy from the trash
    if let Some(t) = p.trash.as_ref().filter(|t| t.after.is_none()) {
        trash::remove(store, &t.id);
    }
    // Verification: re-read and got exactly "source + plan". A mismatch means a client wrote the file right after us:
    // restoring the original is not allowed (we would wipe its fresh write), so the operation stays in the journal and the backup is intact.
    if std::fs::read(&p.file).ok().as_deref() != Some(p.new.as_slice()) {
        return Err(crate::tr!(
            "файл изменён другим процессом сразу после записи: проверьте результат, бэкап и строка журнала сохранены",
            "the file was changed by another process right after writing: check the result; the backup and the journal entry are kept"
        ));
    }
    Ok(Applied {
        op: id,
        entity: p.plan.entity,
        from: p.plan.from,
        to: p.plan.to,
    })
}

fn op_name(i: &Intent) -> &'static str {
    match i {
        Intent::Toggle { .. } => "toggle",
        Intent::Edit { .. } => "edit",
        Intent::Copy { .. } => "copy",
        Intent::Add { .. } => "add",
        Intent::InstallSkill { .. } => "installSkill",
    }
}

fn rank(level: &str) -> u8 {
    match level {
        "R2" => 2,
        "R1" => 1,
        _ => 0,
    }
}

/// The core checks the write level too: `max_level` arrives from main in one request together with the operation itself, so
/// no request can be wedged in between check and write to swap the plan (the "asked for the plan, then applied" check
/// was vulnerable to such a race).
fn need_level(need: &str, max_level: &str) -> Result<(), String> {
    if rank(need) > rank(max_level) {
        return Err(crate::tr!(
            "для этой операции нужен уровень {need}",
            "this operation requires level {need}"
        ));
    }
    Ok(())
}

fn apply_one(
    home: &Path,
    store: &Path,
    i: &Intent,
    base_sha: Option<&str>,
    batch: Option<&str>,
    max_level: &str,
) -> Result<Applied, String> {
    if let Intent::InstallSkill { stage, sub, name } = i {
        return skill::apply(home, store, stage, sub, name, base_sha, max_level);
    }
    let scan = scan_for(home, Some(store), i)?;
    if let Intent::Copy { entity, to, .. } = i {
        if skill_copy(&scan, i) {
            need_level("R2", max_level)?;
            let c = skill::copy_check(home, &scan, entity, to)?;
            return skill::install(store, c, base_sha, batch);
        }
    }
    let p = prepare(home, Some(store), &scan, i)?;
    need_level(&p.plan.level, max_level)?;
    if base_sha.is_some_and(|b| b != p.plan.base_sha) {
        return Err(crate::tr!(
            "файл изменился после предпросмотра: постройте план заново",
            "the file changed after the preview: build the plan again"
        ));
    }
    if p.plan.noop {
        return Err(crate::tr!(
            "запись уже в нужном состоянии",
            "the entry is already in the desired state"
        ));
    }
    commit(store, p, op_name(i), None, batch)
}

/// Executes an intent. `base_sha` is the file hash from the preview: if the file has changed since, refuse.
pub fn apply(
    home: &Path,
    store: &Path,
    i: &Intent,
    base_sha: &str,
    max_level: &str,
) -> Result<Applied, String> {
    retention::before_write(store, &[]);
    apply_one(home, store, i, Some(base_sha), None, max_level)
}

/// Bundle (profile) plan: for each intent that found an entry, plus the list of skipped ones.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPlan {
    pub plans: Vec<Plan>,
    /// Intents whose entries no longer exist (names for display).
    pub skipped: Vec<String>,
    pub level: String,
    /// Signature of the whole bundle: if anything changed during the preview, it will not match.
    pub batch_sha: String,
}

pub fn plan_batch(home: &Path, store: Option<&Path>, items: &[Intent]) -> BatchPlan {
    let (mut plans, mut skipped) = (Vec::new(), Vec::new());
    // one scan per project the batch copies from (a batch from the project window has one)
    let mut scans: std::collections::HashMap<String, Result<ScanResult, String>> =
        std::collections::HashMap::new();
    for i in items {
        if matches!(i, Intent::Add { .. } | Intent::InstallSkill { .. }) {
            skipped.push(crate::tr!(
                "добавление не входит в пакет",
                "adding is not part of a batch"
            ));
            continue;
        }
        let key = match i {
            Intent::Copy { project, .. } => project.clone(),
            _ => String::new(),
        };
        let scan = match scans.entry(key).or_insert_with(|| scan_for(home, store, i)) {
            Ok(s) => s,
            Err(e) => {
                skipped.push(e.clone());
                continue;
            }
        };
        match plan_in(home, store, scan, i) {
            Ok(p) => plans.push(p),
            Err(err) => {
                let name = scan
                    .entities
                    .iter()
                    .find(|e| e.id == i.entity())
                    .map_or_else(
                        || crate::tr!("запись исчезла", "the entry is gone"),
                        |e| e.name.clone(),
                    );
                // a refused copy says why: the entry is there, the pair is not possible
                skipped.push(match i {
                    Intent::Copy { .. } => format!("{name}: {err}"),
                    _ => name,
                });
            }
        }
    }
    let level = if plans.iter().any(|p| p.level == "R2") {
        "R2"
    } else {
        "R1"
    }
    .to_owned();
    let sig: String = plans
        .iter()
        .map(|p| format!("{}|{}|{}|{}\n", p.entity, p.enable, p.noop, p.base_sha))
        .collect();
    BatchPlan {
        plans,
        skipped,
        level,
        batch_sha: sha(sig.as_bytes()),
    }
}

/// Applies a bundle intent by intent, each with its own backup and journal line; the shared bundle number allows
/// rolling everything back at once. Stops at the first error: what was done stays in the journal.
pub fn apply_batch(
    home: &Path,
    store: &Path,
    items: &[Intent],
    batch_sha: &str,
    max_level: &str,
) -> Result<(String, Vec<Applied>), String> {
    // an addition has no entry for the bundle to match steps against: it runs only one at a time
    if items.iter().any(|i| matches!(i, Intent::Add { .. })) {
        return Err(crate::tr!(
            "добавление нового сервера не входит в пакет",
            "adding a new server is not part of a batch"
        ));
    }
    let bp = plan_batch(home, Some(store), items);
    if bp.batch_sha != batch_sha {
        return Err(crate::tr!(
            "состояние изменилось после предпросмотра: постройте план заново",
            "the state changed after the preview: build the plan again"
        ));
    }
    need_level(&bp.level, max_level)?;
    // once per bundle, not per entry: a bundle must not trim its own beginning
    retention::before_write(store, &[]);
    let batch = format!("{:013}", now_ms());
    let mut done = Vec::new();
    for (n, i) in items.iter().enumerate() {
        let scan = scan_for(home, Some(store), i)?;
        match plan_in(home, Some(store), &scan, i) {
            // already in the desired state: skip, it is not a bundle error
            Ok(p) if p.noop => continue,
            Ok(_) => {}
            // the entry was missing in the preview too (it skipped it): skip; but if it existed and vanished in the middle
            // of the bundle, skipping silently is not allowed: the bundle stops with an error
            Err(_) if !bp.plans.iter().any(|p| p.entity == i.entity()) => continue,
            Err(e) => {
                return Err(crate::tr!(
                    "{e} (выполнено записей: {}; сделанное можно откатить в журнале)",
                    "{e} (done: {} entries; what was done can be rolled back in the journal)",
                    done.len()
                ))
            }
        }
        match apply_one(home, store, i, None, Some(&batch), max_level) {
            Ok(a) => done.push(a),
            Err(e) => {
                return Err(crate::tr!(
                    "{e} (выполнено {} из {}; сделанное можно откатить в журнале)",
                    "{e} (done: {} of {}; what was done can be rolled back in the journal)",
                    done.len(),
                    items.len() - n + done.len()
                ))
            }
        }
    }
    Ok((batch, done))
}

fn read_manifest(store: &Path, id: &str) -> Result<Manifest, String> {
    // id is a directory name: digits and hyphen only, otherwise a path could be smuggled into it
    if id.is_empty() || id.len() > 40 || !id.bytes().all(|c| c.is_ascii_digit() || c == b'-') {
        return Err(crate::tr!(
            "неверный номер операции",
            "invalid operation number"
        ));
    }
    let text = std::fs::read_to_string(store.join(id).join("manifest.json")).map_err(|_| {
        if retention::was_pruned(store, id) {
            crate::tr!(
                "копия этой операции уже удалена очисткой (хранятся последние {} операций не старше {} дней): откатить её нельзя",
                "the copy of this operation was already removed by the cleanup (the last {} operations, not older than {} days, are kept): it cannot be rolled back",
                retention::KEEP_OPS,
                retention::KEEP_DAYS
            )
        } else {
            crate::tr!("операция не найдена", "operation not found")
        }
    })?;
    serde_json::from_str(&text)
        .map_err(|_| crate::tr!("манифест повреждён", "the manifest is corrupted"))
}

fn file_sha(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|b| sha(&b))
}

/// The last `limit` operations, newest first. Only they are parsed: for the rest only directory names are read.
fn manifests_recent(store: &Path, limit: usize) -> Vec<Manifest> {
    retention::op_ids(store)
        .iter()
        .filter_map(|id| read_manifest(store, id).ok())
        .take(limit)
        .collect()
}

/// Operations with id not older than `min_id`, newest first: a rollback is always newer than its operation, no need to read the rest.
fn manifests_since(store: &Path, min_id: &str) -> Vec<Manifest> {
    retention::op_ids(store)
        .iter()
        .take_while(|id| id.as_str() >= min_id)
        .filter_map(|id| read_manifest(store, id).ok())
        .collect()
}

/// The entry the operation applied to. Restoring from the owner's stash changes the pointer, and with it the id
/// (`/_disabledMcpServers/x` → `/mcpServers/x`), so after the id lookup we search by client, type and name.
fn resolve_entity<'a>(scan: &'a ScanResult, m: &Manifest) -> Option<&'a Entity> {
    let by_id = scan.entities.iter().find(|e| e.id == m.entity);
    // An entry from Loadout trash has a stable id: it cannot be looked up by name, another entry with the same
    // name would be found (e.g. a live one in `mcpServers` or another in the stash), and rollback would restore the wrong one.
    if m.trash_id.is_some() {
        return by_id;
    }
    by_id.or_else(|| {
        scan.entities.iter().find(|e| {
            e.client.slug() == m.client
                && kind_name(e.kind) == m.kind
                && e.scope == "user"
                && e.name == m.name
        })
    })
}

/// Words the core writes into the manifest as `from`/`to` (in the operation's language). An entry made before a language change is shown
/// in the current one: standard words and prefixes are translated, a command typed by the user after a prefix stays as is.
const CANNED: [(&str, &str); 7] = [
    ("установлен", "installed"),
    ("включено", "enabled"),
    ("выключено", "disabled"),
    ("не задан", "not set"),
    ("в корзине Loadout", "in Loadout trash"),
    ("в стэше владельца", "in the owner's stash"),
    ("нет записи", "no entry"),
];
const CANNED_PREFIX: [(&str, &str); 2] = [("копия: ", "copy: "), ("добавить: ", "add: ")];

fn relang(s: &str) -> String {
    fn pick<'a>((ru, en): (&'a str, &'a str), to_en: bool) -> (&'a str, &'a str) {
        if to_en {
            (ru, en)
        } else {
            (en, ru)
        }
    }
    let en = crate::i18n::is_en();
    for p in CANNED {
        let (from, to) = pick(p, en);
        if s == from {
            return to.to_owned();
        }
    }
    for p in CANNED_PREFIX {
        let (from, to) = pick(p, en);
        if let Some(rest) = s.strip_prefix(from) {
            return format!("{to}{rest}");
        }
    }
    s.to_owned()
}

/// Journal of our operations, newest first. Client changes made from outside do not appear in it.
pub fn journal(home: &Path, store: &Path) -> Vec<Entry> {
    // a rollback is always newer than its operation, so "rolled back" shows in the same latest lines; the rest are not parsed
    let all = manifests_recent(store, retention::JOURNAL_MAX);
    let undone: std::collections::HashSet<&str> =
        all.iter().filter_map(|m| m.of.as_deref()).collect();
    // entry state is needed only for rollbacks of trash moves: one scan for the whole journal
    let scan: Option<ScanResult> = all
        .iter()
        .any(|m| m.inverse_enable.is_some())
        .then(|| crate::scan_with(home, Some(store)));
    all.iter()
        .map(|m| {
            let rolled_back = undone.contains(m.id.as_str());
            let why = if m.op == "rollback" {
                None
            } else if rolled_back {
                Some(crate::tr!("уже откатано", "already rolled back"))
            } else {
                match m.inverse_enable {
                    None if skill::is_folder_op(m) => (!skill::can_rollback(home, m)).then(|| {
                        crate::tr!(
                            "скил изменён или удалён после установки",
                            "the skill was changed or removed after the install"
                        )
                    }),
                    // move and restore are rolled back by the inverse operation while the entry is in the state the operation left
                    Some(inv) => (!scan
                        .as_ref()
                        .and_then(|s| resolve_entity(s, m))
                        .is_some_and(|e| enabled(e.state) == Some(!inv)))
                    .then(|| {
                        crate::tr!(
                            "запись переключили после операции или её больше нет",
                            "the entry was switched after the operation or is gone"
                        )
                    }),
                    None if !allowed(home, Path::new(&m.path)) => Some(crate::tr!(
                        "файл не входит в список разрешённых для записи",
                        "the file is not on the list of files allowed for writing"
                    )),
                    None => (file_sha(Path::new(&m.path)).as_deref()
                        != Some(m.sha_after.as_str()))
                    .then(|| {
                        crate::tr!(
                            "файл изменён после операции: откат затёр бы чужие правки",
                            "the file changed after the operation: the rollback would overwrite someone else's edits"
                        )
                    }),
                }
            };
            let can_rollback = m.op != "rollback" && why.is_none();
            // A return from the owner's stash over a file changed since is undone by the inverse operation
            // (`rollback_one`), which moves the entry to the Loadout trash, not back into the stash.
            let rollback_to = (can_rollback
                && m.inverse_enable == Some(false)
                && m.trash_id.is_none()
                && file_sha(Path::new(&m.path)).as_deref() != Some(m.sha_after.as_str()))
            .then(|| crate::tr!("в корзине Loadout", "in Loadout trash"));
            // The written file itself. Older lines named the file the entry was found in (a Claude Code plugin:
            // installed_plugins.json) with a key of that file: such a key is not shown next to the real file.
            let (file, pointer) = if m.kind == "skill" || m.path.is_empty() {
                (m.file.clone(), m.pointer.clone())
            } else {
                let real = crate::scrub_home(home, &tilde(home, Path::new(&m.path)));
                let pointer = if real == m.file {
                    m.pointer.clone()
                } else {
                    String::new()
                };
                (real, pointer)
            };
            Entry {
                id: m.id.clone(),
                time: m.time,
                op: m.op.clone(),
                of: m.of.clone(),
                batch: m.batch.clone(),
                level: m.level.clone(),
                client: m.client.clone(),
                kind: m.kind.clone(),
                name: m.name.clone(),
                pointer,
                file,
                from: relang(&m.from),
                to: relang(&m.to),
                rolled_back,
                can_rollback,
                why,
                rollback_to,
            }
        })
        .collect()
}

/// Rollback of an operation. Flags, edits and copies restore the file from backup, only if nobody changed it after the operation.
/// Move to trash and restore are rolled back by the inverse operation on the current file: a client rewrites `~/.claude.json`
/// constantly, and the hash check there would almost always refuse.
pub fn rollback(home: &Path, store: &Path, op: &str, max_level: &str) -> Result<Applied, String> {
    retention::before_write(store, &[op.to_owned()]);
    rollback_one(home, store, op, max_level)
}

fn rollback_one(home: &Path, store: &Path, op: &str, max_level: &str) -> Result<Applied, String> {
    let m = read_manifest(store, op)?;
    need_level(&m.level, max_level)?;
    if m.op == "rollback" {
        return Err(crate::tr!(
            "откатывать можно только саму операцию, а не откат",
            "only the operation itself can be rolled back, not a rollback"
        ));
    }
    if manifests_since(store, op)
        .iter()
        .any(|x| x.of.as_deref() == Some(op))
    {
        return Err(crate::tr!(
            "операция уже откатана",
            "the operation has already been rolled back"
        ));
    }
    if skill::is_folder_op(&m) {
        return skill::rollback(home, store, op, &m);
    }
    // The inverse operation when trash is involved or the file has changed since. Restoring from the owner's stash with an unchanged
    // file is rolled back by restoring the file from backup: the entry is back in the stash, not in Loadout trash.
    let inverse = m.inverse_enable.filter(|_| {
        m.trash_id.is_some()
            || file_sha(Path::new(&m.path)).as_deref() != Some(m.sha_after.as_str())
    });
    if let Some(enable) = inverse {
        let scan = crate::scan_with(home, Some(store));
        let id = resolve_entity(&scan, &m)
            .ok_or_else(|| {
                crate::tr!(
                    "запись не найдена: возможно, её изменили вручную",
                    "entry not found: it may have been changed manually"
                )
            })?
            .id
            .clone();
        let p = prep_toggle(home, Some(store), &scan, &id, enable)?;
        if p.plan.noop {
            return Err(crate::tr!(
                "запись уже в нужном состоянии: откатывать нечего",
                "the entry is already in the desired state: nothing to roll back"
            ));
        }
        return commit(store, p, "rollback", Some(op.to_owned()), None);
    }
    let file = PathBuf::from(&m.path);
    // the manifest lives in the user's directory: its path is untrusted, check against the list the same way as on write
    guard_file(home, &file)?;
    let current = std::fs::read(&file)
        .map_err(|_| crate::tr!("файл клиента не прочитан", "could not read the client file"))?;
    if sha(&current) != m.sha_after {
        return Err(crate::tr!(
            "файл изменился после операции: откат затёр бы чужие правки",
            "the file changed after the operation: the rollback would overwrite someone else's edits"
        ));
    }
    if m.created {
        return remove_created(store, op, &m, &file, &current);
    }
    let before = std::fs::read(store.join(op).join("before"))
        .map_err(|_| crate::tr!("бэкап не найден", "backup not found"))?;
    if sha(&before) != m.sha_before {
        return Err(crate::tr!("бэкап повреждён", "the backup is corrupted"));
    }
    let (id, dir) = new_op_dir(store)?;
    let fail = |e: String| {
        let _ = std::fs::remove_dir_all(&dir);
        Err(e)
    };
    if let Err(e) = write_synced(&dir.join("before"), &current) {
        return fail(backup_not_written(e));
    }
    let r = Manifest {
        id: id.clone(),
        time: now_ms(),
        op: "rollback".into(),
        of: Some(op.to_owned()),
        sha_before: m.sha_after.clone(),
        sha_after: m.sha_before.clone(),
        from: m.to.clone(),
        to: m.from.clone(),
        ..m.clone()
    };
    if let Err(e) = write_manifest(&dir, &r) {
        return fail(e);
    }
    if let Err(e) = atomic_write(&file, &before, Some(current.as_slice())) {
        return fail(e);
    }
    // as after a write: do not wipe a client's fresh write, the rollback record stays
    if file_sha(&file).as_deref() != Some(m.sha_before.as_str()) {
        return Err(crate::tr!(
            "файл изменён другим процессом сразу после отката: проверьте результат",
            "the file was changed by another process right after the rollback: check the result"
        ));
    }
    Ok(Applied {
        op: id,
        entity: String::new(),
        from: r.from,
        to: r.to,
    })
}

/// Rollback of an operation that created its file: the file (unchanged since, checked by the caller) goes to this rollback's
/// backup and is removed, and so is the folder the operation created, if it is empty.
fn remove_created(
    store: &Path,
    op: &str,
    m: &Manifest,
    file: &Path,
    current: &[u8],
) -> Result<Applied, String> {
    let (id, dir) = new_op_dir(store)?;
    let fail = |e: String| {
        let _ = std::fs::remove_dir_all(&dir);
        Err(e)
    };
    if let Err(e) = write_synced(&dir.join("before"), current) {
        return fail(backup_not_written(e));
    }
    let r = Manifest {
        id: id.clone(),
        time: now_ms(),
        op: "rollback".into(),
        of: Some(op.to_owned()),
        sha_before: m.sha_after.clone(),
        sha_after: String::new(),
        from: m.to.clone(),
        to: m.from.clone(),
        created: false,
        mkdir: false,
        ..m.clone()
    };
    if let Err(e) = write_manifest(&dir, &r) {
        return fail(e);
    }
    if std::fs::read(file).ok().as_deref() != Some(current) {
        return fail(crate::tr!(
            "файл изменился перед удалением: его переписал другой процесс, откат отменён, повторите",
            "the file changed just before removal: another process rewrote it; nothing was rolled back, try again"
        ));
    }
    if let Err(e) = std::fs::remove_file(file) {
        return fail(crate::tr!("откат не удался: {e}", "rollback failed: {e}"));
    }
    if m.mkdir {
        // only an empty folder goes: `remove_dir` refuses one that holds anything
        if let Some(d) = file.parent() {
            let _ = std::fs::remove_dir(d);
        }
    }
    Ok(Applied {
        op: id,
        entity: String::new(),
        from: r.from,
        to: r.to,
    })
}

/// Rolls back a bundle as a whole, starting from the last operation. Stops at the first error.
pub fn rollback_batch(
    home: &Path,
    store: &Path,
    batch: &str,
    max_level: &str,
) -> Result<Vec<Applied>, String> {
    // operations of the bundle not older than its number (ms of bundle start): the rest are not read
    let all = manifests_since(store, batch);
    let members: Vec<&Manifest> = all
        .iter()
        .filter(|m| m.batch.as_deref() == Some(batch) && m.op != "rollback")
        .collect();
    // the level of all bundle operations is checked before the first rollback: a bundle must not roll back halfway
    for m in &members {
        need_level(&m.level, max_level)?;
    }
    // newest first: the required rollback order
    let ops: Vec<String> = members.iter().map(|m| m.id.clone()).collect();
    // bundle operations must not fall under cleanup in the middle of a rollback
    retention::before_write(store, &ops);
    let mut done = Vec::new();
    for id in ops {
        if all.iter().any(|x| x.of.as_deref() == Some(id.as_str())) {
            continue;
        }
        done.push(rollback_one(home, store, &id, max_level)?);
    }
    if done.is_empty() {
        return Err(crate::tr!(
            "в пакете нечего откатывать",
            "nothing to roll back in the batch"
        ));
    }
    Ok(done)
}

#[cfg(test)]
mod relang_tests {
    use super::relang;

    /// The process language in tests is Russian: English words from a manifest written with `--lang en` are shown in Russian,
    /// while a typed command after a prefix and unknown text are unchanged.
    #[test]
    fn manifest_words_follow_the_process_language() {
        assert_eq!(relang("enabled"), "включено");
        assert_eq!(relang("in Loadout trash"), "в корзине Loadout");
        assert_eq!(relang("no entry"), "нет записи");
        assert_eq!(relang("installed"), "установлен");
        assert_eq!(relang("add: npx -y pkg"), "добавить: npx -y pkg");
        assert_eq!(relang("copy: tool"), "копия: tool");
        assert_eq!(relang("включено"), "включено");
        assert_eq!(relang("npx -y custom"), "npx -y custom");
    }
}
