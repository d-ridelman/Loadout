//! Frontmatter of `SKILL.md` and agents: only the head of the file is read (CONCEPT.md §7).

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

/// Top-level `key: value` pairs. A value may be a block scalar (`|` or `>`, with chomping and indentation indicators
/// and a trailing comment) or a plain or quoted value that goes on over indented lines; either way it becomes one line
/// of words, as the window's own reader (`install.ts`) does: values here are shown on one line. A key with an empty
/// value and indented lines under it is a nested map: its value stays empty and its lines are not read as keys.
pub fn parse(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut lines = text.lines().peekable();
    if lines.next().map(str::trim) != Some("---") {
        return map;
    }
    while let Some(line) = lines.next() {
        if line.trim() == "---" {
            break;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        if k.is_empty() || k.starts_with(char::is_whitespace) {
            continue;
        }
        let v = v.trim();
        // the indented lines that belong to this key: up to the next top-level line or the end of the frontmatter
        let mut body = Vec::new();
        while let Some(next) = lines.peek() {
            if next.trim() == "---"
                || !(next.trim().is_empty() || next.starts_with(char::is_whitespace))
            {
                break;
            }
            body.push(*next);
            lines.next();
        }
        // the text lines under the key, without indentation; outside a block a `#` line is a comment, inside it is text
        let block = is_block_indicator(v);
        let more = body
            .iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty() && (block || !l.starts_with('#')));
        let value = if block {
            // inside a block quotes are text, so they are kept as written
            more.collect::<Vec<_>>().join(" ")
        } else if v.is_empty() {
            String::new() // a nested map or list: not a text value
        } else {
            let joined = std::iter::once(v).chain(more).collect::<Vec<_>>().join(" ");
            joined.trim_matches(|c| c == '"' || c == '\'').to_owned()
        };
        map.insert(k.trim().to_owned(), value.trim().to_owned());
    }
    map
}

/// `|` or `>` with an optional chomping (`+`/`-`) and indentation digit, and an optional ` # comment` after them.
fn is_block_indicator(v: &str) -> bool {
    let v = v.split(" #").next().unwrap_or("").trim();
    let mut c = v.chars();
    matches!(c.next(), Some('|' | '>'))
        && c.all(|x| matches!(x, '+' | '-') || x.is_ascii_digit())
        && v.len() <= 3
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
    fn block_scalars_are_unfolded() {
        // a description is shown on one line: `>` and `|` alike become one line of words, as the window's own reader does
        let m = parse("---\nname: a\ndescription: >-\n  Build TUIs\n  in pure Bash.\n\n  Second paragraph.\nmodel: opus\n---\n");
        assert_eq!(
            m["description"],
            "Build TUIs in pure Bash. Second paragraph."
        );
        assert_eq!(m["model"], "opus", "the key after the block is read");
        let m = parse("---\ndescription: |\n    line one\n    line two\nname: b\n---\n");
        assert_eq!(m["description"], "line one line two");
        assert_eq!(m["name"], "b");
        let m = parse("---\ndescription: >2\n  folded\n  text\n---\n");
        assert_eq!(m["description"], "folded text");
    }

    #[test]
    fn block_edge_cases() {
        // quotes inside a block are text, not quoting
        let m = parse("---\ndescription: |\n  \"Quoted\" text ends with 'x'\n---\n");
        assert_eq!(m["description"], "\"Quoted\" text ends with 'x'");
        // a comment after the indicator is no part of the value
        let m = parse("---\ndescription: > # note\n  folded text\n---\n");
        assert_eq!(m["description"], "folded text");
        // a no-break space in the indentation loses no line
        let m = parse("---\ndescription: |\n  aa\n \u{a0}bb\n---\n");
        assert_eq!(m["description"], "aa bb");
        // a comment line inside a plain value that goes on is no text; inside a block a `#` line is text
        let m = parse("---\ndescription: one\n  # c\n  two\n---\n");
        assert_eq!(m["description"], "one two");
        let m = parse("---\ndescription: |\n  # Usage\n  run it\n---\n");
        assert_eq!(m["description"], "# Usage run it");
    }

    #[test]
    fn a_plain_value_may_go_on_over_indented_lines() {
        let m = parse(
            "---\ndescription: Use this skill when\n  the user asks for a TUI.\nname: c\n---\n",
        );
        assert_eq!(
            m["description"],
            "Use this skill when the user asks for a TUI."
        );
        let m = parse("---\ndescription: \"Quoted and\n  continued\"\n---\n");
        assert_eq!(m["description"], "Quoted and continued");
    }

    #[test]
    fn a_nested_map_is_not_a_value() {
        // `metadata:` with indented keys under it stays empty: those lines are not its text
        let m = parse("---\nname: d\nmetadata:\n  version: 2\n  tags: x\ndescription: real\n---\n");
        assert_eq!(m["metadata"], "");
        assert_eq!(m["description"], "real");
        assert!(!m.contains_key("version"));
    }

    #[test]
    fn no_frontmatter_is_empty() {
        assert!(parse("# just a title\nname: x\n").is_empty());
    }
}
