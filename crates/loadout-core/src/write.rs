//! Запись R1 (CONCEPT.md §5): план, предпросмотр, оптимистичная блокировка, бэкап, атомарная запись, проверка, откат.
//!
//! Наружу — только id записи и желаемое состояние: цель записи (путь и сырой ключ) берётся из свежего скана внутри ядра.
//! В плане и журнале нет содержимого файлов: только очищенные имя и указатель и старое/новое значение одного ключа.

use crate::edit;
use crate::model::{Client, Entity, Kind, ScanResult, State, Target};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Почему запись нельзя переключить (показывается в инспекторе).
pub fn why_not(e: &Entity) -> &'static str {
    match (e.client, e.kind) {
        (Client::ClaudeCode, Kind::Plugin) if e.state == State::Broken => {
            "плагин не установлен: переключать нечего"
        }
        (Client::ClaudeCode, Kind::Plugin) => {
            "флаг включения лежит в настройках проекта, а проекты Loadout не читает"
        }
        (Client::Codex, Kind::Connector) => {
            "запись кеша каталога удалённых плагинов, а не подключение"
        }
        (Client::ClaudeCode, Kind::Connector) => {
            "запрещён в deniedMcpServers по имени: ключ disableClaudeAiConnectors этого не снимает"
        }
        (_, Kind::Mcp) => "у записи нет флага «выключено»: выключение переносит её в корзину (M4)",
        _ => "правка записей этого типа — уровень R2 (M4)",
    }
}

fn enabled(s: State) -> Option<bool> {
    match s {
        State::On | State::Stale | State::Cloud => Some(true),
        State::Off => Some(false),
        State::Broken | State::Unknown => None,
    }
}

/// Писать можно только в эти файлы клиентов, какой бы путь ни лежал в записи или в манифесте.
fn allowed(home: &Path, file: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").to_lowercase();
    [".claude/settings.json", ".codex/config.toml"]
        .iter()
        .any(|rel| norm(&home.join(rel)) == norm(file))
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub entity: String,
    pub client: Client,
    pub kind: Kind,
    pub name: String,
    pub file: String,
    pub pointer: String,
    pub enable: bool,
    /// Значение ключа в файле до и после: `true`, `false` или «не задан».
    pub from: String,
    pub to: String,
    /// Запись уже в нужном состоянии, писать нечего.
    pub noop: bool,
    /// Другие записи, которые меняет тот же ключ (все коннекторы `disableClaudeAiConnectors`).
    pub affects: Vec<String>,
    pub base_sha: String,
}

struct Built {
    plan: Plan,
    target: Target,
    old: Vec<u8>,
    new: Vec<u8>,
}

fn build(home: &Path, scan: &ScanResult, id: &str, enable: bool) -> Result<Built, String> {
    let e = scan
        .entities
        .iter()
        .find(|e| e.id == id)
        .ok_or("запись не найдена: обновите список")?;
    let t = e.target.clone().ok_or_else(|| why_not(e).to_owned())?;
    if !allowed(home, &t.file) {
        return Err("файл не входит в список разрешённых для записи".into());
    }
    refuse_symlink(&t.file)?;
    let old = std::fs::read(&t.file).map_err(|_| "файл клиента не прочитан".to_owned())?;
    let text = std::str::from_utf8(&old).map_err(|_| "файл клиента не в UTF-8".to_owned())?;
    let cur = edit::get_bool(t.format, text, &t.path)?;
    // `disableClaudeAiConnectors: true` значит «выключено»
    let want = enable != t.inverted;
    let already = cur == Some(want) || (cur.is_none() && enabled(e.state) == Some(enable));
    let new = if already {
        old.clone()
    } else {
        edit::set_bool(t.format, text, &t.path, want)?.into_bytes()
    };
    let affects = scan
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
    let plan = Plan {
        entity: e.id.clone(),
        client: e.client,
        kind: e.kind,
        name: e.name.clone(),
        file: e.origin.file.clone(),
        pointer: e.origin.pointer.clone(),
        enable,
        from: cur.map_or_else(|| "не задан".to_owned(), |b| b.to_string()),
        to: want.to_string(),
        noop: already,
        affects,
        base_sha: sha(&old),
    };
    Ok(Built {
        plan,
        target: t,
        old,
        new,
    })
}

/// Предпросмотр: ничего не пишет.
pub fn plan(home: &Path, id: &str, enable: bool) -> Result<Plan, String> {
    build(home, &crate::scan(home), id, enable).map(|b| b.plan)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    id: String,
    time: u64,
    /// `toggle` или `rollback`.
    op: String,
    of: Option<String>,
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
}

/// Строка журнала: манифест без настоящего пути.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub time: u64,
    pub op: String,
    pub of: Option<String>,
    pub client: String,
    pub kind: String,
    pub name: String,
    pub pointer: String,
    pub file: String,
    pub from: String,
    pub to: String,
    pub rolled_back: bool,
    pub can_rollback: bool,
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

/// Новый каталог операции: имя из времени и счётчика, сортируется как строка.
fn new_op_dir(store: &Path) -> Result<(String, PathBuf), String> {
    std::fs::create_dir_all(store).map_err(|e| format!("каталог бэкапов недоступен: {e}"))?;
    let ms = now_ms();
    for n in 0..100 {
        let id = format!("{ms:013}-{n:02}");
        match std::fs::create_dir(store.join(&id)) {
            Ok(()) => return Ok((id.clone(), store.join(id))),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("каталог бэкапов недоступен: {e}")),
        }
    }
    Err("не удалось выбрать имя каталога бэкапа".into())
}

/// Временный файл рядом: тот же том, значит `rename` атомарен. Имя оканчивается на `.tmp`, сторож его не видит.
fn atomic_write(file: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut name = file.as_os_str().to_owned();
    name.push(".loadout.tmp");
    let tmp = PathBuf::from(name);
    let res = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        // клиент мог на миг открыть файл без права на замену: пробуем несколько раз
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
    res.map_err(|e| format!("запись не удалась: {e}"))
}

/// Запись с `sync_all`: бэкап и манифест должны дойти до диска раньше, чем меняется файл клиента.
fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::File::create(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

fn write_manifest(dir: &Path, m: &Manifest) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?;
    write_synced(&dir.join("manifest.json"), &json).map_err(|e| format!("манифест не записан: {e}"))
}

/// Запись через символьную ссылку заменила бы саму ссылку, а не файл за ней.
fn refuse_symlink(file: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(file) {
        Ok(m) if m.file_type().is_symlink() => {
            Err("файл клиента — символьная ссылка: запись заменила бы ссылку, а не файл".into())
        }
        _ => Ok(()),
    }
}

fn kind_str(k: Kind) -> String {
    serde_json::to_value(k)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// Переключает запись. `base_sha` — хеш файла из предпросмотра: если файл с тех пор изменился, отказ.
pub fn apply(
    home: &Path,
    store: &Path,
    id: &str,
    enable: bool,
    base_sha: &str,
) -> Result<Applied, String> {
    let b = build(home, &crate::scan(home), id, enable)?;
    if b.plan.base_sha != base_sha {
        return Err("файл изменился после предпросмотра: постройте план заново".into());
    }
    if b.plan.noop {
        return Err("запись уже в нужном состоянии".into());
    }
    let (op, dir) = new_op_dir(store)?;
    let fail = |e: String| {
        let _ = std::fs::remove_dir_all(&dir);
        Err(e)
    };
    if let Err(e) = write_synced(&dir.join("before"), &b.old) {
        return fail(format!("бэкап не записан: {e}"));
    }
    // второй раз перед самой записью: между планом и бэкапом клиент мог переписать файл
    if std::fs::read(&b.target.file).ok().as_deref() != Some(b.old.as_slice()) {
        return fail("файл изменился во время записи бэкапа: повторите".into());
    }
    let m = Manifest {
        version: 1,
        id: op.clone(),
        time: now_ms(),
        op: "toggle".into(),
        of: None,
        path: b.target.file.to_string_lossy().into_owned(),
        sha_before: b.plan.base_sha.clone(),
        sha_after: sha(&b.new),
        client: b.plan.client.slug().into(),
        kind: kind_str(b.plan.kind),
        name: b.plan.name.clone(),
        pointer: b.plan.pointer.clone(),
        file: b.plan.file.clone(),
        from: b.plan.from.clone(),
        to: b.plan.to.clone(),
    };
    if let Err(e) = write_manifest(&dir, &m) {
        return fail(e);
    }
    if let Err(e) = atomic_write(&b.target.file, &b.new) {
        return fail(e);
    }
    // Проверка: перечитали и получили ровно «исходник + план». Несовпадение значит, что клиент записал файл сразу после нас:
    // возвращать исходный нельзя (затёрли бы его свежую запись), поэтому операция остаётся в журнале, а бэкап цел.
    if std::fs::read(&b.target.file).ok().as_deref() != Some(b.new.as_slice()) {
        return Err("файл изменён другим процессом сразу после записи: проверьте результат, бэкап и строка журнала сохранены".into());
    }
    Ok(Applied {
        op,
        entity: b.plan.entity,
        from: b.plan.from,
        to: b.plan.to,
    })
}

fn read_manifest(store: &Path, id: &str) -> Result<Manifest, String> {
    // id — имя каталога: только цифры и дефис, иначе в него можно было бы вписать путь
    if id.is_empty() || id.len() > 40 || !id.bytes().all(|c| c.is_ascii_digit() || c == b'-') {
        return Err("неверный номер операции".into());
    }
    let text = std::fs::read_to_string(store.join(id).join("manifest.json"))
        .map_err(|_| "операция не найдена".to_owned())?;
    serde_json::from_str(&text).map_err(|_| "манифест повреждён".to_owned())
}

fn file_sha(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|b| sha(&b))
}

fn manifests(store: &Path) -> Vec<Manifest> {
    let Ok(rd) = std::fs::read_dir(store) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    ids.sort_unstable_by(|a, b| b.cmp(a));
    ids.iter()
        .filter_map(|id| read_manifest(store, id).ok())
        .collect()
}

/// Журнал наших операций, новые первыми. Изменения клиентов извне в него не попадают.
pub fn journal(home: &Path, store: &Path) -> Vec<Entry> {
    let all = manifests(store);
    let undone: std::collections::HashSet<&str> =
        all.iter().filter_map(|m| m.of.as_deref()).collect();
    all.iter()
        .take(200)
        .map(|m| {
            let rolled_back = undone.contains(m.id.as_str());
            let can_rollback = m.op == "toggle"
                && !rolled_back
                && allowed(home, Path::new(&m.path))
                && file_sha(Path::new(&m.path)).as_deref() == Some(m.sha_after.as_str());
            Entry {
                id: m.id.clone(),
                time: m.time,
                op: m.op.clone(),
                of: m.of.clone(),
                client: m.client.clone(),
                kind: m.kind.clone(),
                name: m.name.clone(),
                pointer: m.pointer.clone(),
                file: m.file.clone(),
                from: m.from.clone(),
                to: m.to.clone(),
                rolled_back,
                can_rollback,
            }
        })
        .collect()
}

/// Откат операции: возвращает файл из бэкапа, только если после неё его никто не менял.
pub fn rollback(home: &Path, store: &Path, op: &str) -> Result<Applied, String> {
    let m = read_manifest(store, op)?;
    if m.op != "toggle" {
        return Err("откатывать можно только переключения".into());
    }
    if manifests(store).iter().any(|x| x.of.as_deref() == Some(op)) {
        return Err("операция уже откатана".into());
    }
    let file = PathBuf::from(&m.path);
    // манифест лежит в каталоге пользователя: его путь не доверенный, проверяем по списку так же, как при записи
    if !allowed(home, &file) {
        return Err("файл не входит в список разрешённых для записи".into());
    }
    refuse_symlink(&file)?;
    let current = std::fs::read(&file).map_err(|_| "файл клиента не прочитан".to_owned())?;
    if sha(&current) != m.sha_after {
        return Err("файл изменился после операции: откат затёр бы чужие правки".into());
    }
    let before =
        std::fs::read(store.join(op).join("before")).map_err(|_| "бэкап не найден".to_owned())?;
    if sha(&before) != m.sha_before {
        return Err("бэкап повреждён".into());
    }
    let (id, dir) = new_op_dir(store)?;
    let fail = |e: String| {
        let _ = std::fs::remove_dir_all(&dir);
        Err(e)
    };
    if let Err(e) = write_synced(&dir.join("before"), &current) {
        return fail(format!("бэкап не записан: {e}"));
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
    if let Err(e) = atomic_write(&file, &before) {
        return fail(e);
    }
    // как и после записи: чужую свежую запись не затираем, запись об откате остаётся
    if file_sha(&file).as_deref() != Some(m.sha_before.as_str()) {
        return Err("файл изменён другим процессом сразу после отката: проверьте результат".into());
    }
    Ok(Applied {
        op: id,
        entity: String::new(),
        from: r.from,
        to: r.to,
    })
}
