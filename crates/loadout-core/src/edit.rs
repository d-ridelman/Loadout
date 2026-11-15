//! Точечная правка булева ключа в тексте JSON и TOML (R1, CONCEPT.md §5, шаг 6).
//! Файл не разбирается и не собирается заново: меняются только байты самого значения (или добавляется одна запись),
//! поэтому порядок ключей, комментарии, отступы, BOM и CRLF остаются как были.

use crate::model::Format;
use jsonc_parser::ast::{BooleanLit, Object, ObjectProp, ObjectPropName, Value};
use jsonc_parser::common::Ranged;
use jsonc_parser::{parse_to_ast, CollectOptions, ParseOptions};
use toml_edit::{DocumentMut, Item, TableLike};

const BOM: char = '\u{feff}';

/// Текущее значение ключа: `Ok(None)` — ключа нет.
pub fn get_bool(format: Format, text: &str, path: &[String]) -> Result<Option<bool>, String> {
    let text = text.strip_prefix(BOM).unwrap_or(text);
    match format {
        Format::Json => with_json(text, path, |_, found| match found {
            Found::Bool(b) => Ok(Some(b.value)),
            Found::Missing { .. } => Ok(None),
        }),
        Format::Toml => {
            let doc: DocumentMut = text.parse().map_err(|_| "не TOML".to_owned())?;
            let mut item = doc.as_item();
            for k in path {
                match item.as_table_like().and_then(|t| t.get(k)) {
                    Some(i) => item = i,
                    None => return Ok(None),
                }
            }
            item.as_bool()
                .map(Some)
                .ok_or_else(|| "значение не булево".to_owned())
        }
    }
}

/// Текст с ключом `path`, равным `value`. Остальные байты те же.
pub fn set_bool(
    format: Format,
    text: &str,
    path: &[String],
    value: bool,
) -> Result<String, String> {
    let (bom, body) = match text.strip_prefix(BOM) {
        Some(b) => ("\u{feff}", b),
        None => ("", text),
    };
    let out = match format {
        Format::Json => with_json(body, path, |obj_text, found| {
            Ok(match found {
                Found::Bool(b) => {
                    let r = b.range;
                    format!("{}{value}{}", &obj_text[..r.start], &obj_text[r.end..])
                }
                Found::Missing { obj, depth } => insert_json(obj_text, obj, &path[depth..], value)?,
            })
        })?,
        Format::Toml => set_toml(body, path, value)?,
    };
    Ok(format!("{bom}{out}"))
}

enum Found<'a, 'b> {
    Bool(&'b BooleanLit),
    /// Ключа нет: `obj` — самый глубокий существующий объект, `depth` — сколько ключей пути в нём уже есть.
    Missing {
        obj: &'b Object<'a>,
        depth: usize,
    },
}

fn name_of<'a>(n: &'a ObjectPropName<'_>) -> &'a str {
    match n {
        ObjectPropName::String(l) => l.value.as_ref(),
        ObjectPropName::Word(l) => l.value,
    }
}

/// Последнее свойство с таким именем: `serde_json` при повторе ключа берёт последний.
fn find<'a, 'b>(obj: &'b Object<'a>, key: &str) -> Option<&'b ObjectProp<'a>> {
    obj.properties
        .iter()
        .rev()
        .find(|p| name_of(&p.name) == key)
}

fn with_json<T>(
    text: &str,
    path: &[String],
    f: impl FnOnce(&str, Found<'_, '_>) -> Result<T, String>,
) -> Result<T, String> {
    if path.is_empty() {
        return Err("пустой путь".to_owned());
    }
    let parsed = parse_to_ast(text, &CollectOptions::default(), &ParseOptions::default())
        .map_err(|_| "не JSON".to_owned())?;
    let Some(Value::Object(root)) = parsed.value else {
        return Err("корень JSON не объект".to_owned());
    };
    let mut obj = &root;
    for (depth, key) in path.iter().enumerate() {
        let last = depth + 1 == path.len();
        match (find(obj, key), last) {
            (None, _) => return f(text, Found::Missing { obj, depth }),
            (Some(p), true) => {
                return match &p.value {
                    Value::BooleanLit(b) => f(text, Found::Bool(b)),
                    _ => Err("значение не булево".to_owned()),
                }
            }
            (Some(p), false) => match &p.value {
                Value::Object(o) => obj = o,
                _ => return Err("на пути лежит не объект".to_owned()),
            },
        }
    }
    unreachable!("путь не пуст, последний ключ возвращает результат")
}

/// Значение для новых ключей: `"k0": {"k1": true}` одной строкой или в несколько с отступом.
fn render(keys: &[String], value: bool, multiline: bool, indent: &str, nl: &str) -> String {
    let key = serde_json::to_string(&keys[0]).unwrap_or_default();
    if keys.len() == 1 {
        return format!("{key}: {value}");
    }
    let inner = render(&keys[1..], value, multiline, &format!("{indent}  "), nl);
    if multiline {
        format!("{key}: {{{nl}{indent}  {inner}{nl}{indent}}}")
    } else {
        format!("{key}: {{{inner}}}")
    }
}

fn line_indent(text: &str, pos: usize) -> &str {
    let start = text[..pos].rfind('\n').map_or(0, |i| i + 1);
    let line = &text[start..pos];
    let n = line.len() - line.trim_start_matches([' ', '\t']).len();
    &line[..n]
}

fn insert_json(
    text: &str,
    obj: &Object<'_>,
    keys: &[String],
    value: bool,
) -> Result<String, String> {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let (start, end) = (obj.range().start, obj.range().end);
    match obj.properties.last() {
        Some(last) => {
            let first = &obj.properties[0];
            let multiline = text[start..first.range.start].contains('\n');
            let indent = if multiline {
                line_indent(text, first.range.start)
            } else {
                ""
            };
            let prop = render(keys, value, multiline, indent, nl);
            let sep = if multiline {
                format!(",{nl}{indent}")
            } else {
                ", ".to_owned()
            };
            let at = last.range.end;
            Ok(format!("{}{sep}{prop}{}", &text[..at], &text[at..]))
        }
        None => {
            // `{}` или `{ }`: комментарий внутри потерять нельзя, такой файл не трогаем
            let inner = &text[start + 1..end - 1];
            if !inner.trim().is_empty() {
                return Err("в пустом объекте есть комментарий".to_owned());
            }
            let base = line_indent(text, start);
            let indent = format!("{base}  ");
            let prop = render(keys, value, true, &indent, nl);
            Ok(format!(
                "{}{nl}{indent}{prop}{nl}{base}{}",
                &text[..=start],
                &text[end - 1..]
            ))
        }
    }
}

fn set_toml(text: &str, path: &[String], value: bool) -> Result<String, String> {
    let (last, parents) = path.split_last().ok_or_else(|| "пустой путь".to_owned())?;
    let crlf = text.contains("\r\n");
    let only_crlf = crlf && !text.replace("\r\n", "").contains('\n');
    if crlf && !only_crlf {
        // toml_edit пишет новые и перенесённые строки через `\n`: в смешанном файле поменялись бы байты вне правки
        return Err("в файле смешанные переводы строк (CRLF и LF): правка отказана".to_owned());
    }
    let mut doc: DocumentMut = text.parse().map_err(|_| "не TOML".to_owned())?;
    let mut t: &mut dyn TableLike = doc.as_table_mut();
    for (i, k) in parents.iter().enumerate() {
        if !t.contains_key(k) {
            let mut nt = toml_edit::Table::new();
            // промежуточные таблицы без собственного заголовка; заголовок получает только самая глубокая
            nt.set_implicit(i + 1 != parents.len());
            t.insert(k, Item::Table(nt));
        }
        t = t
            .get_mut(k)
            .and_then(Item::as_table_like_mut)
            .ok_or_else(|| "на пути лежит не таблица".to_owned())?;
    }
    match t.get_mut(last) {
        Some(item) => {
            let v = item
                .as_value_mut()
                .filter(|v| v.is_bool())
                .ok_or_else(|| "значение не булево".to_owned())?;
            let decor = v.decor().clone(); // пробелы и комментарий в конце строки
            *v = toml_edit::Value::from(value);
            *v.decor_mut() = decor;
        }
        None => {
            t.insert(last, toml_edit::value(value));
        }
    }
    let out = doc.to_string();
    // новые строки toml_edit пишет через `\n`: в файле с одними CRLF приводим всё к CRLF
    if only_crlf {
        return Ok(out.replace("\r\n", "\n").replace('\n', "\r\n"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| (*x).to_owned()).collect()
    }

    /// Разница в байтах: общий префикс и суффикс отброшены, остаётся только изменённая середина.
    fn middle(a: &str, b: &str) -> (String, String) {
        let pre = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
        let suf = a
            .bytes()
            .rev()
            .zip(b.bytes().rev())
            .take_while(|(x, y)| x == y)
            .count();
        let suf = suf.min(a.len() - pre).min(b.len() - pre);
        (
            a[pre..a.len() - suf].to_owned(),
            b[pre..b.len() - suf].to_owned(),
        )
    }

    /// Разбирается как JSON с комментариями (в фикстуре `J` есть `//`, строгий `serde_json` его не примет).
    fn valid(s: &str) -> bool {
        parse_to_ast(s, &CollectOptions::default(), &ParseOptions::default()).is_ok()
    }

    const J: &str = "{\n  \"model\": \"x\", // keep\n  \"enabledPlugins\": {\n    \"a@m\": true,\n    \"b@m\": false\n  },\n  \"env\": {\"TOKEN\": \"FAKE-SECRET\"}\n}\n";

    #[test]
    fn json_flips_only_the_literal() {
        let out = set_bool(Format::Json, J, &p(&["enabledPlugins", "a@m"]), false).unwrap();
        assert_eq!(middle(J, &out), ("tru".into(), "fals".into()));
        assert_eq!(
            get_bool(Format::Json, &out, &p(&["enabledPlugins", "a@m"])).unwrap(),
            Some(false)
        );
    }

    #[test]
    fn json_inserts_missing_key_after_last_with_indent() {
        let out = set_bool(Format::Json, J, &p(&["enabledPlugins", "c@m"]), true).unwrap();
        assert_eq!(middle(J, &out).0, "");
        assert!(
            out.contains("\"b@m\": false,\n    \"c@m\": true\n  }"),
            "{out}"
        );
        assert_eq!(
            get_bool(Format::Json, &out, &p(&["enabledPlugins", "c@m"])).unwrap(),
            Some(true)
        );
        assert!(valid(&out));
    }

    #[test]
    fn json_inserts_missing_object_and_into_empty() {
        let out = set_bool(Format::Json, J, &p(&["x", "y"]), true).unwrap();
        assert!(valid(&out), "{out}");
        assert_eq!(
            get_bool(Format::Json, &out, &p(&["x", "y"])).unwrap(),
            Some(true)
        );
        let out = set_bool(Format::Json, "{}", &p(&["a", "b"]), false).unwrap();
        assert_eq!(out, "{\n  \"a\": {\n    \"b\": false\n  }\n}");
        let out = set_bool(Format::Json, "{\"a\": 1}", &p(&["k"]), true).unwrap();
        assert_eq!(out, "{\"a\": 1, \"k\": true}");
    }

    #[test]
    fn json_keeps_bom_crlf_and_trailing_comma() {
        let t = "\u{feff}{\r\n  \"a\": 1,\r\n}\r\n";
        let out = set_bool(Format::Json, t, &p(&["k"]), true).unwrap();
        assert_eq!(out, "\u{feff}{\r\n  \"a\": 1,\r\n  \"k\": true,\r\n}\r\n");
    }

    #[test]
    fn json_duplicate_key_edits_the_one_serde_reads() {
        let t = "{\"k\": true, \"k\": false}";
        let out = set_bool(Format::Json, t, &p(&["k"]), true).unwrap();
        assert_eq!(out, "{\"k\": true, \"k\": true}");
    }

    #[test]
    fn json_refuses_wrong_shapes() {
        assert!(set_bool(Format::Json, "{\"k\": 1}", &p(&["k"]), true).is_err());
        assert!(set_bool(Format::Json, "{\"k\": 1}", &p(&["k", "z"]), true).is_err());
        assert!(set_bool(Format::Json, "[1]", &p(&["k"]), true).is_err());
        assert!(set_bool(Format::Json, "{ /* c */ }", &p(&["k"]), true).is_err());
        assert!(set_bool(Format::Json, "{oops", &p(&["k"]), true).is_err());
    }

    const T: &str = "# top\nmodel = \"x\"\n\n[plugins.\"a@m\"]\nenabled = true # why\n\n[mcp_servers.s]\ncommand = \"c\"\nenv = { TOKEN = \"FAKE-SECRET\" }\n";

    #[test]
    fn toml_flips_value_and_keeps_comment() {
        let out = set_bool(Format::Toml, T, &p(&["plugins", "a@m", "enabled"]), false).unwrap();
        assert_eq!(middle(T, &out), ("tru".into(), "fals".into()));
    }

    #[test]
    fn toml_inserts_key_into_existing_and_new_tables() {
        let out = set_bool(Format::Toml, T, &p(&["mcp_servers", "s", "enabled"]), false).unwrap();
        assert!(out.starts_with(T.trim_end()), "{out}");
        assert_eq!(
            get_bool(Format::Toml, &out, &p(&["mcp_servers", "s", "enabled"])).unwrap(),
            Some(false)
        );
        let out = set_bool(Format::Toml, T, &p(&["apps", "app-1", "enabled"]), false).unwrap();
        assert!(out.starts_with(T), "{out}");
        assert!(out.contains("[apps.app-1]\nenabled = false"), "{out}");
        assert!(!out.contains("[apps]\n"), "{out}");
        let out = set_bool(Format::Toml, "", &p(&["plugins", "a@m", "enabled"]), true).unwrap();
        assert_eq!(
            get_bool(Format::Toml, &out, &p(&["plugins", "a@m", "enabled"])).unwrap(),
            Some(true)
        );
    }

    #[test]
    fn toml_keeps_bom_and_crlf_and_refuses_wrong_shapes() {
        let t = "\u{feff}[a]\r\nenabled = true\r\n";
        let out = set_bool(Format::Toml, t, &p(&["a", "enabled"]), false).unwrap();
        assert_eq!(out, "\u{feff}[a]\r\nenabled = false\r\n");
        let out = set_bool(Format::Toml, t, &p(&["b", "enabled"]), true).unwrap();
        assert!(
            out.starts_with(t) && !out.replace("\r\n", "").contains('\n'),
            "{out:?}"
        );
        assert!(set_bool(Format::Toml, "a = 1", &p(&["a"]), true).is_err());
        assert!(set_bool(Format::Toml, "a = 1", &p(&["a", "b"]), true).is_err());
        assert!(set_bool(Format::Toml, "a = [", &p(&["a"]), true).is_err());
        // смешанные переводы строк: отказ, а не молчаливая порча байтов вне правки
        let mixed = "[a]\r\nx = 1\n[b]\r\ny = 2\r\n";
        assert!(set_bool(Format::Toml, mixed, &p(&["a", "enabled"]), true)
            .unwrap_err()
            .contains("смешанные"));
    }
}
