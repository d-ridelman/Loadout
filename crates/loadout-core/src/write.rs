//! Запись R1 и R2 (CONCEPT.md §5): план, предпросмотр, оптимистичная блокировка, бэкап, атомарная запись, проверка, откат.
//!
//! Наружу — только намерение (`Intent`: id записи и что с ней сделать): цель записи (путь и сырой ключ) берётся
//! из свежего скана внутри ядра, путей от страницы нет. В плане и журнале нет содержимого файлов: только очищенные
//! имя и указатель, старое и новое значение одного ключа (команды — через маскирование) и имена ключей `env`.
//!
//! Уровни: R1 — булев флаг; R2 — вынос в корзину и возврат, правка команды MCP, копирование между клиентами.

use crate::edit;
use crate::mask;
use crate::model::{Client, Entity, Format, Kind, ScanResult, Source, State, TargetKind};
use crate::trash;
use crate::yaml_edit;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
        (Client::DeepSeek, Kind::Mcp) => {
            "запись не определилась как блок `- id: …` в cordis.patch.yml: вынос по строкам для неё не поддержан"
        }
        (_, Kind::Mcp) => "запись лежит в проекте или в плагине: их файлы Loadout не правит",
        _ => "правка записей этого типа не поддержана",
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
/// В `antigravity/mcp/*` и в файлы плагинов Loadout не пишет никогда.
fn allowed(home: &Path, file: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").to_lowercase();
    let fixed = [
        ".claude/settings.json",
        ".claude.json",
        ".codex/config.toml",
        "AppData/Roaming/Claude/claude_desktop_config.json",
        ".gemini/config/mcp_config.json",
    ]
    .iter()
    .any(|rel| norm(&home.join(rel)) == norm(file));
    // DeepSeek: патч пользователя и патчи профилей `~/.dsh/profiles/<имя>/cordis.patch.yml`
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
    fixed || patch
}

pub(crate) fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `~/…` с прямыми слэшами: путь для показа без имени пользователя.
fn tilde(home: &Path, p: &Path) -> String {
    let (s, h) = (
        p.to_string_lossy().replace('\\', "/"),
        home.to_string_lossy().replace('\\', "/"),
    );
    let h = h.trim_end_matches('/');
    if s.len() > h.len() && s[..h.len()].eq_ignore_ascii_case(h) && s.as_bytes()[h.len()] == b'/' {
        format!("~{}", &s[h.len()..])
    } else {
        s
    }
}

/// Что пользователь хочет сделать. Все поля — из окна, поэтому проверяются при разборе плана.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Intent {
    /// Включить или выключить запись (флаг, корзина или стэш: ядро выбирает по цели).
    Toggle { entity: String, enable: bool },
    /// Заменить `command` и `args` MCP целиком. Старых значений окно не получает.
    Edit {
        entity: String,
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
    /// Скопировать MCP в другой клиент (`to` — короткое имя клиента).
    Copy { entity: String, to: String },
}

impl Intent {
    fn entity(&self) -> &str {
        match self {
            Intent::Toggle { entity, .. }
            | Intent::Edit { entity, .. }
            | Intent::Copy { entity, .. } => entity,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// `toggle`, `edit` или `copy`.
    pub op: String,
    /// Какой уровень записи нужен: `R1` или `R2`.
    pub level: String,
    pub entity: String,
    /// Клиент, в файл которого пишем (для копирования это получатель).
    pub client: Client,
    pub kind: Kind,
    pub name: String,
    pub file: String,
    pub pointer: String,
    pub enable: bool,
    /// Значение до и после: `true`/`false`, «включено», «в корзине Loadout» или замаскированная команда.
    pub from: String,
    pub to: String,
    /// Запись уже в нужном состоянии, писать нечего.
    pub noop: bool,
    /// Другие записи, которые меняет тот же ключ (все коннекторы `disableClaudeAiConnectors`).
    pub affects: Vec<String>,
    /// Что стоит знать до подтверждения (что не переносится, какие ключи `env` копируются).
    pub notes: Vec<String>,
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
    /// Для вынесенных и возвращённых записей откат — обратная операция, а не возврат файла целиком.
    inverse_enable: Option<bool>,
}

fn find<'a>(scan: &'a ScanResult, id: &str) -> Result<&'a Entity, String> {
    scan.entities
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| "запись не найдена: обновите список".to_owned())
}

/// Файл клиента: из списка разрешённых и не символьная ссылка (запись заменила бы ссылку, а не файл за ней).
fn guard_file(home: &Path, file: &Path) -> Result<(), String> {
    if !allowed(home, file) {
        return Err("файл не входит в список разрешённых для записи".into());
    }
    match std::fs::symlink_metadata(file) {
        Ok(m) if m.file_type().is_symlink() => {
            Err("файл клиента — символьная ссылка: запись заменила бы ссылку, а не файл".into())
        }
        _ => Ok(()),
    }
}

fn read_text(file: &Path) -> Result<(Vec<u8>, String), String> {
    let old = std::fs::read(file).map_err(|_| "файл клиента не прочитан".to_owned())?;
    let text = String::from_utf8(old.clone()).map_err(|_| "файл клиента не в UTF-8".to_owned())?;
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

fn plan_for(e: &Entity, op: &str, level: &str, file: String, old: &[u8]) -> Plan {
    Plan {
        op: op.to_owned(),
        level: level.to_owned(),
        entity: e.id.clone(),
        client: e.client,
        kind: e.kind,
        name: e.name.clone(),
        file,
        pointer: e.origin.pointer.clone(),
        enable: true,
        from: String::new(),
        to: String::new(),
        noop: false,
        affects: Vec::new(),
        notes: Vec::new(),
        base_sha: sha(old),
    }
}

/// Номер операции и номер записи из пути цели DeepSeek (`[oi, "insert", ei]`).
fn yaml_pos(path: &[String]) -> Result<(usize, usize), String> {
    match path {
        [oi, k, ei] if k == "insert" => Ok((
            oi.parse()
                .map_err(|_| "неверный путь записи YAML".to_owned())?,
            ei.parse()
                .map_err(|_| "неверный путь записи YAML".to_owned())?,
        )),
        _ => Err("неверный путь записи YAML".into()),
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
    let t = e.target.clone().ok_or_else(|| why_not(e).to_owned())?;
    guard_file(home, &t.file)?;
    let (old, text) = read_text(&t.file)?;
    let mut plan = plan_for(e, "toggle", "R1", e.origin.file.clone(), &old);
    plan.enable = enable;
    let mut new = old.clone();
    let (mut trash, mut inverse) = (None, None);
    match &t.kind {
        TargetKind::Flag => {
            let cur = edit::get_bool(t.format, &text, &t.path)?;
            // `disableClaudeAiConnectors: true` значит «выключено»
            let want = enable != t.inverted;
            plan.noop = cur == Some(want) || (cur.is_none() && enabled(e.state) == Some(enable));
            plan.from = cur.map_or_else(|| "не задан".to_owned(), |b| b.to_string());
            plan.to = want.to_string();
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
            plan.from = "включено".into();
            plan.to = if enable {
                "включено"
            } else {
                "в корзине Loadout"
            }
            .into();
            if !enable {
                let (key, parent) = t.path.split_last().ok_or("пустой путь")?;
                // Запись с таким id в корзине, пока живая в файле, устаревшая (её заново добавили руками или возврат
                // не дочистил корзину): перезаписываем, прежнюю копию храним в манифесте.
                let stale = store.and_then(|s| trash::read(s, &e.id));
                let (nt, raw) = match t.format {
                    Format::Yaml => {
                        let (oi, ei) = yaml_pos(&t.path)?;
                        yaml_edit::cut(&text, oi, ei)?
                    }
                    _ => edit::cut_json(&text, &t.path)?,
                };
                new = nt.into_bytes();
                trash = Some(TrashChange {
                    id: e.id.clone(),
                    before: stale,
                    after: Some(trash::Item {
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
                plan.notes.push(
                    "Запись вырезается из файла клиента и лежит в корзине Loadout; клиент её больше не запускает. Включение вернёт её на то же место.".into(),
                );
            }
        }
        TargetKind::Restore(src) => {
            plan.level = "R2".into();
            plan.noop = !enable;
            plan.from = match src {
                Source::Trash(_) => "в корзине Loadout",
                Source::Stash(_) => "в стэше владельца",
            }
            .into();
            plan.to = if enable {
                "включено".to_owned()
            } else {
                plan.from.clone()
            };
            if enable {
                let (base, raw, live) = match src {
                    Source::Trash(tid) => {
                        let s = store
                            .ok_or("корзина недоступна: ядро запущено без каталога бэкапов")?;
                        let it = trash::read(s, tid).ok_or("запись корзины не найдена")?;
                        if Path::new(&it.path) != t.file {
                            return Err("запись корзины относится к другому файлу".into());
                        }
                        let mut live = it.parent.clone();
                        live.push(it.key.clone());
                        let raw = it.value.clone();
                        if it.format == "yaml" {
                            // возврат строк DeepSeek на прежнее место списка (`yaml_edit::put` сверяет результат)
                            let (oi, ei) = yaml_pos(&t.path)?;
                            let put = yaml_edit::put(&text, oi, ei, &raw)
                                .map_err(|e| format!("вернуть запись нельзя: {e}"))?;
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
                            });
                        }
                        trash = Some(TrashChange {
                            id: tid.clone(),
                            before: Some(it),
                            after: None,
                        });
                        (text.clone(), raw, live)
                    }
                    Source::Stash(_) => {
                        let (nt, raw) = edit::cut_json(&text, &t.path)?;
                        let key = t.path.last().ok_or("пустой путь")?.clone();
                        (nt, raw, vec!["mcpServers".to_owned(), key])
                    }
                };
                new = edit::put_raw_json(&base, &live, &raw, false)
                    .map_err(|e| format!("вернуть запись нельзя: {e}"))?
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
    let s = e
        .src
        .clone()
        .ok_or("запись нельзя править: она не в файле клиента")?;
    guard_file(home, &s.file)?;
    if command.trim().is_empty() || !clean_arg(command) {
        return Err("команда пустая, слишком длинная или с управляющими символами".into());
    }
    if args.len() > 64 || !args.iter().all(|a| clean_arg(a)) {
        return Err("аргументы: не больше 64, до 500 знаков, без управляющих символов".into());
    }
    let (old, text) = read_text(&s.file)?;
    let entry = edit::get_value(s.format, &text, &s.path)?.ok_or("записи нет в файле")?;
    if entry.get("command").and_then(Value::as_str).is_none() {
        return Err("у записи нет command: это не локальный сервер (адрес править нельзя)".into());
    }
    let key = |k: &str| {
        let mut p = s.path.clone();
        p.push(k.to_owned());
        p
    };
    let mut new_text = edit::put_value(s.format, &text, &key("command"), &json!(command), true)?;
    if !args.is_empty() || entry.get("args").is_some() {
        new_text = edit::put_value(s.format, &new_text, &key("args"), &json!(args), true)?;
    }
    let mut plan = plan_for(e, "edit", "R2", e.origin.file.clone(), &old);
    plan.from = masked_line(&tokens_of(&entry));
    let mut now = vec![command.to_owned()];
    now.extend(args.iter().cloned());
    plan.to = masked_line(&now);
    plan.noop = new_text.as_bytes() == old.as_slice();
    plan.notes
        .push("Заменяются только command и args; env и заголовки не меняются. Секретные на вид значения в предпросмотре и журнале скрыты.".into());
    Ok(Prepared {
        plan,
        entity: e.id.clone(),
        file: s.file,
        old,
        new: new_text.into_bytes(),
        trash: None,
        inverse_enable: None,
    })
}

/// Файл, формат и ключ с записями MCP у клиента-получателя.
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
        Client::DeepSeek => return None,
    })
}

/// Запись MCP в формате получателя. Что не переносится, возвращается именами ключей.
fn translate(v: &Value, to: Client) -> Result<(Value, Vec<String>), String> {
    let obj = v.as_object().ok_or("запись не объект")?;
    let mut out = serde_json::Map::new();
    let mut skipped = Vec::new();
    for (k, val) in obj {
        match k.as_str() {
            "command" | "args" | "env" | "url" => {
                out.insert(k.clone(), val.clone());
            }
            "headers" | "http_headers" => {
                let name = if to == Client::Codex {
                    "http_headers"
                } else {
                    "headers"
                };
                out.insert(name.to_owned(), val.clone());
            }
            "type" => {} // выводится из url
            other => skipped.push(mask::scrub_words(other)),
        }
    }
    if to == Client::ClaudeCode && out.contains_key("url") {
        out.insert("type".to_owned(), json!("http"));
    }
    skipped.sort();
    Ok((Value::Object(out), skipped))
}

fn prep_copy(home: &Path, scan: &ScanResult, id: &str, to: &str) -> Result<Prepared, String> {
    let e = find(scan, id)?;
    let s = e
        .src
        .clone()
        .ok_or("запись нельзя копировать: она не в файле клиента")?;
    guard_file(home, &s.file)?;
    let dest = Client::from_slug(to).ok_or("неизвестный клиент-получатель")?;
    if dest == e.client {
        return Err("получатель совпадает с источником".into());
    }
    let (file, format, root) = client_target(home, dest)
        .ok_or("в этого клиента копировать нельзя: формат файла не поддержан")?;
    guard_file(home, &file)?;
    let key = s.path.last().ok_or("пустой путь")?.clone();
    if mask::safe_name(&key).is_none() {
        return Err("имя записи недопустимо для копирования".into());
    }
    let (_, src_text) = read_text(&s.file)?;
    let entry = edit::get_value(s.format, &src_text, &s.path)?.ok_or("записи нет в файле")?;
    let (old, text) = read_text(&file)
        .map_err(|_| "файл клиента-получателя не найден: клиент не установлен".to_owned())?;
    let path = vec![root.to_owned(), key.clone()];
    if edit::get_value(format, &text, &path)?.is_some()
        || scan.entities.iter().any(|o| {
            o.client == dest && o.kind == Kind::Mcp && o.scope == "user" && o.name == e.name
        })
    {
        return Err("в клиенте-получателе уже есть запись с таким именем".into());
    }
    let (value, skipped) = translate(&entry, dest)?;
    // Запись без command и url у получателя мертва: так бывает, когда адрес лежит в другом ключе (`serverUrl`),
    // а перевод его не знает. Лучше отказать, чем записать пустышку в чужой конфиг.
    let has = |k: &str| {
        value
            .get(k)
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
    };
    if !has("command") && !has("url") {
        return Err(format!(
            "запись не переносится: после перевода у неё нет ни command, ни url{}",
            if skipped.is_empty() {
                String::new()
            } else {
                format!(" (не распознаны ключи: {})", skipped.join(", "))
            }
        ));
    }
    let new_text = edit::put_value(format, &text, &path, &value, false)?;

    let mut plan = plan_for(e, "copy", "R2", tilde(home, &file), &old);
    plan.client = dest;
    plan.pointer = match format {
        Format::Json | Format::Yaml => format!("/{root}/{key}"),
        Format::Toml => format!("{root}.{key}"),
    };
    plan.from = "нет записи".into();
    plan.to = format!("копия: {}", {
        let t = tokens_of(&value);
        if t.is_empty() {
            value
                .get("url")
                .and_then(Value::as_str)
                .map_or_else(String::new, |u| masked_line(&[u.to_owned()]))
        } else {
            masked_line(&t)
        }
    });
    let env_keys = mask::mcp_detail(&entry)
        .get("envKeys")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    if !env_keys.is_empty() {
        plan.notes.push(format!(
            "Копируются ключи env: {env_keys}. Значения (в том числе секреты) переносятся как есть и в окне не показываются."
        ));
    }
    if !skipped.is_empty() {
        plan.notes
            .push(format!("Не переносятся: {}.", skipped.join(", ")));
    }
    Ok(Prepared {
        plan,
        entity: e.id.clone(),
        file,
        old,
        new: new_text.into_bytes(),
        trash: None,
        inverse_enable: None,
    })
}

fn prepare(
    home: &Path,
    store: Option<&Path>,
    scan: &ScanResult,
    i: &Intent,
) -> Result<Prepared, String> {
    let mut p = prepare_raw(home, store, scan, i)?;
    // В план и журнал уходят введённая команда и скопированные аргументы: путь домашнего каталога в них заменяется на `~`
    for s in [&mut p.plan.from, &mut p.plan.to] {
        *s = crate::scrub_home(home, s);
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
        Intent::Copy { entity, to } => prep_copy(home, scan, entity, to),
    }
}

/// Предпросмотр: ничего не пишет.
pub fn plan(home: &Path, store: Option<&Path>, i: &Intent) -> Result<Plan, String> {
    let scan = crate::scan_with(home, store);
    prepare(home, store, &scan, i).map(|p| p.plan)
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
    /// `toggle`, `edit`, `copy` или `rollback`.
    op: String,
    of: Option<String>,
    #[serde(default)]
    batch: Option<String>,
    /// Какой уровень записи требовала операция (`R1`, `R2`): для отката нужен тот же.
    #[serde(default = "level_r1")]
    level: String,
    /// id записи, к которой относится операция (откат корзинных операций строится по нему).
    #[serde(default)]
    entity: String,
    /// Какое значение `enable` вернёт запись обратно (только у выноса и возврата из корзины).
    #[serde(default)]
    inverse_enable: Option<bool>,
    /// Состояние корзины до операции: при откате файла возвращается и оно.
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
}

/// Строка журнала: манифест без настоящего пути.
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
pub(crate) fn write_synced(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::File::create(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

fn write_manifest(dir: &Path, m: &Manifest) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?;
    write_synced(&dir.join("manifest.json"), &json).map_err(|e| format!("манифест не записан: {e}"))
}

/// Короткое имя типа (`mcp`, `plugin`…), как в JSON.
pub fn kind_name(k: Kind) -> String {
    serde_json::to_value(k)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// Общий конвейер записи: бэкап → манифест → (корзина) → временный файл и `rename` → проверка.
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
        return fail(format!("бэкап не записан: {e}"));
    }
    // второй раз перед самой записью: между планом и бэкапом клиент мог переписать файл
    if std::fs::read(&p.file).ok().as_deref() != Some(p.old.as_slice()) {
        return fail("файл изменился во время записи бэкапа: повторите".into());
    }
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
    };
    if let Err(e) = write_manifest(&dir, &m) {
        return fail(e);
    }
    // вынос: сначала текст записи в корзину, и только потом вырезаем из файла (иначе при сбое запись потеряна)
    if let Some(item) = p.trash.as_ref().and_then(|t| t.after.as_ref()) {
        if let Err(e) = trash::write(store, item) {
            return fail(e);
        }
    }
    if let Err(e) = atomic_write(&p.file, &p.new) {
        // вынос не состоялся: корзина возвращается к прежнему виду (новой копии нет, устаревшая на месте)
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
    // возврат: запись уже на месте в файле, теперь её копию из корзины убираем
    if let Some(t) = p.trash.as_ref().filter(|t| t.after.is_none()) {
        trash::remove(store, &t.id);
    }
    // Проверка: перечитали и получили ровно «исходник + план». Несовпадение значит, что клиент записал файл сразу после нас:
    // возвращать исходный нельзя (затёрли бы его свежую запись), поэтому операция остаётся в журнале, а бэкап цел.
    if std::fs::read(&p.file).ok().as_deref() != Some(p.new.as_slice()) {
        return Err("файл изменён другим процессом сразу после записи: проверьте результат, бэкап и строка журнала сохранены".into());
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
    }
}

fn rank(level: &str) -> u8 {
    match level {
        "R2" => 2,
        "R1" => 1,
        _ => 0,
    }
}

/// Уровень записи проверяет и ядро: `max_level` приходит от main одним запросом вместе с самой операцией, поэтому
/// между проверкой и записью нельзя вклинить запрос, который подменит план (проверка «спросили план, потом применили»
/// такой гонке поддавалась).
fn need_level(need: &str, max_level: &str) -> Result<(), String> {
    if rank(need) > rank(max_level) {
        return Err(format!("для этой операции нужен уровень {need}"));
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
    let scan = crate::scan_with(home, Some(store));
    let p = prepare(home, Some(store), &scan, i)?;
    need_level(&p.plan.level, max_level)?;
    if base_sha.is_some_and(|b| b != p.plan.base_sha) {
        return Err("файл изменился после предпросмотра: постройте план заново".into());
    }
    if p.plan.noop {
        return Err("запись уже в нужном состоянии".into());
    }
    commit(store, p, op_name(i), None, batch)
}

/// Выполняет намерение. `base_sha` — хеш файла из предпросмотра: если файл с тех пор изменился, отказ.
pub fn apply(
    home: &Path,
    store: &Path,
    i: &Intent,
    base_sha: &str,
    max_level: &str,
) -> Result<Applied, String> {
    apply_one(home, store, i, Some(base_sha), None, max_level)
}

/// План пакета (профиль): по каждому намерению, которое нашло запись, и список пропущенных.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPlan {
    pub plans: Vec<Plan>,
    /// Намерения, для которых записи уже нет (имена для показа).
    pub skipped: Vec<String>,
    pub level: String,
    /// Подпись всего пакета: если за время предпросмотра что-то изменилось, она не совпадёт.
    pub batch_sha: String,
}

pub fn plan_batch(home: &Path, store: Option<&Path>, items: &[Intent]) -> BatchPlan {
    let scan = crate::scan_with(home, store);
    let (mut plans, mut skipped) = (Vec::new(), Vec::new());
    for i in items {
        match prepare(home, store, &scan, i) {
            Ok(p) => plans.push(p.plan),
            Err(_) => skipped.push(
                scan.entities
                    .iter()
                    .find(|e| e.id == i.entity())
                    .map_or_else(|| "запись исчезла".to_owned(), |e| e.name.clone()),
            ),
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

/// Применяет пакет по одному намерению, каждое со своим бэкапом и строкой журнала; общий номер пакета позволяет
/// откатить всё сразу. При первой ошибке останавливается: сделанное остаётся в журнале.
pub fn apply_batch(
    home: &Path,
    store: &Path,
    items: &[Intent],
    batch_sha: &str,
    max_level: &str,
) -> Result<(String, Vec<Applied>), String> {
    let bp = plan_batch(home, Some(store), items);
    if bp.batch_sha != batch_sha {
        return Err("состояние изменилось после предпросмотра: постройте план заново".into());
    }
    need_level(&bp.level, max_level)?;
    let batch = format!("{:013}", now_ms());
    let mut done = Vec::new();
    for (n, i) in items.iter().enumerate() {
        let scan = crate::scan_with(home, Some(store));
        match prepare(home, Some(store), &scan, i) {
            // уже в нужном состоянии: пропускаем, это не ошибка пакета
            Ok(p) if p.plan.noop => continue,
            Ok(_) => {}
            // записи не было и в предпросмотре (он её пропустил): пропускаем; а если она была и пропала посреди
            // пакета, молча пропускать нельзя: пакет остановится с ошибкой
            Err(_) if !bp.plans.iter().any(|p| p.entity == i.entity()) => continue,
            Err(e) => {
                return Err(format!(
                    "{e} (выполнено {} записей; сделанное можно откатить в журнале)",
                    done.len()
                ))
            }
        }
        match apply_one(home, store, i, None, Some(&batch), max_level) {
            Ok(a) => done.push(a),
            Err(e) => {
                return Err(format!(
                    "{e} (выполнено {} из {}; сделанное можно откатить в журнале)",
                    done.len(),
                    items.len() - n + done.len()
                ))
            }
        }
    }
    Ok((batch, done))
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
        .filter(|e| e.path().is_dir() && e.file_name() != "trash")
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    ids.sort_unstable_by(|a, b| b.cmp(a));
    ids.iter()
        .filter_map(|id| read_manifest(store, id).ok())
        .collect()
}

/// Запись, к которой относилась операция. Возврат из стэша владельца меняет указатель, а с ним и id
/// (`/_disabledMcpServers/x` → `/mcpServers/x`), поэтому после поиска по id ищем по клиенту, типу и имени.
fn resolve_entity<'a>(scan: &'a ScanResult, m: &Manifest) -> Option<&'a Entity> {
    scan.entities.iter().find(|e| e.id == m.entity).or_else(|| {
        scan.entities.iter().find(|e| {
            e.client.slug() == m.client
                && kind_name(e.kind) == m.kind
                && e.scope == "user"
                && e.name == m.name
        })
    })
}

/// Журнал наших операций, новые первыми. Изменения клиентов извне в него не попадают.
pub fn journal(home: &Path, store: &Path) -> Vec<Entry> {
    let all = manifests(store);
    let undone: std::collections::HashSet<&str> =
        all.iter().filter_map(|m| m.of.as_deref()).collect();
    // состояние записей нужно только для откатов вынесенных в корзину: один скан на весь журнал
    let scan: Option<ScanResult> = all
        .iter()
        .take(200)
        .any(|m| m.inverse_enable.is_some())
        .then(|| crate::scan_with(home, Some(store)));
    all.iter()
        .take(200)
        .map(|m| {
            let rolled_back = undone.contains(m.id.as_str());
            let can_rollback = m.op != "rollback"
                && !rolled_back
                && match m.inverse_enable {
                    // вынос и возврат откатываются обратной операцией, пока запись в том состоянии, которое оставила операция
                    Some(inv) => scan
                        .as_ref()
                        .and_then(|s| resolve_entity(s, m))
                        .is_some_and(|e| enabled(e.state) == Some(!inv)),
                    None => {
                        allowed(home, Path::new(&m.path))
                            && file_sha(Path::new(&m.path)).as_deref() == Some(m.sha_after.as_str())
                    }
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

/// Откат операции. Флаги, правки и копии возвращают файл из бэкапа, только если после операции его никто не менял.
/// Вынос в корзину и возврат откатываются обратной операцией над текущим файлом: `~/.claude.json` клиент переписывает
/// постоянно, и сверка хеша там почти всегда отказывала бы.
pub fn rollback(home: &Path, store: &Path, op: &str, max_level: &str) -> Result<Applied, String> {
    let m = read_manifest(store, op)?;
    need_level(&m.level, max_level)?;
    if m.op == "rollback" {
        return Err("откатывать можно только саму операцию, а не откат".into());
    }
    if manifests(store).iter().any(|x| x.of.as_deref() == Some(op)) {
        return Err("операция уже откатана".into());
    }
    // Обратная операция — когда в деле корзина или файл с тех пор менялся. Возврат из стэша владельца при неизменном
    // файле откатывается возвратом файла из бэкапа: запись снова оказывается в стэше, а не в корзине Loadout.
    let inverse = m.inverse_enable.filter(|_| {
        m.trash_id.is_some()
            || file_sha(Path::new(&m.path)).as_deref() != Some(m.sha_after.as_str())
    });
    if let Some(enable) = inverse {
        let scan = crate::scan_with(home, Some(store));
        let id = resolve_entity(&scan, &m)
            .ok_or("запись не найдена: возможно, её изменили вручную")?
            .id
            .clone();
        let p = prep_toggle(home, Some(store), &scan, &id, enable)?;
        if p.plan.noop {
            return Err("запись уже в нужном состоянии: откатывать нечего".into());
        }
        return commit(store, p, "rollback", Some(op.to_owned()), None);
    }
    let file = PathBuf::from(&m.path);
    // манифест лежит в каталоге пользователя: его путь не доверенный, проверяем по списку так же, как при записи
    guard_file(home, &file)?;
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

/// Откатывает пакет целиком, начиная с последней операции. Останавливается на первой ошибке.
pub fn rollback_batch(
    home: &Path,
    store: &Path,
    batch: &str,
    max_level: &str,
) -> Result<Vec<Applied>, String> {
    let ops: Vec<String> = manifests(store)
        .into_iter()
        .filter(|m| m.batch.as_deref() == Some(batch) && m.op != "rollback")
        .map(|m| m.id)
        .collect(); // manifests() отдаёт новые первыми, это и нужный порядок отката
    let all = manifests(store);
    let mut done = Vec::new();
    for id in ops {
        if all.iter().any(|x| x.of.as_deref() == Some(id.as_str())) {
            continue;
        }
        done.push(rollback(home, store, &id, max_level)?);
    }
    if done.is_empty() {
        return Err("в пакете нечего откатывать".into());
    }
    Ok(done)
}
