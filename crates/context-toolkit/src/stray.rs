//! Policy `stray_files`: a `Write` of a report-like or scratch file (`report*.md`, `*-analysis.md`, `notes*.md`,
//! `*.tmp`, `*.bak`, ...) straight into the project root (the hook's `cwd`) or the profile root is answered
//! with "ask": the owner wants reports in the chat, not in a file. Files in subfolders (`docs/`, `tests/`)
//! are not touched. `stray_patterns` in `context-toolkit.json` adds patterns (`*` is the only wildcard).
use crate::policy::Config;
use crate::Lang;
use std::path::{Component, Path, PathBuf};

pub const DEFAULT_PATTERNS: [&str; 8] = [
    "report*.md",
    "*-report.md",
    "analysis*.md",
    "*-analysis.md",
    "summary*.md",
    "notes*.md",
    "*.tmp",
    "*.bak",
];

/// `*` matches any run of characters (also none); everything else matches itself, without regard to case.
pub fn glob(pattern: &str, name: &str) -> bool {
    let (p, n) = (pattern.to_lowercase(), name.to_lowercase());
    let parts: Vec<&str> = p.split('*').collect();
    if parts.len() == 1 {
        return p == n;
    }
    let Some(mut rest) = n.strip_prefix(parts[0]) else {
        return false;
    };
    for mid in &parts[1..parts.len() - 1] {
        match rest.find(mid) {
            Some(i) => rest = &rest[i + mid.len()..],
            None => return false,
        }
    }
    rest.ends_with(parts[parts.len() - 1])
}

/// The path with `.` and `..` resolved by text (the file need not exist).
fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c.as_os_str()),
        }
    }
    out
}

/// A folder in the form used to compare two of them: forward slashes, lower case, no trailing slash.
fn dir_key(p: &Path) -> String {
    let s = lexical(p)
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase();
    s.strip_prefix("//?/")
        .unwrap_or(&s)
        .trim_end_matches('/')
        .to_string()
}

/// The question for a `Write` of `file_path`, when the policy is on and the file is a stray one at a root.
pub fn reason(
    cfg: &Config,
    file_path: &str,
    cwd: Option<&Path>,
    profile: Option<&Path>,
    lang: Lang,
) -> Option<String> {
    if !cfg.stray_files || file_path.is_empty() {
        return None;
    }
    let p = Path::new(file_path);
    let base = cwd
        .map(Path::to_path_buf)
        .or_else(|| std::env::current_dir().ok());
    let full = if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.as_deref()?.join(p)
    };
    let name = full.file_name()?.to_string_lossy().to_string();
    let parent = dir_key(full.parent()?);
    let at_root = base.as_deref().is_some_and(|b| dir_key(b) == parent)
        || profile.is_some_and(|d| dir_key(d) == parent);
    if !at_root {
        return None;
    }
    let hit = DEFAULT_PATTERNS
        .iter()
        .copied()
        .chain(cfg.stray_patterns.iter().map(String::as_str))
        .any(|pat| glob(pat, &name));
    hit.then(|| match lang {
        Lang::En => format!(
            "`{name}` looks like a report or scratch file in the project root. The owner wants reports in the chat, not in a file (policy stray_files in context-toolkit.json): answer in the chat, or put the file in a subfolder (docs/, tests/) if it belongs to the project."
        ),
        Lang::Ru => format!(
            "`{name}` похож на отчёт или временный файл в корне проекта. Владелец просит отчёты в чат, а не в файл (политика stray_files в context-toolkit.json): ответь в чате или положи файл в подкаталог (docs/, tests/), если он относится к проекту."
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(extra: &[&str]) -> Config {
        Config {
            stray_files: true,
            stray_patterns: extra.iter().map(|s| s.to_string()).collect(),
            ..Config::default()
        }
    }

    #[cfg(windows)]
    fn hit(path: &str) -> bool {
        let root = Path::new("C:\\proj");
        reason(
            &cfg(&[]),
            path,
            Some(root),
            Some(Path::new("C:\\u\\.claude")),
            Lang::En,
        )
        .is_some()
    }

    #[test]
    fn glob_is_case_blind_with_star_only() {
        for (p, n, want) in [
            ("report*.md", "report.md", true),
            ("report*.md", "Report-2026.MD", true),
            ("report*.md", "myreport.md", false),
            ("*-report.md", "q3-report.md", true),
            ("*-report.md", "report.md", false),
            ("*.tmp", "a.b.tmp", true),
            ("*.tmp", "tmp", false),
            ("a*b*c", "aXXbYYc", true),
            ("a*b*c", "aXXcYYb", false),
            ("ab*ba", "aba", false),
            ("exact.txt", "EXACT.txt", true),
            ("exact.txt", "exact.txt.bak", false),
            ("*", "anything", true),
        ] {
            assert_eq!(glob(p, n), want, "{p} ~ {n}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn asks_for_report_like_files_at_the_project_root_and_the_profile_root() {
        for p in [
            "C:\\proj\\report.md",
            "C:\\proj\\REPORT-final.md",
            "C:/proj/analysis.md",
            "C:\\proj\\perf-analysis.md",
            "C:\\proj\\summary-2026.md",
            "C:\\proj\\notes.md",
            "C:\\proj\\scratch.tmp",
            "C:\\proj\\config.json.bak",
            "report.md",
            ".\\notes-today.md",
            "docs\\..\\report.md",
            "c:\\PROJ\\Report.md",
            "C:\\proj\\.\\report.md",
            "C:\\u\\.claude\\notes.md",
            "C:\\u\\.claude\\report-x.md",
        ] {
            assert!(hit(p), "{p}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn leaves_subfolders_other_names_and_other_roots_alone() {
        for p in [
            "C:\\proj\\docs\\report.md",
            "C:\\proj\\tests\\fixture.bak",
            "C:\\proj\\src\\notes.md",
            "docs/report.md",
            "C:\\proj\\README.md",
            "C:\\proj\\src.rs",
            "C:\\proj\\reports.txt",
            "C:\\proj\\myreport.md",
            "C:\\other\\report.md",
            "C:\\proj2\\report.md",
            "C:\\u\\.claude\\agents\\notes.md",
            "C:\\u\\.claude\\CLAUDE.md",
            "",
        ] {
            assert!(!hit(p), "{p}");
        }
    }

    #[test]
    fn custom_patterns_extend_the_defaults_and_off_means_silent() {
        let root = std::env::temp_dir().join("ctxkit-stray-p");
        let ask = |c: &Config, f: &Path| {
            reason(c, &f.to_string_lossy(), Some(&root), None, Lang::En).is_some()
        };
        let c = cfg(&["draft*.md", "TODO-*"]);
        assert!(ask(&c, &root.join("draft-1.md")) && ask(&c, &root.join("todo-later.txt")));
        assert!(ask(&c, &root.join("report.md")), "defaults stay");
        assert!(!ask(&c, &root.join("sub").join("draft-1.md")));
        assert!(!ask(&cfg(&[]), &root.join("draft-1.md")));
        assert!(!ask(&Config::default(), &root.join("report.md")));
        // a relative path without a cwd is judged against the process folder, an unusable one gives no question
        assert!(reason(&c, "x.tmp", None, None, Lang::En).is_some());
    }

    #[test]
    fn the_question_is_in_the_language_of_the_settings_and_names_the_file() {
        let root = std::env::temp_dir().join("ctxkit-stray-p");
        let file = root.join("report.md").to_string_lossy().to_string();
        let en = reason(&cfg(&[]), &file, Some(&root), None, Lang::En).unwrap();
        let ru = reason(&cfg(&[]), &file, Some(&root), None, Lang::Ru).unwrap();
        assert!(en.contains("`report.md`") && en.contains("reports in the chat"));
        assert!(ru.contains("`report.md`") && ru.contains("отчёты в чат, а не в файл"));
    }
}
