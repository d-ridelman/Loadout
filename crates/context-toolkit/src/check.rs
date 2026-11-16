use serde_json::Value;
use std::collections::HashSet;
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime};

const MAX_ERRORS: usize = 3;
const MAX_LINES: usize = 30;

pub fn run_check(args: &[String]) -> i32 {
    if args.is_empty() {
        eprintln!("Usage: context-toolkit check <command...>");
        return 2;
    }

    // Policy build_slots (context-toolkit.json): wait for a machine-wide slot; held until this function returns,
    // also on a panic. Off by default; any trouble with the slot files means no slot and no waiting.
    let _slot = crate::policy::load().build_slots.and_then(|n| {
        let lang = crate::detect_lang(&[]);
        let waited = Instant::now();
        let slot = crate::slots::acquire(
            &crate::slots::dir(),
            n as usize,
            crate::slots::MAX_WAIT,
            &mut |busy| eprintln!("{}", crate::slots::wait_message(lang, busy)),
        );
        if slot.is_none() && waited.elapsed() >= crate::slots::MAX_WAIT {
            eprintln!(
                "{}",
                crate::t(
                    lang,
                    "no build slot after 10 minutes: running anyway",
                    "слот сборки не освободился за 10 минут: запускаю без него"
                )
            );
        }
        slot
    });

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

    let path_var = env::var_os("PATH").unwrap_or_default();
    let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let output = build_command(&final_args, &path_var, &pathext).output();

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
            println!(
                "FAIL exit={code} ({elapsed_ms} ms), top {} errors:",
                diags.len().min(MAX_ERRORS)
            );
            for (i, d) in diags.iter().take(MAX_ERRORS).enumerate() {
                println!("[{}] {}", i + 1, d);
            }
            if diags.len() > MAX_ERRORS {
                if let Some(log_path) = save_log(&stdout, &stderr) {
                    println!(
                        "... +{} errors (full log: {})",
                        diags.len() - MAX_ERRORS,
                        log_path.display()
                    );
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
            println!(
                "... ({} lines total; full log: {})",
                lines.len(),
                log_path.display()
            );
        }
    }
    code
}

#[cfg_attr(not(windows), allow(dead_code))]
/// The program as Windows would find it: a path with a directory or an extension as given, a bare name
/// in the current directory and along `PATH`, trying each `PATHEXT` extension (`npm` -> `npm.cmd`).
fn find_program(bin: &str, path_var: &OsStr, pathext: &str) -> Option<PathBuf> {
    let has_ext = Path::new(bin).extension().is_some();
    let dirs: Vec<PathBuf> = if bin.contains(['/', '\\']) {
        vec![PathBuf::new()]
    } else {
        // The current folder first, as cmd does; as an absolute path, because `Command` looks a bare
        // relative name up on PATH only.
        env::current_dir()
            .into_iter()
            .chain(env::split_paths(path_var))
            .collect()
    };
    for dir in dirs {
        let base = dir.join(bin);
        if has_ext && base.is_file() {
            return Some(base);
        }
        for ext in pathext.split(';').filter(|e| !e.is_empty()) {
            let mut cand = base.clone().into_os_string();
            cand.push(ext);
            let cand = PathBuf::from(cand);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// The commands `cmd.exe` runs itself; it prefers them to any file of the same name (Git for Windows puts a
/// coreutils `dir.exe` and `echo.exe` on PATH, which would otherwise take over).
fn is_cmd_builtin(name: &str) -> bool {
    const BUILTINS: &[&str] = &[
        "assoc", "break", "call", "cd", "chdir", "cls", "color", "copy", "date", "del", "dir",
        "echo", "endlocal", "erase", "exit", "for", "ftype", "goto", "if", "md", "mkdir", "mklink",
        "move", "path", "pause", "popd", "prompt", "pushd", "rd", "rem", "ren", "rename", "rmdir",
        "set", "setlocal", "shift", "start", "time", "title", "type", "ver", "verify", "vol",
    ];
    BUILTINS.contains(&name.to_ascii_lowercase().as_str())
}

/// Files `CreateProcess` can start itself; any other `PATHEXT` kind (`.js`, `.vbs`, `.py`) needs the
/// file association, which only `cmd` applies.
fn startable_directly(program: &Path) -> bool {
    program
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ["exe", "com", "bat", "cmd"].contains(&e.to_ascii_lowercase().as_str()))
}

/// How `context-toolkit check` starts the command. On Windows a program found on `PATH` (an `.exe`, or an
/// `npm.cmd` / `.bat`, which std quotes for `cmd.exe` itself) is started directly, so `&`, `|`, `%` and
/// `^` in its arguments reach it as they are. What only `cmd` can run (one of its built-ins such as `dir`,
/// a name that is no file, a script run through its file association) goes through `cmd.exe /d /c`,
/// where those characters keep their `cmd` meaning.
fn build_command(args: &[String], path_var: &OsStr, pathext: &str) -> Command {
    if cfg!(windows) {
        let direct = if is_cmd_builtin(&args[0]) {
            None
        } else {
            find_program(&args[0], path_var, pathext).filter(|p| startable_directly(p))
        };
        match direct {
            Some(program) => {
                let mut cmd = Command::new(program);
                cmd.args(&args[1..]);
                return cmd;
            }
            None => {
                let mut cmd = Command::new("cmd.exe");
                cmd.args(["/d", "/c"]).args(args);
                return cmd;
            }
        }
    }
    let mut cmd = Command::new(&args[0]);
    cmd.args(&args[1..]);
    cmd
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
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v["reason"] != "compiler-message" {
            continue;
        }
        let msg = &v["message"];
        if msg["level"] != "error" {
            continue;
        }
        let text = msg["message"].as_str().unwrap_or("").trim();
        if text.is_empty()
            || text.starts_with("aborting due to")
            || text.starts_with("could not compile")
        {
            continue;
        }
        let span = msg["spans"].as_array().and_then(|arr| {
            arr.iter()
                .find(|s| s["is_primary"] == true)
                .or_else(|| arr.first())
        });
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
        Some(
            parts
                .into_iter()
                .rev()
                .take(2)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join(" | "),
        )
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

const LOG_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Deletes `last-check-*.log` files in `dir` that were last written more than a day before `now`.
fn remove_old_logs(dir: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| now.duration_since(t).is_ok_and(|age| age > LOG_MAX_AGE));
        if name.starts_with("last-check-") && name.ends_with(".log") && old {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// Writes the full output to `last-check-<pid>.log` (one file per run, so concurrent sessions do not
/// overwrite each other) and first sweeps logs older than a day out of the same folder.
fn save_log(stdout: &str, stderr: &str) -> Option<PathBuf> {
    let base = env::var_os("TEMP")
        .or_else(|| env::var_os("TMP"))
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    let _ = fs::create_dir_all(&base);
    remove_old_logs(&base, SystemTime::now());
    let pid = std::process::id();
    let path = base.join(format!("last-check-{pid}.log"));
    let body = format!("=== STDOUT ===\n{stdout}\n=== STDERR ===\n{stderr}\n");
    fs::write(&path, &body).ok()?;
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = env::temp_dir().join(format!("ctxkit-check-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn only_old_check_logs_are_swept() {
        let d = temp_dir("logs");
        for n in [
            "last-check-1.log",
            "last-check-2.log",
            "other.log",
            "last-check.txt",
        ] {
            fs::write(d.join(n), "x").unwrap();
        }
        remove_old_logs(&d, SystemTime::now());
        assert!(d.join("last-check-1.log").exists(), "fresh logs stay");
        remove_old_logs(&d, SystemTime::now() + Duration::from_secs(2 * 24 * 3600));
        assert!(!d.join("last-check-1.log").exists() && !d.join("last-check-2.log").exists());
        assert!(d.join("other.log").exists() && d.join("last-check.txt").exists());
        let _ = fs::remove_dir_all(&d);
    }

    /// `echoargs.cmd` prints its first two arguments quoted; the batch file is found by its bare name.
    #[cfg(windows)]
    #[test]
    fn batch_and_builtins_get_special_characters_intact() {
        let d = temp_dir("cmd");
        fs::write(
            d.join("echoargs.cmd"),
            "@echo off\r\necho ARG1=\"%~1\"\r\necho ARG2=\"%~2\"\r\n",
        )
        .unwrap();
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (path, ext) = (d.as_os_str(), ".COM;.EXE;.BAT;.CMD");
        for (a, b) in [("x&y", "a|b"), ("100%", "^caret"), ("two words", "(a)&(b)")] {
            let out = build_command(&args(&["echoargs", a, b]), path, ext)
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            assert!(text.contains(&format!("ARG1=\"{a}\"")), "{a:?}: {text}");
            assert!(text.contains(&format!("ARG2=\"{b}\"")), "{b:?}: {text}");
        }
        // Not a file anywhere on the path: a cmd built-in still works.
        let out = build_command(&args(&["echo", "built-in"]), path, ext)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("built-in"));
        assert!(find_program("echoargs", path, ext).is_some());
        assert!(find_program("echo", path, ext).is_none());
        // a coreutils-style `dir.exe` on PATH does not take a cmd built-in over; a `.js` goes through cmd
        fs::write(d.join("dir.exe"), "x").unwrap();
        fs::write(d.join("tool.js"), "x").unwrap();
        assert!(is_cmd_builtin("DIR") && is_cmd_builtin("echo") && !is_cmd_builtin("echoargs"));
        assert!(find_program("dir", path, ext).is_some() && is_cmd_builtin("dir"));
        let tool = find_program("tool", path, ".JS;.CMD").unwrap();
        assert!(!startable_directly(&tool));
        assert!(startable_directly(&d.join("a.CMD")) && startable_directly(Path::new("x.exe")));
        assert!(!startable_directly(Path::new("noext")));
        // a bare name in the current folder is found as an absolute path
        let here = find_program("Cargo", OsStr::new(""), ".toml").unwrap();
        assert!(here.is_absolute(), "{here:?}");
        let _ = fs::remove_dir_all(&d);
    }

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
        assert_eq!(
            diags[0],
            "src/main.rs:12:5 [E0308] — mismatched types (expected u32)"
        );
    }

    #[test]
    fn extracts_pass_summary_and_compacts_errors() {
        let out = "running 3 tests\n...\ntest result: ok. 3 passed; 0 failed\n";
        assert_eq!(
            extract_pass_summary(out, "").as_deref(),
            Some("test result: ok. 3 passed; 0 failed")
        );

        let lines = vec![
            "info: building",
            "Error: bad import",
            "at foo.ts:10",
            "line 4",
            "line 5",
        ];
        let c = compact_error_lines(&lines);
        assert_eq!(c, vec!["Error: bad import", "at foo.ts:10", "line 4"]);
    }
}
