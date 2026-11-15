//! `ctxkit report`: per-day aggregates from Claude Code transcripts (`<profile>/projects/**/*.jsonl`).
//! Only counters leave this module: no prompts, paths or tool output.
//! shortcut: days are UTC (std has no time zone), so "today" can differ from local by a few hours; add a zone when a GUI needs it.
use crate::doctor::{lang_arg, profile_path};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
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
    if rx(&CHECK, r"\bctxkit(\.exe)?\s+check\b").is_match(cmd) {
        Kind::Check
    } else if rx(
        &BUILD,
        r"\b(cargo (test|build|check|clippy)|npm (test|run build)|tsc|pytest|go test|node --test)\b",
    )
    .is_match(cmd)
    {
        Kind::Build
    } else if rx(&INSPECT, r"(^|[;&|]\s*)(cat|head|tail|sed|nl|Get-Content|grep|rg|find)\b")
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

fn result_len(block: &Value) -> u64 {
    match &block["content"] {
        Value::String(s) => s.len() as u64,
        Value::Array(a) => a
            .iter()
            .map(|x| x["text"].as_str().map_or(0, str::len) as u64)
            .sum(),
        _ => 0,
    }
}

fn result_has(block: &Value, needle: &str) -> bool {
    match &block["content"] {
        Value::String(s) => s.contains(needle),
        Value::Array(a) => a
            .iter()
            .any(|x| x["text"].as_str().is_some_and(|t| t.contains(needle))),
        _ => false,
    }
}

/// State shared by all files of one run: resumed or forked sessions copy rows into new files.
#[derive(Default)]
struct Seen {
    rows: HashSet<String>,
    msgs: HashSet<String>,
    uses: HashMap<String, Kind>,
}

/// `subagent_type` is written by the model: keep only name-like keys so no free text leaves the module.
fn safe_key(s: &str) -> String {
    let ok = s.len() <= 64
        && !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.' | '(' | ')'));
    if ok { s } else { "(other)" }.to_string()
}

fn scan_file(
    path: &Path,
    is_sub: bool,
    cutoff: &str,
    days: &mut BTreeMap<String, Day>,
    seen: &mut Seen,
) {
    let Ok(file) = File::open(path) else { return };
    for line in BufReader::new(file).split(b'\n').map_while(Result::ok) {
        let line = String::from_utf8_lossy(&line);
        let line = line.trim_start_matches('\u{feff}');
        // Cheap skip before the full JSON parse (transcripts reach tens of MB): only when
        // every `"timestamp":"` in the line is old, so a nested field cannot hide a new row.
        let mut stamps = line.match_indices("\"timestamp\":\"").peekable();
        if stamps.peek().is_some()
            && stamps.all(|(p, _)| line.get(p + 13..p + 23).is_some_and(|d| d < cutoff))
        {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(date) = row["timestamp"].as_str().and_then(|t| t.get(..10)) else {
            continue;
        };
        if date < cutoff {
            continue;
        }
        if row["uuid"]
            .as_str()
            .is_some_and(|u| !seen.rows.insert(u.to_string()))
        {
            continue;
        }
        let day = days.entry(date.to_string()).or_default();
        match row["type"].as_str() {
            Some("assistant") => {
                let msg = &row["message"];
                // A message may be split over several rows: count the turn once.
                let first = msg["id"]
                    .as_str()
                    .is_none_or(|id| seen.msgs.insert(id.to_string()));
                if first {
                    if is_sub {
                        day.sub_turns += 1;
                    } else {
                        day.main[model_slot(msg["model"].as_str().unwrap_or(""))] += 1;
                    }
                }
                for b in msg["content"].as_array().into_iter().flatten() {
                    match b["type"].as_str() {
                        Some("tool_use") => {
                            let name = b["name"].as_str().unwrap_or("");
                            let kind = match name {
                                "Read" => Kind::Read,
                                "Bash" | "PowerShell" => {
                                    classify(b["input"]["command"].as_str().unwrap_or(""))
                                }
                                _ => Kind::Other,
                            };
                            if kind == Kind::Check {
                                day.check_calls += 1;
                            }
                            if !is_sub && matches!(name, "Agent" | "Task") {
                                let t = b["input"]["subagent_type"]
                                    .as_str()
                                    .unwrap_or("(general-purpose)");
                                *day.agents.entry(safe_key(t)).or_default() += 1;
                            }
                            if let Some(id) = b["id"].as_str() {
                                seen.uses.insert(id.to_string(), kind);
                            }
                        }
                        Some("server_tool_use") if !is_sub && b["name"] == "advisor" => {
                            day.advisor += 1
                        }
                        _ => {}
                    }
                }
            }
            Some("user") if !is_sub => {
                for b in row["message"]["content"].as_array().into_iter().flatten() {
                    if b["type"] != "tool_result" {
                        continue;
                    }
                    let len = result_len(b);
                    day.tool_result += len;
                    match b["tool_use_id"].as_str().and_then(|id| seen.uses.get(id)) {
                        Some(Kind::Read) => {
                            day.read += len;
                            if b["is_error"] == true && result_has(b, "hook error") {
                                day.read_blocked += 1;
                            }
                        }
                        Some(Kind::Build) => day.build += len,
                        Some(Kind::Inspect) => day.inspect += len,
                        Some(Kind::Check) => day.check += len,
                        _ => {}
                    }
                }
            }
            _ => {}
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
    let mut days: BTreeMap<String, Day> = BTreeMap::new();
    files.sort(); // deterministic order: the first copy of a duplicated row wins
    let mut seen = Seen::default();
    for p in &files {
        let rel = p.strip_prefix(projects).unwrap_or(p);
        let sub = rel.components().any(|c| c.as_os_str() == "subagents");
        scan_file(p, sub, &cutoff, &mut days, &mut seen);
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
                println!("Usage: ctxkit report [--json] [--days N] [--profile <dir>]");
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
                eprintln!("ERR: unknown option '{other}'. Usage: ctxkit report [--json] [--days N] [--profile <dir>]");
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
            json!({"schema": 1, "tool": "ctxkit", "tz": "UTC", "days": days})
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

    #[test]
    fn civil_dates() {
        assert_eq!(day_string(0), "1970-01-01");
        assert_eq!(day_string(19_723), "2024-01-01");
        assert_eq!(day_string(19_723 + 59), "2024-02-29");
    }

    #[test]
    fn copied_rows_nested_timestamps_bom_and_free_text_keys() {
        let dir = std::env::temp_dir().join("ctxkit_report_dup");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("p")).unwrap();
        let row = r#"{"type":"assistant","uuid":"u1","timestamp":"2026-11-15T10:00:00Z","toolUseResult":{"timestamp":"2001-01-01T00:00:00Z"},"message":{"id":"m1","model":"claude-sonnet-5-5","content":[{"type":"tool_use","id":"t1","name":"Agent","input":{"subagent_type":"secret path C:\\x"}}]}}"#;
        // a resumed session copies the row into another file; the second file starts with a BOM
        fs::write(dir.join("p").join("a.jsonl"), row).unwrap();
        fs::write(dir.join("p").join("b.jsonl"), format!("\u{feff}{row}")).unwrap();
        let r = build(&dir, 3, 20_772 * 86_400 + 12 * 3600);
        let d = &r["2026-11-15"];
        assert_eq!(d["main_turns"]["sonnet"], 1, "{d}");
        assert_eq!(d["agent_calls"]["(other)"], 1);
        assert!(!d.to_string().contains("secret"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn classifies_commands() {
        assert!(classify("ctxkit check cargo test") == Kind::Check);
        assert!(classify("cargo test --release") == Kind::Build);
        assert!(classify("cat a.txt | head") == Kind::Inspect);
        assert!(classify("git status") == Kind::Other);
    }

    #[test]
    fn aggregates_a_transcript_once_per_message_and_skips_old_rows() {
        let dir = std::env::temp_dir().join("ctxkit_report_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("proj").join("subagents")).unwrap();
        let rows = [
            r#"{"type":"assistant","timestamp":"2026-11-15T10:00:00Z","message":{"id":"m1","model":"claude-sonnet-5-5","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ctxkit check cargo test"}}]}}"#,
            // second row of the same message: not a new turn
            r#"{"type":"assistant","timestamp":"2026-11-15T10:00:00Z","message":{"id":"m1","model":"claude-sonnet-5-5","content":[{"type":"tool_use","id":"t2","name":"Agent","input":{"subagent_type":"checker"}},{"type":"server_tool_use","name":"advisor"}]}}"#,
            r#"{"type":"user","timestamp":"2026-11-15T10:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"OK (12 ms)"}]}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-01T10:00:00Z","message":{"id":"old","model":"claude-opus-5-5","content":[]}}"#,
        ];
        fs::write(dir.join("proj").join("a.jsonl"), rows.join("\n")).unwrap();
        fs::write(
            dir.join("proj").join("subagents").join("b.jsonl"),
            r#"{"type":"assistant","timestamp":"2026-11-15T11:00:00Z","message":{"id":"s1","model":"claude-opus-5-5","content":[]}}"#,
        )
        .unwrap();
        // 2026-11-15 12:00 UTC
        let now = 20_772 * 86_400 + 12 * 3600;
        assert_eq!(day_string(20_772), "2026-11-15");
        let r = build(&dir, 3, now);
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
