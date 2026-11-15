//! Маскирование (CONCEPT.md §5): секретные значения не покидают ядро.
//!
//! Подход — белый список. Аргументы и команды хуков — свободный текст, и чёрный список слов давал бы новый
//! обход при каждом аудите. Поэтому всё, что не опознано как безвредное, скрывается (`<masked>`):
//! показываются имена флагов, числа, пути (укоренённые или с именем файла известного типа), URL без секретных
//! частей, имена пакетов, имена файлов, исполняемые файлы и небольшой набор типичных слов. Значение после
//! секретно названного флага или ключа скрывается всегда, даже если выглядит безвредным.
//!
//! Цена: часть полезного текста (позиционные слова, значения флагов) в выводе заменена на `<masked>`.
//! В M3 UI покажет полную команду по явному действию «показать» (удержание), а не по умолчанию.

use serde_json::{json, Value};

pub const MASK: &str = "<masked>";

/// Подстроки, которых достаточно где угодно в имени.
const SECRET_PARTS: [&str; 12] = [
    "token",
    "secret",
    "password",
    "passwd",
    "passphrase",
    "authorization",
    "credential",
    "cookie",
    "apikey",
    "api_key",
    "bearer",
    "oauth",
];
/// Слова, которые считаем только целыми (`pat` в `GH_PAT`, но не в `path`).
const SECRET_WORDS: [&str; 14] = [
    "pat", "auth", "pass", "pwd", "pw", "sid", "jwt", "cred", "session", "private", "pin", "otp",
    "passcode", "code",
];

/// Слова, которые можно показать без опаски: интерпретаторы, обёртки, типичные подкоманды и значения.
const SAFE_WORDS: &[&str] = &[
    "node",
    "npx",
    "npm",
    "pnpm",
    "yarn",
    "uv",
    "uvx",
    "pipx",
    "bunx",
    "dlx",
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
    "origin",
    "main",
    "master",
    "latest",
    "true",
    "false",
    "bypass",
    "remotesigned",
    "hidden",
    "debug",
    "info",
    "warn",
    "warning",
    "error",
    "trace",
    "ru",
    "en",
];
/// Расширения файлов, имя которых можно показывать.
const SAFE_EXT: &[&str] = &[
    "js", "mjs", "cjs", "ts", "py", "sh", "ps1", "cmd", "bat", "exe", "json", "yaml", "yml",
    "toml", "md", "txt", "sql", "db", "ini", "cfg", "conf", "log", "jar", "dll", "so", "rs", "go",
    "rb", "php", "html", "css", "lock", "pid", "sock",
];
/// Параметры PowerShell, у которых имя безвредно.
const PS_FLAGS: &[&str] = &[
    "NoProfile",
    "File",
    "Command",
    "ExecutionPolicy",
    "NonInteractive",
    "WindowStyle",
    "NoLogo",
    "Version",
];
/// Программы, которые запускают пакет по имени: следующее слово без флага — имя пакета.
const LAUNCHERS: &[&str] = &["npx", "uvx", "pipx", "bunx", "dlx"];
/// Схемы URL, которые считаем URL.
const SCHEMES: &[&str] = &[
    "http",
    "https",
    "ws",
    "wss",
    "ssh",
    "git",
    "git+https",
    "git+ssh",
    "file",
    "ftp",
    "sse",
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

/// Смесь заглавных, строчных и цифр от 16 символов: base64 и случайные ключи, а не слово.
fn high_entropy(s: &str) -> bool {
    s.chars().count() >= 16
        && s.chars().any(|c| c.is_ascii_digit())
        && s.chars().any(|c| c.is_ascii_uppercase())
        && s.chars().any(|c| c.is_ascii_lowercase())
}

/// Фрагмент пути или слово, в котором, скорее всего, лежит секрет.
fn seg_secret(seg: &str) -> bool {
    let stem = seg.rsplit_once('.').map_or(seg, |(s, _)| s);
    // шестнадцатеричная строка от 20 знаков (ключи API, хеши) и длинное слово из одних букв и цифр от 32 знаков
    let hex = |s: &str| s.len() >= 20 && s.chars().all(|c| c.is_ascii_hexdigit());
    let long_plain = |s: &str| s.len() >= 32 && s.chars().all(|c| c.is_ascii_alphanumeric());
    looks_like_token(seg)
        || high_entropy(seg)
        || seg.contains("eyJ")
        || looks_like_token(stem)
        || high_entropy(stem)
        || hex(seg)
        || hex(stem)
        || long_plain(seg)
        || long_plain(stem)
}

/// Версия пакета: `1.2`, `6.8.0`, `1.0.0-rc.1` или тег выпуска. Короткие числа без точки (`123`) и случайные
/// строки версией не считаются: так `admin@123` и `имя@токен` не сойдут за `пакет@версия`.
fn is_version(v: &str) -> bool {
    if matches!(
        v,
        "latest" | "next" | "beta" | "alpha" | "canary" | "rc" | "stable"
    ) {
        return true;
    }
    let (core, pre) = v.split_once(['-', '+']).map_or((v, ""), |(c, p)| (c, p));
    let parts: Vec<&str> = core.split('.').collect();
    (2..=4).contains(&parts.len())
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 6 && p.chars().all(|c| c.is_ascii_digit()))
        && pre.len() <= 20
        && pre
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        && !seg_secret(pre)
}

fn is_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !s.starts_with(|c: char| c.is_ascii_digit())
}

/// Операторы, после которых начинается новая команда.
fn is_control_op(s: &str) -> bool {
    matches!(s, "&" | "&&" | "|" | "||" | ";")
}

/// Перенаправления без файла-значения; после них команда не начинается.
fn is_redirect(s: &str) -> bool {
    matches!(
        s,
        ">/dev/null" | "2>/dev/null" | "&>/dev/null" | "2>&1" | ">" | ">>" | "2>"
    )
}

fn has_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() > 2 && b[1] == b':' && b[0].is_ascii_alphabetic()
}

fn is_file_name(s: &str) -> bool {
    match s.rsplit_once('.') {
        Some((stem, ext)) => {
            !stem.is_empty()
                && stem.len() <= 40
                && SAFE_EXT.contains(&ext.to_ascii_lowercase().as_str())
                && stem
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                && !seg_secret(stem)
        }
        None => false,
    }
}

/// Путь: укоренённый (`/`, `\`, `~`, `.`, `$`, `%`, `C:`) или оканчивающийся именем файла известного типа;
/// без символов, в которых прячутся секреты; двоеточие только в имени диска; ни один сегмент не похож на секрет.
/// Строка base64 со слэшами сюда не попадает: она не укоренена и не оканчивается именем файла.
fn is_path_like(s: &str) -> bool {
    let segs: Vec<&str> = s.split(['/', '\\']).collect();
    if segs.len() < 2 {
        return false;
    }
    let rooted = s.starts_with(['/', '\\', '~', '.', '$', '%']) || has_drive(s);
    let last = segs.last().copied().unwrap_or("");
    let colon_ok = segs.iter().enumerate().all(|(i, seg)| {
        !seg.contains(':') || (i == 0 && seg.len() == 2 && seg.as_bytes()[0].is_ascii_alphabetic())
    });
    (rooted || is_file_name(last))
        && colon_ok
        && !s.contains([
            '@', '?', '=', ';', '&', '|', '<', '>', '"', '\'', '`', '+', '!', '*',
        ])
        && !s.contains("$(")
        && segs
            .iter()
            .all(|seg| seg.chars().count() <= 80 && !seg_secret(seg))
        && !scrambled(s)
}

/// Путь целиком похож на base64, разрезанный слэшами (`/K7MDENG/bPxRfiCYEXAMPLEKEY`): смесь регистров и цифр,
/// длинный, без точек. Настоящие пути с точкой в имени файла сюда не попадают.
fn scrambled(s: &str) -> bool {
    let flat: String = s.chars().filter(|c| !matches!(c, '/' | '\\')).collect();
    !s.contains('.') && high_entropy(&flat) && flat.chars().count() >= 20
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
        && is_version(ver)
}

/// Имя пакета после `npx`/`uvx`: `firecrawl-mcp`, `@upstash/context7-mcp@latest`, `mcp-server-fetch`.
fn is_package_name(s: &str) -> bool {
    let body = s.strip_prefix('@').unwrap_or(s);
    let (path, version) = body
        .split_once('@')
        .map_or((body, None), |(p, v)| (p, Some(v)));
    !path.is_empty()
        && s.len() <= 80
        && path.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && path.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.' | '/')
        })
        && path.matches('/').count() <= 1
        && version.is_none_or(is_version)
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

/// Состояние разбора командной строки.
#[derive(Clone, Copy)]
struct Pos {
    /// Ожидается исполняемый файл.
    cmd: bool,
    /// Ожидается имя пакета (после `npx`, `uvx`).
    pkg: bool,
}

/// Один токен командной строки. `next` — следующий токен (для коротких флагов с отдельным значением).
/// Возвращает показываемый токен и признак «следующее значение скрыть».
fn mask_token(a: &str, pos: Pos, next: Option<&str>) -> (String, bool) {
    if a.is_empty() || is_control_op(a) || is_redirect(a) {
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
        let secretish = is_secret_key(name) || matches!(name, "user" | "proxy-user");
        return match val {
            Some(_) if secretish => (format!("--{name}={MASK}"), false),
            Some(v) => (format!("--{name}={}", safe_value(v)), false),
            None => (a.to_owned(), secretish),
        };
    }
    if let Some(short) = a.strip_prefix('-') {
        let letters = !short.is_empty() && short.chars().all(|c| c.is_ascii_alphabetic());
        if letters && (short.len() <= 2 || PS_FLAGS.contains(&short)) {
            // `-p значение`, `-a значение`: однобуквенные флаги паролей и ключей; значение прячем, если оно не флаг и не URL
            let secret_letter =
                (short.len() == 1 && "pPaAwWkK".contains(short)) || is_secret_key(short);
            let hide =
                secret_letter && next.is_some_and(|n| !n.starts_with('-') && !n.contains("://"));
            return (a.to_owned(), hide);
        }
        // `-pПАРОЛЬ`, `-ubob:pw`, `-pw значение`, `-Password значение`: имя флага неизвестно, значит и значение после него
        return (MASK.to_owned(), true);
    }
    // `X-Token:` — имя заголовка отдельным токеном: значение следующим
    if a.len() > 2 && a.ends_with(':') {
        return (MASK.to_owned(), true);
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
    if shown != MASK {
        return (shown, false);
    }
    // Имя пакета после npx/uvx и имя исполняемого файла в позиции команды: только строчные буквы.
    if pos.pkg && is_package_name(a) && !seg_secret(a) {
        return (a.to_owned(), false);
    }
    if pos.cmd
        && a.len() <= 41
        && a.starts_with(|c: char| c.is_ascii_lowercase())
        && a.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
        && !looks_like_token(a)
    {
        return (a.to_owned(), false);
    }
    (shown, false)
}

/// Аргументы командной строки, где первый токен — исполняемый файл (хуки).
pub fn mask_args(args: &[String]) -> Vec<String> {
    mask_args_ex(
        args,
        0,
        Pos {
            cmd: true,
            pkg: false,
        },
    )
}

/// Глубже этого вложенность (`sh -c "bash -c '…'"`) не разбираем, а прячем целиком.
const MAX_DEPTH: usize = 3;

/// Аргумент с пробелом, который не похож на путь с пробелами, — вложенная командная строка.
pub(crate) fn is_nested_command(a: &str) -> bool {
    a.contains(char::is_whitespace) && !a.split_whitespace().all(|w| w.contains(['/', '\\']))
}

fn mask_nested(arg: &str, depth: usize) -> String {
    if depth >= MAX_DEPTH {
        return MASK.to_owned();
    }
    let masked = join_line(&mask_args_ex(
        &split_shell(arg),
        depth + 1,
        Pos {
            cmd: true,
            pkg: false,
        },
    ));
    // подряд идущие скрытые слова сворачиваем в одно
    let mut out: Vec<&str> = Vec::new();
    for w in masked.split(' ') {
        if !(w == MASK && out.last() == Some(&MASK)) {
            out.push(w);
        }
    }
    out.join(" ")
}

fn stem_of(token: &str) -> String {
    let base = token.rsplit(['/', '\\']).next().unwrap_or(token);
    base.rsplit_once('.')
        .map_or(base, |(s, _)| s)
        .to_ascii_lowercase()
}

fn mask_args_ex(args: &[String], depth: usize, start: Pos) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let (mut hide_next, mut pos) = (false, start);
    for (i, a) in args.iter().enumerate() {
        if hide_next {
            out.push(MASK.to_owned());
            hide_next = false;
            pos = Pos {
                cmd: false,
                pkg: false,
            };
        } else if is_nested_command(a) {
            out.push(mask_nested(a, depth));
            pos = Pos {
                cmd: false,
                pkg: false,
            };
        } else if a.contains(char::is_whitespace) {
            // путь с пробелами
            out.push(if is_path_like(a) {
                a.clone()
            } else {
                MASK.to_owned()
            });
            pos = Pos {
                cmd: false,
                pkg: pos.pkg,
            };
        } else {
            let (shown, hide) = mask_token(a, pos, args.get(i + 1).map(String::as_str));
            let launcher = LAUNCHERS.contains(&stem_of(a).as_str());
            let is_flag = a.starts_with('-');
            // команда ожидается после управляющего оператора; имя пакета — после npx/uvx, флаги его не сбрасывают
            pos = Pos {
                cmd: is_control_op(a),
                // имя пакета возможно сразу после npx/uvx и после флагов без значения (`-y`); флаг со значением
                // (`--header секрет`) сбивает счёт, и следующее слово пакетом не считается
                pkg: launcher
                    || (pos.pkg
                        && is_flag
                        && matches!(
                            a.as_str(),
                            "-y" | "--yes" | "-q" | "--quiet" | "--no-install"
                        )),
            };
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

/// Хост с портом: имя из букв, цифр, `.` и `-` (или IPv6 в скобках), порт только цифрами.
fn host_ok(h: &str) -> bool {
    let (name, port) = match h.strip_prefix('[') {
        Some(r) => match r.split_once(']') {
            Some((v6, tail)) => (v6, tail.strip_prefix(':').or(tail.is_empty().then_some(""))),
            None => return false,
        },
        None => h.rsplit_once(':').map_or((h, None), |(n, p)| (n, Some(p))),
    };
    let name_ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'));
    name_ok && port.is_none_or(|p| p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()))
}

/// URL: без userinfo (`user:pass@`, `токен@`), query, fragment и `;параметров`; хост и порт проверены;
/// токеноподобные, JWT и %-закодированные сегменты пути скрыты. Строка с неизвестной схемой скрывается целиком.
pub fn mask_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return MASK.to_owned();
    };
    if !SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) {
        return MASK.to_owned();
    }
    // Userinfo: всё до первой `@`, если перед ней нет слэша. Слэш перед `@` значит либо путь (`/@scope/pkg`),
    // либо пароль со слэшем (`u:pa/ss@host`): отличаем по тому, пусто ли слово между последним слэшем и `@`.
    let rest = match rest.find('@') {
        Some(i) => match rest[..i].rfind('/') {
            None => &rest[i + 1..],
            Some(j) if j + 1 < i => &rest[i + 1..],
            _ => rest,
        },
        None => rest,
    };
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let (host, path) = rest.split_once('/').map_or((rest, ""), |(h, p)| (h, p));
    if !host_ok(host) {
        return MASK.to_owned();
    }
    if path.is_empty() {
        return format!("{scheme}://{host}");
    }
    let path: Vec<String> = path
        .split('/')
        .map(|s| {
            let s = s.split(';').next().unwrap_or("");
            if seg_secret(s) || (s.contains('%') && s.len() >= 16) {
                MASK.to_owned()
            } else {
                s.to_owned()
            }
        })
        .collect();
    format!("{scheme}://{host}/{}", path.join("/"))
}

/// Версия, хеш коммита, тип, имя схемы: только безобидные символы и разумная длина, иначе ничего.
pub fn safe_version(s: &str) -> Option<&str> {
    let hex = (7..=40).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit());
    let plain = !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-' | '_'))
        && !looks_like_token(s)
        && !high_entropy(s);
    (hex || plain).then_some(s)
}

/// Matcher хука (`Bash`, `Write|Edit`, `mcp__x__.*`): только символы регулярного выражения над именами инструментов.
pub fn safe_matcher(s: &str) -> Option<&str> {
    (!s.is_empty()
        && s.len() <= 120
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '|' | '*' | '.' | '_' | '-' | ':' | '(' | ')' | '^' | '$')
        })
        && !s.split(['|', '(', ')']).any(seg_secret))
    .then_some(s)
}

/// Имя сущности из файла (скил, агент, событие хука): буквы любого алфавита, цифры и `._-:@/` с пробелом, до 80 символов,
/// без слов, похожих на секрет.
pub fn safe_name(s: &str) -> Option<&str> {
    (!s.is_empty()
        && s.chars().count() <= 80
        && s.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-' | ':' | '@' | '/'))
        && !s.split_whitespace().any(seg_secret))
    .then_some(s)
}

/// Строка из файла в поле, где секретов быть не должно (имя, область, указатель, примечание): куски между
/// разделителями (`/ \ : @ , = ;` и пробел), похожие на токен, заменяются. Разделители сохраняются.
pub fn scrub_words(s: &str) -> String {
    let is_delim =
        |c: char| c.is_whitespace() || matches!(c, '/' | '\\' | ':' | '@' | ',' | '=' | ';' | '~');
    let mut out = String::with_capacity(s.len());
    let mut word = String::new();
    let flush = |word: &mut String, out: &mut String| {
        if !word.is_empty() {
            out.push_str(if seg_secret(word) { MASK } else { word });
            word.clear();
        }
    };
    for c in s.chars() {
        if is_delim(c) {
            flush(&mut word, &mut out);
            out.push(c);
        } else {
            word.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

/// Свободный текст (описание скила): слова, похожие на токен или ключ известного вида, заменяются.
pub fn mask_prose(s: &str) -> String {
    const PREFIXES: [&str; 8] = ["sk-", "sk_", "ghp_", "gho_", "xox", "AKIA", "eyJ", "glpat"];
    s.split(' ')
        .map(|w| {
            let bare = w.trim_matches(|c: char| !c.is_alphanumeric());
            if seg_secret(bare) || PREFIXES.iter().any(|p| bare.starts_with(p)) {
                MASK
            } else {
                w
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn keys_of(cfg: &Value, names: &[&str]) -> Vec<String> {
    let mut keys: Vec<String> = names
        .iter()
        .filter_map(|n| cfg.get(n).and_then(Value::as_object))
        .flat_map(|o| o.keys().cloned())
        .map(|k| if seg_secret(&k) { MASK.to_owned() } else { k })
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
    // `args` не начинаются с исполняемого файла: он в `command`. Если это npx/uvx, первое слово без флага — пакет.
    let launcher = command.is_some_and(|c| LAUNCHERS.contains(&stem_of(c).as_str()));
    json!({
        "transport": transport,
        "command": command.map(mask_line),
        "args": mask_args_ex(&args, 0, Pos { cmd: false, pkg: launcher }),
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
            "passphrase",
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

    /// Находки итогового аудита M1: ни одно значение не должно пройти.
    #[test]
    fn m1_audit_forms_do_not_leak() {
        let cases: Vec<(&str, &str)> = vec![
            ("tool --login bot@7a9F2kLmQ8xZ3vB1nC4dE6", "7a9F"),
            ("plink -pw admin@123 host", "admin@123"),
            ("plink -pw 4821 host", "4821"),
            ("tool -Password 48213", "48213"),
            ("openssl -pass 4821", "4821"),
            ("tool --pin 48213", "48213"),
            (r#"curl -H "X-Token: 48213" https://x"#, "48213"),
            (r#"tool -pw "correct horse battery""#, "correct"),
            (
                "aws configure set aws_secret_access_key /K7MDENG/bPxRfiCYEXAMPLEKEY",
                "K7MDENG",
            ),
            ("curl https://h/mcp/a1b2c3d4e5f6a7b8c9d0/sse", "a1b2c3d4"),
            (
                "curl https://h/mcp/qwErtyuiopAsdfghjklZxcvbnmQwertyuiop/sse",
                "qwErty",
            ),
            ("npx mypkg@a3f9c2e8b1d4f6a7c9e2b5d8", "a3f9c2e8"),
            ("npx -y a3f9c2e8b1d4f6a7c9e2", "a3f9c2e8"),
        ];
        for (line, secret) in cases {
            let out = mask_line(line);
            assert!(!out.contains(secret), "{line} -> {out}");
        }
        // и безвредное по-прежнему видно
        assert_eq!(
            mask_line("npx -y firecrawl-mcp@1.2.3"),
            "npx -y firecrawl-mcp@1.2.3"
        );
        // пользователь@адрес не секрет и по виду совпадает с пакет@версия: показываем сознательно
        assert_eq!(mask_line("ssh admin@10.0.0.5"), "ssh admin@10.0.0.5");
    }

    #[test]
    fn scrub_words_hides_token_like_pieces_and_keeps_delimiters() {
        assert_eq!(
            scrub_words("/mcpServers/ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/x"),
            "/mcpServers/<masked>/x"
        );
        assert_eq!(scrub_words("claude.ai Github"), "claude.ai Github");
        assert_eq!(scrub_words("project:~/work/proj"), "project:~/work/proj");
        assert_eq!(scrub_words("harnio@harnio"), "harnio@harnio");
    }

    #[test]
    fn what_stays_visible() {
        for (line, want) in [
            (
                "-y rea-agents@6.8.0 mcp --idle-timeout 0",
                "-y rea-agents@6.8.0 mcp --idle-timeout 0",
            ),
            ("python -u script.py", "python -u script.py"),
            (
                "C:/Users/x/path/auth.json --lang ru --port 8080",
                "C:/Users/x/path/auth.json --lang ru --port 8080",
            ),
            ("uvx mcp-server-fetch", "uvx mcp-server-fetch"),
            ("npx -y firecrawl-mcp", "npx -y firecrawl-mcp"),
            (
                "npx -y @upstash/context7-mcp@latest",
                "npx -y @upstash/context7-mcp@latest",
            ),
            (
                "pwsh -NoProfile -ExecutionPolicy Bypass -File C:/x/y.ps1",
                "pwsh -NoProfile -ExecutionPolicy Bypass -File C:/x/y.ps1",
            ),
            (
                "git pull --rebase origin main",
                "git pull --rebase origin main",
            ),
            ("dist/mcp/stdio-wrapper.js", "dist/mcp/stdio-wrapper.js"),
            (
                "node server.js --log-level debug",
                "node server.js --log-level debug",
            ),
        ] {
            assert_eq!(mask_line(line), want, "{line}");
        }
        assert_eq!(
            mask_line("& 'C:/Program Files/x/tool.exe' --lang ru"),
            "& \"C:/Program Files/x/tool.exe\" --lang ru"
        );
    }

    /// Формы трёх аудитов: ни одно значение не должно пройти.
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
            (vec!["https://example.com/mcp/s/S09abcdefghijklmnopqrstuvwxyz0/mcp"], "S09"),
            (vec!["OAUTH_CLIENT=S10"], "S10"),
            (vec!["--pat", "S12"], "S12"),
            (vec!["--header", "Authorization: Bearer S13"], "S13"),
            (vec!["--header=Authorization: Bearer S14"], "S14"),
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
            (vec!["--token=my secret"], "secret"),
            (vec!["PASSWORD=correct horse"], "horse"),
            // третий аудит
            (vec!["uvx", "--from", "git+https://ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1@github.com/org/repo@main", "tool"], "ghp_"),
            (vec!["aws", "configure", "set", "aws_secret_access_key", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"], "wJalr"),
            (vec!["-EncodedCommand", "SQBFAFgAIAAoAE4AZQB3AC0ATwBi/+AAA"], "SQBF"),
            (vec!["--config", "C:/keys/ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345.json"], "ghp_"),
            (vec!["--x=sk-abc123SECRET+https://h"], "sk-abc"),
            (vec!["-p", "correct.horse"], "horse"),
            (vec!["-p", "4821"], "4821"),
            (vec!["--passphrase=hunter.22"], "hunter"),
            (vec!["--user=bob/secretpw"], "secretpw"),
            (vec!["tool", "2>/dev/null", "hunterpw"], "hunterpw"),
            (vec!["tool", ">hunterpw"], "hunterpw"),
            (vec!["Basic", "dXNlcjpwYXNz/d29yZA"], "dXNlcjpwYXNz"),
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
            // третий аудит: вложенная строка с первым словом-путём
            (
                r#"bash -c "/usr/bin/tool sk_live_51HabcdefghijklmnopqrSTUV""#,
                "sk_live",
            ),
            (
                r#"bash -c "$HOME/bin/send.sh xoxb-1234-5678-abcdefSECRET prod""#,
                "xoxb",
            ),
            (r#"bash -c "./deploy.sh MyPassw0rd!""#, "MyPassw0rd"),
            (
                r#"curl -H "Authorization: Bearer abc/def+ghiSECRETtoken""#,
                "ghiSECRET",
            ),
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
        assert_eq!(
            mask_url("https://TOKEN4@registry.npmjs.org/@scope/pkg"),
            "https://registry.npmjs.org/@scope/pkg"
        );
        for (url, secret) in [
            ("https://u:pa?ss@host/x", "ss"),
            ("https://u:pa#ss@host/x", "ss"),
            ("https://u:pa/ss@host/x", "ss"),
            ("redis:URL2@host", "URL2"),
            ("https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage", "AAH"),
            ("https://h/x;token=MX1/y", "MX1"),
            ("https://h/abc%2Bdef%2Fghi%3Djkl", "abc"),
            ("https://h:SECRETPW;key=SEC1/x", "SECRETPW"),
            ("https://h:SECRETPW/x", "SECRETPW"),
            ("sk-abc123SECRET+https://h", "sk-abc"),
            ("https://h/v1/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SIGNATUREPART/mcp", "eyJ"),
            ("https://h/hook/TOKEN3AbCdEfGhIjKlMnOpQrSt.json", "TOKEN3"),
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
        let cfg = json!({"command":"node","args":["a.js","--token","S4","--user=bob:M1","-pM2","correcthorsebatterystaple"],"url":"user:M3@h","env":{"API_KEY":"S5","ghp_AbCdEfGhIjKlMnOpQrStUvWx0123":"x"},"headers":{"Authorization":"Bearer S6"}});
        let s = mcp_detail(&cfg).to_string();
        for secret in ["S4", "S5", "S6", "M1", "M2", "M3", "correcthorse", "ghp_"] {
            assert!(!s.contains(secret), "{secret} утёк: {s}");
        }
        assert!(s.contains("API_KEY") && s.contains("Authorization"));
        // имя пакета у npx остаётся
        let npx = mcp_detail(&json!({"command":"npx","args":["-y","firecrawl-mcp"]})).to_string();
        assert!(npx.contains("firecrawl-mcp"), "{npx}");
    }

    #[test]
    fn free_text_fields() {
        assert_eq!(safe_version("1.2.3-rc.1"), Some("1.2.3-rc.1"));
        assert_eq!(
            safe_version("b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6"),
            Some("b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6")
        );
        assert_eq!(
            safe_version("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
            None
        );
        assert_eq!(safe_version("abc def"), None);
        assert_eq!(safe_name("Скил про VPN"), Some("Скил про VPN"));
        assert_eq!(safe_name("sk-ant-api03-AbCdEfGh0123456789xyz"), None);
        assert_eq!(
            safe_matcher("Write|Edit|mcp__x__.*"),
            Some("Write|Edit|mcp__x__.*")
        );
        assert_eq!(
            mask_prose("Ключ sk-ant-api03-AbCdEf0123456789 и текст"),
            "Ключ <masked> и текст"
        );
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
            "https://",
            "://",
            "@",
            "[",
            "]:",
        ] {
            let _ = mask_line(s);
            let _ = mask_url(s);
            let _ = mask_args(&a(&[s]));
            let _ = mask_prose(s);
        }
        let long = "[".repeat(100_000);
        let _ = mask_line(&long);
        let _ = mask_url(&format!("https://{}", "@".repeat(50_000)));
    }
}
