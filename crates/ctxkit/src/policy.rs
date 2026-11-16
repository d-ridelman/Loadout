//! Policies: protections the owner used to keep as prose in CLAUDE.md, enforced by hooks instead.
//! They live in `<profile>/ctxkit.json` (profile: `CLAUDE_CONFIG_DIR`, else `~/.claude`):
//!
//! ```json
//! {"policies": {"commit_hygiene": true, "confirm_irreversible": true, "stray_files": true, "build_slots": 2},
//!  "stray_patterns": ["draft*.md"], "rules": ["my own line for the rules block"]}
//! ```
//!
//! `ctxkit setup --policy ...` writes the file; hooks and `ctxkit check` only read it. A missing or
//! broken file means every policy is off and the hook stays silent.
use crate::shell::Dialect;
use crate::Lang;
use serde_json::{Map, Value};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub const FILE: &str = "ctxkit.json";
/// Written by `setup` into a `ctxkit.json` it created, so `--uninstall` can tell its own file from the owner's.
pub const CREATED_BY: &str = "ctxkit setup";
/// Policy keys in `policies`, in the order they are printed.
pub const KEYS: [&str; 4] = [
    "commit_hygiene",
    "confirm_irreversible",
    "stray_files",
    "build_slots",
];
const MAX_SLOTS: u64 = 64;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Config {
    pub commit_hygiene: bool,
    pub confirm_irreversible: bool,
    pub stray_files: bool,
    /// Concurrent `ctxkit check` runs allowed on the machine; `None` = the policy is off.
    pub build_slots: Option<u32>,
    pub stray_patterns: Vec<String>,
    pub rules: Vec<String>,
}

impl Config {
    /// `commit_hygiene, build_slots=2` or `none`.
    pub fn describe(&self) -> String {
        let mut on = Vec::new();
        if self.commit_hygiene {
            on.push("commit_hygiene".to_string());
        }
        if self.confirm_irreversible {
            on.push("confirm_irreversible".to_string());
        }
        if self.stray_files {
            on.push("stray_files".to_string());
        }
        if let Some(n) = self.build_slots {
            on.push(format!("build_slots={n}"));
        }
        if on.is_empty() {
            "none".to_string()
        } else {
            on.join(", ")
        }
    }
}

pub fn profile_dir() -> Option<PathBuf> {
    env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::setup::home_dir().map(|h| h.join(".claude")))
}

/// The policies of the current profile; anything unreadable gives every policy off.
pub fn load() -> Config {
    profile_dir().map(|d| load_from(&d)).unwrap_or_default()
}

pub fn load_from(profile: &Path) -> Config {
    fs::read_to_string(profile.join(FILE))
        .ok()
        .and_then(|t| parse(&t).ok())
        .unwrap_or_default()
}

/// What a policy hook answers: `Deny` blocks the call, `Ask` leaves it to the user's confirmation.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    Deny(String),
    #[allow(dead_code)] // first built by confirm_irreversible
    Ask(String),
}

/// The policies for a shell command. `dialects` are the shells it may be written for (Bash, PowerShell, or
/// both when the client does not say). A deny wins over an ask.
pub fn shell(
    cfg: &Config,
    cmd: &str,
    dialects: &[Dialect],
    lang: Lang,
    cwd: Option<&Path>,
) -> Option<Verdict> {
    if cfg.commit_hygiene {
        if let Some(r) = dialects
            .iter()
            .find_map(|d| crate::commit::reason(cmd, *d, lang, cwd))
        {
            return Some(Verdict::Deny(r));
        }
    }
    None
}

fn strings(root: &Map<String, Value>, key: &str, rules: bool) -> Result<Vec<String>, String> {
    let Some(v) = root.get(key) else {
        return Ok(Vec::new());
    };
    let arr = v
        .as_array()
        .ok_or_else(|| format!("'{key}' is not an array of strings"))?;
    let mut out = Vec::new();
    for item in arr {
        let s = item
            .as_str()
            .ok_or_else(|| format!("'{key}' holds something that is not a string"))?
            .trim();
        if s.is_empty() {
            return Err(format!("'{key}' holds an empty string"));
        }
        // A rules line lands in CLAUDE.md between the ctxkit markers: no line break, no marker text.
        if rules && (s.contains(['\n', '\r']) || s.contains("<!--")) {
            return Err(format!(
                "'{key}' item must be one line without `<!--`: {s:?}"
            ));
        }
        out.push(s.to_string());
    }
    Ok(out)
}

/// Strict parse (setup refuses a file that fails here; hooks treat the failure as "all off").
pub fn parse(text: &str) -> Result<Config, String> {
    let v: Value =
        serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
    let root = v.as_object().ok_or("the top level is not a JSON object")?;
    let mut c = Config::default();
    if let Some(p) = root.get("policies") {
        let p = p.as_object().ok_or("'policies' is not a JSON object")?;
        let flag = |k: &str| match p.get(k) {
            None | Some(Value::Null) => Ok(false),
            Some(Value::Bool(b)) => Ok(*b),
            Some(_) => Err(format!("'policies.{k}' must be true or false")),
        };
        c.commit_hygiene = flag("commit_hygiene")?;
        c.confirm_irreversible = flag("confirm_irreversible")?;
        c.stray_files = flag("stray_files")?;
        c.build_slots = match p.get("build_slots") {
            None | Some(Value::Null | Value::Bool(false)) => None,
            Some(Value::Number(n)) => match n.as_u64() {
                Some(0) => None,
                Some(n) if n <= MAX_SLOTS => Some(n as u32),
                _ => {
                    return Err(format!(
                        "'policies.build_slots' must be a whole number from 1 to {MAX_SLOTS}"
                    ))
                }
            },
            Some(_) => return Err("'policies.build_slots' must be a number (or false)".to_string()),
        };
    }
    c.stray_patterns = strings(root, "stray_patterns", false)?;
    c.rules = strings(root, "rules", true)?;
    Ok(c)
}

/// What `--policy` asks for: exactly these policies are on, the rest are off.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Selection {
    pub commit_hygiene: bool,
    pub confirm_irreversible: bool,
    pub stray_files: bool,
    pub build_slots: Option<u32>,
}

/// `commit-hygiene,confirm-irreversible,stray-files,build-slots=2`, or `none`.
pub fn parse_selection(list: &str) -> Result<Selection, String> {
    let mut sel = Selection::default();
    let items: Vec<&str> = list.split(',').map(str::trim).collect();
    if items.iter().any(|i| i.is_empty()) {
        return Err("--policy: empty item in the list".to_string());
    }
    if items.iter().any(|i| i.eq_ignore_ascii_case("none")) {
        return if items.len() == 1 {
            Ok(sel)
        } else {
            Err("--policy: `none` cannot be combined with other names".to_string())
        };
    }
    for item in items {
        let (name, value) = match item.split_once('=') {
            Some((n, v)) => (n.trim(), Some(v.trim())),
            None => (item, None),
        };
        let name = name.to_ascii_lowercase().replace('_', "-");
        let on = |slot: &mut bool| match value {
            None => {
                *slot = true;
                Ok(())
            }
            Some(_) => Err(format!("--policy: `{name}` takes no value")),
        };
        match name.as_str() {
            "commit-hygiene" => on(&mut sel.commit_hygiene)?,
            "confirm-irreversible" => on(&mut sel.confirm_irreversible)?,
            "stray-files" => on(&mut sel.stray_files)?,
            "build-slots" => {
                sel.build_slots = Some(match value {
                    None => 2,
                    Some(v) => v
                        .parse::<u32>()
                        .ok()
                        .filter(|n| (1..=MAX_SLOTS as u32).contains(n))
                        .ok_or_else(|| {
                            format!("--policy: build-slots=N needs a whole number from 1 to {MAX_SLOTS}, got `{v}`")
                        })?,
                })
            }
            _ => {
                return Err(format!(
                    "--policy: unknown policy `{item}` (use commit-hygiene, confirm-irreversible, stray-files, build-slots=N, or none)"
                ))
            }
        }
    }
    Ok(sel)
}

impl Selection {
    /// Puts the selection into the `policies` object: the four known keys are rewritten, others stay.
    pub fn apply(&self, root: &mut Map<String, Value>) {
        let entry = root
            .entry("policies".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        let p = entry.as_object_mut().expect("just made an object");
        for k in KEYS {
            p.remove(k);
        }
        for (k, on) in [
            ("commit_hygiene", self.commit_hygiene),
            ("confirm_irreversible", self.confirm_irreversible),
            ("stray_files", self.stray_files),
        ] {
            if on {
                p.insert(k.to_string(), Value::Bool(true));
            }
        }
        if let Some(n) = self.build_slots {
            p.insert("build_slots".to_string(), Value::from(n));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_broken_file_means_every_policy_is_off() {
        let d = std::env::temp_dir().join(format!("ctxkit-policy-load-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        assert_eq!(load_from(&d), Config::default(), "no file");
        for bad in [
            "",
            "{",
            "[]",
            r#"{"policies":{"commit_hygiene":"yes"}}"#,
            r#"{"policies":[]}"#,
            r#"{"policies":{"build_slots":"2"}}"#,
            r#"{"policies":{"commit_hygiene":true},"rules":"x"}"#,
        ] {
            fs::write(d.join(FILE), bad).unwrap();
            assert_eq!(load_from(&d), Config::default(), "{bad:?}");
        }
        fs::write(
            d.join(FILE),
            "\u{feff}{\"policies\":{\"commit_hygiene\":true,\"build_slots\":3}}",
        )
        .unwrap();
        let c = load_from(&d);
        assert!(c.commit_hygiene && !c.stray_files);
        assert_eq!(c.build_slots, Some(3));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn parses_the_documented_file_and_keeps_unknown_keys_harmless() {
        let c = parse(
            r#"{"policies":{"commit_hygiene":true,"confirm_irreversible":true,"stray_files":true,"build_slots":2,"future":1},
                "stray_patterns":["draft*.md"],"rules":["Субагентам, которые правят код, задавай model: \"sonnet\", никогда haiku"],
                "created_by":"ctxkit setup","other":1}"#,
        )
        .unwrap();
        assert_eq!(
            c.describe(),
            "commit_hygiene, confirm_irreversible, stray_files, build_slots=2"
        );
        assert_eq!(c.stray_patterns, ["draft*.md"]);
        assert_eq!(c.rules.len(), 1);
        assert_eq!(parse("{}").unwrap(), Config::default());
        assert_eq!(
            parse(r#"{"policies":{"build_slots":0}}"#)
                .unwrap()
                .build_slots,
            None
        );
        assert_eq!(
            parse(r#"{"policies":{"build_slots":false}}"#)
                .unwrap()
                .build_slots,
            None
        );
    }

    #[test]
    fn refuses_what_would_break_the_rules_block_or_the_hooks() {
        for bad in [
            r#"{"rules":["two\nlines"]}"#,
            r#"{"rules":["<!-- ctxkit:end -->"]}"#,
            r#"{"rules":[""]}"#,
            r#"{"rules":[1]}"#,
            r#"{"stray_patterns":[" "]}"#,
            r#"{"policies":{"build_slots":65}}"#,
            r#"{"policies":{"build_slots":1.5}}"#,
            r#"{"policies":{"build_slots":-1}}"#,
            r#"{"policies":{"stray_files":1}}"#,
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn selection_lists_the_policies_that_are_on_and_everything_else_goes_off() {
        let s = parse_selection("commit-hygiene, build-slots=3").unwrap();
        assert_eq!(
            s,
            Selection {
                commit_hygiene: true,
                build_slots: Some(3),
                ..Selection::default()
            }
        );
        assert_eq!(parse_selection("NONE").unwrap(), Selection::default());
        assert_eq!(parse_selection("build-slots").unwrap().build_slots, Some(2));
        assert!(
            parse_selection("stray_files").unwrap().stray_files,
            "underscore spelling"
        );
        for bad in [
            "",
            "none,stray-files",
            "stray-files,",
            "unknown",
            "build-slots=0",
            "build-slots=x",
            "build-slots=65",
            "commit-hygiene=1",
        ] {
            assert!(parse_selection(bad).is_err(), "{bad:?}");
        }

        // apply: our four keys are rewritten, foreign keys in `policies` stay
        let mut root: Map<String, Value> = serde_json::from_str(
            r#"{"policies":{"commit_hygiene":true,"build_slots":5,"future":1},"rules":["a b c d e"]}"#,
        )
        .unwrap();
        parse_selection("stray-files").unwrap().apply(&mut root);
        assert_eq!(
            Value::Object(root.clone()),
            serde_json::json!({"policies":{"stray_files":true,"future":1},"rules":["a b c d e"]})
        );
        parse_selection("none").unwrap().apply(&mut root);
        assert_eq!(root["policies"], serde_json::json!({"future":1}));
    }
}
