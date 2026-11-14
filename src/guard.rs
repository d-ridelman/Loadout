use crate::{t, Client, Lang};
use regex::Regex;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::OnceLock;

const MAX_READ_BYTES: u64 = 28_000;
const MAX_READ_LINES: usize = 450;
const MAX_HUGE_BYTES: u64 = 250_000;
const MAX_SHELL_CAT_BYTES: u64 = 12_000;
const MAX_SHELL_CAT_LINES: usize = 200;

fn read_hint(client: Client, lang: Lang) -> &'static str {
    match client {
        Client::Claude => t(
            lang,
            "search first via Grep/LSP or delegate to Explore (Haiku), or read a slice via Read with offset and limit (up to 250 lines).",
            "найди нужное место через Grep/LSP или передай в Explore (Haiku), либо прочитай фрагмент через Read с offset и limit (до 250 строк).",
        ),
        Client::Antigravity => t(
            lang,
            "search first via grep, then read a slice via read_file with StartLine and EndLine (up to 250 lines).",
            "сначала найди нужное место через grep, затем прочитай фрагмент через read_file с StartLine и EndLine (до 250 строк).",
        ),
        Client::Dsh => t(
            lang,
            "search first via the grep tool, then read a slice via read with offset and limit (up to 250 lines).",
            "сначала найди нужное место инструментом grep, затем прочитай фрагмент через read с offset и limit (до 250 строк).",
        ),
    }
}

fn is_media_or_pdf(path: &str) -> bool {
    let Some(ext) = Path::new(path).extension().and_then(|s| s.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif"
            | "pdf"
            | "mp3" | "wav" | "ogg" | "flac" | "m4a"
            | "mp4" | "webm" | "mov" | "mkv"
    )
}

/// Blocks unbounded reads of large text files while allowing bounded slices and media/PDF.
pub fn read_guard(
    file_path: &str,
    offset: Option<u64>,
    limit: Option<u64>,
    client: Client,
    lang: Lang,
) -> Option<String> {
    if file_path.is_empty() || is_media_or_pdf(file_path) {
        return None;
    }
    if let Some(lim) = limit {
        if lim <= MAX_READ_LINES as u64 {
            return None;
        }
    }
    let meta = fs::metadata(file_path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let bytes = meta.len();
    let hint = read_hint(client, lang);
    let kb = (bytes + 512) / 1024;

    if bytes <= MAX_READ_BYTES {
        let lines = count_lines(file_path)?;
        let start = offset.unwrap_or(1).saturating_sub(1) as usize;
        let rem = lines.saturating_sub(start);
        let eff = limit.map(|l| (l as usize).min(rem)).unwrap_or(rem);
        if eff <= MAX_READ_LINES {
            return None;
        }
        return Some(match lang {
            Lang::En => format!("File is large ({lines} lines, {kb} KB). Do not load it whole into main context: {hint}"),
            Lang::Ru => format!("Файл большой ({lines} строк, {kb} КБ). Не загружай его целиком в основной контекст: {hint}"),
        });
    }

    // Reading from line 1 is a whole-file read, whether or not the offset is spelled out.
    let offset = offset.filter(|o| *o > 1);
    if bytes > MAX_HUGE_BYTES && (offset.is_none() || limit.is_none()) {
        return Some(match lang {
            Lang::En => format!("File is very large ({kb} KB). Do not read it whole: {hint}"),
            Lang::Ru => format!("Файл очень большой ({kb} КБ). Не читай его целиком: {hint}"),
        });
    }

    // The limit is absent or above the cap here, so only a short tail can pass. Count just far
    // enough past the offset to know whether more than the cap remains.
    if let Some(start) = offset.map(|o| (o - 1) as usize) {
        if tail_fits(file_path, start)? {
            return None;
        }
    }
    if let Some(lines) = count_lines_bounded(file_path, 5000) {
        let prefix = if lines >= 5000 { ">" } else { "" };
        return Some(match lang {
            Lang::En => format!("File is large ({prefix}{lines} lines, {kb} KB). Do not load it whole into main context: {hint}"),
            Lang::Ru => format!("Файл большой ({prefix}{lines} строк, {kb} КБ). Не загружай его целиком: {hint}"),
        });
    }
    None
}

fn count_lines(path: &str) -> Option<usize> {
    let f = File::open(path).ok()?;
    let mut r = BufReader::new(f);
    let mut buf = Vec::with_capacity(4096);
    let mut count = 0usize;
    loop {
        buf.clear();
        let n = r.read_until(b'\n', &mut buf).ok()?;
        if n == 0 {
            break;
        }
        count += 1;
    }
    Some(count)
}

/// Whether everything after the first `start` lines stays within both read caps. A few very
/// long lines are as heavy as many short ones, so bytes count too.
fn tail_fits(path: &str, start: usize) -> Option<bool> {
    let mut r = BufReader::new(File::open(path).ok()?);
    let mut buf = Vec::with_capacity(4096);
    let (mut index, mut lines, mut bytes) = (0usize, 0usize, 0u64);
    loop {
        buf.clear();
        let n = r.read_until(b'\n', &mut buf).ok()?;
        if n == 0 {
            return Some(true);
        }
        if index >= start {
            lines += 1;
            bytes += n as u64;
            if lines > MAX_READ_LINES || bytes > MAX_READ_BYTES {
                return Some(false);
            }
        }
        index += 1;
    }
}

fn count_lines_bounded(path: &str, cap: usize) -> Option<usize> {
    let f = File::open(path).ok()?;
    let mut r = BufReader::new(f);
    let mut buf = Vec::with_capacity(4096);
    let mut count = 0usize;
    while count < cap {
        buf.clear();
        let n = r.read_until(b'\n', &mut buf).ok()?;
        if n == 0 {
            break;
        }
        count += 1;
    }
    Some(count)
}

pub fn shell_read_guard(tool: &str, cmd: &str, client: Client, lang: Lang) -> Option<String> {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Never interfere with pipelines, redirections, heredocs, git, tests, or chained scripts.
    if trimmed.contains('|')
        || trimmed.contains('>')
        || trimmed.contains("<<")
        || trimmed.contains('\n')
        || trimmed.contains(';')
        || trimmed.contains("&&")
    {
        return None;
    }

    let dump = match (client, tool) {
        (Client::Claude | Client::Dsh, "Bash") => check_bash_inspect(trimmed, client, lang),
        (Client::Claude | Client::Dsh, "PowerShell") => check_ps_inspect(trimmed, client, lang),
        (Client::Claude | Client::Dsh, _) => return None,
        (Client::Antigravity, _) => check_ps_inspect(trimmed, client, lang)
            .or_else(|| check_bash_inspect(trimmed, client, lang)),
    };
    dump.or_else(|| check_recursive_grep(trimmed, client, lang))
}

/// A path argument: quoted (may hold spaces) or a bare token.
const PATH_ARG: &str = r#"("[^"]+"|'[^']+'|[^"'\s|><&;]+)"#;

fn check_bash_inspect(trimmed: &str, client: Client, lang: Lang) -> Option<String> {
    static RE_BARE_CAT: OnceLock<Regex> = OnceLock::new();
    let re_cat = RE_BARE_CAT
        .get_or_init(|| Regex::new(&format!(r"^cat\s+(?:-[A-Za-z]+\s+)*{PATH_ARG}$")).unwrap());
    if let Some(cap) = re_cat.captures(trimmed) {
        let target = cap[1].trim_matches(|c| c == '"' || c == '\'');
        if is_big_file(target) {
            let prefix = t(
                lang,
                "Do not read a large file via `cat` in shell:",
                "Не читай большой файл через `cat` в shell:",
            );
            return Some(format!("{prefix} {}", read_hint(client, lang)));
        }
    }
    None
}

/// Splits a simple command into words; the flag says whether the word was quoted.
fn shell_tokens(cmd: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let (mut cur, mut quoted, mut quote) = (String::new(), false, None::<char>);
    for c in cmd.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                quoted = true;
            }
            None if c.is_whitespace() => {
                if !cur.is_empty() || quoted {
                    out.push((std::mem::take(&mut cur), quoted));
                    quoted = false;
                }
            }
            None => cur.push(c),
        }
    }
    if !cur.is_empty() || quoted {
        out.push((cur, quoted));
    }
    out
}

/// Unbounded recursive search: `grep` with a recursive flag, or `rg` (recursive by default).
fn check_recursive_grep(trimmed: &str, client: Client, lang: Lang) -> Option<String> {
    // Work on tokens: `-r` inside `user-manager.txt`, `--color` or a quoted pattern is not a flag.
    let toks = shell_tokens(trimmed);
    let is_rg = match toks.first().map(|(t, _)| t.as_str()) {
        Some("rg") => true,
        Some("grep") => false,
        _ => return None,
    };
    let flags: Vec<&str> =
        toks[1..].iter().filter(|(t, quoted)| !quoted && t.starts_with('-')).map(|(t, _)| t.as_str()).collect();
    // A cluster of short flags, e.g. `-rn`; `allowed` keeps value-taking letters (`-tcpp`) out.
    let cluster = |f: &str, allowed: &str, any_of: &str| {
        let body = &f[1..];
        !body.is_empty()
            && !body.starts_with('-')
            && body.chars().all(|c| allowed.contains(c))
            && body.chars().any(|c| any_of.contains(c))
    };
    const BOOL_FLAGS: &str = "ilcnsSwxvHIFPoNuUazZrR";
    let recursive = is_rg
        || flags.iter().any(|f| {
            matches!(*f, "--recursive" | "--dereference-recursive") || cluster(f, BOOL_FLAGS, "rR")
        });
    let bounded = flags.iter().any(|f| {
        matches!(*f, "--files-with-matches" | "--count" | "--count-matches")
            || f.starts_with("--max-count")
            || (f.starts_with("-m") && f[2..].chars().all(|c| c.is_ascii_digit()))
            || cluster(f, BOOL_FLAGS, "lc")
            || (is_rg && matches!(*f, "--version" | "--help" | "--files" | "--type-list" | "-V" | "-h"))
    });
    if !recursive || bounded {
        return None;
    }
    // One pattern and one path that is a file: not a recursive walk.
    let positional: Vec<&str> =
        toks[1..].iter().filter(|(t, quoted)| *quoted || !t.starts_with('-')).map(|(t, _)| t.as_str()).collect();
    if positional.len() == 2 && Path::new(positional[1]).is_file() {
        return None;
    }
    Some(
        match client {
            Client::Claude => t(
                lang,
                "Use the built-in `Grep` tool (or Haiku `Explore`) instead of raw recursive grep/rg in the shell to avoid bloating its output.",
                "Используй встроенный инструмент `Grep` (или `Explore` на Haiku) вместо прямого рекурсивного grep/rg в shell, чтобы не раздувать его вывод.",
            ),
            Client::Dsh => t(
                lang,
                "Use the built-in `grep` tool instead of raw recursive grep/rg in the shell to avoid bloating its output.",
                "Используй встроенный инструмент `grep` вместо прямого рекурсивного grep/rg в shell, чтобы не раздувать его вывод.",
            ),
            Client::Antigravity => t(
                lang,
                "Add `-l`, `-c` or `-m 20`, or point it at a single file, instead of broad recursive `grep -r`/`rg`.",
                "Добавь `-l`, `-c` или `-m 20` либо укажи один файл вместо широкого рекурсивного `grep -r`/`rg`, чтобы не раздувать вывод shell.",
            ),
        }
        .to_string(),
    )
}

fn check_ps_inspect(trimmed: &str, client: Client, lang: Lang) -> Option<String> {
    static RE_BARE_GC: OnceLock<Regex> = OnceLock::new();
    // Flags that still dump the whole file; `-TotalCount` / `-Tail` after the path do not match.
    let re_gc = RE_BARE_GC.get_or_init(|| {
        Regex::new(&format!(
            r"(?i)^(?:Get-Content|gc|type|cat)\s+(?:-(?:Path|LiteralPath|Raw)\s+|-Encoding\s+\S+\s+)*{PATH_ARG}(?:\s+-Raw)?$"
        ))
        .unwrap()
    });
    if let Some(cap) = re_gc.captures(trimmed) {
        let target = cap[1].trim_matches(|c| c == '"' || c == '\'');
        if is_big_file(target) {
            let prefix = t(
                lang,
                "Do not dump a large file in PowerShell:",
                "Не выгружай большой файл целиком в PowerShell:",
            );
            return Some(format!("{prefix} {}", read_hint(client, lang)));
        }
    }
    None
}

fn is_big_file(path: &str) -> bool {
    let p = Path::new(path);
    let Ok(meta) = fs::metadata(p) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    if meta.len() > MAX_SHELL_CAT_BYTES {
        return true;
    }
    count_lines_bounded(path, MAX_SHELL_CAT_LINES + 1).unwrap_or(0) > MAX_SHELL_CAT_LINES
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn read_guard_allows_bounded_slice_and_blocks_whole_big_file() {
        let dir = std::env::temp_dir().join("cg_unit_guard");
        let _ = fs::create_dir_all(&dir);
        let big = dir.join("big.ts");
        let mut f = fs::File::create(&big).unwrap();
        for i in 0..600 {
            writeln!(f, "export const v{i} = {i}; // padding bytes for size").unwrap();
        }
        let path = big.to_str().unwrap();

        assert!(read_guard(path, None, None, Client::Claude, Lang::En).unwrap().contains("File is large"));
        assert!(read_guard(path, None, None, Client::Claude, Lang::Ru).unwrap().contains("Файл большой"));
        assert!(read_guard(path, Some(1), Some(200), Client::Claude, Lang::En).is_none());

        let agy_deny = read_guard(path, None, None, Client::Antigravity, Lang::En).unwrap();
        assert!(agy_deny.contains("read_file"));
        assert!(agy_deny.contains("StartLine"));
        assert!(read_guard(path, Some(1), Some(250), Client::Antigravity, Lang::En).is_none());

        let img = dir.join("big-image.jpg");
        let mut img_f = fs::File::create(&img).unwrap();
        img_f.write_all(&vec![0u8; 300_000]).unwrap();
        assert!(read_guard(img.to_str().unwrap(), None, None, Client::Antigravity, Lang::En).is_none());
        assert!(read_guard(img.to_str().unwrap(), None, None, Client::Claude, Lang::Ru).is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dsh_hints_name_dsh_tools() {
        let dir = std::env::temp_dir().join("cg_unit_guard_dsh");
        let _ = fs::create_dir_all(&dir);
        let big = dir.join("big.ts");
        fs::write(&big, "export const v = 1; // padding bytes for size\n".repeat(700)).unwrap();
        let path = big.to_str().unwrap();

        let deny = read_guard(path, None, None, Client::Dsh, Lang::En).unwrap();
        assert!(deny.contains("read with offset and limit") && !deny.contains("Explore"));
        assert!(read_guard(path, Some(1), Some(200), Client::Dsh, Lang::En).is_none());
        let grep = shell_read_guard("Bash", "rg foo src/", Client::Dsh, Lang::En).unwrap();
        assert!(grep.contains("`grep` tool") && !grep.contains("Haiku"));
        let cat = shell_read_guard("PowerShell", &format!("Get-Content {path}"), Client::Dsh, Lang::En);
        assert!(cat.unwrap().contains("read with offset"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn shell_guard_handles_antigravity_pwsh_and_bash() {
        assert!(shell_read_guard("run_command", "rg foo src/", Client::Antigravity, Lang::En).is_some());
        assert!(shell_read_guard("run_command", "rg -l foo src/", Client::Antigravity, Lang::En).is_none());
        assert!(
            shell_read_guard("run_command", "rg -n foo src/ | Select-Object -First 10", Client::Antigravity, Lang::En).is_none()
        );
    }
}
