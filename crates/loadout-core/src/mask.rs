//! Маскирование (CONCEPT.md §5): секретные значения не покидают ядро.
//!
//! Подход — белый список. Аргументы и команды хуков — свободный текст, и чёрный список слов дал бы новый
//! обход при каждом аудите. Поэтому всё, что не опознано как безвредное, скрывается (`<masked>`):
//! показываются имена флагов, числа, пути, URL без секретных частей, имена пакетов с версией, имена файлов,
//! исполняемые файлы и небольшой набор типичных подкоманд. Значение после секретно названного флага или ключа
//! скрывается всегда, даже если выглядит безвредным.
//!
//! Цена: часть полезного текста (позиционные слова, значения флагов) в выводе заменена на `<masked>`.
//! В M3 UI покажет полную команду по явному действию «показать» (удержание), а не по умолчанию.

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

/// Слова, которые можно показать без опаски: интерпретаторы, обёртки и типичные подкоманды.
const SAFE_WORDS: [&str; 44] = [
    "node",
    "npx",
    "npm",
    "pnpm",
    "yarn",
    "uv",
    "uvx",
    "python",
    "python3",
    "pwsh",
    "powershell",
    "bash",
    "sh",
    "zsh",
    "cmd",
    "cargo",
    "go",
    "git",
    "docker",
    "nohup",
    "disown",
    "exec",
    "env",
    "sudo",
    "time",
    "start",
    "export",
    "mcp",
    "serve",
    "server",
    "stdio",
    "sse",
    "http",
    "run",
    "stop",
    "restart",
    "status",
    "install",
    "list",
    "scan",
    "sync",
    "pull",
    "update",
    "ru",
];
/// Параметры PowerShell, у которых значение не секрет и имя безвредно.
const PS_FLAGS: [&str; 9] = [
    "NoProfile",
    "File",
    "Command",
    "ExecutionPolicy",
    "NonInteractive",
    "WindowStyle",
    "NoLogo",
    "Version",
    "Bypass",
];

pub fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase().replace('-', "_");
    k.ends_with("key")
        || SECRET_PARTS.iter().any(|p| k.contains(p))
        || k.split(|c: char| !c.is_ascii_alphanumeric())
            .any(|w| w == "key" || SECRET_WORDS.contains(&w))
}

/// Длинная строка из букв и цифр (допускаем `_`, `-`, `:`): похоже на токен (`ghp_…`, UUID без дефисов, `bot123:AAH…`).
fn looks_like_token(s: &str) -> bool {
    s.len() >= 24
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':'))
        && s.chars().any(|c| c.is_ascii_digit())
        && s.chars().any(|c| c.is_ascii_alphabetic())
}

fn is_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !s.starts_with(|c: char| c.is_ascii_digit())
}

fn is_operator(s: &str) -> bool {
    matches!(s, "&" | "&&" | "|" | "||" | ";")
        || (s
            .trim_start_matches(|c: char| c.is_ascii_digit())
            .starts_with('>')
            && s.len() <= 12
            && s.chars().all(|c| {
                c.is_ascii_digit() || matches!(c, '>' | '&' | '/') || c.is_ascii_lowercase()
            }))
}

/// Путь: есть разделитель, нет символов, в которых прячутся секреты (`@ ? = ; & | < > " '`),
/// и ни один сегмент не похож на токен.
fn is_path_like(s: &str) -> bool {
    let has_sep = s.contains(['/', '\\']);
    // Двоеточие допустимо только в имени диска `C:`; иначе это `/P:пароль`, `/user:имя`.
    let colon_ok = s.split(['/', '\\']).enumerate().all(|(i, seg)| {
        !seg.contains(':')
            || (i == 0
                && seg.len() == 2
                && seg.as_bytes()[0].is_ascii_alphabetic()
                && seg.ends_with(':'))
    });
    has_sep
        && colon_ok
        && !s.contains(['@', '?', '=', ';', '&', '|', '<', '>', '"', '\'', '`'])
        && !s.contains("$(")
        && !s.split(['/', '\\']).any(looks_like_token)
}

/// Имя пакета с версией: `rea-agents@6.8.0`, `@scope/name@1.2`.
fn is_pkg_version(s: &str) -> bool {
    let Some((name, ver)) = s.rsplit_once('@').filter(|(n, _)| !n.is_empty()) else {
        return false;
    };
    let name = name.strip_prefix('@').unwrap_or(name);
    !name.is_empty()
        && name.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.' | '/')
        })
        && ver.starts_with(|c: char| c.is_ascii_digit())
        && ver.len() <= 24
        && ver
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
}

fn is_file_name(s: &str) -> bool {
    match s.rsplit_once('.') {
        Some((stem, ext)) => {
            !stem.is_empty()
                && stem.len() <= 40
                && (1..=6).contains(&ext.len())
                && stem
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
        }
        None => false,
    }
}

/// Значение (не флаг): показываем, только если опознали как безвредное.
fn safe_value(v: &str) -> String {
    if v.contains("://") {
        return mask_url(v);
    }
    let lower = v.to_ascii_lowercase();
    let ok = (!v.is_empty() && v.len() <= 5 && v.chars().all(|c| c.is_ascii_digit()))
        || SAFE_WORDS.contains(&lower.as_str())
        || is_pkg_version(v)
        || is_path_like(v)
        || is_file_name(v);
    if ok {
        v.to_owned()
    } else {
        MASK.to_owned()
    }
}

/// Один токен командной строки. `cmd_pos` — токен стоит там, где ожидается исполняемый файл.
/// Возвращает показываемый токен и признак «следующее значение скрыть» (секретно названный флаг).
fn mask_token(a: &str, cmd_pos: bool) -> (String, bool) {
    if a.is_empty() || is_operator(a) {
        return (a.to_owned(), false);
    }
    if a.starts_with(['{', '[']) || a.starts_with("@{") {
        return (MASK.to_owned(), false); // JSON и хеш-таблицы PowerShell: ключи неизвестны, прячем целиком
    }
    if let Some(long) = a.strip_prefix("--") {
        let (name, val) = long
            .split_once('=')
            .map_or((long, None), |(n, v)| (n, Some(v)));
        let valid = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !valid {
            return (MASK.to_owned(), false);
        }
        return match val {
            Some(_) if is_secret_key(name) => (format!("--{name}={MASK}"), false),
            Some(v) => (format!("--{name}={}", safe_value(v)), false),
            None => (
                a.to_owned(),
                is_secret_key(name) || matches!(name, "user" | "proxy-user"),
            ),
        };
    }
    if let Some(short) = a.strip_prefix('-') {
        let letters = !short.is_empty() && short.chars().all(|c| c.is_ascii_alphabetic());
        if letters && (short.len() <= 2 || PS_FLAGS.contains(&short)) {
            return (a.to_owned(), false);
        }
        return (MASK.to_owned(), false); // `-pПАРОЛЬ`, `-ubob:pw`, неизвестные параметры
    }
    if let Some((name, _)) = a.split_once('=') {
        if is_identifier(name) {
            return (format!("{name}={MASK}"), false); // `ИМЯ=значение`: значение всегда скрыто
        }
        return (MASK.to_owned(), false);
    }
    if a.len() == 2 && a.starts_with('/') && a.as_bytes()[1].is_ascii_alphabetic() {
        return (a.to_owned(), false); // ключ cmd: `/c`
    }
    let shown = safe_value(a);
    if shown == MASK
        && cmd_pos
        && a.len() <= 41
        && a.starts_with(|c: char| c.is_ascii_lowercase())
        && a.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
        && !looks_like_token(a)
    {
        return (a.to_owned(), false); // имя исполняемого файла
    }
    (shown, false)
}

/// Аргументы командной строки.
pub fn mask_args(args: &[String]) -> Vec<String> {
    mask_args_at(args, 0)
}

/// Глубже этого вложенность (`sh -c "bash -c '…'"`) не разбираем, а прячем целиком.
const MAX_DEPTH: usize = 3;

/// Аргумент с пробелом, который не похож на путь, — вложенная командная строка (`bash -c "tool --token X"`).
fn mask_nested(arg: &str, depth: usize) -> String {
    if depth >= MAX_DEPTH {
        return MASK.to_owned();
    }
    let masked = join_line(&mask_args_at(&split_shell(arg), depth + 1));
    // подряд идущие скрытые слова сворачиваем в одно
    let mut out: Vec<&str> = Vec::new();
    for w in masked.split(' ') {
        if !(w == MASK && out.last() == Some(&MASK)) {
            out.push(w);
        }
    }
    out.join(" ")
}

fn is_nested_command(a: &str) -> bool {
    if !a.contains(char::is_whitespace) {
        return false;
    }
    // Путь с пробелами: первое слово с разделителем и дальше ни одного флага.
    let mut words = a.split_whitespace();
    let first = words.next().unwrap_or("");
    let path = first.contains(['/', '\\']) && !words.any(|w| w.starts_with('-'));
    !path
}

fn mask_args_at(args: &[String], depth: usize) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let (mut hide_next, mut cmd_pos) = (false, true);
    for a in args {
        if hide_next {
            out.push(MASK.to_owned());
            hide_next = false;
            cmd_pos = false;
        } else if is_nested_command(a) {
            out.push(mask_nested(a, depth));
            cmd_pos = false;
        } else if a.contains(char::is_whitespace) {
            // путь с пробелами
            out.push(if is_path_like(a) {
                a.clone()
            } else {
                MASK.to_owned()
            });
            cmd_pos = false;
        } else {
            let (shown, hide) = mask_token(a, cmd_pos);
            // команда ожидается после оператора; после `A=1` нет: во вложенной строке кавычки сняты,
            // и `PASSWORD="a b"` иначе показало бы `b` как имя команды
            cmd_pos = is_operator(a);
            hide_next = hide;
            out.push(shown);
        }
    }
    out
}

/// Делит командную строку по пробелам с учётом кавычек. Обратный слэш не считаем экранированием
/// (на Windows это разделитель пути), кроме `\"` и `\'` внутри кавычек.
pub fn split_shell(line: &str) -> Vec<String> {
    let (mut out, mut cur, mut quote, mut any) = (Vec::new(), String::new(), None::<char>, false);
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), '\\') if matches!(chars.peek(), Some(&n) if n == q) => {
                cur.push(q);
                chars.next();
            }
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

/// Командная строка целиком (хуки, `command` MCP).
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

/// URL: без `user:pass@`, query, fragment и параметров `;x=y`; токеноподобные и %-закодированные сегменты пути скрыты.
/// Строка без `схема://` скрывается целиком (`user:pw@host:5432` и подобное).
pub fn mask_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return MASK.to_owned();
    };
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    {
        return MASK.to_owned();
    }
    // Userinfo: последняя `@`, перед которой есть `:`. Пароль с `/`, `?` или `#` тоже попадает под вырезание.
    let rest = match rest.rfind('@') {
        Some(i) if rest[..i].contains(':') || !rest[..i].contains(['/', '?', '#']) => {
            &rest[i + 1..]
        }
        _ => rest,
    };
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let (host, path) = rest.split_once('/').map_or((rest, ""), |(h, p)| (h, p));
    if path.is_empty() {
        return format!("{scheme}://{host}");
    }
    let path: Vec<String> = path
        .split('/')
        .map(|s| {
            let s = s.split(';').next().unwrap_or("");
            if looks_like_token(s) || (s.contains('%') && s.len() >= 16) {
                MASK.to_owned()
            } else {
                s.to_owned()
            }
        })
        .collect();
    format!("{scheme}://{host}/{}", path.join("/"))
}

/// Версия или хеш коммита: только безобидные символы и разумная длина, иначе ничего.
pub fn safe_version(s: &str) -> Option<&str> {
    (!s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-' | '_')))
    .then_some(s)
}

/// Matcher хука (`Bash`, `Write|Edit`, `mcp__x__.*`): только символы регулярного выражения над именами инструментов.
pub fn safe_matcher(s: &str) -> Option<&str> {
    (!s.is_empty()
        && s.len() <= 120
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '|' | '*' | '.' | '_' | '-' | ':' | '(' | ')' | '^' | '$')
        }))
    .then_some(s)
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
    let transport = match cfg.get("type").and_then(Value::as_str) {
        Some(t @ ("stdio" | "http" | "sse")) => t,
        Some(_) => "other",
        None if command.is_some() => "stdio",
        None => "http",
    };
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

    fn shown(v: &[&str]) -> String {
        mask_args(&a(v)).join(" ")
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
    fn what_stays_visible() {
        assert_eq!(
            shown(&["-y", "rea-agents@6.8.0", "mcp", "--idle-timeout", "0"]),
            "-y rea-agents@6.8.0 mcp --idle-timeout 0"
        );
        assert_eq!(shown(&["python", "-u", "script.py"]), "python -u script.py");
        assert_eq!(
            shown(&[
                "C:/Users/x/path/auth.json",
                "--lang",
                "ru",
                "--port",
                "8080"
            ]),
            "C:/Users/x/path/auth.json --lang ru --port 8080"
        );
        assert_eq!(
            shown(&["@playwright/mcp@latest"]),
            MASK,
            "версия не число: скрыто, это сознательная цена"
        );
        assert_eq!(
            mask_line("& 'C:/Program Files/x/tool.exe' --lang ru"),
            "& \"C:/Program Files/x/tool.exe\" --lang ru"
        );
    }

    /// Двенадцать форм первого аудита и 20+ форм второго: ни одно значение не должно пройти.
    #[test]
    fn audit_forms_do_not_leak() {
        let cases: Vec<(Vec<&str>, &str)> = vec![
            (vec!["-e", "GH_PAT=S02"], "S02"),
            (vec!["--env", "GITHUB_PAT", "S03"], "S03"),
            (vec!["-u", "user:S04"], "S04"),
            (vec!["--config", r#"{"token":"S05"}"#], "S05"),
            (vec!["-H", "X-Api-Key:S06"], "S06"),
            (vec!["--auth", "S07"], "S07"),
            (vec!["Server=h;Password=S08"], "S08"),
            (
                vec!["https://example.com/mcp/s/S09abcdefghijklmnopqrstuvwxyz0/mcp"],
                "S09",
            ),
            (vec!["OAUTH_CLIENT=S10"], "S10"),
            (vec!["--pat", "S12"], "S12"),
            (vec!["--header", "Authorization: Bearer S13"], "S13"),
            (vec!["--header=Authorization: Bearer S14"], "S14"),
            // второй аудит
            (vec!["--user=bob:PW1"], "PW1"),
            (vec!["-ubob:PW2"], "PW2"),
            (vec!["-pPW3"], "PW3"),
            (vec!["-p", "PW4"], "PW4"),
            (vec!["-a", "PW5"], "PW5"),
            (vec!["/P:PW7"], "PW7"),
            (vec!["/user:bob", "PW8"], "PW8"),
            (vec!["--args", r#"{"args":["--api-key","J1"]}"#], "J1"),
            (vec![r#"{"url":"https://u:J3@h"}"#], "J3"),
            (vec!["$env:API_TOKEN", "=", "PS3"], "PS3"),
            (vec!["@{", "X-Api-Key", "=", "PS2", "}"], "PS2"),
            (vec!["user:URL1@host:5432"], "URL1"),
            (vec!["tool", "AKIAABCDEFGHIJKLMNOP"], "AKIA"),
            (vec!["tool", "hunter2"], "hunter2"),
            (vec!["AKIAABCDEFGHIJKLMNOP"], "AKIA"),
            (vec!["--token=my secret"], "secret"),
            (vec!["PASSWORD=correct horse"], "horse"),
        ];
        for (c, secret) in cases {
            let out = shown(&c);
            assert!(!out.contains(secret), "{c:?} -> {out}");
        }
    }

    #[test]
    fn hook_lines_with_quotes_and_nesting() {
        for (line, secret) in [
            (r#"curl -H "Authorization: Bearer L01" https://x"#, "L01"),
            (r#"curl -H 'X-Api-Key: L02' https://x"#, "L02"),
            ("TOKEN=L03 node a.js", "L03"),
            ("node --token L04 guard.mjs", "L04"),
            (r#"bash -c "tool --token N01""#, "N01"),
            (r#"pwsh -Command "tool --api-key=N02 --user=bob""#, "N02"),
            (r#"cmd /c "tool -H 'X-Api-Key: N03'""#, "N03"),
            (r#"sh -c "bash -c 'tool --token N04'""#, "N04"),
            (r#"sh -c "sh -c \"sh -c 'sh -c tool --token N05'\"""#, "N05"),
            (r#"bash -c "export A=1; tool --token SC1""#, "SC1"),
            (
                r#"pwsh -Command "$ErrorActionPreference='Stop'; tool -Token SC2""#,
                "SC2",
            ),
            (r#"node --token="my secret" hook.js"#, "secret"),
            (r#"bash -c "tool --token \"ESC2 ESC2b\"""#, "ESC2b"),
            ("cat <<EOF | tool\nHD1\nEOF", "HD1"),
            ("mysql -pPW3 db", "PW3"),
            ("sshpass -p PW6 ssh host", "PW6"),
        ] {
            let out = mask_line(line);
            assert!(!out.contains(secret), "{line} -> {out}");
        }
    }

    #[test]
    fn urls() {
        assert_eq!(
            mask_url("https://user:pw@api.example.com/mcp/?key=S3#x"),
            "https://api.example.com/mcp/"
        );
        assert_eq!(mask_url("http://127.0.0.1:4020"), "http://127.0.0.1:4020");
        for (url, secret) in [
            ("https://u:pa?ss@host/x", "ss"),
            ("https://u:pa#ss@host/x", "ss"),
            ("https://u:pa/ss@host/x", "ss"),
            ("redis:URL2@host", "URL2"),
            ("https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage", "AAH"),
            ("https://h/x;token=MX1/y", "MX1"),
            ("https://h/abc%2Bdef%2Fghi%3Djkl", "abc"),
        ] {
            let out = mask_url(url);
            assert!(!out.contains(secret), "{url} -> {out}");
        }
        assert_eq!(mask_url("https://[::1]:8080/x"), "https://[::1]:8080/x");
        assert_eq!(
            mask_url("https://h.example/@scope/pkg"),
            "https://h.example/@scope/pkg"
        );
    }

    #[test]
    fn mcp_detail_has_no_values() {
        let cfg = json!({"command":"node","args":["a.js","--token","S4","--user=bob:M1","-pM2"],"url":"user:M3@h","env":{"API_KEY":"S5"},"headers":{"Authorization":"Bearer S6"}});
        let s = mcp_detail(&cfg).to_string();
        for secret in ["S4", "S5", "S6", "M1", "M2", "M3"] {
            assert!(!s.contains(secret), "{secret} утёк: {s}");
        }
        assert!(s.contains("API_KEY") && s.contains("Authorization"));
    }

    #[test]
    fn no_panics_on_odd_input() {
        for s in [
            "",
            "\"",
            "'",
            "\\",
            "é--token=ж",
            "Bearer",
            "eyJ",
            "日本語 --token 秘密",
            "a b c d e f g h",
            "😀 --x=😀",
        ] {
            let _ = mask_line(s);
            let _ = mask_url(s);
            let _ = mask_args(&a(&[s]));
        }
        let long = "[".repeat(100_000);
        let _ = mask_line(&long);
    }

    #[test]
    fn versions() {
        assert_eq!(safe_version("1.2.3-rc.1"), Some("1.2.3-rc.1"));
        assert_eq!(safe_version("abc def"), None);
        assert_eq!(safe_version(""), None);
    }
}
