//! The Loadout trash (CONCEPT.md §5, step 8: "deletion = move to the trash, not `rm`").
//! An entry that has no "disabled" flag (MCP in clients' JSON configs) is cut out of the client's file, and its text
//! lies here, in the app's backups directory. In a scan such an entry is visible as `off` with the same file and pointer,
//! so its id, selection in the window, journal and profiles do not change. We leave nothing foreign in the client's file: unfamiliar
//! keys could be dropped by the client when it rewrites the file.

use crate::mask::mcp_detail;
use crate::model::{Client, Entity, Format, Kind, Source, State, Target, TargetKind};
use crate::Ctx;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A trash entry. Stores values as they are (with `env`): the file lies in the user's profile and is not given out.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// The entry's id in the scan at the time of cutting out: also the file name.
    pub id: String,
    /// `json` (the entry's value) or `yaml` (its lines in `cordis.patch.yml`, `parent`/`key` are the operation and entry numbers).
    #[serde(default = "json_format")]
    pub format: String,
    /// `yaml` only: the `id` of the operation's neighbouring entry, which the return uses to make sure the place is the same.
    #[serde(default)]
    pub anchor: Option<String>,
    pub client: String,
    pub scope: String,
    /// The name and pointer for display (already sanitized by the scan).
    pub name: String,
    pub file: String,
    pub pointer: String,
    /// The real client file to return to.
    pub path: String,
    /// Keys down to the object the entry lay in (`["mcpServers"]`), and the key itself.
    pub parent: Vec<String>,
    pub key: String,
    /// The value text (JSON) as it stood in the file, without indentation.
    pub value: String,
    pub time: u64,
}

fn json_format() -> String {
    "json".to_owned()
}

/// The id goes into the file name: only what the core produces (`16 hex` and an optional `-N`).
pub fn valid_id(id: &str) -> bool {
    let (head, tail) = id.split_once('-').map_or((id, None), |(h, t)| (h, Some(t)));
    head.len() == 16
        && head.bytes().all(|b| b.is_ascii_hexdigit())
        && tail
            .is_none_or(|t| !t.is_empty() && t.len() <= 4 && t.bytes().all(|b| b.is_ascii_digit()))
}

fn file_of(store: &Path, id: &str) -> PathBuf {
    store.join("trash").join(format!("{id}.json"))
}

pub fn read(store: &Path, id: &str) -> Option<Item> {
    if !valid_id(id) {
        return None;
    }
    serde_json::from_str(&std::fs::read_to_string(file_of(store, id)).ok()?).ok()
}

pub fn write(store: &Path, item: &Item) -> Result<(), String> {
    if !valid_id(&item.id) {
        return Err(crate::tr!(
            "неверный id записи корзины",
            "invalid trash entry id"
        ));
    }
    std::fs::create_dir_all(store.join("trash"))
        .map_err(|e| crate::tr!("корзина недоступна: {e}", "trash is unavailable: {e}"))?;
    let json = serde_json::to_vec_pretty(item).map_err(|e| e.to_string())?;
    crate::write::write_synced(&file_of(store, &item.id), &json)
        .map_err(|e| crate::tr!("корзина не записана: {e}", "trash was not written: {e}"))
}

pub fn remove(store: &Path, id: &str) {
    if valid_id(id) {
        let _ = std::fs::remove_file(file_of(store, id));
    }
}

fn list(store: &Path) -> Vec<Item> {
    let Ok(rd) = std::fs::read_dir(store.join("trash")) else {
        return Vec::new();
    };
    let mut items: Vec<Item> = rd
        .flatten()
        .filter_map(|e| read(store, e.path().file_stem()?.to_str()?))
        .collect();
    items.sort_by(|a, b| a.id.cmp(&b.id));
    items
}

/// Trash entries as disabled entities. If such an entry has already returned to the file another way, the trash one is skipped.
pub fn inject(c: &mut Ctx, store: &Path) {
    for it in list(store) {
        let (Some(client), true) = (
            Client::from_slug(&it.client),
            c.entities.iter().all(|e| e.id != it.id),
        ) else {
            continue;
        };
        let yaml = it.format == "yaml";
        // for DeepSeek an entry is YAML lines: for display we parse them the same way the scan parses the file
        let detail = if yaml {
            crate::deepseek::trashed_detail(&it.value)
        } else {
            serde_json::from_str(&it.value)
                .map_or_else(|_| serde_json::json!({}), |v| mcp_detail(&v))
        };
        let mut path = it.parent.clone();
        path.push(it.key.clone());
        let mut e = Entity::new(
            client,
            Kind::Mcp,
            it.scope.clone(),
            it.name.clone(),
            State::Off,
            it.file.clone(),
            it.pointer.clone(),
        )
        .note(crate::tr!(
            "в корзине Loadout: запись вырезана из файла клиента и вернётся при включении",
            "in the Loadout trash: the entry was cut out of the client file and will return when turned on"
        ))
        .detail(detail)
        .target(Target {
            file: PathBuf::from(&it.path),
            format: if yaml { Format::Yaml } else { Format::Json },
            path,
            inverted: false,
            kind: TargetKind::Restore(Source::Trash(it.id.clone())),
        });
        e.id = it.id;
        c.push(e);
    }
}
