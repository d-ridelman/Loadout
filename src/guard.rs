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

    if bytes > MAX_HUGE_BYTES && (offset.is_none() || limit.is_none()) {
        return Some(match lang {
            Lang::En => format!("File is very large ({kb} KB). Do not read it whole: {hint}"),
            Lang::Ru => format!("Файл очень большой ({kb} КБ). Не читай его целиком: {hint}"),
        });
    }

    if let Some(lines) = count_lines_bounded(file_path, 5000) {
        let start = offset.unwrap_or(1).saturating_sub(1) as usize;
        let rem = lines.saturating_sub(start);
        let eff = limit.map(|l| (l as usize).min(rem)).unwrap_or(rem);
        if offset.is_some() && eff <= MAX_READ_LINES {
            return None;
        }
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

    match client {
        Client::Claude => match tool {
            "Bash" => check_bash_inspect(trimmed, client, lang),
            "PowerShell" => check_ps_inspect(trimmed, client, lang),
            _ => None,
        },
        Client::Antigravity => check_ps_inspect(trimmed, client, lang)
            .or_else(|| check_bash_inspect(trimmed, client, lang)),
    }
}

fn check_bash_inspect(trimmed: &str, client: Client, lang: Lang) -> Option<String> {
    static RE_BARE_CAT: OnceLock<Regex> = OnceLock::new();
    let re_cat = RE_BARE_CAT.get_or_init(|| {
        Regex::new(r#"^cat\s+(?:-[A-Za-z]+\s+)*(["']?[^"'\s|><&;]+["']?)$"#).unwrap()
    });
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

    static RE_REC_GREP: OnceLock<Regex> = OnceLock::new();
    let re_grep = RE_REC_GREP.get_or_init(|| {
        Regex::new(r#"^(?:grep\s+[^\n]*-[A-Za-z]*r|rg\s+)"#).unwrap()
    });
    if re_grep.is_match(trimmed)
        && !trimmed.contains(" -l")
        && !trimmed.contains("--files-with-matches")
        && !trimmed.contains("--count")
        && !trimmed.contains(" -c")
        && !trimmed.contains("--max-count")
        && !trimmed.contains(" -m ")
    {
        return Some(match client {
            Client::Claude => t(
                lang,
                "Use the built-in `Grep` tool (or Haiku `Explore`) instead of raw recursive grep/rg in Bash to avoid bloating shell output.",
                "Используй встроенный инструмент `Grep` (или `Explore` на Haiku) вместо прямого рекурсивного grep/rg в Bash, чтобы не раздувать вывод shell.",
            )
            .to_string(),
            Client::Antigravity => t(
                lang,
                "Add `-l` / `-n` / `-m 20` or narrow the target path instead of broad recursive `grep -r`/`rg`.",
                "Добавь `-l` / `-n` / `-m 20` или сузь путь поиска вместо широкого рекурсивного `grep -r`/`rg`, чтобы не раздувать вывод shell.",
            )
            .to_string(),
        });
    }
    None
}

fn check_ps_inspect(trimmed: &str, client: Client, lang: Lang) -> Option<String> {
    static RE_BARE_GC: OnceLock<Regex> = OnceLock::new();
    let re_gc = RE_BARE_GC.get_or_init(|| {
        Regex::new(r#"(?i)^(?:Get-Content|gc|type)\s+(?:-Path\s+)?(["']?[^"'\s|><&;]+["']?)$"#)
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
    fn shell_guard_handles_antigravity_pwsh_and_bash() {
        assert!(shell_read_guard("run_command", "rg foo src/", Client::Antigravity, Lang::En).is_some());
        assert!(shell_read_guard("run_command", "rg -l foo src/", Client::Antigravity, Lang::En).is_none());
        assert!(
            shell_read_guard("run_command", "rg -n foo src/ | Select-Object -First 10", Client::Antigravity, Lang::En).is_none()
        );
    }
}
