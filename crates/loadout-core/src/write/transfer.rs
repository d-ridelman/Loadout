//! Copying an entry to another client (R2): an MCP server or a hook, in the user scope or inside one known project.
//! Skills are folders and go through `skill.rs`; this module also holds the reasons shared by both (`static_why`).
//!
//! The map of what goes where, with which losses, is docs/TRANSFER.en.md. A copy never overwrites: a taken name is a
//! refusal. Values of `env` and headers are copied inside the core as they are and never reach the plan.

use super::{
    client_target, empty_path, entry_missing, find, guard_file, locate, masked_line, mcp_root,
    plan_for, read_text, target_file_missing, tokens_of, written_as, Prepared,
};
use crate::edit;
use crate::mask;
use crate::model::{Client, CopyFrom, Entity, Format, Kind, ScanResult, Src};
use crate::projects::{self, Project};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Hook events both Claude Code and Codex have (Claude Code docs `hooks`, Codex `hooks/src/lib.rs`).
const SHARED_EVENTS: [&str; 11] = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SubagentStart",
    "SubagentStop",
    "Stop",
];
/// Events whose `matcher` is a tool name; for the others its values are not compared between the clients.
const TOOL_EVENTS: [&str; 3] = ["PreToolUse", "PostToolUse", "PermissionRequest"];

fn tr(ru: &str, en: &str) -> String {
    if crate::i18n::is_en() { en } else { ru }.to_owned()
}

/// A project file Loadout may write to: `<p>/.codex/config.toml` or `<p>/opencode.json(c)` of a known project.
pub(super) fn project_file(home: &Path, file: &Path) -> Option<Project> {
    const REL: [&str; 3] = [".codex/config.toml", "opencode.json", "opencode.jsonc"];
    let n = |p: &Path| p.to_string_lossy().replace('\\', "/").to_lowercase();
    let f = n(file);
    // the project lists are read only for a file with one of these names
    if !REL.iter().any(|r| f.ends_with(&format!("/{r}"))) {
        return None;
    }
    projects::known(home)
        .into_iter()
        .find(|p| REL.iter().any(|r| n(&p.dir.join(r)) == f))
}

/// The write stays inside the project: the nearest existing folder on the way to `path`, with links and junctions
/// resolved, lies in the project folder (a `.codex` that is a junction elsewhere is a refusal).
pub(super) fn inside(p: &Project, path: &Path) -> Result<(), String> {
    let mut at = path;
    while !at.exists() {
        at = at.parent().ok_or_else(empty_path)?;
    }
    match (std::fs::canonicalize(at), std::fs::canonicalize(&p.dir)) {
        (Ok(real), Ok(root)) if real.starts_with(&root) => Ok(()),
        _ => Err(tr(
            "папка внутри проекта ведёт за его пределы (ссылка или junction): запись отменена",
            "a folder inside the project leads outside it (a link or junction): nothing is written",
        )),
    }
}

/// Where the copy goes: `None` is the user scope, `Some` a known project (the entry's own). Other scopes are not copied.
pub(super) fn place_of(home: &Path, e: &Entity) -> Result<Option<Project>, String> {
    if e.scope == "user" {
        return Ok(None);
    }
    if !e.scope.starts_with("project:") {
        return Err(tr(
            "переносятся только записи области user и записи проекта",
            "only user-scope and project entries are copied",
        ));
    }
    e.project
        .as_deref()
        .and_then(|id| projects::find(home, id))
        .map(Some)
        .ok_or_else(|| {
            tr(
                "проект не найден среди известных Loadout (его нет в ~/.claude.json и в [projects] Codex)",
                "the project is not among the ones Loadout knows (it is in neither ~/.claude.json nor the Codex [projects])",
            )
        })
}

fn is_ctxkit(s: &str) -> bool {
    let l = s.to_lowercase();
    l.contains("context-toolkit") || l.contains("ctxkit")
}

/// Pairs that are refused whatever the files hold, with the reason (the window shows it next to the client).
/// An empty map: every other client may take the entry, and the plan checks the rest.
pub(crate) fn static_why(e: &Entity) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let project = e.scope.starts_with("project:");
    for to in Client::ALL.into_iter().filter(|c| *c != e.client) {
        if let Some(why) = why(e, to, project) {
            out.insert(to.slug().to_owned(), why);
        }
    }
    out
}

fn why(e: &Entity, to: Client, project: bool) -> Option<String> {
    use Client::*;
    let r = match e.kind {
        Kind::Plugin => match (e.client, to) {
            (ClaudeCode, Antigravity) => tr(
                "плагин — пакет, его ставит сам клиент: в Antigravity есть свой перевод, команда agy plugin import claude",
                "a plugin is a package the client installs itself: Antigravity has its own converter, agy plugin import claude",
            ),
            (ClaudeCode, Codex) => tr(
                "плагин — пакет, его ставит сам клиент: Codex читает маркетплейсы Claude Code, добавьте маркетплейс и поставьте плагин в Codex",
                "a plugin is a package the client installs itself: Codex reads Claude Code marketplaces, add the marketplace and install the plugin in Codex",
            ),
            _ => tr(
                "плагин — пакет, его ставит и обновляет сам клиент; правкой файла он в другой клиент не переносится",
                "a plugin is a package its client installs and updates; no file edit moves it to another client",
            ),
        },
        _ if !e.can_copy => return None,
        Kind::Mcp => match to {
            DeepSeek => tr(
                "MCP DeepSeek живёт в YAML с тегами (!!js): такую запись Loadout только вынимает и возвращает",
                "DeepSeek MCP lives in tagged YAML (!!js): Loadout only takes such an entry out and puts it back",
            ),
            ClaudeDesktop | Antigravity if project => tr(
                "у этого клиента нет проверенного проектного файла MCP",
                "this client has no verified project MCP file",
            ),
            _ => return None,
        },
        Kind::Skill => match (e.client, to) {
            (_, ClaudeDesktop) => tr(
                "скилы чата Claude Desktop живут в аккаунте claude.ai, а не в файлах",
                "Claude Desktop chat skills live in the claude.ai account, not in files",
            ),
            (ClaudeCode, OpenCode) => tr(
                "не нужно: OpenCode и так читает скилы Claude Code (.claude/skills)",
                "not needed: OpenCode already reads Claude Code skills (.claude/skills)",
            ),
            _ => return None,
        },
        Kind::Hook if is_ctxkit(&e.name) => tr(
            "хуки Context Toolkit свои у каждого клиента: для другого клиента их ставит раздел «Инструменты контекста»",
            "Context Toolkit hooks are specific to each client: install them for another client in Context Toolkit",
        ),
        Kind::Hook => match to {
            ClaudeCode | Codex => return None,
            Antigravity => tr(
                "у Antigravity другой протокол хуков (вход в camelCase, ответ decision): скрипт для Claude Code его не поймёт",
                "Antigravity has another hook protocol (camelCase input, a decision answer): a Claude Code script would not understand it",
            ),
            OpenCode => tr(
                "у OpenCode нет хуков-команд, только плагины-код",
                "OpenCode has no command hooks, only code plugins",
            ),
            DeepSeek => tr(
                "файл хуков DeepSeek назван внутри YAML с тегами, а Stop-хук там не видит stop_hook_active: Loadout туда не пишет",
                "the DeepSeek hooks file is named inside tagged YAML, and a Stop hook there cannot see stop_hook_active: Loadout does not write there",
            ),
            ClaudeDesktop => tr("у Claude Desktop нет хуков", "Claude Desktop has no hooks"),
        },
        _ => tr(
            "записи этого типа не переносятся",
            "entries of this kind are not copied",
        ),
    };
    Some(r)
}

/// The copy of an MCP server or a hook (skills go through `skill.rs`).
pub(super) fn prep_copy(
    home: &Path,
    scan: &ScanResult,
    id: &str,
    to: &str,
) -> Result<Prepared, String> {
    let e = find(scan, id)?;
    let dest = dest_of(e, to)?;
    match e.kind {
        Kind::Mcp => mcp(home, scan, e, dest),
        Kind::Hook => hook(home, e, dest),
        _ => Err(tr(
            "записи этого типа не переносятся",
            "entries of this kind are not copied",
        )),
    }
}

/// The target client, checked against the static refusals.
pub(super) fn dest_of(e: &Entity, to: &str) -> Result<Client, String> {
    let dest = Client::from_slug(to)
        .ok_or_else(|| tr("неизвестный клиент-получатель", "unknown target client"))?;
    if dest == e.client {
        return Err(tr(
            "получатель совпадает с источником",
            "the target is the same as the source",
        ));
    }
    if let Some(r) = why(e, dest, e.scope.starts_with("project:")) {
        return Err(r);
    }
    if !e.can_copy {
        return Err(tr(
            "запись нельзя копировать: Loadout не знает, где она лежит целиком",
            "the entry cannot be copied: Loadout does not know where it lies in full",
        ));
    }
    Ok(dest)
}

fn source(e: &Entity) -> Result<Src, String> {
    match (&e.copy_from, &e.src) {
        (Some(CopyFrom::Entry(s)), _) | (None, Some(s)) => Ok(s.clone()),
        _ => Err(tr(
            "запись нельзя копировать: она не в файле клиента",
            "the entry cannot be copied: it is not in a client file",
        )),
    }
}

/// An MCP entry in the target's format. What is not carried over is returned as key names.
fn translate(v: &Value, to: Client) -> Result<(Value, Vec<String>), String> {
    let obj = v
        .as_object()
        .ok_or_else(|| tr("запись не объект", "the entry is not an object"))?;
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
            // the transport comes from `url`; an old SSE or WebSocket server would be written as HTTP and not connect
            "type" if matches!(val.as_str(), Some("sse" | "ws")) => return Err(tr(
                "транспорт sse или ws у получателя не поддержан: запись не переносится",
                "the sse or ws transport is not supported by the target: the entry is not copied",
            )),
            "type" => {}
            other => skipped.push(mask::scrub_words(other)),
        }
    }
    if to == Client::ClaudeDesktop && out.contains_key("url") {
        return Err(tr(
            "удалённый сервер в Claude Desktop добавляется в приложении как коннектор: в файле конфигурации документация показывает только локальные",
            "a remote server is added to Claude Desktop in the app, as a connector: the documentation shows only local ones in the config file",
        ));
    }
    if to == Client::ClaudeCode && out.contains_key("url") {
        out.insert("type".to_owned(), json!("http"));
    }
    // an OpenCode remote server has no environment
    if to == Client::OpenCode && !out.contains_key("command") && out.remove("env").is_some() {
        skipped.push("env".to_owned());
    }
    skipped.sort();
    Ok((Value::Object(out), skipped))
}

fn has_placeholder(v: &Value) -> bool {
    match v {
        Value::String(s) => s.contains("${"),
        Value::Array(a) => a.iter().any(has_placeholder),
        Value::Object(o) => o.values().any(has_placeholder),
        _ => false,
    }
}

/// The target file of an MCP copy, its text and the key path to the new entry; `created` when the file is new.
struct Spot {
    file: PathBuf,
    format: Format,
    path: Vec<String>,
    old: Vec<u8>,
    text: String,
    created: bool,
}

fn read_or_new(file: &Path) -> Result<(Vec<u8>, String, bool), String> {
    if std::fs::symlink_metadata(file).is_ok() {
        let (old, text) = read_text(file)?;
        Ok((old, text, false))
    } else {
        Ok((Vec::new(), String::new(), true))
    }
}

fn mcp_spot(home: &Path, place: Option<&Project>, dest: Client, key: &str) -> Result<Spot, String> {
    let Some(p) = place else {
        let (file, format, root) = client_target(home, dest).ok_or_else(|| {
            tr(
                "в этого клиента копировать нельзя: формат файла не поддержан",
                "copying into this client is not possible: the file format is not supported",
            )
        })?;
        let (old, text) = read_text(&file).map_err(|_| target_file_missing())?;
        let mut path = mcp_root(dest, root, &text)?;
        path.push(key.to_owned());
        return Ok(Spot {
            file,
            format,
            path,
            old,
            text,
            created: false,
        });
    };
    match dest {
        // the private local scope, not the shared `.mcp.json`: values of env do not end up in the repository
        Client::ClaudeCode => {
            let ck = p.claude_key.clone().ok_or_else(|| {
                tr(
                    "Claude Code не знает этот проект (его нет в ~/.claude.json): откройте проект в Claude Code один раз",
                    "Claude Code does not know this project (it is not in ~/.claude.json): open the project in Claude Code once",
                )
            })?;
            let file = home.join(".claude.json");
            let (old, text) = read_text(&file).map_err(|_| target_file_missing())?;
            let parent = ["projects".to_owned(), ck.clone()];
            if !edit::get_value(Format::Json, &text, &parent)?.is_some_and(|v| v.is_object()) {
                return Err(entry_missing());
            }
            Ok(Spot {
                file,
                format: Format::Json,
                path: vec!["projects".into(), ck, "mcpServers".into(), key.to_owned()],
                old,
                text,
                created: false,
            })
        }
        Client::Codex => {
            let file = p.dir.join(".codex").join("config.toml");
            inside(p, &file)?;
            let (old, text, created) = read_or_new(&file)?;
            Ok(Spot {
                file,
                format: Format::Toml,
                path: vec!["mcp_servers".into(), key.to_owned()],
                old,
                text,
                created,
            })
        }
        Client::OpenCode => {
            let file = crate::opencode::FILES
                .iter()
                .map(|f| p.dir.join(f))
                .find(|f| f.is_file())
                .ok_or_else(|| {
                    tr(
                        "в папке проекта нет opencode.json: без него неизвестно, какую схему ждёт OpenCode; создайте его в OpenCode",
                        "the project folder has no opencode.json: without it the schema OpenCode expects is unknown; create it in OpenCode",
                    )
                })?;
            inside(p, &file)?;
            let (old, text) = read_text(&file)?;
            let mut path = crate::opencode::servers_path_of(&text)?;
            path.push(key.to_owned());
            Ok(Spot {
                file,
                format: Format::Json,
                path,
                old,
                text,
                created: false,
            })
        }
        _ => Err(tr(
            "у этого клиента нет проверенного проектного файла MCP",
            "this client has no verified project MCP file",
        )),
    }
}

fn mcp(home: &Path, scan: &ScanResult, e: &Entity, dest: Client) -> Result<Prepared, String> {
    let s = source(e)?;
    let key = s.path.last().ok_or_else(empty_path)?.clone();
    if mask::safe_name(&key).is_none() {
        return Err(tr(
            "имя записи недопустимо для копирования",
            "the entry name is not valid for copying",
        ));
    }
    let (_, src_text) = read_text(&s.file)?;
    let entry = edit::get_value(s.format, &src_text, &s.path)?.ok_or_else(entry_missing)?;
    let entry = if e.client == Client::OpenCode {
        crate::opencode::to_common(&entry)
    } else {
        entry
    };
    let place = place_of(home, e)?;
    let spot = mcp_spot(home, place.as_ref(), dest, &key)?;
    guard_file(home, &spot.file)?;
    let taken = !spot.created && edit::get_value(spot.format, &spot.text, &spot.path)?.is_some();
    if taken
        || scan.entities.iter().any(|o| {
            o.client == dest && o.kind == Kind::Mcp && o.scope == e.scope && o.name == e.name
        })
    {
        return Err(tr(
            "в клиенте-получателе уже есть запись с таким именем",
            "the target client already has an entry with this name",
        ));
    }
    let (value, skipped) = translate(&entry, dest)?;
    // An entry without command and url is dead at the target: this happens when the address lives in another key (`serverUrl`)
    // and the translation does not know it. Better to refuse than to write a placeholder into someone else's config.
    let has = |k: &str| {
        value
            .get(k)
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
    };
    if !has("command") && !has("url") {
        let hint = if skipped.is_empty() {
            String::new()
        } else {
            crate::tr!(
                " (не распознаны ключи: {})",
                " (unrecognized keys: {})",
                skipped.join(", ")
            )
        };
        return Err(crate::tr!(
            "запись не переносится: после перевода у неё нет ни command, ни url{hint}",
            "the entry is not copied: after translation it has neither command nor url{hint}"
        ));
    }
    let new_text = edit::put_value(
        spot.format,
        &spot.text,
        &spot.path,
        &written_as(dest, &value),
        false,
    )?;

    let mut plan = plan_for(
        e,
        "copy",
        "R2",
        locate(home, &spot.file, spot.format, &spot.path, e),
        &spot.old,
    );
    plan.client = dest;
    plan.from = tr("нет записи", "no entry");
    let shown = {
        let t = tokens_of(&value);
        if t.is_empty() {
            value
                .get("url")
                .and_then(Value::as_str)
                .map_or_else(String::new, |u| masked_line(&[u.to_owned()]))
        } else {
            masked_line(&t)
        }
    };
    plan.to = crate::tr!("копия: {shown}", "copy: {shown}");
    // what the target receives, not what the source has
    let env_keys = mask::mcp_detail(&value)
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
        plan.notes.push(crate::tr!(
            "Копируются ключи env: {env_keys}. Значения (в том числе секреты) переносятся как есть и в окне не показываются.",
            "env keys are copied: {env_keys}. Values (including secrets) are copied as is and are not shown in the window."
        ));
    }
    if !skipped.is_empty() {
        plan.notes.push(crate::tr!(
            "Не переносятся: {}.",
            "Not copied: {}.",
            skipped.join(", ")
        ));
    }
    if dest != Client::ClaudeCode && has_placeholder(&value) {
        plan.notes.push(tr(
            "В значениях есть подстановки ${…}: их раскрывает только Claude Code, получатель увидит их буквальным текстом. Проверьте запись после копирования.",
            "The values contain ${…} placeholders: only Claude Code expands them, the target sees them as literal text. Check the entry after copying.",
        ));
    }
    if spot.created {
        plan.notes.push(crate::tr!(
            "Файла ещё нет: Loadout создаст его, а откат удалит.",
            "The file does not exist yet: Loadout creates it, and a rollback removes it."
        ));
    }
    // the journal rollback restores the whole file only while it is unchanged, and a running Claude Code rewrites it often
    if dest == Client::ClaudeCode {
        let scope = if place.is_some() { "local" } else { "user" };
        let key = mask::scrub_words(&key);
        plan.notes.push(crate::tr!(
            "Claude Code часто сам переписывает ~/.claude.json: откат из журнала пройдёт, только пока файл не менялся. Иначе уберите запись командой claude mcp remove {key} -s {scope}.",
            "Claude Code often rewrites ~/.claude.json itself: the journal rollback works only while the file is unchanged. Otherwise remove the entry with claude mcp remove {key} -s {scope}."
        ));
    }
    if let Some(p) = &place {
        let secret = ["env", "headers", "http_headers"].iter().any(|k| {
            value
                .get(*k)
                .and_then(Value::as_object)
                .is_some_and(|o| !o.is_empty())
        });
        match dest {
            Client::ClaudeCode => plan.notes.push(tr(
                "Запись ляжет в личную область local проекта (~/.claude.json), а не в общий .mcp.json: в репозиторий она не попадёт.",
                "The entry goes to the project's private local scope (~/.claude.json), not the shared .mcp.json: it does not reach the repository.",
            )),
            _ if secret => plan.warn.push(tr(
                "Значения env или заголовков (в том числе секреты) будут записаны в файл внутри папки проекта. Если папка под git, проверьте .gitignore до коммита, иначе секреты попадут в репозиторий.",
                "Values of env or headers (secrets included) will be written to a file inside the project folder. If the folder is under git, check .gitignore before you commit, or the secrets reach the repository.",
            )),
            _ => {}
        }
        if dest == Client::Codex && !p.codex_trusted {
            plan.notes.push(tr(
                "Проект не отмечен доверенным в Codex: Codex прочитает .codex/config.toml только после того, как вы доверите проекту.",
                "The project is not trusted in Codex: Codex reads .codex/config.toml only after you trust the project.",
            ));
        }
    }
    Ok(Prepared {
        plan,
        entity: e.id.clone(),
        file: spot.file,
        old: spot.old,
        new: new_text.into_bytes(),
        trash: None,
        inverse_enable: None,
        created: spot.created,
    })
}

/// Tool names of the `matcher` in the target client's terms; names with no counterpart are returned as dropped.
fn translate_matcher(
    m: Option<&str>,
    to: Client,
    event: &str,
) -> Result<(Option<String>, Vec<String>), String> {
    let Some(m) = m.map(str::trim).filter(|s| !s.is_empty() && *s != "*") else {
        return Ok((None, Vec::new()));
    };
    if !TOOL_EVENTS.contains(&event) {
        return Err(crate::tr!(
            "у хука на событии {event} есть matcher, а его значения у клиентов не сверены: хук не переносится",
            "the hook on {event} has a matcher whose values are not matched between the clients: the hook is not copied"
        ));
    }
    if !m
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '|'))
    {
        return Err(tr(
            "matcher хука — регулярное выражение: однозначно перевести имена инструментов нельзя",
            "the hook matcher is a regular expression: tool names cannot be translated unambiguously",
        ));
    }
    let (mut out, mut dropped): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    for name in m.split('|').filter(|s| !s.is_empty()) {
        // Codex: `Bash`, `apply_patch` (also matched as `Edit` and `Write`), `mcp__…` (Codex docs, hooks)
        let names: Vec<&str> = match (to, name) {
            (_, n) if n.starts_with("mcp__") => vec![n],
            (Client::Codex | Client::ClaudeCode, n @ ("Bash" | "Edit" | "Write")) => vec![n],
            (Client::Codex, "MultiEdit") => vec!["Edit"],
            (Client::ClaudeCode, "apply_patch") => vec!["Edit", "Write"],
            _ => {
                dropped.push(name.to_owned());
                continue;
            }
        };
        for n in names.into_iter().map(str::to_owned) {
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }
    if out.is_empty() {
        return Err(crate::tr!(
            "ни одного инструмента из matcher ({m}) у получателя нет: хук не сработал бы ни разу",
            "the target has none of the tools in the matcher ({m}): the hook would never fire"
        ));
    }
    Ok((Some(out.join("|")), dropped))
}

fn hook(home: &Path, e: &Entity, dest: Client) -> Result<Prepared, String> {
    let s = source(e)?;
    let n = s.path.len();
    if n < 4 || s.path[n - 2] != "hooks" {
        return Err(entry_missing());
    }
    let event = s.path[n - 4].clone();
    if !SHARED_EVENTS.contains(&event.as_str()) {
        return Err(crate::tr!(
            "события {event} у получателя нет: хук не переносится",
            "the target has no {event} event: the hook is not copied"
        ));
    }
    let (_, text) = read_text(&s.file)?;
    // the path holds array indices: `get_value` walks object keys only, a JSON Pointer walks both
    let root = edit::get_value(Format::Json, &text, &[])?.ok_or_else(entry_missing)?;
    let ptr = |p: &[String]| -> String {
        p.iter()
            .map(|k| format!("/{}", crate::esc_ptr(k)))
            .collect()
    };
    let group = root
        .pointer(&ptr(&s.path[..n - 2]))
        .ok_or_else(entry_missing)?
        .clone();
    let h = root
        .pointer(&ptr(&s.path))
        .and_then(Value::as_object)
        .ok_or_else(entry_missing)?;
    if h.get("type").and_then(Value::as_str) != Some("command") {
        return Err(tr(
            "переносятся только хуки type: command",
            "only type: command hooks are copied",
        ));
    }
    let cmd = h
        .get("command")
        .and_then(Value::as_str)
        .filter(|c| !c.trim().is_empty())
        .ok_or_else(entry_missing)?;
    // the label can miss it (a wrapper script), the command itself cannot
    if is_ctxkit(cmd) {
        return Err(tr(
            "хуки Context Toolkit свои у каждого клиента: для другого клиента их ставит раздел «Инструменты контекста»",
            "Context Toolkit hooks are specific to each client: install them for another client in Context Toolkit",
        ));
    }
    // these keys change how or when the hook runs, and the target has no such key
    for k in ["args", "shell", "if"] {
        if h.contains_key(k) {
            return Err(crate::tr!(
                "у хука есть ключ {k}: он меняет, как и когда запускается хук, а у получателя его нет",
                "the hook has the {k} key: it changes how or when the hook runs, and the target has no such key"
            ));
        }
    }
    let mut out = serde_json::Map::new();
    let mut dropped_keys = Vec::new();
    for (k, v) in h {
        match k.as_str() {
            "type" | "command" => {
                out.insert(k.clone(), v.clone());
            }
            "timeout" if v.is_number() => {
                out.insert(k.clone(), v.clone());
            }
            "statusMessage" if v.is_string() => {
                out.insert(k.clone(), v.clone());
            }
            other => dropped_keys.push(mask::scrub_words(other)),
        }
    }
    let (matcher, dropped) =
        translate_matcher(group.get("matcher").and_then(Value::as_str), dest, &event)?;
    let mut g = serde_json::Map::new();
    if let Some(m) = &matcher {
        g.insert("matcher".into(), json!(m));
    }
    g.insert("hooks".into(), json!([Value::Object(out)]));
    let g = Value::Object(g);

    let file = match dest {
        Client::ClaudeCode => home.join(".claude").join("settings.json"),
        _ => home.join(".codex").join("hooks.json"),
    };
    guard_file(home, &file)?;
    let (old, text, created) = read_or_new(&file)?;
    let at = ["hooks".to_owned(), event.clone()];
    let existing = if created {
        None
    } else {
        edit::get_value(Format::Json, &text, &at)?
    };
    let same = |v: &Value| {
        v.get("hooks").and_then(Value::as_array).is_some_and(|hs| {
            hs.iter()
                .any(|x| x.get("command").and_then(Value::as_str) == Some(cmd))
        })
    };
    let idx = match &existing {
        Some(Value::Array(a)) if a.iter().any(same) => {
            return Err(tr(
                "у получателя уже есть хук с этой командой на этом событии",
                "the target already has a hook with this command on this event",
            ))
        }
        Some(Value::Array(a)) => a.len(),
        Some(_) => {
            return Err(tr(
                "в файле получателя hooks этого события не список: файл не тот, что ждёт клиент",
                "in the target file the hooks of this event are not a list: the file is not what the client expects",
            ))
        }
        None => 0,
    };
    let new_text = if created {
        serde_json::to_string_pretty(&json!({ "hooks": { event.clone(): [g] } }))
            .map_err(|e| e.to_string())?
            + "\n"
    } else if existing.is_some() {
        edit::append_json(&text, &at, &g)?
    } else {
        edit::put_value(Format::Json, &text, &at, &json!([g]), false)?
    };

    let pointer = format!("/hooks/{}/{idx}", crate::esc_ptr(&event));
    let mut plan = plan_for(e, "copy", "R2", (crate::tilde(home, &file), pointer), &old);
    plan.client = dest;
    plan.from = tr("нет записи", "no entry");
    plan.to = crate::tr!(
        "копия: {}",
        "copy: {}",
        masked_line(&mask::split_shell(cmd))
    );
    if let Some(m) = &matcher {
        plan.notes.push(crate::tr!(
            "matcher у получателя: {m}.",
            "matcher at the target: {m}."
        ));
    }
    if !dropped.is_empty() {
        plan.notes.push(crate::tr!(
            "У получателя нет инструментов {}: они убраны из matcher, на них хук не сработает.",
            "The target has no {} tools: they are dropped from the matcher, the hook does not fire on them.",
            dropped.join(", ")
        ));
    }
    if !dropped_keys.is_empty() {
        dropped_keys.sort();
        plan.notes.push(crate::tr!(
            "Не переносятся ключи: {}.",
            "Keys not copied: {}.",
            dropped_keys.join(", ")
        ));
    }
    if dest == Client::Codex {
        plan.warn.push(tr(
            "Codex запустит новый хук только после того, как вы доверите ему: в Codex откройте /hooks и подтвердите его.",
            "Codex runs a new hook only after you trust it: open /hooks in Codex and confirm it.",
        ));
        if cmd.contains("CLAUDE_") {
            plan.notes.push(tr(
                "Команда опирается на переменные CLAUDE_…: их задаёт Claude Code; задаёт ли их Codex, не проверено.",
                "The command relies on CLAUDE_… variables: Claude Code sets them; whether Codex does is not verified.",
            ));
        }
    }
    // Claude Code on Windows runs a hook command in Git Bash (or PowerShell), Codex in `cmd /C` (codex-rs/hooks command_runner.rs)
    plan.warn.push(tr(
        "Оболочка другая: на Windows Claude Code запускает команду хука через Git Bash, а Codex — через cmd /C. Запись вида ИМЯ=значение перед командой, $HOME, %VAR% и одинарные кавычки в другой оболочке не сработают; проверьте команду после копирования.",
        "Another shell: on Windows Claude Code runs a hook command in Git Bash, Codex in cmd /C. A NAME=value prefix, $HOME, %VAR% and single quotes do not work in the other shell; check the command after copying.",
    ));
    if h.contains_key("timeout") {
        plan.notes.push(tr(
            "timeout переносится числом как есть; в каких единицах его считает Codex, не проверено (у Claude Code — секунды).",
            "timeout is copied as the same number; which unit Codex reads it in is not verified (Claude Code: seconds).",
        ));
    }
    plan.notes.push(tr(
        "Хук — команда, которую клиент запускает сам. Убедитесь, что скрипт понимает вход и ответ получателя: формы у Claude Code и Codex общие, но не во всём.",
        "A hook is a command the client runs by itself. Make sure the script handles the target's input and answer: Claude Code and Codex share the shape, not every detail.",
    ));
    if created {
        plan.notes.push(tr(
            "Файла ещё нет: Loadout создаст его, а откат удалит.",
            "The file does not exist yet: Loadout creates it, and a rollback removes it.",
        ));
    }
    Ok(Prepared {
        plan,
        entity: e.id.clone(),
        file,
        old,
        new: new_text.into_bytes(),
        trash: None,
        inverse_enable: None,
        created,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matcher_names_follow_the_target() {
        let m = |s: &str, to| translate_matcher(Some(s), to, "PreToolUse");
        assert_eq!(
            m("Bash", Client::Codex).unwrap(),
            (Some("Bash".into()), vec![])
        );
        assert_eq!(
            m("Read|Edit|MultiEdit", Client::Codex).unwrap(),
            (Some("Edit".into()), vec!["Read".into()])
        );
        assert_eq!(
            m("apply_patch|Bash", Client::ClaudeCode).unwrap(),
            (Some("Edit|Write|Bash".into()), vec![])
        );
        assert_eq!(
            m("mcp__gh__x", Client::ClaudeCode).unwrap().0.as_deref(),
            Some("mcp__gh__x")
        );
        assert!(m("Read|Grep", Client::Codex).is_err(), "nothing left");
        assert!(m("Edit.*", Client::Codex).is_err(), "a regular expression");
        assert_eq!(
            translate_matcher(Some("*"), Client::Codex, "Stop").unwrap(),
            (None, vec![])
        );
        assert!(
            translate_matcher(Some("startup"), Client::Codex, "SessionStart").is_err(),
            "a SessionStart matcher is not a tool name"
        );
    }

    #[test]
    fn sse_and_remote_desktop_are_refused() {
        assert!(translate(&json!({"type":"sse","url":"https://h/x"}), Client::Codex).is_err());
        assert!(translate(
            &json!({"type":"http","url":"https://h/x"}),
            Client::ClaudeDesktop
        )
        .is_err());
        let (v, skipped) = translate(
            &json!({"type":"http","url":"https://h/x","timeout":5}),
            Client::ClaudeCode,
        )
        .unwrap();
        assert_eq!(v["type"], "http");
        assert_eq!(skipped, vec!["timeout".to_owned()]);
    }
}
