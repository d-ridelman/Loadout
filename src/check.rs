use serde_json::Value;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

const MAX_ERRORS: usize = 3;
const MAX_LINES: usize = 30;

pub fn run_check(args: &[String]) -> i32 {
    if args.is_empty() {
        eprintln!("Usage: ctxkit check <command...>");
        return 2;
    }

    let start = Instant::now();
    let is_cargo = is_cargo_diagnostic(args);
    let mut final_args: Vec<String> = args.to_vec();
    if is_cargo && !final_args.iter().any(|a| a.starts_with("--message-format")) {
        // Inject JSON diagnostics after `cargo <subcmd>`
        let insert_at = if final_args.len() >= 2 { 2 } else { 1 };
        final_args.insert(insert_at, "--message-format=json".to_string());
        if !final_args.iter().any(|a| a == "--quiet" || a == "-q") {
            final_args.insert(insert_at + 1, "--quiet".to_string());
        }
    }

    let output = if cfg!(windows) && !is_direct_exe(&final_args[0]) {
        Command::new("cmd.exe")
            .arg("/d")
            .arg("/c")
            .args(&final_args)
            .output()
    } else {
        Command::new(&final_args[0]).args(&final_args[1..]).output()
    };

    let out = match output {
        Ok(o) => o,
        Err(e) => {
            eprintln!("ERR: failed to start `{}`: {e}", final_args[0]);
            return 1;
        }
    };

    let elapsed_ms = start.elapsed().as_millis();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let code = out.status.code().unwrap_or(1);

    if out.status.success() {
        if let Some(summary) = extract_pass_summary(&stdout, &stderr) {
            println!("OK ({elapsed_ms} ms): {summary}");
        } else {
            println!("OK ({elapsed_ms} ms)");
        }
        return 0;
    }

    if is_cargo {
        let diags = parse_cargo_json(&stdout);
        if !diags.is_empty() {
            println!("FAIL exit={code} ({elapsed_ms} ms), top {} errors:", diags.len().min(MAX_ERRORS));
            for (i, d) in diags.iter().take(MAX_ERRORS).enumerate() {
                println!("[{}] {}", i + 1, d);
            }
            if diags.len() > MAX_ERRORS {
                if let Some(log_path) = save_log(&stdout, &stderr) {
                    println!("... +{} errors (full log: {})", diags.len() - MAX_ERRORS, log_path.display());
                } else {
                    println!("... +{} more errors", diags.len() - MAX_ERRORS);
                }
            }
            return code;
        }
    }

    let combined = if stderr.trim().is_empty() {
        stdout.to_string()
    } else if stdout.trim().is_empty() {
        stderr.to_string()
    } else {
        format!("{stdout}\n{stderr}")
    };

    let lines: Vec<&str> = combined.lines().collect();
    let compact = compact_error_lines(&lines);
    println!("FAIL exit={code} ({elapsed_ms} ms):");
    for l in &compact {
        println!("{l}");
    }
    if lines.len() > compact.len() {
        if let Some(log_path) = save_log(&stdout, &stderr) {
            println!("... ({} lines total; full log: {})", lines.len(), log_path.display());
        }
    }
    code
}

fn is_direct_exe(bin: &str) -> bool {
    matches!(bin, "cargo" | "rustc" | "node" | "python" | "git")
}

fn is_cargo_diagnostic(args: &[String]) -> bool {
    args.len() >= 2
        && (args[0] == "cargo" || args[0].ends_with("cargo.exe"))
        && matches!(args[1].as_str(), "check" | "clippy" | "build")
}

fn parse_cargo_json(stdout: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in stdout.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["reason"] != "compiler-message" {
            continue;
        }
        let msg = &v["message"];
        if msg["level"] != "error" {
            continue;
        }
        let text = msg["message"].as_str().unwrap_or("").trim();
        if text.is_empty() || text.starts_with("aborting due to") || text.starts_with("could not compile") {
            continue;
        }
        let span = msg["spans"]
            .as_array()
            .and_then(|arr| arr.iter().find(|s| s["is_primary"] == true).or_else(|| arr.first()));
        let loc = match span {
            Some(s) => format!(
                "{}:{}:{}",
                s["file_name"].as_str().unwrap_or("?"),
                s["line_start"].as_u64().unwrap_or(0),
                s["column_start"].as_u64().unwrap_or(0)
            ),
            None => "unknown".to_string(),
        };
        let label = span
            .and_then(|s| s["label"].as_str())
            .map(str::trim)
            .filter(|l| !l.is_empty());
        let code = msg["code"]["code"].as_str().unwrap_or("");
        let mut entry = if code.is_empty() {
            format!("{loc} — {text}")
        } else {
            format!("{loc} [{code}] — {text}")
        };
        if let Some(l) = label {
            if !text.contains(l) {
                entry.push_str(&format!(" ({l})"));
            }
        }
        if seen.insert(entry.clone()) {
            out.push(entry);
        }
    }
    out
}

fn extract_pass_summary(stdout: &str, stderr: &str) -> Option<String> {
    let mut parts = Vec::new();
    for line in stdout.lines().chain(stderr.lines()) {
        let t = line.trim();
        if t.starts_with("test result: ok.")
            || t.starts_with("ℹ pass ")
            || t.starts_with("ALL PASS")
            || t.contains("passed") && t.len() < 100
        {
            parts.push(t.to_string());
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.into_iter().rev().take(2).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | "))
    }
}

fn compact_error_lines(lines: &[&str]) -> Vec<String> {
    let mut picked = Vec::new();
    let mut seen = HashSet::new();
    for (i, line) in lines.iter().enumerate() {
        let lower = line.to_ascii_lowercase();
        let hit = lower.contains("error")
            || lower.contains("fail")
            || lower.contains("not ok")
            || line.trim_start().starts_with('✖')
            || line.trim_start().starts_with("FAIL ");
        if hit {
            let start = i;
            let end = (i + 3).min(lines.len());
            for l in &lines[start..end] {
                let s = l.trim_end();
                if !s.is_empty() && seen.insert(s.to_string()) {
                    picked.push(s.to_string());
                    if picked.len() >= MAX_LINES {
                        return picked;
                    }
                }
            }
        }
    }
    if picked.is_empty() {
        let skip = lines.len().saturating_sub(MAX_LINES);
        return lines[skip..].iter().map(|s| (*s).to_string()).collect();
    }
    picked
}

fn save_log(stdout: &str, stderr: &str) -> Option<PathBuf> {
    let base = env::var_os("TEMP")
        .or_else(|| env::var_os("TMP"))
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    let _ = fs::create_dir_all(&base);
    let path = base.join("last-check.log");
    let body = format!("=== STDOUT ===\n{stdout}\n=== STDERR ===\n{stderr}\n");
    fs::write(&path, body).ok()?;
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cargo_json_dedup_and_drops_aborting_noise() {
        let sample = concat!(
            "{\"reason\":\"compiler-message\",\"message\":{\"level\":\"error\",\"code\":{\"code\":\"E0308\"},\"message\":\"mismatched types\",\"spans\":[{\"file_name\":\"src/main.rs\",\"line_start\":12,\"column_start\":5,\"is_primary\":true,\"label\":\"expected u32\"}]}}\n",
            "{\"reason\":\"compiler-message\",\"message\":{\"level\":\"error\",\"code\":{\"code\":\"E0308\"},\"message\":\"mismatched types\",\"spans\":[{\"file_name\":\"src/main.rs\",\"line_start\":12,\"column_start\":5,\"is_primary\":true,\"label\":\"expected u32\"}]}}\n",
            "{\"reason\":\"compiler-message\",\"message\":{\"level\":\"warning\",\"code\":null,\"message\":\"unused var\",\"spans\":[]}}\n",
            "{\"reason\":\"compiler-message\",\"message\":{\"level\":\"error\",\"code\":null,\"message\":\"aborting due to 1 previous error\",\"spans\":[]}}\n"
        );
        let diags = parse_cargo_json(sample);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0], "src/main.rs:12:5 [E0308] — mismatched types (expected u32)");
    }

    #[test]
    fn extracts_pass_summary_and_compacts_errors() {
        let out = "running 3 tests\n...\ntest result: ok. 3 passed; 0 failed\n";
        assert_eq!(extract_pass_summary(out, "").as_deref(), Some("test result: ok. 3 passed; 0 failed"));

        let lines = vec!["info: building", "Error: bad import", "at foo.ts:10", "line 4", "line 5"];
        let c = compact_error_lines(&lines);
        assert_eq!(c, vec!["Error: bad import", "at foo.ts:10", "line 4"]);
    }
}
