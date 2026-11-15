//! Маскирование (CONCEPT.md §5): секретные значения не покидают ядро.
//! Правило простое и консервативное: лучше замаскировать лишнее.

use serde_json::{json, Value};

pub const MASK: &str = "<masked>";

const SECRET_PARTS: [&str; 10] = [
    "token",
    "secret",
    "password",
    "passwd",
    "authorization",
    "credential",
    "cookie",
    "apikey",
    "api_key",
    "bearer",
];

pub fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase().replace('-', "_");
    k.ends_with("key") || SECRET_PARTS.iter().any(|p| k.contains(p))
}

/// Один аргумент сам по себе: URL, заголовок `Имя: значение`, bearer-токен, JWT.
/// Возвращает `None`, если ничего не нашли и аргумент надо разбирать дальше как `имя=значение` или флаг.
fn mask_whole_arg(a: &str) -> Option<String> {
    if a.contains("://") && !a.contains(' ') {
        return Some(mask_url(a));
    }
    let lower = a.to_ascii_lowercase();
    for marker in ["bearer ", "basic "] {
        if let Some(i) = lower.find(marker) {
            return Some(format!("{}{MASK}", &a[..i]));
        }
    }
    if let Some(i) = a.find("eyJ") {
        return Some(format!("{}{MASK}", &a[..i])); // начало base64-JSON, то есть JWT
    }
    match a.split_once(": ") {
        Some((name, _)) if is_secret_key(name) => Some(format!("{name}: {MASK}")),
        _ => None,
    }
}

/// Аргументы командной строки: значение после секретного флага, `имя=значение`, заголовки, URL, bearer, JWT.
pub fn mask_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut mask_next = false;
    for a in args {
        if mask_next {
            out.push(MASK.to_owned());
            mask_next = false;
        } else if let Some(m) = mask_whole_arg(a) {
            out.push(m);
        } else if let Some((k, _)) = a.split_once('=') {
            out.push(if is_secret_key(k) {
                format!("{k}={MASK}")
            } else {
                a.clone()
            });
        } else if a.starts_with('-') && is_secret_key(a.trim_start_matches('-')) {
            out.push(a.clone());
            mask_next = true;
        } else {
            out.push(a.clone());
        }
    }
    out
}

/// Командная строка целиком (хуки): делим по пробелам. Кавычки не разбираем, поэтому для
/// аргумента в кавычках с пробелом маскирование может сработать грубее, а не слабее.
pub fn mask_line(line: &str) -> String {
    let parts: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
    mask_args(&parts).join(" ")
}

/// URL без `user:pass@` и без query/fragment (в них живут ключи).
pub fn mask_url(url: &str) -> String {
    let cut = url.find(['?', '#']).map_or(url, |i| &url[..i]);
    match cut.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest.split_once('/').map_or((rest, ""), |(a, p)| (a, p));
            let host = authority.rsplit('@').next().unwrap_or(authority);
            if path.is_empty() {
                format!("{scheme}://{host}")
            } else {
                format!("{scheme}://{host}/{path}")
            }
        }
        None => cut.to_owned(),
    }
}

fn keys_of(cfg: &Value, names: &[&str]) -> Vec<String> {
    let mut keys: Vec<String> = names
        .iter()
        .filter_map(|n| cfg.get(n).and_then(Value::as_object))
        .flat_map(|o| o.keys().cloned())
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

/// Описание MCP-сервера без значений env и заголовков: только имена ключей.
pub fn mcp_detail(cfg: &Value) -> Value {
    let command = cfg.get("command").and_then(Value::as_str);
    let url = cfg.get("url").and_then(Value::as_str);
    let transport = cfg
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if command.is_some() {
                "stdio".into()
            } else {
                "http".into()
            }
        });
    let args: Vec<String> = cfg
        .get("args")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    json!({
        "transport": transport,
        "command": command.map(mask_line),
        "args": mask_args(&args),
        "url": url.map(mask_url),
        "envKeys": keys_of(cfg, &["env"]),
        "headerKeys": keys_of(cfg, &["headers", "http_headers", "env_http_headers"]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_keys() {
        for k in [
            "API_KEY",
            "github_token",
            "Authorization",
            "x-api-key",
            "PASSWORD",
            "oauthToken",
        ] {
            assert!(is_secret_key(k), "{k}");
        }
        for k in ["command", "NODE_ENV", "serverName", "timeout"] {
            assert!(!is_secret_key(k), "{k}");
        }
    }

    #[test]
    fn args_and_lines() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            mask_args(&a(&["srv.js", "--token", "S1", "--port", "80"])),
            a(&["srv.js", "--token", MASK, "--port", "80"])
        );
        assert_eq!(mask_args(&a(&["--api-key=S2"])), a(&["--api-key=<masked>"]));
        assert_eq!(
            mask_line("tool --password hunter2 --lang ru"),
            "tool --password <masked> --lang ru"
        );
    }

    #[test]
    fn whole_arg_forms() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // заголовок передан одним аргументом: флаг не секретный, секрет внутри значения
        assert_eq!(
            mask_args(&a(&["--header", "Authorization: Bearer S7"])),
            a(&["--header", "Authorization: <masked>"])
        );
        assert_eq!(
            mask_args(&a(&["-H", "X-Api-Key: S8"])),
            a(&["-H", "X-Api-Key: <masked>"])
        );
        assert_eq!(
            mask_args(&a(&["https://u:p@h.example/x?token=S9"])),
            a(&["https://h.example/x"])
        );
        assert_eq!(
            mask_args(
                &a(&["--jwt=eyJhbGciOiJIUzI1NiJ9.x.y"])
                    .iter()
                    .map(|s| s.replace("--jwt=", ""))
                    .collect::<Vec<_>>()
            ),
            a(&["<masked>"])
        );
        assert_eq!(
            mask_args(&a(&["Content-Type: application/json"])),
            a(&["Content-Type: application/json"])
        );
    }

    #[test]
    fn urls() {
        assert_eq!(
            mask_url("https://user:pw@api.example.com/mcp/?key=S3#x"),
            "https://api.example.com/mcp/"
        );
        assert_eq!(mask_url("http://127.0.0.1:4020"), "http://127.0.0.1:4020");
    }

    #[test]
    fn mcp_detail_has_no_values() {
        let cfg = json!({"command":"node","args":["a.js","--token","S4"],"env":{"API_KEY":"S5"},"headers":{"Authorization":"Bearer S6"}});
        let s = mcp_detail(&cfg).to_string();
        for secret in ["S4", "S5", "S6"] {
            assert!(!s.contains(secret), "{secret} утёк: {s}");
        }
        assert!(s.contains("API_KEY") && s.contains("Authorization"));
    }
}
