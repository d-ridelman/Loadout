//! Targeted removal and restoration of an entry in DeepSeek's `cordis.patch.yml` (CONCEPT.md §11): many tools edit the file and it
//! contains the `!!js` tag, so it cannot be parsed and rebuilt. The entry is cut out and put back line by line, and its
//! position is taken from `yaml-rust2` parse events (the start line of each entry). After each edit the result is
//! parsed again and checked: the other entries equal the previous ones, and this entry has exactly the expected content. If it
//! does not match, it is refused and the file is not changed.
//!
//! Only block style `- insert:` → `- id: …` with spaces is supported. Anchors, aliases, flow style and tabs are refused.

use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::Marker;
use yaml_rust2::{Yaml, YamlLoader};

struct Collect(Vec<(Event, Marker)>);

impl MarkedEventReceiver for Collect {
    fn on_event(&mut self, ev: Event, m: Marker) {
        self.0.push((ev, m));
    }
}

/// Where the `insert` list of one operation lies in the file.
struct Seq {
    /// Line (1-based) of the `insert:` key.
    key_line: usize,
    /// Lines (1-based) where entries start.
    entries: Vec<usize>,
    /// Line (1-based) where the list ended (the first line after it).
    end_line: usize,
}

fn events(text: &str) -> Result<Vec<(Event, Marker)>, String> {
    let mut c = Collect(Vec::new());
    Parser::new_from_str(text)
        .load(&mut c, true)
        .map_err(|_| crate::tr!("не YAML", "not YAML"))?;
    Ok(c.0)
}

/// Index of the event after the node that starts at `i`.
fn skip(ev: &[(Event, Marker)], i: usize) -> usize {
    let mut depth = 0usize;
    for (j, (e, _)) in ev.iter().enumerate().skip(i) {
        match e {
            Event::SequenceStart(..) | Event::MappingStart(..) => depth += 1,
            Event::SequenceEnd | Event::MappingEnd => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return j + 1;
                }
            }
            _ if depth == 0 => return j + 1,
            _ => {}
        }
    }
    ev.len()
}

/// One `Option<Seq>` per operation of the top-level list; `None` means the operation has no `insert` list.
fn locate(text: &str) -> Result<Vec<Option<Seq>>, String> {
    let ev = events(text)?;
    let Some(root) = ev
        .iter()
        .position(|(e, _)| matches!(e, Event::SequenceStart(..)))
    else {
        return Err(crate::tr!(
            "корень YAML не список",
            "YAML root is not a list"
        ));
    };
    let (mut ops, mut i) = (Vec::new(), root + 1);
    while i < ev.len() && !matches!(ev[i].0, Event::SequenceEnd) {
        let next = skip(&ev, i);
        let mut found = None;
        if matches!(ev[i].0, Event::MappingStart(..)) {
            let mut j = i + 1;
            while j < next - 1 {
                let val = j + 1;
                if matches!(&ev[j].0, Event::Scalar(k, ..) if k == "insert") {
                    if matches!(ev[val].0, Event::SequenceStart(..)) {
                        let (mut entries, mut k) = (Vec::new(), val + 1);
                        while !matches!(ev[k].0, Event::SequenceEnd) {
                            entries.push(ev[k].1.line());
                            k = skip(&ev, k);
                        }
                        found = Some(Seq {
                            key_line: ev[j].1.line(),
                            entries,
                            end_line: ev[k].1.line(),
                        });
                    } else if matches!(ev[val].0, Event::Scalar(ref v, ..) if v.is_empty() || v == "~" || v == "null")
                    {
                        found = Some(Seq {
                            key_line: ev[j].1.line(),
                            entries: Vec::new(),
                            end_line: ev[j].1.line() + 1,
                        });
                    }
                }
                j = skip(&ev, val);
            }
        }
        ops.push(found);
        i = next;
    }
    Ok(ops)
}

/// The `insert` entries of each operation as YAML values: for comparing before and after an edit.
fn entries_of(text: &str) -> Result<Vec<Vec<Yaml>>, String> {
    let docs = YamlLoader::load_from_str(text).map_err(|_| crate::tr!("не YAML", "not YAML"))?;
    let ops = docs
        .first()
        .and_then(Yaml::as_vec)
        .ok_or_else(|| crate::tr!("корень YAML не список", "YAML root is not a list"))?;
    Ok(ops
        .iter()
        .map(|op| op["insert"].as_vec().cloned().unwrap_or_default())
        .collect())
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// Bounds of entry `ei` of operation `oi` in lines (0-based, end exclusive) and the dash indent.
fn span(lines: &[&str], seq: &Seq, ei: usize) -> Result<(usize, usize, usize), String> {
    let start = *seq
        .entries
        .get(ei)
        .ok_or_else(|| crate::tr!("записи нет", "no such entry"))?
        - 1;
    let first = lines.get(start).ok_or_else(|| {
        crate::tr!(
            "запись за концом файла",
            "entry is past the end of the file"
        )
    })?;
    if !first.trim_start().starts_with("- ") || first.contains('\t') {
        return Err(crate::tr!(
            "запись не в блочном стиле (`- ключ: значение`): правка отказана",
            "entry is not in block style (`- key: value`): edit refused"
        ));
    }
    let indent = indent_of(first);
    let mut end = seq
        .entries
        .get(ei + 1)
        .map_or(seq.end_line.saturating_sub(1), |n| n - 1)
        .min(lines.len());
    end = end.max(start + 1);
    // A tail of blank lines and comment lines (installer markers between operations) does not belong to the entry.
    let tail = |l: &str| l.trim().is_empty() || l.trim_start().starts_with('#');
    while end > start + 1 && tail(lines[end - 1]) {
        end -= 1;
    }
    // everything inside an entry is deeper than the dash: otherwise the position was computed wrongly
    if lines[start + 1..end]
        .iter()
        .any(|l| !l.trim().is_empty() && indent_of(l) <= indent)
    {
        return Err(crate::tr!(
            "границы записи не определились: правка отказана",
            "entry boundaries could not be determined: edit refused"
        ));
    }
    // Blank lines before an entry belong to it (they leave and return with it), but not beyond the `insert:` key.
    let mut head = start;
    while head > seq.key_line && lines[head - 1].trim().is_empty() {
        head -= 1;
    }
    Ok((head, end, indent))
}

fn guard(text: &str) -> Result<(), String> {
    if text.contains('\t') {
        return Err(crate::tr!(
            "в файле табы: правка отказана",
            "the file contains tabs: edit refused"
        ));
    }
    match crate::deepseek::yaml_guard(text) {
        Some(why) => Err(crate::tr!("{why}: правка отказана", "{why}: edit refused")),
        None => Ok(()),
    }
}

/// Anchor for putting back: the `id` of a neighboring entry in the same operation (the next one, or the previous for the last one); `None` if the entry
/// was the only one in the operation. Entry and operation numbers in the file shift (installers add and remove operations),
/// but the neighbor can be found again by `id`.
pub fn anchor_of(text: &str, oi: usize, ei: usize) -> Result<Option<String>, String> {
    let ents = entries_of(text)?;
    let list = ents
        .get(oi)
        .ok_or_else(|| crate::tr!("нет такой операции", "no such operation"))?;
    let Some(n) = list
        .get(ei + 1)
        .or_else(|| ei.checked_sub(1).and_then(|i| list.get(i)))
    else {
        return Ok(None);
    };
    n["id"].as_str().map(|s| Some(s.to_owned())).ok_or_else(|| {
        crate::tr!(
            "соседняя запись без id: вынос по строкам отказан",
            "neighbouring entry has no id: line-based move-out refused"
        )
    })
}

/// Before putting back: operation `oi` still contains the anchor entry (or the operation is empty if there was no anchor).
/// Otherwise the file changed so that the former place is unknown, and the entry would silently land in another operation.
pub fn check_anchor(text: &str, oi: usize, anchor: Option<&str>) -> Result<(), String> {
    let ents = entries_of(text)?;
    let list = ents.get(oi).ok_or_else(|| {
        crate::tr!(
            "операции нет: вернуть запись на прежнее место нельзя",
            "the operation is gone: the entry cannot be restored to its place"
        )
    })?;
    let ok = match anchor {
        Some(a) => list.iter().any(|e| e["id"].as_str() == Some(a)),
        None => list.is_empty(),
    };
    if ok {
        Ok(())
    } else {
        Err(crate::tr!(
            "операция в файле изменилась с момента выноса: вернуть запись на прежнее место нельзя",
            "the operation in the file changed since the move-out: the entry cannot be restored to its place"
        ))
    }
}

/// Cuts entry `ei` of operation `oi`. Returns the new text and the cut lines as they are.
pub fn cut(text: &str, oi: usize, ei: usize) -> Result<(String, String), String> {
    guard(text)?;
    let ops = locate(text)?;
    let seq = ops
        .get(oi)
        .and_then(Option::as_ref)
        .ok_or_else(|| crate::tr!("нет такой операции", "no such operation"))?;
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let (start, end, _) = span(&lines, seq, ei)?;
    let raw: String = lines[start..end].concat();
    let new: String = lines[..start]
        .iter()
        .chain(&lines[end..])
        .copied()
        .collect();
    // check: everything else is the same, this entry is gone
    let (before, after) = (entries_of(text)?, entries_of(&new)?);
    // the cut entry itself must also parse into the same value (a block scalar line starting with `#` would otherwise be orphaned)
    let cut_entry = YamlLoader::load_from_str(&raw).ok().and_then(|d| {
        d.first()
            .and_then(Yaml::as_vec)
            .and_then(|v| v.first().cloned())
    });
    if cut_entry.as_ref() != before[oi].get(ei) {
        return Err(crate::tr!(
            "вырезанные строки не равны записи: правка отказана",
            "the cut lines do not match the entry: edit refused"
        ));
    }
    let mut want = before;
    want[oi].remove(ei);
    if want != after {
        return Err(crate::tr!(
            "после вырезания файл не совпал с ожидаемым: правка отказана",
            "after cutting, the file does not match the expected result: edit refused"
        ));
    }
    Ok((new, raw))
}

/// Puts the cut lines back at position `ei` of operation `oi` (at the end if there are fewer entries).
pub fn put(text: &str, oi: usize, ei: usize, raw: &str) -> Result<String, String> {
    guard(text)?;
    let ops = locate(text)?;
    let seq = ops
        .get(oi)
        .and_then(Option::as_ref)
        .ok_or_else(|| crate::tr!("нет такой операции", "no such operation"))?;
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    // line endings as in the file: an added line must not make a CRLF file mixed
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut chunk = raw.to_owned();
    if !chunk.ends_with('\n') {
        chunk.push_str(nl);
    }
    let at = if seq.entries.is_empty() {
        seq.key_line // right under `insert:`
    } else if ei < seq.entries.len() {
        span(&lines, seq, ei)?.0 // before the blank lines that precede this entry
    } else {
        let (_, end, _) = span(&lines, seq, seq.entries.len() - 1)?;
        end
    };
    let at = at.min(lines.len());
    let mut new = String::new();
    for (i, l) in lines.iter().enumerate() {
        new.push_str(l);
        // the last line of the file may have had no line ending
        if i + 1 == at && !l.ends_with('\n') {
            new.push_str(nl);
        }
        if i + 1 == at {
            new.push_str(&chunk);
        }
    }
    if at == 0 {
        new = format!("{chunk}{new}");
    }
    // check: the other entries are the same, the restored one equals the parsed lines
    let one = YamlLoader::load_from_str(raw)
        .map_err(|_| crate::tr!("строки записи не YAML", "entry lines are not YAML"))?;
    let entry = one
        .first()
        .and_then(Yaml::as_vec)
        .and_then(|v| v.first())
        .cloned()
        .ok_or_else(|| crate::tr!("строки записи не список", "entry lines are not a list"))?;
    let mut want = entries_of(text)?;
    let pos = ei.min(want[oi].len());
    want[oi].insert(pos, entry);
    if want != entries_of(&new)? {
        return Err(crate::tr!(
            "после возврата файл не совпал с ожидаемым: правка отказана",
            "after restoring, the file does not match the expected result: edit refused"
        ));
    }
    Ok(new)
}

#[cfg(test)]
mod tests {
    use super::*;

    const Y: &str = "- insert:\n    - id: a\n      name: \"@deepseek-ai/dsh-mcp-client\"\n      config:\n        serverName: one\n        cwd: !!js process.cwd()\n        args:\n          - x\n    - id: b\n      name: \"@deepseek-ai/dsh-mcp-client\"\n      config:\n        serverName: two\n\n    - id: c\n      name: \"@deepseek-ai/dsh-mcp-client\"\n      config:\n        serverName: three\n- insert:\n    - id: only\n      name: p\n- insert:\n    - id: last\n      name: q\n";

    #[test]
    fn cut_and_put_back_is_byte_identical_for_every_entry() {
        for (oi, ei) in [(0, 0), (0, 1), (0, 2), (1, 0), (2, 0)] {
            let (cut, raw) = cut(Y, oi, ei).unwrap_or_else(|e| panic!("{oi}/{ei}: {e}"));
            assert!(cut.len() < Y.len() && !cut.contains(&raw), "{oi}/{ei}");
            let back = put(&cut, oi, ei, &raw).unwrap_or_else(|e| panic!("{oi}/{ei}: {e}"));
            assert_eq!(
                back, Y,
                "{oi}/{ei}: byte-identical to the original after putting back"
            );
        }
    }

    /// This is what a real file looks like: between operations there are installer comment lines at zero indent.
    #[test]
    fn installer_comments_between_operations_stay_in_place() {
        let t = "# BEGIN x\n- insert:\n    - id: a\n      name: p\n      config:\n        k: 1\n# END x\n\n# BEGIN y\n- insert:\n    - id: b\n      name: q\n# END y\n";
        for (oi, ei) in [(0, 0), (1, 0)] {
            let (cut, raw) = cut(t, oi, ei).unwrap();
            assert!(
                cut.contains("# END x") && cut.contains("# BEGIN y") && cut.contains("# END y"),
                "{cut}"
            );
            assert_eq!(put(&cut, oi, ei, &raw).unwrap(), t, "{oi}/{ei}");
        }
    }

    #[test]
    fn block_scalar_line_starting_with_a_hash_is_not_mistaken_for_a_comment() {
        let t = "- insert:\n    - id: a\n      script: |\n        echo hi\n        # end\n";
        assert!(
            cut(t, 0, 0).is_err(),
            "the `# end` line is part of the value: it cannot be cut out"
        );
    }

    #[test]
    fn crlf_file_without_trailing_newline_gets_crlf_not_lf_back() {
        let t = "- insert:\r\n    - id: a\r\n      name: p\r\n    - id: b\r\n      name: q";
        let (c, raw) = cut(t, 0, 1).unwrap();
        let back = put(&c, 0, 1, &raw).unwrap();
        assert!(!back.replace("\r\n", "").contains('\n'), "{back:?}");
    }

    #[test]
    fn only_entry_leaves_an_empty_insert_that_still_parses() {
        let (cut, raw) = cut(Y, 1, 0).unwrap();
        assert!(cut.contains("- insert:\n- insert:"), "{cut}");
        assert_eq!(entries_of(&cut).unwrap()[1].len(), 0);
        assert_eq!(put(&cut, 1, 0, &raw).unwrap(), Y);
    }

    #[test]
    fn crlf_and_missing_trailing_newline_survive() {
        let crlf = Y.replace('\n', "\r\n");
        let (c, raw) = cut(&crlf, 0, 1).unwrap();
        assert!(!c.replace("\r\n", "").contains('\n'));
        assert_eq!(put(&c, 0, 1, &raw).unwrap(), crlf);
        let no_nl = Y.trim_end_matches('\n');
        let (c, raw) = cut(no_nl, 2, 0).unwrap();
        assert_eq!(put(&c, 2, 0, &raw).unwrap().trim_end(), no_nl);
    }

    #[test]
    fn refuses_anchors_flow_style_tabs_and_missing_entries() {
        let anchors = "- insert:\n    - id: a\n      config: &x\n        k: 1\n";
        assert!(cut(anchors, 0, 0).is_err());
        let flow = "- insert: [{id: a}]\n";
        assert!(cut(flow, 0, 0).is_err());
        assert!(cut("- insert:\n\t- id: a\n", 0, 0).is_err());
        assert!(cut(Y, 0, 9).is_err());
        assert!(cut(Y, 9, 0).is_err());
        assert!(cut("a: 1\n", 0, 0).is_err());
    }
}
