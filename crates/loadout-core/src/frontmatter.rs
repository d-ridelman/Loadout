//! Frontmatter `SKILL.md` и агентов: читаем только голову файла (CONCEPT.md §7).

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

const HEAD: u64 = 4096;

pub fn read(path: &Path) -> Option<HashMap<String, String>> {
    let mut buf = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(HEAD)
        .read_to_end(&mut buf)
        .ok()?;
    Some(parse(&String::from_utf8_lossy(&buf)))
}

/// Плоские `ключ: значение`. Многострочные значения (`|`, `>`) не разворачиваем: для M0 хватает имени и описания.
pub fn parse(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return map;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if !k.starts_with(char::is_whitespace) && !k.is_empty() {
                let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
                map.insert(k.trim().to_owned(), v.to_owned());
            }
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flat_keys() {
        let m = parse("---\nname: bash-tui\ndescription: \"Build TUIs: fast\"\nmodel: opus\n---\n# Body\nname: not-this\n");
        assert_eq!(m["name"], "bash-tui");
        assert_eq!(m["description"], "Build TUIs: fast");
        assert_eq!(m["model"], "opus");
    }

    #[test]
    fn no_frontmatter_is_empty() {
        assert!(parse("# just a title\nname: x\n").is_empty());
    }
}
