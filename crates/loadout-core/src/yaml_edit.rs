//! Точечный вынос и возврат записи в `cordis.patch.yml` DeepSeek (CONCEPT.md §11): файл правят многие инструменты и в нём
//! есть тег `!!js`, поэтому его нельзя разбирать и собирать заново. Запись вырезается и возвращается по строкам, а
//! положение берётся из событий разбора `yaml-rust2` (строка начала каждой записи). После каждой правки результат
//! разбирается заново и сверяется: остальные записи равны прежним, у этой записи — ровно ожидаемое содержимое. Не
//! сошлось — отказ, файл не меняется.
//!
//! Поддерживается только блочный стиль `- insert:` → `- id: …` с пробелами. Якоря, алиасы, потоковый стиль и табы — отказ.

use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::Marker;
use yaml_rust2::{Yaml, YamlLoader};

struct Collect(Vec<(Event, Marker)>);

impl MarkedEventReceiver for Collect {
    fn on_event(&mut self, ev: Event, m: Marker) {
        self.0.push((ev, m));
    }
}

/// Где в файле лежит список `insert` одной операции.
struct Seq {
    /// Строка (с 1) ключа `insert:`.
    key_line: usize,
    /// Строки (с 1), с которых начинаются записи.
    entries: Vec<usize>,
    /// Строка (с 1), на которой список закончился (первая строка после него).
    end_line: usize,
}

fn events(text: &str) -> Result<Vec<(Event, Marker)>, String> {
    let mut c = Collect(Vec::new());
    Parser::new_from_str(text)
        .load(&mut c, true)
        .map_err(|_| "не YAML".to_owned())?;
    Ok(c.0)
}

/// Индекс события после узла, который начинается в `i`.
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

/// По одному `Option<Seq>` на операцию верхнего списка; `None` — у операции нет списка `insert`.
fn locate(text: &str) -> Result<Vec<Option<Seq>>, String> {
    let ev = events(text)?;
    let Some(root) = ev
        .iter()
        .position(|(e, _)| matches!(e, Event::SequenceStart(..)))
    else {
        return Err("корень YAML не список".into());
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

/// Записи `insert` каждой операции как значения YAML: для сверки до и после правки.
fn entries_of(text: &str) -> Result<Vec<Vec<Yaml>>, String> {
    let docs = YamlLoader::load_from_str(text).map_err(|_| "не YAML".to_owned())?;
    let ops = docs
        .first()
        .and_then(Yaml::as_vec)
        .ok_or("корень YAML не список")?;
    Ok(ops
        .iter()
        .map(|op| op["insert"].as_vec().cloned().unwrap_or_default())
        .collect())
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// Границы записи `ei` операции `oi` в строках (с 0, конец не включён) и отступ тире.
fn span(lines: &[&str], seq: &Seq, ei: usize) -> Result<(usize, usize, usize), String> {
    let start = *seq.entries.get(ei).ok_or("записи нет")? - 1;
    let first = lines.get(start).ok_or("запись за концом файла")?;
    if !first.trim_start().starts_with("- ") || first.contains('\t') {
        return Err("запись не в блочном стиле (`- ключ: значение`): правка отказана".into());
    }
    let indent = indent_of(first);
    let mut end = seq
        .entries
        .get(ei + 1)
        .map_or(seq.end_line.saturating_sub(1), |n| n - 1)
        .min(lines.len());
    end = end.max(start + 1);
    // Хвост из пустых строк и строк-комментариев (маркеры установщиков между операциями) к записи не относится.
    let tail = |l: &str| l.trim().is_empty() || l.trim_start().starts_with('#');
    while end > start + 1 && tail(lines[end - 1]) {
        end -= 1;
    }
    // всё внутри записи глубже тире: иначе положение посчитано неверно
    if lines[start + 1..end]
        .iter()
        .any(|l| !l.trim().is_empty() && indent_of(l) <= indent)
    {
        return Err("границы записи не определились: правка отказана".into());
    }
    // Пустые строки перед записью принадлежат ей (уйдут и вернутся вместе с ней), но не глубже ключа `insert:`.
    let mut head = start;
    while head > seq.key_line && lines[head - 1].trim().is_empty() {
        head -= 1;
    }
    Ok((head, end, indent))
}

fn guard(text: &str) -> Result<(), String> {
    if text.contains('\t') {
        return Err("в файле табы: правка отказана".into());
    }
    match crate::deepseek::yaml_guard(text) {
        Some(why) => Err(format!("{why}: правка отказана")),
        None => Ok(()),
    }
}

/// Опора для возврата: `id` соседней записи той же операции (следующей, а у последней предыдущей); `None`, если запись
/// в операции была единственной. Номера записей и операций в файле сдвигаются (установщики добавляют и убирают операции),
/// а соседа по `id` можно найти снова.
pub fn anchor_of(text: &str, oi: usize, ei: usize) -> Result<Option<String>, String> {
    let ents = entries_of(text)?;
    let list = ents.get(oi).ok_or("нет такой операции")?;
    let Some(n) = list
        .get(ei + 1)
        .or_else(|| ei.checked_sub(1).and_then(|i| list.get(i)))
    else {
        return Ok(None);
    };
    n["id"]
        .as_str()
        .map(|s| Some(s.to_owned()))
        .ok_or_else(|| "соседняя запись без id: вынос по строкам отказан".into())
}

/// Перед возвратом: в операции `oi` всё ещё стоит опорная запись (или операция пуста, если опоры не было).
/// Иначе файл изменился так, что прежнее место неизвестно, и запись молча встала бы в чужую операцию.
pub fn check_anchor(text: &str, oi: usize, anchor: Option<&str>) -> Result<(), String> {
    let ents = entries_of(text)?;
    let list = ents
        .get(oi)
        .ok_or("операции нет: вернуть запись на прежнее место нельзя")?;
    let ok = match anchor {
        Some(a) => list.iter().any(|e| e["id"].as_str() == Some(a)),
        None => list.is_empty(),
    };
    if ok {
        Ok(())
    } else {
        Err(
            "операция в файле изменилась с момента выноса: вернуть запись на прежнее место нельзя"
                .into(),
        )
    }
}

/// Вырезает запись `ei` операции `oi`. Возвращает новый текст и вырезанные строки как есть.
pub fn cut(text: &str, oi: usize, ei: usize) -> Result<(String, String), String> {
    guard(text)?;
    let ops = locate(text)?;
    let seq = ops
        .get(oi)
        .and_then(Option::as_ref)
        .ok_or("нет такой операции")?;
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let (start, end, _) = span(&lines, seq, ei)?;
    let raw: String = lines[start..end].concat();
    let new: String = lines[..start]
        .iter()
        .chain(&lines[end..])
        .copied()
        .collect();
    // сверка: остальное то же, этой записи нет
    let (before, after) = (entries_of(text)?, entries_of(&new)?);
    // сама вырезанная запись тоже должна разобраться в то же значение (строка блочного скаляра на `#` иначе осиротела бы)
    let cut_entry = YamlLoader::load_from_str(&raw).ok().and_then(|d| {
        d.first()
            .and_then(Yaml::as_vec)
            .and_then(|v| v.first().cloned())
    });
    if cut_entry.as_ref() != before[oi].get(ei) {
        return Err("вырезанные строки не равны записи: правка отказана".into());
    }
    let mut want = before;
    want[oi].remove(ei);
    if want != after {
        return Err("после вырезания файл не совпал с ожидаемым: правка отказана".into());
    }
    Ok((new, raw))
}

/// Возвращает вырезанные строки на место `ei` операции `oi` (в конец, если записей меньше).
pub fn put(text: &str, oi: usize, ei: usize, raw: &str) -> Result<String, String> {
    guard(text)?;
    let ops = locate(text)?;
    let seq = ops
        .get(oi)
        .and_then(Option::as_ref)
        .ok_or("нет такой операции")?;
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    // переводы строк как в файле: добавленная строка не должна делать CRLF-файл смешанным
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut chunk = raw.to_owned();
    if !chunk.ends_with('\n') {
        chunk.push_str(nl);
    }
    let at = if seq.entries.is_empty() {
        seq.key_line // сразу под `insert:`
    } else if ei < seq.entries.len() {
        span(&lines, seq, ei)?.0 // перед пустыми строками, которые стоят перед этой записью
    } else {
        let (_, end, _) = span(&lines, seq, seq.entries.len() - 1)?;
        end
    };
    let at = at.min(lines.len());
    let mut new = String::new();
    for (i, l) in lines.iter().enumerate() {
        new.push_str(l);
        // последняя строка файла могла быть без перевода строки
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
    // сверка: остальные записи те же, вернувшаяся равна разобранным строкам
    let one = YamlLoader::load_from_str(raw).map_err(|_| "строки записи не YAML".to_owned())?;
    let entry = one
        .first()
        .and_then(Yaml::as_vec)
        .and_then(|v| v.first())
        .cloned()
        .ok_or("строки записи не список")?;
    let mut want = entries_of(text)?;
    let pos = ei.min(want[oi].len());
    want[oi].insert(pos, entry);
    if want != entries_of(&new)? {
        return Err("после возврата файл не совпал с ожидаемым: правка отказана".into());
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
            assert_eq!(back, Y, "{oi}/{ei}: после возврата побайтово как было");
        }
    }

    /// Так выглядит настоящий файл: между операциями строки-комментарии установщиков на нулевом отступе.
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
            "строка `# end` — часть значения: вырезать нельзя"
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
