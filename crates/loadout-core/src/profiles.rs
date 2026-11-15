//! Профили (CONCEPT.md §4, M4): именованные наборы «что должно быть включено». Лежат в каталоге бэкапов приложения
//! (`profiles.json`), в конфиги клиентов не попадают. Применение — пакет переключений через тот же конвейер записи
//! (см. `write::plan_batch` и `write::apply_batch`): один предпросмотр, у каждой записи свой бэкап и строка журнала.

use crate::model::{Kind, State};
use crate::write::Intent;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Запись профиля: сущность по тому, как её показывает скан (клиент, тип, область, имя), и нужное состояние.
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

pub fn list(store: &Path) -> Vec<Profile> {
    std::fs::read_to_string(path(store))
        .ok()
        .and_then(|t| serde_json::from_str::<File>(&t).ok())
        .map(|f| f.profiles)
        .unwrap_or_default()
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

/// Создаёт профиль или заменяет одноимённый.
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
    let mut all = list(store);
    match all.iter_mut().find(|x| x.name == p.name) {
        Some(x) => *x = p,
        None => all.push(p),
    }
    store_all(store, all)
}

pub fn delete(store: &Path, name: &str) -> Result<(), String> {
    let mut all = list(store);
    let before = all.len();
    all.retain(|p| p.name != name);
    if all.len() == before {
        return Err(crate::tr!("профиль не найден", "profile not found"));
    }
    store_all(store, all)
}

/// Профиль из текущего состояния: плагины и MCP, у которых есть переключатель. Коннекторы не входят: один ключ
/// `disableClaudeAiConnectors` гасит их все сразу, отдельное состояние у каждого в профиле было бы ложью.
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
                _ => return None, // состояние неизвестно: в профиль нечего записать
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

/// Намерения профиля по свежему скану и имена записей, которых уже нет.
pub fn intents(
    home: &Path,
    store: &Path,
    name: &str,
) -> Result<(Vec<Intent>, Vec<String>), String> {
    let p = list(store)
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
