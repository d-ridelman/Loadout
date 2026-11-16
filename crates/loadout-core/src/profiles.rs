//! Profiles (CONCEPT.md §4, M4): named sets of "what should be enabled". They live in the app's backups directory
//! (`profiles.json`) and do not get into client configs. Applying one is a batch of switches through the same write pipeline
//! (see `write::plan_batch` and `write::apply_batch`): one preview, each entry has its own backup and journal line.

use crate::model::{Kind, State};
use crate::write::Intent;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A profile entry: an entity by the way a scan shows it (client, kind, scope, name), and the desired state.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Item {
    pub client: String,
    pub kind: String,
    pub scope: String,
    pub name: String,
    pub enable: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Profile {
    pub name: String,
    pub items: Vec<Item>,
}

#[derive(Serialize, Deserialize, Default)]
struct File {
    profiles: Vec<Profile>,
}

fn path(store: &Path) -> PathBuf {
    store.join("profiles.json")
}

/// Reads `profiles.json`. No file means no profiles. A file that exists but cannot be read or parsed is an error: silently
/// treating it as "no profiles" is not allowed, the next save would wipe what was in it (see [`quarantine`]).
fn read_file(store: &Path) -> Result<Vec<Profile>, String> {
    let text = match std::fs::read_to_string(path(store)) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(broken(&e.to_string())),
    };
    serde_json::from_str::<File>(&text)
        .map(|f| f.profiles)
        .map_err(|e| broken(&e.to_string()))
}

fn broken(why: &str) -> String {
    crate::tr!(
        "файл профилей profiles.json повреждён или не читается ({why}): профили не загружены и не перезаписываются. Отложите файл (он будет переименован в profiles.json.broken-<время>) и создайте профили заново",
        "the profiles file profiles.json is damaged or unreadable ({why}): profiles are not loaded and will not be overwritten. Set the file aside (it is renamed to profiles.json.broken-<time>) and create the profiles again"
    )
}

pub fn list(store: &Path) -> Result<Vec<Profile>, String> {
    read_file(store)
}

/// An explicit owner action: a corrupt `profiles.json` is renamed to `profiles.json.broken-<time>`
/// (nothing is deleted), after which profiles can be saved again. A readable file is left alone.
pub fn quarantine(store: &Path) -> Result<String, String> {
    if read_file(store).is_ok() {
        return Err(crate::tr!(
            "profiles.json в порядке: откладывать нечего",
            "profiles.json is fine: nothing to set aside"
        ));
    }
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let name = format!("profiles.json.broken-{ms}");
    std::fs::rename(path(store), store.join(&name)).map_err(|e| {
        crate::tr!(
            "файл профилей не переименован: {e}",
            "the profiles file was not renamed: {e}"
        )
    })?;
    Ok(name)
}

pub fn valid_name(n: &str) -> bool {
    let len = n.chars().count();
    (1..=40).contains(&len)
        && n.trim() == n
        && n.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '_' | '-' | '.'))
}

fn store_all(store: &Path, profiles: Vec<Profile>) -> Result<(), String> {
    std::fs::create_dir_all(store).map_err(|e| {
        crate::tr!(
            "каталог профилей недоступен: {e}",
            "profiles directory is unavailable: {e}"
        )
    })?;
    let json = serde_json::to_vec_pretty(&File { profiles }).map_err(|e| e.to_string())?;
    let tmp = store.join("profiles.json.tmp");
    crate::write::write_synced(&tmp, &json)
        .map_err(|e| crate::tr!("профили не записаны: {e}", "profiles were not written: {e}"))?;
    std::fs::rename(&tmp, path(store))
        .map_err(|e| crate::tr!("профили не записаны: {e}", "profiles were not written: {e}"))
}

/// Creates a profile or replaces one of the same name.
pub fn save(store: &Path, p: Profile) -> Result<(), String> {
    if !valid_name(&p.name) {
        return Err(crate::tr!(
            "имя профиля: 1–40 знаков (буквы, цифры, пробел, _ - .)",
            "profile name: 1–40 characters (letters, digits, space, _ - .)"
        ));
    }
    let ok = |s: &str| !s.is_empty() && s.len() <= 300 && !s.chars().any(char::is_control);
    if p.items.len() > 2000
        || !p
            .items
            .iter()
            .all(|i| ok(&i.client) && ok(&i.kind) && ok(&i.scope) && ok(&i.name))
    {
        return Err(crate::tr!(
            "в профиле слишком много записей или в них недопустимые строки",
            "the profile has too many entries or they contain invalid strings"
        ));
    }
    let mut all = list(store)?;
    match all.iter_mut().find(|x| x.name == p.name) {
        Some(x) => *x = p,
        None => all.push(p),
    }
    store_all(store, all)
}

pub fn delete(store: &Path, name: &str) -> Result<(), String> {
    let mut all = list(store)?;
    let before = all.len();
    all.retain(|p| p.name != name);
    if all.len() == before {
        return Err(crate::tr!("профиль не найден", "profile not found"));
    }
    store_all(store, all)
}

/// A profile from the current state: plugins and MCP servers that have a switch. Connectors are not included: one key
/// `disableClaudeAiConnectors` switches them all off at once, a separate state for each in a profile would be a lie.
pub fn from_current(home: &Path, store: &Path, name: &str) -> Profile {
    let scan = crate::scan_with(home, Some(store));
    let items = scan
        .entities
        .iter()
        .filter(|e| e.can_toggle && matches!(e.kind, Kind::Plugin | Kind::Mcp))
        .filter_map(|e| {
            let enable = match e.state {
                State::On | State::Stale => true,
                State::Off => false,
                _ => return None, // state unknown: nothing to record in the profile
            };
            Some(Item {
                client: e.client.slug().to_owned(),
                kind: crate::write::kind_name(e.kind),
                scope: e.scope.clone(),
                name: e.name.clone(),
                enable,
            })
        })
        .collect();
    Profile {
        name: name.to_owned(),
        items,
    }
}

/// Profile intents from a fresh scan and the names of entries that no longer exist.
pub fn intents(
    home: &Path,
    store: &Path,
    name: &str,
) -> Result<(Vec<Intent>, Vec<String>), String> {
    let p = list(store)?
        .into_iter()
        .find(|p| p.name == name)
        .ok_or_else(|| crate::tr!("профиль не найден", "profile not found"))?;
    let scan = crate::scan_with(home, Some(store));
    let (mut out, mut missing) = (Vec::new(), Vec::new());
    for it in &p.items {
        let hits: Vec<_> = scan
            .entities
            .iter()
            .filter(|e| {
                e.can_toggle
                    && e.client.slug() == it.client
                    && crate::write::kind_name(e.kind) == it.kind
                    && e.scope == it.scope
                    && e.name == it.name
            })
            .collect();
        if hits.is_empty() {
            missing.push(it.name.clone());
        }
        out.extend(hits.into_iter().map(|e| Intent::Toggle {
            entity: e.id.clone(),
            enable: it.enable,
        }));
    }
    Ok((out, missing))
}
