use crate::setup::{home_dir, marker_span, read_json_object};
use crate::{detect_lang, parse_lang, t, Lang};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub struct Finding {
    pub id: &'static str,
    /// ok | info | warn | error
    pub severity: &'static str,
    pub message: &'static str,
    pub detail: Option<String>,
    pub fix: Option<&'static str>,
}

fn f(
    id: &'static str,
    severity: &'static str,
    message: &'static str,
    detail: Option<String>,
    fix: Option<&'static str>,
) -> Finding {
    Finding {
        id,
        severity,
        message,
        detail,
        fix,
    }
}

/// Validates a `--lang` argument at `i` (the value itself is read by `detect_lang`);
/// returns how many extra arguments to skip, `None` if the value is missing or unsupported.
pub fn lang_arg(args: &[String], i: usize) -> Option<usize> {
    let val = match args[i].strip_prefix("--lang=") {
        Some(v) => v,
        None => args.get(i + 1)?,
    };
    parse_lang(val)?;
    Some(usize::from(!args[i].contains('=')))
}

/// First `ctxkit` hook command in PreToolUse, reduced to the executable path.
fn hook_command(settings: &Value) -> Option<String> {
    let cmd = settings["hooks"]["PreToolUse"]
        .as_array()?
        .iter()
        .flat_map(|g| g["hooks"].as_array().into_iter().flatten())
        .find_map(|h| {
            h["command"]
                .as_str()
                .filter(|c| crate::setup::our_name(c) == Some("ctxkit"))
        })?
        .trim();
    Some(
        match cmd.chars().next().filter(|c| matches!(c, '"' | '\'')) {
            Some(q) => cmd[1..].split(q).next().unwrap_or("").to_string(),
            None if Path::new(cmd).exists() => cmd.to_string(),
            // `C:/x/ctxkit.exe --lang ru`: the executable is the first word
            None => cmd.split_whitespace().next().unwrap_or(cmd).to_string(),
        },
    )
}

pub fn diagnose(profile: &Path, lang: Lang) -> Vec<Finding> {
    let mut out = Vec::new();
    let settings = match read_json_object(&profile.join("settings.json")) {
        Ok(v) => v,
        Err(e) => {
            out.push(f(
                "settings",
                "error",
                t(
                    lang,
                    "settings.json is unreadable",
                    "settings.json не читается",
                ),
                Some(e),
                None,
            ));
            Value::Null
        }
    };

    match hook_command(&settings) {
        None => out.push(f(
            "hooks",
            "warn",
            t(
                lang,
                "no ctxkit hook in PreToolUse: reads and logs are not guarded",
                "в PreToolUse нет хука ctxkit: чтения и логи не защищены",
            ),
            None,
            Some("ctxkit setup"),
        )),
        Some(cmd) if Path::new(&cmd).is_absolute() && !Path::new(&cmd).exists() => out.push(f(
            "hooks",
            "error",
            t(
                lang,
                "the hook points to a missing binary: every tool call will report a hook error",
                "хук указывает на несуществующий бинарь: каждый вызов инструмента даст ошибку хука",
            ),
            Some(cmd),
            Some("ctxkit setup"),
        )),
        Some(_) => out.push(f(
            "hooks",
            "ok",
            t(lang, "hook installed", "хук установлен"),
            None,
            None,
        )),
    }

    let has_gate = settings["hooks"]["Stop"]
        .as_array()
        .is_some_and(|a| a.iter().any(|g| crate::setup::is_our_hook_group(g, None)));
    out.push(if has_gate {
        f("stop_gate", "ok", t(lang, "Stop gate installed", "шлюз Stop установлен"), None, None)
    } else {
        f(
            "stop_gate",
            "info",
            t(
                lang,
                "no Stop gate: nothing returns the model to checker/advisor before it finishes",
                "нет шлюза Stop: ничто не возвращает модель к checker/advisor перед завершением хода",
            ),
            None,
            Some("ctxkit setup"),
        )
    });

    let model = settings["model"].as_str().map(str::to_string);
    let costly = model.as_deref().is_some_and(|m| {
        let m = m.to_ascii_lowercase();
        m.contains("opus") || m.contains("fable")
    });
    if model.is_none() || costly {
        out.push(f(
            "main_model",
            "warn",
            t(
                lang,
                "main session is not pinned to a cheap model (routine work may run on Opus/Fable)",
                "основная сессия не закреплена на дешёвой модели (рутина может идти на Opus/Fable)",
            ),
            model,
            Some("ctxkit setup"),
        ));
    } else {
        out.push(f(
            "main_model",
            "ok",
            t(lang, "main model set", "основная модель задана"),
            model,
            None,
        ));
    }

    out.push(f(
        "advisor",
        "info",
        t(lang, "advisor model", "модель советника"),
        settings["advisorModel"].as_str().map(str::to_string),
        None,
    ));
    let sub = settings["env"]["CLAUDE_CODE_SUBAGENT_MODEL"].as_str();
    // Older `ctxkit setup` wrote haiku here: it puts every subagent without its own `model`, code writers included, on haiku.
    let sub_haiku = sub.is_some_and(|v| v.to_ascii_lowercase().contains("haiku"));
    out.push(f(
        "subagent_model",
        if sub_haiku { "warn" } else { "info" },
        t(
            lang,
            "CLAUDE_CODE_SUBAGENT_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
        ),
        sub.map(str::to_string),
        sub_haiku.then_some(t(
            lang,
            "here haiku also goes to subagents that write code: remove the key and set model in agent files",
            "haiku здесь достаётся и субагентам, которые пишут код: убери ключ и задай model в файлах агентов",
        )),
    ));

    let missing: Vec<&str> = ["Explore.md", "checker.md"]
        .into_iter()
        .filter(|n| !profile.join("agents").join(n).exists())
        .collect();
    if missing.is_empty() {
        out.push(f(
            "agents",
            "ok",
            t(
                lang,
                "Explore and checker agents present",
                "агенты Explore и checker на месте",
            ),
            None,
            None,
        ));
    } else {
        out.push(f(
            "agents",
            "warn",
            t(
                lang,
                "agent files are missing: delegation has nothing to call",
                "нет файлов агентов: делегировать некому",
            ),
            Some(missing.join(", ")),
            Some("ctxkit setup"),
        ));
    }

    let md = fs::read(profile.join("CLAUDE.md")).map(|b| String::from_utf8_lossy(&b).into_owned());
    match md {
        Ok(md) if marker_span(&md).is_some() => {
            out.push(f("rules_block", "ok", t(lang, "ctxkit rules block present", "блок правил ctxkit есть"), None, None));
            let lines = md.lines().count();
            if lines > 200 || md.len() > 8192 {
                out.push(f(
                    "claude_md_size",
                    "warn",
                    t(
                        lang,
                        "CLAUDE.md is large: rules get diluted, move area rules to rules/*.md",
                        "CLAUDE.md большой: правила размываются, вынеси областные в rules/*.md",
                    ),
                    Some(format!("{lines} lines, {} bytes", md.len())),
                    None,
                ));
            }
        }
        _ => out.push(f(
            "rules_block",
            "warn",
            t(
                lang,
                "no ctxkit rules block in CLAUDE.md: the model is never told when to call Explore, checker or advisor, so it usually will not",
                "в CLAUDE.md нет блока правил ctxkit: модели нигде не сказано, когда звать Explore, checker и advisor, и обычно она их не зовёт",
            ),
            None,
            Some("ctxkit setup --with-rules"),
        )),
    }
    out
}

pub fn profile_path(custom: Option<PathBuf>) -> Option<PathBuf> {
    custom
        .or_else(|| env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from))
        .or_else(|| home_dir().map(|h| h.join(".claude")))
}

pub fn run_doctor(args: &[String]) -> i32 {
    let (mut json_out, mut custom) = (false, None);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json_out = true,
            "--profile" => {
                let Some(v) = args.get(i + 1) else {
                    eprintln!("ERR: missing value for --profile");
                    return 2;
                };
                custom = Some(PathBuf::from(v));
                i += 1;
            }
            "--help" | "-h" => {
                println!("Usage: ctxkit doctor [--json] [--profile <dir>] [--lang en|ru]");
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
                eprintln!("ERR: unknown option '{other}'. Usage: ctxkit doctor [--json] [--profile <dir>] [--lang en|ru]");
                return 2;
            }
        }
        i += 1;
    }
    let Some(profile) = profile_path(custom) else {
        eprintln!("ERR: cannot determine USERPROFILE / HOME directory");
        return 1;
    };
    let findings = diagnose(&profile, detect_lang(args));
    let failed = findings.iter().any(|x| x.severity == "error");
    if json_out {
        let list: Vec<Value> = findings
            .iter()
            .map(|x| json!({"id": x.id, "severity": x.severity, "message": x.message, "detail": x.detail, "fix": x.fix}))
            .collect();
        let doc = json!({
            "schema": 1,
            "tool": "ctxkit",
            "version": env!("CARGO_PKG_VERSION"),
            "profile": profile.to_string_lossy(),
            "findings": list,
        });
        println!("{doc}");
    } else {
        for x in &findings {
            let detail = x
                .detail
                .as_deref()
                .map(|d| format!(" [{d}]"))
                .unwrap_or_default();
            let fix = x.fix.map(|c| format!(" -> {c}")).unwrap_or_default();
            println!("[{}] {}: {}{detail}{fix}", x.severity, x.id, x.message);
        }
    }
    i32::from(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("agents")).unwrap();
        d
    }

    fn sev(v: &[Finding], id: &str) -> &'static str {
        v.iter().find(|x| x.id == id).unwrap().severity
    }

    #[test]
    fn empty_profile_warns_about_rules_hooks_and_agents() {
        let d = temp("ctxkit_doctor_empty");
        let v = diagnose(&d, Lang::En);
        assert_eq!(sev(&v, "rules_block"), "warn");
        assert_eq!(sev(&v, "hooks"), "warn");
        assert_eq!(sev(&v, "agents"), "warn");
        assert_eq!(sev(&v, "main_model"), "warn");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn configured_profile_is_clean_and_missing_hook_binary_is_an_error() {
        let d = temp("ctxkit_doctor_ok");
        let exe = d.join("ctxkit.exe");
        fs::write(&exe, b"x").unwrap();
        let cmd = format!("\"{}\"", exe.to_string_lossy().replace('\\', "/"));
        let settings = json!({
            "model": "sonnet",
            "env": {"CLAUDE_CODE_SUBAGENT_MODEL": "sonnet"},
            "hooks": {"PreToolUse": [{"matcher": "Read", "hooks": [{"type": "command", "command": cmd}]}]}
        });
        fs::write(d.join("settings.json"), settings.to_string()).unwrap();
        fs::write(d.join("agents").join("Explore.md"), "x").unwrap();
        fs::write(d.join("agents").join("checker.md"), "x").unwrap();
        fs::write(
            d.join("CLAUDE.md"),
            "<!-- ctxkit:start -->\nr\n<!-- ctxkit:end -->\n",
        )
        .unwrap();
        let v = diagnose(&d, Lang::En);
        assert!(v
            .iter()
            .all(|x| x.severity != "warn" && x.severity != "error"));
        fs::remove_file(&exe).unwrap();
        assert_eq!(sev(&diagnose(&d, Lang::En), "hooks"), "error");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn subagent_env_haiku_warns_but_other_values_do_not() {
        let d = temp("ctxkit_doctor_subagent_env");
        let write = |v: &str| {
            let s = json!({"model": "sonnet", "env": {"CLAUDE_CODE_SUBAGENT_MODEL": v}});
            fs::write(d.join("settings.json"), s.to_string()).unwrap();
        };
        write("haiku");
        assert_eq!(sev(&diagnose(&d, Lang::En), "subagent_model"), "warn");
        write("claude-haiku-5-5");
        assert_eq!(sev(&diagnose(&d, Lang::En), "subagent_model"), "warn");
        write("sonnet");
        assert_eq!(sev(&diagnose(&d, Lang::En), "subagent_model"), "info");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn hook_command_forms_and_lang_values() {
        let hook = |c: &str| {
            json!({"hooks": {"PreToolUse": [
                {"hooks": [{"command": "claude-guard"}]},
                {"hooks": [{"command": "node C:/tools/ctxkit-helper/stop.js"}]},
                {"hooks": [{"command": c}]}
            ]}})
        };
        assert_eq!(
            hook_command(&hook("\"C:/a b/ctxkit.exe\" --claude")).unwrap(),
            "C:/a b/ctxkit.exe"
        );
        assert_eq!(
            hook_command(&hook("'C:/x/ctxkit.exe'")).unwrap(),
            "C:/x/ctxkit.exe"
        );
        assert_eq!(
            hook_command(&hook("C:/x/ctxkit.exe --lang ru")).unwrap(),
            "C:/x/ctxkit.exe"
        );
        assert!(hook_command(&json!({})).is_none());
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(lang_arg(&a(&["--lang", "ru"]), 0), Some(1));
        assert_eq!(lang_arg(&a(&["--lang=en"]), 0), Some(0));
        assert_eq!(lang_arg(&a(&["--lang", "--json"]), 0), None);
        assert_eq!(lang_arg(&a(&["--lang"]), 0), None);
        assert_eq!(lang_arg(&a(&["--lang", "xx"]), 0), None);
    }

    #[test]
    fn non_utf8_claude_md_still_finds_the_marker() {
        let d = temp("ctxkit_doctor_utf8");
        let mut bytes = b"<!-- ctxkit:start -->\nr\n<!-- ctxkit:end -->\n".to_vec();
        bytes.push(0xff);
        fs::write(d.join("CLAUDE.md"), bytes).unwrap();
        assert_eq!(sev(&diagnose(&d, Lang::En), "rules_block"), "ok");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn broken_settings_json_is_an_error() {
        let d = temp("ctxkit_doctor_bad");
        fs::write(d.join("settings.json"), "{not json").unwrap();
        assert_eq!(sev(&diagnose(&d, Lang::En), "settings"), "error");
        let _ = fs::remove_dir_all(&d);
    }
}
