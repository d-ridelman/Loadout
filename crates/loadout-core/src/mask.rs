//! Маскирование (CONCEPT.md §5): секретные значения не покидают ядро.
//!
//! Аргументы и команды — свободный текст, поэтому чёрный список ключевых слов один не работает.
//! Правило такое: маскируем по имени ключа, по форме (заголовок, bearer, JWT, URL, JSON, строка подключения)
//! и по виду значения (длинная строка из букв и цифр без разделителей). Лучше замаскировать лишнее.

use serde_json::{json, Value};

pub const MASK: &str = "<masked>";

/// Подстроки, которых достаточно где угодно в имени.
const SECRET_PARTS: [&str; 11] = [
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
    "oauth",
];
/// Слова, которые считаем только целыми (`pat` в `GH_PAT`, но не в `path`).
const SECRET_WORDS: [&str; 10] = [
    "pat", "auth", "pass", "pwd", "pw", "sid", "jwt", "cred", "session", "private",
];

pub fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase().replace('-', "_");
    k.ends_with("key")
        || SECRET_PARTS.iter().any(|p| k.contains(p))
        || k.split(|c: char| !c.is_ascii_alphanumeric())
            .any(|w| w == "key" || SECRET_WORDS.contains(&w))
}

/// Длинная строка из букв и цифр без разделителей пути: похоже на токен (`ghp_…`, UUID без дефисов, base64url).
fn looks_like_token(s: &str) -> bool {
    s.len() >= 24
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && s.chars().any(|c| c.is_ascii_digit())
        && s.chars().any(|c| c.is_ascii_alphabetic())
}

fn is_identifier(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Строка, в которой секрет мог оказаться посреди текста: bearer/basic, JWT, токеноподобное слово.
fn mask_text(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    for marker in ["bearer ", "basic "] {
        if let Some(i) = lower.find(marker) {
            return format!("{}{MASK}", &s[..i]);
        }
    }
    if let Some(i) = s.find("eyJ") {
        return format!("{}{MASK}", &s[..i]);
    }
    if looks_like_token(s) {
        return MASK.to_owned();
    }
    s.to_owned()
}

fn mask_json(v: &mut Value) {
    match v {
        Value::Object(o) => {
            for (k, x) in o.iter_mut() {
                if is_secret_key(k) {
                    *x = Value::String(MASK.to_owned());
                } else {
                    mask_json(x);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(mask_json),
        Value::String(s) => *s = mask_text(s),
        _ => {}
    }
}

/// Один аргумент сам по себе. `None` — ничего особенного, разбираем дальше как `имя=значение` или флаг.
fn mask_whole_arg(a: &str) -> Option<String> {
    let t = a.trim_start();
    if t.starts_with('{') || t.starts_with('[') {
        return Some(match serde_json::from_str::<Value>(a) {
            Ok(mut v) => {
                mask_json(&mut v);
                v.to_string()
            }
            Err(_) => MASK.to_owned(), // JSON-подобная строка, которую не разобрать: прячем целиком
        });
    }
    if a.contains("://") && !a.contains(' ') {
        return Some(mask_url(a));
    }
    let m = mask_text(a);
    if m != a {
        return Some(m);
    }
    // Заголовок `Имя: значение` и `Имя:значение`.
    if let Some((name, rest)) = a.split_once(':') {
        if is_secret_key(name) && !name.contains(['/', '\\', ' ']) {
            let sep = if rest.starts_with(' ') { " " } else { "" };
            return Some(format!("{name}:{sep}{MASK}"));
        }
    }
    // Строка подключения `Server=h;Password=x`.
    if a.contains(';') && a.contains('=') {
        let parts: Vec<String> = a
            .split(';')
            .map(|p| match p.split_once('=') {
                Some((k, _)) if is_secret_key(k) => format!("{k}={MASK}"),
                _ => p.to_owned(),
            })
            .collect();
        return Some(parts.join(";"));
    }
    None
}

/// Аргументы командной строки.
pub fn mask_args(args: &[String]) -> Vec<String> {
    mask_args_at(args, 0)
}

/// Глубже этого вложенность (`sh -c "bash -c '…'"`) не разбираем, а прячем целиком.
const MAX_DEPTH: usize = 3;

/// Аргумент с пробелом, который не поймали правила формы, — чаще всего вложенная командная строка
/// (`bash -c "tool --token X"`). Разбираем его так же, как верхнюю.
fn mask_nested(arg: &str, depth: usize) -> String {
    if depth >= MAX_DEPTH {
        return MASK.to_owned();
    }
    join_line(&mask_args_at(&split_shell(arg), depth + 1))
}

fn mask_args_at(args: &[String], depth: usize) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut mask_next = false;
    for (i, a) in args.iter().enumerate() {
        if mask_next {
            out.push(MASK.to_owned());
            mask_next = false;
        } else if let Some(m) = mask_whole_arg(a) {
            out.push(m);
        } else if a.contains(char::is_whitespace) {
            out.push(mask_nested(a, depth));
        } else if let Some((k, v)) = a.split_once('=') {
            out.push(if is_secret_key(k) || looks_like_token(v) {
                format!("{k}={MASK}")
            } else {
                a.clone()
            });
        } else if a.starts_with('-') {
            let name = a.trim_start_matches('-');
            let user_pass = matches!(name, "u" | "user" | "proxy-user")
                && args.get(i + 1).is_some_and(|n| n.contains(':'));
            mask_next = is_secret_key(name) || user_pass;
            out.push(a.clone());
        } else if is_identifier(a) && is_secret_key(a) {
            // `--env GITHUB_PAT значение`: имя переменной и значение разнесены
            mask_next = true;
            out.push(a.clone());
        } else if looks_like_token(a) {
            out.push(MASK.to_owned());
        } else {
            out.push(a.clone());
        }
    }
    out
}

/// Делит командную строку по пробелам с учётом кавычек. Обратный слэш не считаем экранированием:
/// на Windows это разделитель пути.
pub fn split_shell(line: &str) -> Vec<String> {
    let (mut out, mut cur, mut quote, mut any) = (Vec::new(), String::new(), None::<char>, false);
    for c in line.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                any = true;
            }
            (None, c) if c.is_whitespace() => {
                if any || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            (None, c) => cur.push(c),
        }
    }
    if any || !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Командная строка целиком (хуки, `command` MCP). Кавычки снимаются, токены с пробелами берутся обратно в двойные.
pub fn mask_line(line: &str) -> String {
    join_line(&mask_args(&split_shell(line)))
}

/// Собирает токены обратно в строку: токены с пробелами берутся в двойные кавычки.
pub fn join_line(tokens: &[String]) -> String {
    tokens
        .iter()
        .map(|t| {
            if t.contains(char::is_whitespace) {
                format!("\"{t}\"")
            } else {
                t.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// URL без `user:pass@`, query и fragment; сегменты пути, похожие на токен, тоже скрыты (ключ в пути у Zapier и подобных).
pub fn mask_url(url: &str) -> String {
    let cut = url.find(['?', '#']).map_or(url, |i| &url[..i]);
    match cut.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest.split_once('/').map_or((rest, ""), |(a, p)| (a, p));
            let host = authority.rsplit('@').next().unwrap_or(authority);
            if path.is_empty() {
                return format!("{scheme}://{host}");
            }
            let path: Vec<String> = path
                .split('/')
                .map(|s| {
                    if looks_like_token(s) {
                        MASK.to_owned()
                    } else {
                        s.to_owned()
                    }
                })
                .collect();
            format!("{scheme}://{host}/{}", path.join("/"))
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

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn secret_keys() {
        for k in [
            "API_KEY",
            "github_token",
            "Authorization",
            "x-api-key",
            "PASSWORD",
            "oauthToken",
            "GH_PAT",
            "KEY_ID",
            "OAUTH_CLIENT",
            "auth",
            "session-id",
        ] {
            assert!(is_secret_key(k), "{k}");
        }
        for k in [
            "command",
            "NODE_ENV",
            "serverName",
            "timeout",
            "path",
            "PATH",
            "lang",
            "Content-Type",
        ] {
            assert!(!is_secret_key(k), "{k}");
        }
    }

    #[test]
    fn basic_forms() {
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

    /// Двенадцать форм из аудита checker: ни одно значение не должно пройти.
    #[test]
    fn audit_forms_do_not_leak() {
        let cases: Vec<Vec<&str>> = vec![
            vec!["-e", "GH_PAT=S02"],
            vec!["--env", "GITHUB_PAT", "S03"],
            vec!["-u", "user:S04"],
            vec!["--config", r#"{"token":"S05"}"#],
            vec!["-H", "X-Api-Key:S06"],
            vec!["--auth", "S07"],
            vec!["Server=h;Password=S08"],
            vec!["https://example.com/mcp/s/S09abcdefghijklmnopqrstuvwxyz0/mcp"],
            vec!["OAUTH_CLIENT=S10"],
            vec!["--pat", "S12"],
            vec!["--header", "Authorization: Bearer S13"],
            vec!["--header=Authorization: Bearer S14"],
        ];
        for c in cases {
            let out = mask_args(&a(&c)).join(" ");
            let leaked = [
                "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10", "S12", "S13", "S14",
            ]
            .iter()
            .find(|s| out.contains(*s));
            assert!(leaked.is_none(), "{c:?} -> {out}");
        }
    }

    #[test]
    fn hook_lines_with_quotes() {
        for (line, secret) in [
            (r#"curl -H "Authorization: Bearer L01" https://x"#, "L01"),
            (r#"curl -H 'X-Api-Key: L02' https://x"#, "L02"),
            ("TOKEN=L03 node a.js", "L03"),
            ("node --token L04 guard.mjs", "L04"),
        ] {
            let out = mask_line(line);
            assert!(!out.contains(secret), "{line} -> {out}");
        }
        assert_eq!(
            mask_line("& 'C:/Program Files/x/tool.exe' --lang ru"),
            "& \"C:/Program Files/x/tool.exe\" --lang ru"
        );
    }

    /// Вложенная командная строка одним аргументом (`bash -c "…"`): бывший обход аудита №2.
    #[test]
    fn nested_command_lines() {
        for (line, secret) in [
            (r#"bash -c "tool --token N01""#, "N01"),
            (r#"pwsh -Command "tool --api-key=N02 --user=bob""#, "N02"),
            (r#"cmd /c "tool -H 'X-Api-Key: N03'""#, "N03"),
            (r#"sh -c "bash -c 'tool --token N04'""#, "N04"),
            (r#"sh -c "sh -c \"sh -c 'sh -c tool --token N05'\"""#, "N05"),
        ] {
            let out = mask_line(line);
            assert!(!out.contains(secret), "{line} -> {out}");
        }
        let args = a(&["-c", "srv --api-key X1 --port 80"]);
        assert!(!mask_args(&args).join(" ").contains("X1"));
        // путь с пробелами не портится
        assert_eq!(
            mask_args(&a(&["C:/Program Files/x/tool.exe"])),
            a(&["C:/Program Files/x/tool.exe"])
        );
    }

    #[test]
    fn harmless_values_survive() {
        assert_eq!(
            mask_args(&a(&[
                "-y",
                "rea-agents@6.8.0",
                "mcp",
                "--idle-timeout",
                "0"
            ])),
            a(&["-y", "rea-agents@6.8.0", "mcp", "--idle-timeout", "0"])
        );
        assert_eq!(
            mask_args(&a(&[
                "Content-Type: application/json",
                "C:/Users/x/path/auth.json"
            ])),
            a(&[
                "Content-Type: application/json",
                "C:/Users/x/path/auth.json"
            ])
        );
        assert_eq!(
            mask_args(&a(&["python", "-u", "script.py"])),
            a(&["python", "-u", "script.py"])
        );
    }

    #[test]
    fn whole_arg_forms() {
        assert_eq!(
            mask_args(&a(&["--header", "Authorization: Bearer S7"])),
            a(&["--header", "Authorization: <masked>"])
        );
        assert_eq!(
            mask_args(&a(&["https://u:p@h.example/x?token=S9"])),
            a(&["https://h.example/x"])
        );
        assert_eq!(
            mask_args(&a(&["eyJhbGciOiJIUzI1NiJ9.x.y"])),
            a(&["<masked>"])
        );
        assert_eq!(
            mask_args(&a(&["--config", "{не json"])),
            a(&["--config", "<masked>"])
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
