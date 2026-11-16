//! `context-toolkit report`: per-day aggregates from Claude Code transcripts (`<profile>/projects/**/*.jsonl`).
//! Only counters leave this module: no prompts, paths or tool output.
//! shortcut: days are UTC (std has no time zone), so "today" can differ from local by a few hours; add a zone when a GUI needs it.
//!
//! Two phases keep the result deterministic while using several threads: workers parse files
//! into small row records in parallel, then one thread applies them in path order, so the first
//! copy of a row duplicated between files (resumed or forked sessions) always wins.
use crate::doctor::{lang_arg, profile_path};
use regex::Regex;
use serde::de::value::MapAccessDeserializer;
use serde::de::{Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{json, Value};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::fs::{self, File};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default)]
struct Day {
    /// sonnet, opus_fable, haiku, other
    main: [u64; 4],
    sub_turns: u64,
    tool_result: u64,
    read: u64,
    inspect: u64,
    build: u64,
    check: u64,
    check_calls: u64,
    read_blocked: u64,
    advisor: u64,
    agents: BTreeMap<String, u64>,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Read,
    Build,
    Inspect,
    Check,
    Other,
}

fn rx(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("static regex"))
}

fn classify(cmd: &str) -> Kind {
    static CHECK: OnceLock<Regex> = OnceLock::new();
    static BUILD: OnceLock<Regex> = OnceLock::new();
    static INSPECT: OnceLock<Regex> = OnceLock::new();
    if rx(&CHECK, r"\b(context-toolkit|ctxkit)(\.exe)?\s+check\b").is_match(cmd) {
        Kind::Check
    } else if rx(
        &BUILD,
        r"\b(cargo (test|build|check|clippy)|npm (test|run build)|tsc|pytest|go test|node --test)\b",
    )
    .is_match(cmd)
    {
        Kind::Build
    } else if rx(
        &INSPECT,
        r"(^|[;&|]\s*)(cat|head|tail|sed|nl|Get-Content|grep|rg|find)\b",
    )
    .is_match(cmd)
    {
        Kind::Inspect
    } else {
        Kind::Other
    }
}

/// Days since 1970-01-01 -> `YYYY-MM-DD` (Hinnant's civil_from_days).
fn day_string(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

fn valid_day(d: &str) -> bool {
    let b = d.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

fn model_slot(model: &str) -> usize {
    let m = model.to_ascii_lowercase();
    if m.contains("sonnet") {
        0
    } else if m.contains("opus") || m.contains("fable") {
        1
    } else if m.contains("haiku") {
        2
    } else {
        3
    }
}

// Typed, borrowing views of a transcript row: big subtrees stay unparsed (`RawValue`) or are
// skipped, which is several times faster than building a `serde_json::Value` per row.
// Every field is lenient: a value of an unexpected type reads as absent instead of failing the
// row, like the `Value`-based reader this replaced.
// shortcut: structural errors inside an object (duplicate keys, a lone `\ud83d` surrogate) still
// drop that row's blocks, as the old reader dropped the whole row; Claude Code writes neither
// duplicates nor, in practice, broken surrogates. Catch the error in `ObjV::visit_map` if it shows up.
type S<'a> = Option<Cow<'a, str>>;

macro_rules! skip_scalars {
    () => {
        fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
            Ok(Default::default())
        }
        fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
            Ok(Default::default())
        }
        fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
            Ok(Default::default())
        }
        fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
            Ok(Default::default())
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(Default::default())
        }
        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(Default::default())
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
            while a.next_element::<IgnoredAny>()?.is_some() {}
            Ok(Default::default())
        }
    };
}

struct StrV;

impl<'de> Visitor<'de> for StrV {
    type Value = S<'de>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_borrowed_str<E>(self, v: &'de str) -> Result<S<'de>, E> {
        Ok(Some(Cow::Borrowed(v)))
    }
    fn visit_str<E>(self, v: &str) -> Result<S<'de>, E> {
        Ok(Some(Cow::Owned(v.to_owned())))
    }
    fn visit_string<E>(self, v: String) -> Result<S<'de>, E> {
        Ok(Some(Cow::Owned(v)))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<S<'de>, A::Error> {
        while a.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(None)
    }
    skip_scalars!();
}

fn lenient_str<'de, D: Deserializer<'de>>(d: D) -> Result<S<'de>, D::Error> {
    d.deserialize_any(StrV)
}

struct BoolV;

impl<'de> Visitor<'de> for BoolV {
    type Value = Option<bool>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_bool<E>(self, v: bool) -> Result<Option<bool>, E> {
        Ok(Some(v))
    }
    fn visit_i64<E>(self, _: i64) -> Result<Option<bool>, E> {
        Ok(None)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Option<bool>, E> {
        Ok(None)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Option<bool>, E> {
        Ok(None)
    }
    fn visit_str<E>(self, _: &str) -> Result<Option<bool>, E> {
        Ok(None)
    }
    fn visit_unit<E>(self) -> Result<Option<bool>, E> {
        Ok(None)
    }
    fn visit_none<E>(self) -> Result<Option<bool>, E> {
        Ok(None)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Option<bool>, A::Error> {
        while a.next_element::<IgnoredAny>()?.is_some() {}
        Ok(None)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Option<bool>, A::Error> {
        while a.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(None)
    }
}

fn lenient_bool<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    d.deserialize_any(BoolV)
}

/// An object of type `T`, or `None` for any other JSON value.
struct ObjV<T>(PhantomData<T>);

impl<'de, T: Deserialize<'de>> Visitor<'de> for ObjV<T> {
    type Value = Option<T>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_map<A: MapAccess<'de>>(self, a: A) -> Result<Option<T>, A::Error> {
        T::deserialize(MapAccessDeserializer::new(a)).map(Some)
    }
    fn visit_str<E>(self, _: &str) -> Result<Option<T>, E> {
        Ok(None)
    }
    skip_scalars!();
}

fn lenient_obj<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    d.deserialize_any(ObjV(PhantomData))
}

/// A list element that is an object of type `T`; anything else reads as `None`.
struct Lenient<T>(Option<T>);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Lenient<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        lenient_obj(d).map(Lenient)
    }
}

#[derive(Deserialize)]
struct Row<'a> {
    #[serde(rename = "type", borrow, default, deserialize_with = "lenient_str")]
    kind: S<'a>,
    #[serde(borrow, default, deserialize_with = "lenient_str")]
    timestamp: S<'a>,
    #[serde(borrow, default, deserialize_with = "lenient_str")]
    uuid: S<'a>,
    #[serde(borrow, default, deserialize_with = "lenient_obj")]
    message: Option<Msg<'a>>,
}

#[derive(Deserialize)]
struct Msg<'a> {
    #[serde(borrow, default, deserialize_with = "lenient_str")]
    id: S<'a>,
    #[serde(borrow, default, deserialize_with = "lenient_str")]
    model: S<'a>,
    #[serde(borrow, default)]
    content: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct Block<'a> {
    #[serde(rename = "type", borrow, default, deserialize_with = "lenient_str")]
    kind: S<'a>,
    #[serde(borrow, default, deserialize_with = "lenient_str")]
    name: S<'a>,
    #[serde(borrow, default, deserialize_with = "lenient_str")]
    id: S<'a>,
    #[serde(borrow, default, deserialize_with = "lenient_str")]
    tool_use_id: S<'a>,
    #[serde(default, deserialize_with = "lenient_bool")]
    is_error: Option<bool>,
    #[serde(borrow, default)]
    input: Option<&'a RawValue>,
    #[serde(borrow, default)]
    content: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct Input<'a> {
    #[serde(borrow, default, deserialize_with = "lenient_str")]
    command: S<'a>,
    #[serde(borrow, default, deserialize_with = "lenient_str")]
    subagent_type: S<'a>,
}

#[derive(Deserialize)]
struct Part<'a> {
    #[serde(borrow, default, deserialize_with = "lenient_str")]
    text: S<'a>,
}

/// Text pieces of a `tool_result.content` (a string or a list of `{text}` parts).
fn result_texts(raw: Option<&RawValue>) -> Vec<Cow<'_, str>> {
    let Some(raw) = raw else { return Vec::new() };
    let s = raw.get().trim_start();
    if s.starts_with('"') {
        serde_json::from_str::<Cow<str>>(s).into_iter().collect()
    } else if s.starts_with('[') {
        serde_json::from_str::<Vec<Lenient<Part>>>(s)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.0?.text)
            .collect()
    } else {
        Vec::new()
    }
}

fn blocks(content: Option<&RawValue>) -> Vec<Block<'_>> {
    content
        .filter(|c| c.get().trim_start().starts_with('['))
        .and_then(|c| serde_json::from_str::<Vec<Lenient<Block>>>(c.get()).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|b| b.0)
        .collect()
}

/// `subagent_type` is written by the model: keep only name-like keys so no free text leaves the module.
fn safe_key(s: &str) -> String {
    let ok = s.len() <= 64
        && !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.' | '(' | ')'));
    if ok { s } else { "(other)" }.to_string()
}

fn hash(s: &str) -> u64 {
    let mut h = DefaultHasher::new(); // fixed keys: same hash in every run
    s.hash(&mut h);
    h.finish()
}

/// What one transcript row contributes; ids are hashed to keep a day of rows small.
enum Ev {
    /// `slot` 0..=3 is a main-session model class, 4 is a subagent turn.
    Turn {
        msg: Option<u64>,
        slot: usize,
    },
    Use {
        id: Option<u64>,
        kind: Kind,
        agent: Option<String>,
    },
    Advisor,
    Result {
        use_id: Option<u64>,
        len: u64,
        blocked: bool,
    },
}

struct Rec {
    uuid: Option<u64>,
    date: [u8; 10],
    ev: Vec<Ev>,
}

fn parse_file(path: &Path, is_sub: bool, cutoff: &str) -> Vec<Rec> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in BufReader::new(file).split(b'\n').map_while(Result::ok) {
        let line = String::from_utf8_lossy(&line);
        let line = line.trim_start_matches('\u{feff}');
        // Cheap skip before the full JSON parse (transcripts reach hundreds of MB): only when
        // every `"timestamp":"` in the line is old, so a nested field cannot hide a new row.
        let mut stamps = line.match_indices("\"timestamp\":\"").peekable();
        if stamps.peek().is_some()
            && stamps.all(|(p, _)| line.get(p + 13..p + 23).is_some_and(|d| d < cutoff))
        {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Row>(line) else {
            continue;
        };
        let Some(date) = row
            .timestamp
            .as_deref()
            .and_then(|t| t.get(..10))
            .filter(|d| valid_day(d) && *d >= cutoff)
        else {
            continue;
        };
        let mut rec = Rec {
            uuid: row.uuid.as_deref().map(hash),
            date: date.as_bytes().try_into().unwrap_or([b'0'; 10]),
            ev: Vec::new(),
        };
        if let Some(msg) = row.message {
            match row.kind.as_deref() {
                Some("assistant") => {
                    let slot = if is_sub {
                        4
                    } else {
                        model_slot(msg.model.as_deref().unwrap_or(""))
                    };
                    rec.ev.push(Ev::Turn {
                        msg: msg.id.as_deref().map(hash),
                        slot,
                    });
                    for b in blocks(msg.content) {
                        match b.kind.as_deref() {
                            Some("tool_use") => {
                                let name = b.name.as_deref().unwrap_or("");
                                let input = || {
                                    b.input
                                        .and_then(|r| serde_json::from_str::<Input>(r.get()).ok())
                                };
                                let kind = match name {
                                    "Read" => Kind::Read,
                                    "Bash" | "PowerShell" => classify(
                                        input().and_then(|i| i.command).as_deref().unwrap_or(""),
                                    ),
                                    _ => Kind::Other,
                                };
                                let agent =
                                    (!is_sub && matches!(name, "Agent" | "Task")).then(|| {
                                        let t = input().and_then(|i| i.subagent_type);
                                        safe_key(t.as_deref().unwrap_or("(general-purpose)"))
                                    });
                                rec.ev.push(Ev::Use {
                                    id: b.id.as_deref().map(hash),
                                    kind,
                                    agent,
                                });
                            }
                            Some("server_tool_use")
                                if !is_sub && b.name.as_deref() == Some("advisor") =>
                            {
                                rec.ev.push(Ev::Advisor)
                            }
                            _ => {}
                        }
                    }
                }
                Some("user") if !is_sub => {
                    for b in blocks(msg.content) {
                        if b.kind.as_deref() != Some("tool_result") {
                            continue;
                        }
                        let texts = result_texts(b.content);
                        rec.ev.push(Ev::Result {
                            use_id: b.tool_use_id.as_deref().map(hash),
                            len: texts.iter().map(|t| t.len() as u64).sum(),
                            blocked: b.is_error == Some(true)
                                && texts.iter().any(|t| t.contains("hook error")),
                        });
                    }
                }
                _ => {}
            }
        }
        out.push(rec);
    }
    out
}

/// Dedup state shared by all files of one run.
#[derive(Default)]
struct Seen {
    rows: HashSet<u64>,
    msgs: HashSet<u64>,
    uses: HashMap<u64, Kind>,
}

fn apply(recs: Vec<Rec>, seen: &mut Seen, days: &mut BTreeMap<String, Day>) {
    for r in recs {
        if r.uuid.is_some_and(|u| !seen.rows.insert(u)) {
            continue;
        }
        let day = days
            .entry(String::from_utf8_lossy(&r.date).into_owned())
            .or_default();
        for e in r.ev {
            match e {
                // A message may be split over several rows: count the turn once.
                Ev::Turn { msg, slot } => {
                    if msg.is_none_or(|m| seen.msgs.insert(m)) {
                        match slot {
                            4 => day.sub_turns += 1,
                            s => day.main[s] += 1,
                        }
                    }
                }
                Ev::Use { id, kind, agent } => {
                    if kind == Kind::Check {
                        day.check_calls += 1;
                    }
                    if let Some(a) = agent {
                        *day.agents.entry(a).or_default() += 1;
                    }
                    if let Some(id) = id {
                        seen.uses.insert(id, kind);
                    }
                }
                Ev::Advisor => day.advisor += 1,
                Ev::Result {
                    use_id,
                    len,
                    blocked,
                } => {
                    day.tool_result += len;
                    match use_id.and_then(|u| seen.uses.get(&u).copied()) {
                        Some(Kind::Read) => {
                            day.read += len;
                            day.read_blocked += u64::from(blocked);
                        }
                        Some(Kind::Build) => day.build += len,
                        Some(Kind::Inspect) => day.inspect += len,
                        Some(Kind::Check) => day.check += len,
                        _ => {}
                    }
                }
            }
        }
    }
}

fn collect(dir: &Path, since: SystemTime, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(&p, since, out);
        } else if p.extension().is_some_and(|x| x == "jsonl")
            && e.metadata()
                .and_then(|m| m.modified())
                .is_ok_and(|m| m >= since)
        {
            out.push(p);
        }
    }
}

pub fn build(projects: &Path, days_back: u64, now_secs: u64) -> BTreeMap<String, Value> {
    let cutoff = day_string((now_secs / 86_400) as i64 - days_back as i64 + 1);
    let since =
        UNIX_EPOCH + std::time::Duration::from_secs(now_secs.saturating_sub(days_back * 86_400));
    let mut files = Vec::new();
    collect(projects, since, &mut files);
    files.sort(); // apply order: the first copy of a duplicated row wins, in every run
                  // Parse the biggest files first so the workers finish together.
    let mut order: Vec<usize> = (0..files.len()).collect();
    order
        .sort_by_cached_key(|&i| std::cmp::Reverse(fs::metadata(&files[i]).map_or(0, |m| m.len())));
    let next = AtomicUsize::new(0);
    let workers = thread::available_parallelism()
        .map_or(2, |n| n.get())
        .min(4);
    let parsed: Vec<Vec<(usize, Vec<Rec>)>> = thread::scope(|s| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                s.spawn(|| {
                    let mut mine = Vec::new();
                    while let Some(&i) = order.get(next.fetch_add(1, Ordering::Relaxed)) {
                        let rel = files[i].strip_prefix(projects).unwrap_or(&files[i]);
                        let sub = rel.components().any(|c| c.as_os_str() == "subagents");
                        mine.push((i, parse_file(&files[i], sub, &cutoff)));
                    }
                    mine
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|e| std::panic::resume_unwind(e)))
            .collect()
    });
    let mut slots: Vec<Vec<Rec>> = files.iter().map(|_| Vec::new()).collect();
    for (i, recs) in parsed.into_iter().flatten() {
        slots[i] = recs;
    }
    let (mut seen, mut days) = (Seen::default(), BTreeMap::new());
    for recs in slots {
        apply(recs, &mut seen, &mut days);
    }
    days.into_iter()
        .map(|(date, d)| {
            let v = json!({
                "main_turns": {"sonnet": d.main[0], "opus_fable": d.main[1], "haiku": d.main[2], "other": d.main[3]},
                "sub_turns": d.sub_turns,
                "tool_result_chars": d.tool_result,
                "read_chars": d.read,
                "shell_inspect_chars": d.inspect,
                "build_chars": d.build,
                "check_chars": d.check,
                "check_calls": d.check_calls,
                "read_blocked": d.read_blocked,
                "advisor_calls": d.advisor,
                "agent_calls": d.agents,
            });
            (date, v)
        })
        .collect()
}

pub fn run_report(args: &[String]) -> i32 {
    let (mut json_out, mut custom, mut days_back) = (false, None, 14u64);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json_out = true,
            flag @ ("--profile" | "--days") => {
                let Some(v) = args.get(i + 1) else {
                    eprintln!("ERR: missing value for {flag}");
                    return 2;
                };
                if flag == "--profile" {
                    custom = Some(PathBuf::from(v));
                } else {
                    match v.parse::<u64>() {
                        Ok(n) if (1..=365).contains(&n) => days_back = n,
                        _ => {
                            eprintln!("ERR: --days must be 1..365");
                            return 2;
                        }
                    }
                }
                i += 1;
            }
            "--help" | "-h" => {
                println!("Usage: context-toolkit report [--json] [--days N] [--profile <dir>]");
                return 0;
            }
            a if a == "--lang" || a.starts_with("--lang=") => match lang_arg(args, i) {
                Some(skip) => i += skip,
                None => {
                    eprintln!("ERR: --lang needs a value: en or ru");
                    return 2;
                }
            },
            other => {
                eprintln!("ERR: unknown option '{other}'. Usage: context-toolkit report [--json] [--days N] [--profile <dir>]");
                return 2;
            }
        }
        i += 1;
    }
    let Some(profile) = profile_path(custom) else {
        eprintln!("ERR: cannot determine USERPROFILE / HOME directory");
        return 1;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let days = build(&profile.join("projects"), days_back, now);
    if json_out {
        println!(
            "{}",
            json!({"schema": 1, "tool": "context-toolkit", "tz": "UTC", "days": days})
        );
    } else {
        println!("day         main(son/opus+fable/haiku)  sub  tool_result  read  inspect  build  check(calls)  adv  agents");
        for (date, v) in &days {
            let m = &v["main_turns"];
            let agents: Vec<String> = v["agent_calls"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, n)| format!("{k}={n}"))
                .collect();
            println!(
                "{date}  {}/{}/{}  {}  {}  {}  {}  {}  {}({})  {}  {}",
                m["sonnet"],
                m["opus_fable"],
                m["haiku"],
                v["sub_turns"],
                v["tool_result_chars"],
                v["read_chars"],
                v["shell_inspect_chars"],
                v["build_chars"],
                v["check_chars"],
                v["check_calls"],
                v["advisor_calls"],
                agents.join(",")
            );
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 20_772 * 86_400 + 12 * 3600; // 2026-11-15 12:00 UTC

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("p").join("subagents")).unwrap();
        d
    }

    #[test]
    fn civil_dates() {
        assert_eq!(day_string(0), "1970-01-01");
        assert_eq!(day_string(19_723), "2024-01-01");
        assert_eq!(day_string(19_723 + 59), "2024-02-29");
        assert_eq!(day_string(20_772), "2026-11-15");
    }

    #[test]
    fn copied_rows_nested_timestamps_bom_and_free_text_keys() {
        let dir = temp("ctxkit_report_dup");
        let row = r#"{"type":"assistant","uuid":"u1","timestamp":"2026-11-15T10:00:00Z","toolUseResult":{"timestamp":"2001-01-01T00:00:00Z"},"message":{"id":"m1","model":"claude-sonnet-5-5","content":[{"type":"tool_use","id":"t1","name":"Agent","input":{"subagent_type":"secret path C:\\x"}}]}}"#;
        // a resumed session copies the row into another file; the second file starts with a BOM
        fs::write(dir.join("p").join("a.jsonl"), row).unwrap();
        fs::write(dir.join("p").join("b.jsonl"), format!("\u{feff}{row}")).unwrap();
        let r = build(&dir, 3, NOW);
        let d = &r["2026-11-15"];
        assert_eq!(d["main_turns"]["sonnet"], 1, "{d}");
        assert_eq!(d["agent_calls"]["(other)"], 1);
        assert!(!d.to_string().contains("secret"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copies_between_files_give_the_same_result_in_every_run() {
        let dir = temp("ctxkit_report_det");
        let mut text = String::new();
        for i in 0..300 {
            text += &format!(
                "{{\"type\":\"assistant\",\"uuid\":\"a{i}\",\"timestamp\":\"2026-11-15T10:00:00Z\",\"message\":{{\"id\":\"m{i}\",\"model\":\"claude-sonnet-5-5\",\"content\":[{{\"type\":\"tool_use\",\"id\":\"t{i}\",\"name\":\"Bash\",\"input\":{{\"command\":\"cat x\"}}}}]}}}}\n\
                 {{\"type\":\"user\",\"uuid\":\"u{i}\",\"timestamp\":\"2026-11-15T10:00:01Z\",\"message\":{{\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"t{i}\",\"content\":\"0123456789\"}}]}}}}\n"
            );
        }
        // the same session: a file, its resumed copy and a copy under subagents/
        for name in ["a.jsonl", "b.jsonl", "c.jsonl"] {
            fs::write(dir.join("p").join(name), &text).unwrap();
        }
        fs::write(dir.join("p").join("subagents").join("d.jsonl"), &text).unwrap();
        let first = build(&dir, 3, NOW);
        let d = &first["2026-11-15"];
        assert_eq!(d["main_turns"]["sonnet"], 300, "{d}");
        assert_eq!(d["shell_inspect_chars"], 3000);
        for _ in 0..20 {
            assert_eq!(build(&dir, 3, NOW), first);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn values_of_unexpected_types_do_not_lose_the_row() {
        let dir = temp("ctxkit_report_lenient");
        let rows = [
            // odd types in fields: the second block must still be read
            r#"{"type":"assistant","uuid":5,"timestamp":"2026-11-15T10:00:00Z","message":{"id":7,"model":null,"content":[{"type":"tool_use","id":"t1","name":5,"input":"x"},{"type":"tool_use","id":"t2","name":"Read","input":{}},"junk"]}}"#,
            r#"{"type":"user","timestamp":"2026-11-15T10:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"t2","is_error":"yes","content":[{"type":"text","text":5},"x",{"type":"text","text":"abc"}]}]}}"#,
            // message as a string, a numeric type: ignored without breaking neighbours
            r#"{"type":"assistant","timestamp":"2026-11-15T10:00:02Z","message":"text"}"#,
            r#"{"type":9,"timestamp":"2026-11-15T10:00:03Z","message":{"content":[]}}"#,
            // not a date: no day key
            r#"{"type":"assistant","timestamp":"ЖЖЖЖЖЖЖЖЖЖ","message":{"id":"z","content":[]}}"#,
        ];
        fs::write(dir.join("p").join("a.jsonl"), rows.join("\n")).unwrap();
        let r = build(&dir, 3, NOW);
        assert_eq!(r.len(), 1, "{r:?}");
        let d = &r["2026-11-15"];
        assert_eq!(d["main_turns"]["other"], 1, "{d}");
        assert_eq!(d["read_chars"], 3, "{d}");
        assert_eq!(d["read_blocked"], 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn classifies_commands() {
        assert!(
            classify("ctxkit check cargo test") == Kind::Check,
            "the old name in old transcripts"
        );
        assert!(classify("context-toolkit check cargo test") == Kind::Check);
        assert!(classify("C:/u/.local/bin/context-toolkit.exe check npm test") == Kind::Check);
        assert!(classify("cargo test --release") == Kind::Build);
        assert!(classify("cat a.txt | head") == Kind::Inspect);
        assert!(classify("git status") == Kind::Other);
    }

    #[test]
    fn aggregates_a_transcript_once_per_message_and_skips_old_rows() {
        let dir = temp("ctxkit_report_test");
        let rows = [
            r#"{"type":"assistant","timestamp":"2026-11-15T10:00:00Z","message":{"id":"m1","model":"claude-sonnet-5-5","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ctxkit check cargo test"}}]}}"#,
            // second row of the same message: not a new turn
            r#"{"type":"assistant","timestamp":"2026-11-15T10:00:00Z","message":{"id":"m1","model":"claude-sonnet-5-5","content":[{"type":"tool_use","id":"t2","name":"Agent","input":{"subagent_type":"checker"}},{"type":"server_tool_use","name":"advisor"}]}}"#,
            r#"{"type":"user","timestamp":"2026-11-15T10:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"OK (12 ms)"}]}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-01T10:00:00Z","message":{"id":"old","model":"claude-opus-5-5","content":[]}}"#,
        ];
        fs::write(dir.join("p").join("a.jsonl"), rows.join("\n")).unwrap();
        fs::write(
            dir.join("p").join("subagents").join("b.jsonl"),
            r#"{"type":"assistant","timestamp":"2026-11-15T11:00:00Z","message":{"id":"s1","model":"claude-opus-5-5","content":[]}}"#,
        )
        .unwrap();
        let r = build(&dir, 3, NOW);
        assert_eq!(r.len(), 1, "old row must be skipped: {r:?}");
        let d = &r["2026-11-15"];
        assert_eq!(d["main_turns"]["sonnet"], 1);
        assert_eq!(d["main_turns"]["opus_fable"], 0);
        assert_eq!(d["sub_turns"], 1);
        assert_eq!(d["check_calls"], 1);
        assert_eq!(d["check_chars"], 10);
        assert_eq!(d["advisor_calls"], 1);
        assert_eq!(d["agent_calls"]["checker"], 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
