//! Точечная правка булева ключа в тексте JSON и TOML (R1, CONCEPT.md §5, шаг 6).
//! Файл не разбирается и не собирается заново: меняются только байты самого значения (или добавляется одна запись),
//! поэтому порядок ключей, комментарии, отступы, BOM и CRLF остаются как были.

use crate::model::Format;
use jsonc_parser::ast::{Object, ObjectProp, ObjectPropName, Value};
use jsonc_parser::common::Ranged;
use jsonc_parser::{parse_to_ast, CollectOptions, ParseOptions};
use toml_edit::{DocumentMut, Item, TableLike};

const BOM: char = '\u{feff}';

/// Текущее значение ключа: `Ok(None)` — ключа нет.
pub fn get_bool(format: Format, text: &str, path: &[String]) -> Result<Option<bool>, String> {
    let text = text.strip_prefix(BOM).unwrap_or(text);
    match format {
        Format::Json => with_json(text, path, |_, found| match found {
            Found::Value(Value::BooleanLit(b)) => Ok(Some(b.value)),
            Found::Value(_) => Err("значение не булево".to_owned()),
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
        Format::Yaml => Err(
            "для YAML правка значений не поддержана: только вынос и возврат записи (yaml_edit)"
                .to_owned(),
        ),
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
                Found::Value(Value::BooleanLit(b)) => {
                    let r = b.range;
                    format!("{}{value}{}", &obj_text[..r.start], &obj_text[r.end..])
                }
                Found::Value(_) => return Err("значение не булево".to_owned()),
                Found::Missing { obj, depth } => {
                    insert_json(obj_text, obj, &path[depth..], &value.to_string())?
                }
            })
        })?,
        Format::Toml => set_toml(body, path, Leaf::Bool(value))?,
        Format::Yaml => return Err("для YAML булевы флаги не поддержаны".to_owned()),
    };
    Ok(format!("{bom}{out}"))
}

/// Что записать по ключу в TOML.
enum Leaf<'a> {
    Bool(bool),
    Json(&'a serde_json::Value),
}

fn split_bom(text: &str) -> (&'static str, &str) {
    match text.strip_prefix(BOM) {
        Some(b) => ("\u{feff}", b),
        None => ("", text),
    }
}

/// Значение по пути как JSON (для копирования между клиентами). `Ok(None)` — ключа нет.
pub fn get_value(
    format: Format,
    text: &str,
    path: &[String],
) -> Result<Option<serde_json::Value>, String> {
    let text = text.strip_prefix(BOM).unwrap_or(text);
    match format {
        Format::Json => {
            let v: serde_json::Value =
                serde_json::from_str(text).map_err(|_| "не JSON".to_owned())?;
            Ok(path.iter().try_fold(&v, |cur, k| cur.get(k)).cloned())
        }
        Format::Toml => {
            let t: toml::Table = text.parse().map_err(|_| "не TOML".to_owned())?;
            let v = serde_json::to_value(&t).map_err(|e| e.to_string())?;
            Ok(path.iter().try_fold(&v, |cur, k| cur.get(k)).cloned())
        }
        Format::Yaml => Err("для YAML чтение значений по пути не поддержано".to_owned()),
    }
}

/// Записывает значение любого типа по пути. `replace == false`: существующий ключ — отказ (копирование не затирает).
pub fn put_value(
    format: Format,
    text: &str,
    path: &[String],
    value: &serde_json::Value,
    replace: bool,
) -> Result<String, String> {
    let (bom, body) = split_bom(text);
    let out = match format {
        Format::Json => put_json_text(
            body,
            path,
            &serde_json::to_string_pretty(value).map_err(|e| e.to_string())?,
            replace,
        )?,
        Format::Toml => {
            if !replace && get_value(Format::Toml, body, path)?.is_some() {
                return Err("такой ключ уже есть".to_owned());
            }
            set_toml(body, path, Leaf::Json(value))?
        }
        Format::Yaml => return Err("для YAML запись значений не поддержана".to_owned()),
    };
    Ok(format!("{bom}{out}"))
}

fn put_json_text(body: &str, path: &[String], raw: &str, replace: bool) -> Result<String, String> {
    with_json(body, path, |t, found| match found {
        Found::Value(_) if !replace => Err("такой ключ уже есть".to_owned()),
        Found::Value(v) => {
            let r = v.range();
            // многострочное значение встаёт с отступом строки, на которой начинается заменяемое
            let ind = line_indent(t, r.start);
            Ok(format!(
                "{}{}{}",
                &t[..r.start],
                reindent(&raw.replace("\r\n", "\n"), ind, "\n"),
                &t[r.end..]
            ))
        }
        Found::Missing { obj, depth } => insert_json(t, obj, &path[depth..], raw),
    })
}

/// Вставляет в JSON значение, уже записанное текстом (из [`cut_json`]): порядок ключей и форма сохраняются.
pub fn put_raw_json(
    text: &str,
    path: &[String],
    raw: &str,
    replace: bool,
) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(raw).map_err(|_| "значение не JSON".to_owned())?;
    let (bom, body) = split_bom(text);
    Ok(format!("{bom}{}", put_json_text(body, path, raw, replace)?))
}

/// Вырезает свойство из JSON и возвращает новый текст и значение (текст как в файле, отступы приведены к нулю).
/// Запятые соседей, остальные байты и CRLF не трогаются. Комментарии между свойствами и повтор ключа — отказ.
pub fn cut_json(text: &str, path: &[String]) -> Result<(String, String), String> {
    let (bom, body) = split_bom(text);
    let (key, parents) = path.split_last().ok_or_else(|| "пустой путь".to_owned())?;
    let parsed = parse_to_ast(body, &CollectOptions::default(), &ParseOptions::default())
        .map_err(|_| "не JSON".to_owned())?;
    let Some(Value::Object(root)) = parsed.value else {
        return Err("корень JSON не объект".to_owned());
    };
    let mut obj = &root;
    for k in parents {
        match find(obj, k).map(|p| &p.value) {
            Some(Value::Object(o)) => obj = o,
            _ => return Err("нет такого пути".to_owned()),
        }
    }
    let props = &obj.properties;
    let hits: Vec<usize> = (0..props.len())
        .filter(|i| name_of(&props[*i].name) == key)
        .collect();
    let [i] = hits[..] else {
        return Err(if hits.is_empty() {
            "нет такого ключа"
        } else {
            "ключ повторяется в файле"
        }
        .to_owned());
    };
    let p = &props[i];
    let (ps, pe) = (p.range.start, p.range.end);
    let junk = |s: &str| s.trim_matches([',', ' ', '\t', '\r', '\n']).is_empty();
    let (from, to) = if props.len() == 1 {
        let (os, oe) = (obj.range().start, obj.range().end);
        if !(junk(&body[os + 1..ps]) && junk(&body[pe..oe - 1])) {
            return Err("рядом с записью комментарий".to_owned());
        }
        (os + 1, oe - 1)
    } else if i + 1 < props.len() {
        let next = props[i + 1].range.start;
        if !junk(&body[pe..next]) {
            return Err("рядом с записью комментарий".to_owned());
        }
        (ps, next)
    } else {
        let prev = props[i - 1].range.end;
        if !junk(&body[prev..ps]) {
            return Err("рядом с записью комментарий".to_owned());
        }
        (prev, pe)
    };
    let vr = p.value.range();
    let indent = if body[..ps]
        .rsplit('\n')
        .next()
        .is_some_and(|l| l.trim().is_empty())
    {
        line_indent(body, ps)
    } else {
        ""
    };
    let raw = dedent(&body[vr.start..vr.end], indent);
    Ok((format!("{bom}{}{}", &body[..from], &body[to..]), raw))
}

/// Строки значения без общего отступа и с `\n` вместо `\r\n`.
fn dedent(raw: &str, indent: &str) -> String {
    raw.replace("\r\n", "\n")
        .split('\n')
        .enumerate()
        .map(|(i, l)| {
            if i == 0 {
                l
            } else {
                l.strip_prefix(indent).unwrap_or(l)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Обратное к [`dedent`]: продолжение значения получает отступ строки, на которой оно стоит.
fn reindent(raw: &str, indent: &str, nl: &str) -> String {
    raw.split('\n')
        .enumerate()
        .map(|(i, l)| {
            if i == 0 {
                l.to_owned()
            } else {
                format!("{indent}{l}")
            }
        })
        .collect::<Vec<_>>()
        .join(nl)
}

enum Found<'a, 'b> {
    /// Ключ есть, значение любого типа.
    Value(&'b Value<'a>),
    /// Ключа нет: `obj` — самый глубокий существующий объект, `depth` — сколько ключей пути в нём уже есть.
    Missing { obj: &'b Object<'a>, depth: usize },
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
            (Some(p), true) => return f(text, Found::Value(&p.value)),
            (Some(p), false) => match &p.value {
                Value::Object(o) => obj = o,
                _ => return Err("на пути лежит не объект".to_owned()),
            },
        }
    }
    unreachable!("путь не пуст, последний ключ возвращает результат")
}

/// Значение для новых ключей: `"k0": {"k1": <leaf>}` одной строкой или в несколько с отступом.
fn render(keys: &[String], leaf: &str, multiline: bool, indent: &str, nl: &str) -> String {
    let key = serde_json::to_string(&keys[0]).unwrap_or_default();
    if keys.len() == 1 {
        return format!(
            "{key}: {}",
            reindent(&leaf.replace("\r\n", "\n"), indent, nl)
        );
    }
    let inner = render(&keys[1..], leaf, multiline, &format!("{indent}  "), nl);
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
    leaf: &str,
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
            let prop = render(keys, leaf, multiline, indent, nl);
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
            let prop = render(keys, leaf, true, &indent, nl);
            Ok(format!(
                "{}{nl}{indent}{prop}{nl}{base}{}",
                &text[..=start],
                &text[end - 1..]
            ))
        }
    }
}

/// JSON → элемент TOML. Таблицы получают собственные заголовки; `null` и таблицы внутри массивов TOML не знает.
fn to_item(v: &serde_json::Value) -> Result<Item, String> {
    use serde_json::Value as J;
    Ok(match v {
        J::String(s) => toml_edit::value(s.as_str()),
        J::Bool(b) => toml_edit::value(*b),
        J::Number(n) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => toml_edit::value(i),
            (None, Some(f)) => toml_edit::value(f),
            _ => return Err("число не помещается в TOML".to_owned()),
        },
        J::Array(a) => {
            let mut arr = toml_edit::Array::new();
            for x in a {
                match to_item(x)? {
                    Item::Value(v) => arr.push(v),
                    _ => return Err("таблица внутри массива не переносится".to_owned()),
                }
            }
            Item::Value(toml_edit::Value::Array(arr))
        }
        J::Object(o) => {
            let mut t = toml_edit::Table::new();
            for (k, x) in o {
                t.insert(k, to_item(x)?);
            }
            Item::Table(t)
        }
        J::Null => return Err("null не переносится в TOML".to_owned()),
    })
}

fn set_toml(text: &str, path: &[String], leaf: Leaf<'_>) -> Result<String, String> {
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
    match (t.get_mut(last), leaf) {
        (Some(item), Leaf::Bool(b)) => {
            let v = item
                .as_value_mut()
                .filter(|v| v.is_bool())
                .ok_or_else(|| "значение не булево".to_owned())?;
            let decor = v.decor().clone(); // пробелы и комментарий в конце строки
            *v = toml_edit::Value::from(b);
            *v.decor_mut() = decor;
        }
        (None, Leaf::Bool(b)) => {
            t.insert(last, toml_edit::value(b));
        }
        (Some(item), Leaf::Json(j)) => {
            // Заменяем только значение (скаляр или массив) с его пробелами; таблицу целиком не перезаписываем.
            let new = to_item(j)?;
            match (item.as_value_mut(), new) {
                (Some(v), Item::Value(nv)) => {
                    let decor = v.decor().clone();
                    *v = nv;
                    *v.decor_mut() = decor;
                }
                _ => return Err("заменять таблицу целиком нельзя".to_owned()),
            }
        }
        (None, Leaf::Json(j)) => {
            t.insert(last, to_item(j)?);
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

    fn sem(s: &str) -> serde_json::Value {
        serde_json::from_str(s).unwrap_or_else(|e| panic!("не JSON: {e}\n{s}"))
    }

    const S: &str = "{\n  \"keep\": 1,\n  \"mcpServers\": {\n    \"a\": {\n      \"command\": \"x\",\n      \"args\": [\"-y\", \"p\"]\n    },\n    \"b\": {\"command\": \"y\"},\n    \"c\": {\"command\": \"z\", \"env\": {\"K\": \"FAKE-SECRET\"}}\n  }\n}\n";

    /// Убрал и вернул: значение равно исходному, остальной файл семантически тот же. Первая, средняя, последняя и единственная.
    #[test]
    fn json_cut_and_put_back_round_trips_for_every_position() {
        for name in ["a", "b", "c"] {
            let path = p(&["mcpServers", name]);
            let (cut, raw) = cut_json(S, &path).unwrap();
            assert!(valid(&cut), "{name}: {cut}");
            assert_eq!(get_value(Format::Json, &cut, &path).unwrap(), None);
            // остальные записи не тронуты
            for other in ["a", "b", "c"].iter().filter(|o| **o != name) {
                let q = p(&["mcpServers", other]);
                assert_eq!(
                    get_value(Format::Json, &cut, &q).unwrap(),
                    get_value(Format::Json, S, &q).unwrap()
                );
            }
            let back = put_value(Format::Json, &cut, &path, &sem(&raw), false).unwrap();
            assert!(valid(&back), "{name}: {back}");
            assert_eq!(sem(&back), sem(S), "{name}: после возврата значение то же");
        }
        // единственная запись
        let one = "{\n  \"mcpServers\": {\n    \"only\": {\"command\": \"q\"}\n  }\n}\n";
        let path = p(&["mcpServers", "only"]);
        let (cut, raw) = cut_json(one, &path).unwrap();
        assert_eq!(sem(&cut), sem("{\"mcpServers\": {}}"));
        let back = put_value(Format::Json, &cut, &path, &sem(&raw), false).unwrap();
        assert_eq!(sem(&back), sem(one));
    }

    #[test]
    fn json_cut_changes_only_the_cut_region_and_keeps_crlf() {
        let crlf = S.replace('\n', "\r\n");
        let (cut, _) = cut_json(&crlf, &p(&["mcpServers", "b"])).unwrap();
        assert!(
            !cut.replace("\r\n", "").contains('\n'),
            "переводы строк остались CRLF"
        );
        assert_eq!(
            middle(&crlf, &cut).1,
            "",
            "вырезано целиком, ничего не дописано"
        );
        assert!(cut.starts_with("{\r\n  \"keep\": 1"));
    }

    #[test]
    fn json_cut_refuses_comments_duplicates_and_missing() {
        let commented = "{\"m\": {\"a\": 1, /* заметка */ \"b\": 2}}";
        assert!(cut_json(commented, &p(&["m", "a"])).is_err());
        assert!(cut_json("{\"m\": {\"a\": 1, \"a\": 2}}", &p(&["m", "a"])).is_err());
        assert!(cut_json(S, &p(&["mcpServers", "zzz"])).is_err());
        assert!(cut_json(S, &p(&["nope", "a"])).is_err());
    }

    #[test]
    fn put_value_inserts_objects_into_json_and_toml_and_refuses_overwrite() {
        let v = serde_json::json!({"command": "npx", "args": ["-y", "pkg"], "env": {"K": "V"}});
        let out = put_value(Format::Json, S, &p(&["mcpServers", "d"]), &v, false).unwrap();
        assert_eq!(
            get_value(Format::Json, &out, &p(&["mcpServers", "d"])).unwrap(),
            Some(v.clone())
        );
        assert!(put_value(Format::Json, S, &p(&["mcpServers", "a"]), &v, false).is_err());
        let rep = put_value(Format::Json, S, &p(&["mcpServers", "a"]), &v, true).unwrap();
        assert_eq!(
            get_value(Format::Json, &rep, &p(&["mcpServers", "a"])).unwrap(),
            Some(v.clone())
        );

        let t = "# top\n[mcp_servers.old]\ncommand = \"o\"\n";
        let out = put_value(Format::Toml, t, &p(&["mcp_servers", "d"]), &v, false).unwrap();
        assert!(out.starts_with(t), "{out}");
        assert_eq!(
            get_value(Format::Toml, &out, &p(&["mcp_servers", "d"])).unwrap(),
            Some(v)
        );
        assert!(put_value(
            Format::Toml,
            t,
            &p(&["mcp_servers", "old"]),
            &serde_json::json!({}),
            false
        )
        .is_err());
        assert!(put_value(
            Format::Toml,
            t,
            &p(&["mcp_servers", "n"]),
            &serde_json::json!({"a": null}),
            false
        )
        .is_err());
    }

    #[test]
    fn put_value_replaces_command_and_args_in_toml_keeping_the_rest() {
        let t = "[mcp_servers.s]\ncommand = \"old\" # why\nargs = [\"a\"]\nenv = { K = \"FAKE-SECRET\" }\n";
        let c = p(&["mcp_servers", "s", "command"]);
        let out = put_value(Format::Toml, t, &c, &serde_json::json!("new"), true).unwrap();
        assert_eq!(middle(t, &out), ("old".into(), "new".into()));
        let a = p(&["mcp_servers", "s", "args"]);
        let out = put_value(
            Format::Toml,
            &out,
            &a,
            &serde_json::json!(["-x", "y"]),
            true,
        )
        .unwrap();
        assert!(
            out.contains("env = { K = \"FAKE-SECRET\" }") && out.contains("# why"),
            "{out}"
        );
    }

    const J: &str ="{\n  \"model\": \"x\", // keep\n  \"enabledPlugins\": {\n    \"a@m\": true,\n    \"b@m\": false\n  },\n  \"env\": {\"TOKEN\": \"FAKE-SECRET\"}\n}\n";

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
