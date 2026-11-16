//! Stop gate: once per turn, send the model back to `checker` / advisor when it is about to finish
//! a turn that edited code and nothing independent looked at the result afterwards.
//!
//! Only facts from the transcript are used (no regex over the answer text, no commands run), so the
//! hook stays cheap (about 50 ms including process start on a 300 MB transcript). Every doubt (unreadable file, odd rows, a cut-off turn)
//! ends in "allow": a missed block costs one unchecked turn, a false block costs a full context pass.

use crate::Lang;
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Transcripts reach hundreds of MB; a turn that does not fit in the tail is judged by its visible part.
const TAIL_BYTES: u64 = 4 << 20;
/// A turn is "substantial" from this many distinct code files or edit calls.
const MIN_FILES: usize = 2;
const MIN_EDITS: usize = 5;

#[derive(Default, Debug, PartialEq)]
struct Turn {
    files: HashSet<String>,
    edits: usize,
    /// `checker` or advisor was called after the last counted edit.
    verified: bool,
}

/// Reason to keep the model going, or `None` to let the turn end.
pub fn stop_reason(call: &Value, lang: Lang) -> Option<String> {
    // Already continuing because of a stop hook: never block twice in a row.
    if call["stop_hook_active"].as_bool() == Some(true) {
        return None;
    }
    if crate::env_off("CTXKIT_GATE") {
        return None;
    }
    let text = read_tail(Path::new(call["transcript_path"].as_str()?))?;
    let turn = analyze(text.lines());
    // Looked up only when the turn would be blocked: the common pass needs no disk reads beyond the transcript.
    block_reason(&turn, Helpers::ALL, lang)?;
    let cwd = call["cwd"].as_str().map(Path::new);
    block_reason(&turn, Helpers::find(&profile_dir(), cwd), lang)
}

/// What the model can be sent back to. A gate that names an agent or an advisor that does not exist
/// sends the model chasing it, so the message follows what is configured (and with neither, stays silent).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Helpers {
    pub(crate) checker: bool,
    pub(crate) advisor: bool,
}

impl Helpers {
    const ALL: Helpers = Helpers {
        checker: true,
        advisor: true,
    };

    /// `agents/checker.md` and `advisorModel` of the profile, or of the project the call comes from.
    pub(crate) fn find(profile: &Path, cwd: Option<&Path>) -> Helpers {
        let project = cwd.map(|c| c.join(".claude"));
        let dirs = [Some(profile.to_path_buf()), project];
        let has_advisor = |dir: &Path, file: &str| {
            fs::read_to_string(dir.join(file))
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(s.trim_start_matches('\u{feff}')).ok())
                .is_some_and(|v| v["advisorModel"].as_str().is_some_and(|m| !m.is_empty()))
        };
        Helpers {
            checker: dirs
                .iter()
                .flatten()
                .any(|d| d.join("agents").join("checker.md").is_file()),
            advisor: dirs
                .iter()
                .flatten()
                .any(|d| has_advisor(d, "settings.json") || has_advisor(d, "settings.local.json")),
        }
    }
}

/// The profile this binary serves: the parent of the `hooks/` folder it runs from (where `ctxkit setup`
/// puts it), else `CLAUDE_CONFIG_DIR`, else `~/.claude`.
fn profile_dir() -> PathBuf {
    let exe = std::env::current_exe().ok();
    let beside_hooks = exe
        .as_deref()
        .and_then(Path::parent)
        .filter(|d| d.file_name().is_some_and(|n| n == "hooks"))
        .and_then(Path::parent)
        .map(Path::to_path_buf);
    beside_hooks
        .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from))
        .or_else(|| crate::setup::home_dir().map(|h| h.join(".claude")))
        .unwrap_or_default()
}

fn read_tail(path: &Path) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(TAIL_BYTES).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start == 0 {
        return Some(text);
    }
    // The first line is cut in the middle.
    text.split_once('\n').map(|(_, rest)| rest.to_string())
}

fn analyze<'a>(lines: impl Iterator<Item = &'a str>) -> Turn {
    let mut turn = Turn::default();
    for line in lines {
        let Ok(row) = serde_json::from_str::<Value>(line.trim_start_matches('\u{feff}')) else {
            continue;
        };
        match row["type"].as_str() {
            Some("user") if is_prompt(&row) => turn = Turn::default(),
            Some("assistant") => {
                let Some(blocks) = row["message"]["content"].as_array() else {
                    continue;
                };
                for b in blocks {
                    note_block(&mut turn, b);
                }
            }
            _ => {}
        }
    }
    turn
}

fn note_block(turn: &mut Turn, b: &Value) {
    match (b["type"].as_str(), b["name"].as_str()) {
        (Some("tool_use"), Some("Edit" | "Write" | "MultiEdit" | "NotebookEdit")) => {
            let input = &b["input"];
            let path = input["file_path"]
                .as_str()
                .or_else(|| input["notebook_path"].as_str());
            if let Some(p) = path.filter(|p| counts_as_code(p)) {
                turn.files.insert(p.replace('\\', "/").to_ascii_lowercase());
                turn.edits += 1;
                turn.verified = false;
            }
        }
        (Some("tool_use"), Some("Agent" | "Task")) if b["input"]["subagent_type"] == "checker" => {
            turn.verified = true;
        }
        (Some("server_tool_use"), Some("advisor")) => turn.verified = true,
        _ => {}
    }
}

/// A real user prompt starts a new turn. Tool results, hook feedback and meta rows do not.
fn is_prompt(row: &Value) -> bool {
    // A compaction summary or a sidechain row in the middle of a turn is not the user's next prompt.
    if ["isMeta", "isCompactSummary", "isSidechain"]
        .iter()
        .any(|k| row[*k].as_bool() == Some(true))
    {
        return false;
    }
    match &row["message"]["content"] {
        Value::String(s) => !s.trim().is_empty(),
        Value::Array(a) => {
            a.iter().all(|b| b["type"] != "tool_result")
                && a.iter()
                    .any(|b| matches!(b["type"].as_str(), Some("text" | "image")))
        }
        _ => false,
    }
}

/// Docs, notes, logs, scratch files in a temp dir and the profile itself are not code to verify.
fn counts_as_code(path: &str) -> bool {
    let p = path.replace('\\', "/").to_ascii_lowercase();
    let docs = [".md", ".txt", ".rst", ".log"];
    // Worktrees live under <repo>/.claude/worktrees/: that is code, unlike the rest of the profile.
    !docs.iter().any(|e| p.ends_with(e))
        && !["/temp/", "/tmp/"].iter().any(|d| p.contains(d))
        && (!p.contains("/.claude/") || p.contains("/.claude/worktrees/"))
}

fn block_reason(turn: &Turn, helpers: Helpers, lang: Lang) -> Option<String> {
    if turn.verified || (turn.files.len() < MIN_FILES && turn.edits < MIN_EDITS) {
        return None;
    }
    let (n, e) = (turn.files.len(), turn.edits);
    // (what did not run, what to do about it), per language
    let (en, ru) = match (helpers.checker, helpers.advisor) {
        (false, false) => return None,
        (true, true) => (
            (
                "neither `checker` nor the advisor ran",
                "call the `checker` agent (Agent, subagent_type=checker) and fix what it reports, or consult the advisor",
            ),
            (
                "не вызван ни `checker`, ни advisor",
                "вызови агента `checker` (Agent, subagent_type=checker) и исправь то, что он найдёт, либо посоветуйся с advisor",
            ),
        ),
        (true, false) => (
            (
                "`checker` did not run",
                "call the `checker` agent (Agent, subagent_type=checker) and fix what it reports",
            ),
            (
                "не вызван `checker`",
                "вызови агента `checker` (Agent, subagent_type=checker) и исправь то, что он найдёт",
            ),
        ),
        (false, true) => (
            (
                "the advisor was not consulted",
                "consult the advisor and fix what it points out",
            ),
            (
                "не вызван advisor",
                "посоветуйся с advisor и исправь то, на что он укажет",
            ),
        ),
    };
    Some(match lang {
        Lang::En => format!(
            "This turn edited code ({n} file(s), {e} edit(s)) and {} after the last edit. \
Before finishing, {}. \
If you are not reporting the work as done (asking a question, waiting for an answer), just end the turn again: this hook fires only once.",
            en.0, en.1
        ),
        Lang::Ru => format!(
            "В этом ходу правился код ({n} файл(ов), {e} правок), а после последней правки {}. \
Перед завершением {}. \
Если ты не заявляешь о готовности (задаёшь вопрос или ждёшь ответа), просто заверши ход ещё раз: хук срабатывает только один раз.",
            ru.0, ru.1
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(text: &str) -> String {
        json!({"type": "user", "message": {"role": "user", "content": text}}).to_string()
    }
    fn tool_result() -> String {
        json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "x", "content": "ok"}]}}).to_string()
    }
    fn edit(path: &str) -> String {
        json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": path}}]}}).to_string()
    }
    fn checker() -> String {
        json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Agent", "input": {"subagent_type": "checker"}}]}}).to_string()
    }
    fn advisor() -> String {
        json!({"type": "assistant", "message": {"content": [{"type": "server_tool_use", "name": "advisor", "input": {}}]}}).to_string()
    }
    fn reason(rows: &[String]) -> Option<String> {
        block_reason(
            &analyze(rows.iter().map(String::as_str)),
            Helpers::ALL,
            Lang::En,
        )
    }

    #[test]
    fn message_names_only_what_exists_and_is_silent_with_nothing() {
        let turn = analyze(
            [user("go"), edit("/p/a.rs"), edit("/p/b.rs")]
                .iter()
                .map(String::as_str),
        );
        let msg = |checker, advisor, lang| block_reason(&turn, Helpers { checker, advisor }, lang);
        let both = msg(true, true, Lang::En).unwrap();
        assert!(
            both.contains("neither `checker` nor the advisor")
                && both.contains("or consult the advisor")
        );
        let only_checker = msg(true, false, Lang::En).unwrap();
        assert!(
            only_checker.contains("`checker` did not run") && !only_checker.contains("advisor")
        );
        let only_advisor = msg(false, true, Lang::En).unwrap();
        assert!(only_advisor.contains("consult the advisor") && !only_advisor.contains("checker"));
        assert_eq!(msg(false, false, Lang::En), None);
        assert_eq!(msg(false, false, Lang::Ru), None);
        let ru = msg(true, false, Lang::Ru).unwrap();
        assert!(ru.contains("не вызван `checker`") && !ru.contains("advisor"));
        assert!(msg(false, true, Lang::Ru)
            .unwrap()
            .contains("посоветуйся с advisor"));
    }

    #[test]
    fn helpers_come_from_the_profile_and_the_project() {
        let root = std::env::temp_dir().join(format!("ctxkit-gate-helpers-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (profile, project) = (root.join("profile"), root.join("proj"));
        fs::create_dir_all(profile.join("agents")).unwrap();
        fs::create_dir_all(project.join(".claude").join("agents")).unwrap();
        let none = Helpers {
            checker: false,
            advisor: false,
        };
        assert_eq!(Helpers::find(&profile, Some(&project)), none);
        fs::write(
            profile.join("settings.json"),
            "{\"advisorModel\": \"fable\"}",
        )
        .unwrap();
        assert_eq!(
            Helpers::find(&profile, None),
            Helpers {
                checker: false,
                advisor: true
            }
        );
        fs::write(profile.join("settings.json"), "{\"advisorModel\": \"\"}").unwrap();
        assert!(
            !Helpers::find(&profile, None).advisor,
            "an empty advisorModel is none"
        );
        fs::write(profile.join("agents").join("checker.md"), "x").unwrap();
        assert_eq!(
            Helpers::find(&profile, None),
            Helpers {
                checker: true,
                advisor: false
            }
        );
        fs::remove_file(profile.join("agents").join("checker.md")).unwrap();
        fs::write(
            project.join(".claude").join("agents").join("checker.md"),
            "x",
        )
        .unwrap();
        assert!(Helpers::find(&profile, Some(&project)).checker);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_code_files_without_check_block() {
        let rows = [
            user("go"),
            edit("C:\\p\\a.rs"),
            tool_result(),
            edit("C:\\p\\b.rs"),
        ];
        assert!(reason(&rows).unwrap().contains("2 file(s)"));
    }

    #[test]
    fn one_file_and_few_edits_pass() {
        let rows = [user("go"), edit("/p/a.rs"), edit("/p/a.rs")];
        assert_eq!(reason(&rows), None);
    }

    #[test]
    fn many_edits_of_one_file_block() {
        let mut rows = vec![user("go")];
        rows.extend((0..MIN_EDITS).map(|_| edit("/p/a.rs")));
        assert!(reason(&rows).is_some());
    }

    #[test]
    fn checker_or_advisor_after_last_edit_passes() {
        for done in [checker(), advisor()] {
            let rows = [user("go"), edit("/p/a.rs"), edit("/p/b.rs"), done];
            assert_eq!(reason(&rows), None);
        }
    }

    #[test]
    fn edit_after_checker_blocks_again() {
        let rows = [user("go"), edit("/p/a.rs"), checker(), edit("/p/b.rs")];
        assert!(reason(&rows).is_some());
    }

    #[test]
    fn new_prompt_starts_a_new_turn() {
        let rows = [user("go"), edit("/p/a.rs"), edit("/p/b.rs"), user("next")];
        assert_eq!(reason(&rows), None);
    }

    #[test]
    fn docs_temp_and_profile_files_do_not_count() {
        let rows = [
            user("go"),
            edit("/p/README.md"),
            edit("C:\\Users\\x\\AppData\\Local\\Temp\\agents\\s.py"),
            edit("C:\\Users\\x\\.claude\\settings.json"),
            edit("/p/a.rs"),
        ];
        assert_eq!(reason(&rows), None);
    }

    #[test]
    fn meta_rows_and_garbage_lines_do_not_reset_the_turn() {
        let meta = json!({"type": "user", "isMeta": true, "message": {"content": "<system-reminder>x</system-reminder>"}}).to_string();
        let rows = [
            user("go"),
            edit("/p/a.rs"),
            "not json".to_string(),
            meta,
            edit("/p/b.rs"),
        ];
        assert!(reason(&rows).is_some());
    }

    #[test]
    fn worktree_files_count_but_profile_files_do_not() {
        let rows = [
            user("go"),
            edit("D:\\x\\.claude\\worktrees\\w\\src\\a.rs"),
            edit("D:\\x\\.claude\\worktrees\\w\\src\\b.rs"),
        ];
        assert!(reason(&rows).is_some());
    }

    #[test]
    fn compaction_summary_and_sidechain_rows_do_not_reset_the_turn() {
        for flag in ["isCompactSummary", "isSidechain"] {
            let mut row =
                json!({"type": "user", "message": {"content": "This session is being continued"}});
            row[flag] = json!(true);
            let rows = [
                user("go"),
                edit("/p/a.rs"),
                row.to_string(),
                edit("/p/b.rs"),
            ];
            assert!(reason(&rows).is_some(), "{flag}");
        }
    }

    #[test]
    fn stop_hook_active_and_missing_transcript_allow() {
        let again = json!({"stop_hook_active": true, "transcript_path": "/no/such"});
        assert_eq!(stop_reason(&again, Lang::En), None);
        let missing = json!({"transcript_path": "/no/such/file.jsonl"});
        assert_eq!(stop_reason(&missing, Lang::En), None);
        assert_eq!(stop_reason(&json!({}), Lang::En), None);
    }

    #[test]
    fn tail_drops_the_cut_first_line() {
        let dir = std::env::temp_dir().join(format!("ctxkit-gate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        std::fs::write(&p, format!("{}\n{}\n", user("go"), edit("/p/a.rs"))).unwrap();
        assert_eq!(read_tail(&p).unwrap().lines().count(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
