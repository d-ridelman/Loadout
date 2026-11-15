//! Корзина Loadout (CONCEPT.md §5, шаг 8: «удаление = перенос в корзину, не `rm`»).
//! Запись, у которой нет флага «выключено» (MCP в JSON-конфигах клиентов), вырезается из файла клиента, а её текст
//! лежит здесь, в каталоге бэкапов приложения. В скане такая запись видна как `off` с прежними файлом и указателем,
//! поэтому её id, выбор в окне, журнал и профили не меняются. Клиентам в файле ничего чужого не оставляем: незнакомые
//! ключи они могли бы выбросить при перезаписи.

use crate::mask::mcp_detail;
use crate::model::{Client, Entity, Format, Kind, Source, State, Target, TargetKind};
use crate::Ctx;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Запись корзины. Хранит значения как есть (с `env`): файл лежит в профиле пользователя и наружу не отдаётся.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// id записи в скане на момент выноса: он же имя файла.
    pub id: String,
    /// `json` (значение записи) или `yaml` (её строки в `cordis.patch.yml`, `parent`/`key` — номера операции и записи).
    #[serde(default = "json_format")]
    pub format: String,
    /// Только `yaml`: `id` соседней записи операции, по которому возврат убеждается, что место прежнее.
    #[serde(default)]
    pub anchor: Option<String>,
    pub client: String,
    pub scope: String,
    /// Имя и указатель для показа (уже очищенные сканом).
    pub name: String,
    pub file: String,
    pub pointer: String,
    /// Настоящий файл клиента, куда возвращать.
    pub path: String,
    /// Ключи до объекта, в котором лежала запись (`["mcpServers"]`), и сам ключ.
    pub parent: Vec<String>,
    pub key: String,
    /// Текст значения (JSON), как он стоял в файле, без отступа.
    pub value: String,
    pub time: u64,
}

fn json_format() -> String {
    "json".to_owned()
}

/// id идёт в имя файла: только то, что делает ядро (`16 hex` и необязательный `-N`).
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

/// Записи корзины как выключенные сущности. Если такая запись уже вернулась в файл другим путём, корзинная пропускается.
pub fn inject(c: &mut Ctx, store: &Path) {
    for it in list(store) {
        let (Some(client), true) = (
            Client::from_slug(&it.client),
            c.entities.iter().all(|e| e.id != it.id),
        ) else {
            continue;
        };
        let yaml = it.format == "yaml";
        // у DeepSeek запись — строки YAML: для показа разбираем их так же, как скан разбирает файл
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
