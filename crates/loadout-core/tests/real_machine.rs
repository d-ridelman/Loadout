//! Сверка на настоящих конфигах владельца. Тест `#[ignore]`: он читает реальные файлы (значения секретов
//! остаются в памяти теста и не печатаются) и запускается вручную:
//!
//! ```text
//! cargo test -p loadout-core --test real_machine -- --ignored --nocapture
//! ```
//!
//! Критерий выхода из M1: ни одно значение секретно названного ключа (`token`, `secret`, `password`, `*key`, …) и ни
//! одно значение из `env` и заголовков MCP не встречается в выводе сканера. Исключение одно и намеренное: адрес
//! без учётных данных (`https://host:port`) показывается, он не секрет.

use loadout_core::mask::is_secret_key;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Значение, которое ядро показывает намеренно: адрес без пользователя, пароля, query и пути.
fn harmless_address(v: &str) -> bool {
    v.split_once("://").is_some_and(|(scheme, rest)| {
        matches!(scheme, "http" | "https") && !rest.contains(['@', '?', '#', '/'])
    })
}

/// Значение → имя ключа, под которым оно лежит (имя ключа не секрет и нужно для разбора совпадений).
type Secrets = BTreeMap<String, String>;

fn collect(node: &Value, out: &mut Secrets) {
    match node {
        Value::Object(o) => {
            for (k, v) in o {
                let container = matches!(
                    k.as_str(),
                    "env" | "headers" | "http_headers" | "env_http_headers"
                );
                match v {
                    Value::String(s) if is_secret_key(k) => {
                        out.entry(s.clone()).or_insert_with(|| k.clone());
                    }
                    Value::Object(inner) if container => {
                        for (name, val) in inner {
                            if let Some(s) = val.as_str() {
                                out.entry(s.to_owned())
                                    .or_insert_with(|| format!("{k}.{name}"));
                            }
                        }
                    }
                    _ => {}
                }
                collect(v, out);
            }
        }
        Value::Array(a) => {
            // значение после секретного флага: ["--token", "…"]
            for pair in a.windows(2) {
                if let (Some(flag), Some(val)) = (pair[0].as_str(), pair[1].as_str()) {
                    if flag.starts_with('-') && is_secret_key(flag.trim_start_matches('-')) {
                        out.entry(val.to_owned())
                            .or_insert_with(|| format!("arg {flag}"));
                    }
                }
            }
            a.iter().for_each(|x| collect(x, out));
        }
        _ => {}
    }
}

#[test]
#[ignore = "читает реальные конфиги владельца; запускать вручную"]
fn no_secret_value_reaches_the_scan_output() {
    let Some(home) = home() else { return };
    let mut secrets = Secrets::new();

    for rel in [
        ".claude.json",
        ".claude/settings.json",
        ".codex/hooks.json",
        ".gemini/config/mcp_config.json",
        "AppData/Roaming/Claude/claude_desktop_config.json",
    ] {
        if let Ok(text) = std::fs::read_to_string(home.join(rel)) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                collect(&v, &mut secrets);
            }
        }
    }
    if let Ok(text) = std::fs::read_to_string(home.join(".codex/config.toml")) {
        if let Ok(t) = text.parse::<toml::Table>() {
            if let Ok(v) = serde_json::to_value(&t) {
                collect(&v, &mut secrets);
            }
        }
    }
    // Значения, которые совпадают с именами клиентов (`claude-code` в `env.GLIDEHAND_OVERLAY_NAME`), встречаются в
    // выводе в каждой записи как поле `client`: это совпадение слов, а не утечка.
    let slugs: Vec<&str> = loadout_core::model::Client::ALL
        .iter()
        .map(|c| c.slug())
        .collect();
    secrets.retain(|s, _| {
        s.len() >= 6 && !harmless_address(s) && !slugs.contains(&s.to_lowercase().as_str())
    });

    let result = loadout_core::scan(&home);
    let out = serde_json::to_string(&result).expect("вывод сериализуется");
    let hits: Vec<(&String, &String)> = secrets
        .iter()
        .filter(|(value, _)| out.contains(value.as_str()))
        .collect();
    let leaked = hits.len();
    println!(
        "проверено секретных значений: {}, найдено в выводе: {leaked}",
        secrets.len()
    );
    for (value, key) in &hits {
        let where_found: Vec<String> = result
            .entities
            .iter()
            .filter(|e| serde_json::to_string(e).is_ok_and(|j| j.contains(value.as_str())))
            .take(3)
            .map(|e| format!("{}/{:?}/{}", e.client.slug(), e.kind, e.name))
            .collect();
        println!("  где: {where_found:?}");
        // имя ключа-источника и форма совпадения; само значение не печатаем
        println!(
            "  совпадение: ключ «{key}», длина {}, есть ://: {}, есть пробел: {}, есть путь: {}",
            value.len(),
            value.contains("://"),
            value.contains(' '),
            value.contains('/'),
        );
    }
    assert_eq!(leaked, 0, "значения секретов попали в вывод сканера");

    let user = home
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let path_hits = out
        .to_lowercase()
        .matches(&format!("/users/{user}"))
        .count()
        + out
            .to_lowercase()
            .matches(&format!("\\\\users\\\\{user}"))
            .count();
    assert_eq!(path_hits, 0, "путь домашнего каталога попал в вывод");
}
