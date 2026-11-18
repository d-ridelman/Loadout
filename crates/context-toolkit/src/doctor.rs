use crate::setup::{home_dir, marker_problem, marker_span, read_json_object};
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

/// First hook command of ours (`context-toolkit`, or the old `ctxkit`) in PreToolUse, reduced to the executable path.
fn hook_command(settings: &Value) -> Option<String> {
    let cmd = settings["hooks"]["PreToolUse"]
        .as_array()?
        .iter()
        .flat_map(|g| g["hooks"].as_array().into_iter().flatten())
        .find_map(|h| {
            h["command"].as_str().filter(|c| {
                matches!(
                    crate::setup::our_name(c),
                    Some("context-toolkit" | "ctxkit")
                )
            })
        })?
        .trim();
    Some(
        match cmd.chars().next().filter(|c| matches!(c, '"' | '\'')) {
            Some(q) => cmd[1..].split(q).next().unwrap_or("").to_string(),
            None if Path::new(cmd).exists() => cmd.to_string(),
            // `C:/x/context-toolkit.exe --lang ru`: the executable is the first word
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
                "no Context Toolkit hook in PreToolUse: reads and logs are not guarded",
                "в PreToolUse нет хука Инструментов контекста: чтения и логи не защищены",
            ),
            None,
            Some("context-toolkit setup"),
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
            Some("context-toolkit setup"),
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
    let helpers = crate::gate::Helpers::find(profile, None);
    out.push(if has_gate && !helpers.checker && !helpers.advisor {
        f(
            "stop_gate",
            "info",
            t(
                lang,
                "Stop gate installed, but there is neither a checker agent nor an advisorModel: it stays silent",
                "шлюз Stop установлен, но нет ни агента checker, ни advisorModel: он молчит",
            ),
            None,
            Some("context-toolkit setup"),
        )
    } else if has_gate {
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
            Some("context-toolkit setup"),
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
            Some("context-toolkit setup --main-model sonnet"),
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

    // The effort of a model lives in `modelSettings.<model id>`; setup writes it only for a model it can name.
    if let Some((model, id)) = settings["model"]
        .as_str()
        .and_then(|m| crate::setup::canonical_model_id(m).map(|id| (m, id)))
    {
        if !settings["modelSettings"][&id].is_object() {
            out.push(f(
                "model_settings",
                "warn",
                t(
                    lang,
                    "no modelSettings entry for the main model: its effort is not set (an alias such as `sonnet` may also now mean a newer model than this table knows)",
                    "для основной модели нет записи в modelSettings: её effort не задан (алиас вроде `sonnet` мог уже сместиться на более новую модель, чем знает таблица)",
                ),
                Some(format!(
                    "model {model}, expected modelSettings.{id}; the alias table of Context Toolkit is from {}",
                    crate::setup::MODEL_ALIASES_AS_OF
                )),
                Some("context-toolkit setup --main-model <model> --effort <level>"),
            ));
        }
    }

    out.push(f(
        "advisor",
        "info",
        t(lang, "advisor model", "модель советника"),
        settings["advisorModel"].as_str().map(str::to_string),
        None,
    ));
    let sub = settings["env"]["CLAUDE_CODE_SUBAGENT_MODEL"].as_str();
    // Older setup versions wrote haiku here: it puts every subagent without its own `model`, code writers included, on haiku.
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
            Some("context-toolkit setup"),
        ));
    }

    let md = fs::read(profile.join("CLAUDE.md")).map(|b| String::from_utf8_lossy(&b).into_owned());
    if let Some(problem) = md.as_ref().ok().and_then(|m| marker_problem(m)) {
        out.push(f(
            "rules_markers",
            "warn",
            t(
                lang,
                "the rules-block markers in CLAUDE.md are unbalanced or the block is doubled (an older setup could leave this): setup refuses to touch the file and the rollback removes only part of it. Keep one block between the markers, or delete the markers and the old block by hand, then rerun setup --with-rules",
                "маркеры блока правил в CLAUDE.md не сбалансированы или блок задвоен (так могла оставить прежняя версия setup): setup такой файл не трогает, а откат убирает только часть. Оставь один блок между маркерами или удали маркеры и старый блок вручную, затем снова запусти setup --with-rules",
            ),
            Some(format!("{}: {problem}", profile.join("CLAUDE.md").display())),
            None,
        ));
    }
    match &md {
        Ok(md) if marker_span(md).is_some() => {
            out.push(f("rules_block", "ok", t(lang, "Context Toolkit rules block present", "блок правил Инструментов контекста есть"), None, None));
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
                "no Context Toolkit rules block in CLAUDE.md: the model is never told when to call Explore, checker or advisor, so it usually will not",
                "в CLAUDE.md нет блока правил Инструментов контекста: модели нигде не сказано, когда звать Explore, checker и advisor, и обычно она их не зовёт",
            ),
            None,
            Some("context-toolkit setup --with-rules"),
        )),
    }
    // The same rule in two places (the owner's sections and our block): the copies drift apart.
    let repeats = md
        .as_ref()
        .map(|m| crate::dupes::find(m))
        .unwrap_or_default();
    if !repeats.is_empty() {
        out.push(f(
            "rules_duplicate",
            "warn",
            t(
                lang,
                "CLAUDE.md says the same rule in two places: a model reads both copies and they drift apart",
                "в CLAUDE.md одно и то же правило записано в двух местах: модель читает обе копии, и со временем они расходятся",
            ),
            Some(crate::dupes::describe(&repeats, lang)),
            Some(t(
                lang,
                "keep each rule in one place: when your line says what the block says, delete your copy (the Context Toolkit block is rewritten by `context-toolkit setup --with-rules`, so a point of your own that belongs there goes into context-toolkit.json → rules); when your line is an exception to the block's rule, keep it",
                "оставь одно место для каждого правила: если твоя строка говорит то же, что блок, удали свою копию (блок Инструментов контекста переписывает `context-toolkit setup --with-rules`, поэтому свой пункт, которому место в блоке, держи в context-toolkit.json → rules); если твоя строка — исключение из правила блока, оставь её",
            )),
        ));
    }

    // The policy file: silent when absent (the policies are opt-in); a broken file switches every policy off without a word.
    let cfg_path = crate::policy::file_in(profile);
    let old_cfg = !cfg_path.ends_with(crate::policy::FILE);
    if cfg_path.exists() {
        // strict UTF-8 like the hooks and setup: a file the hooks cannot read must not look fine here
        let parsed = fs::read(&cfg_path)
            .map_err(|e| e.to_string())
            .and_then(|b| String::from_utf8(b).map_err(|e| e.to_string()))
            .and_then(|text| crate::policy::parse(&text));
        out.push(match parsed {
            Ok(c) => f(
                "policies",
                "info",
                if old_cfg {
                    t(lang, "policies (ctxkit.json, the old name)", "политики (ctxkit.json, старое имя)")
                } else {
                    t(lang, "policies (context-toolkit.json)", "политики (context-toolkit.json)")
                },
                Some(c.describe()),
                None,
            ),
            Err(e) => f(
                "policies",
                "warn",
                t(
                    lang,
                    "the policy file does not parse: every policy is off and the hooks stay silent",
                    "файл политик не разбирается: все политики выключены, хуки молчат",
                ),
                Some(format!("{}: {e}", cfg_path.display())),
                Some(t(
                    lang,
                    "fix the JSON or delete the file (setup refuses it as it is), then context-toolkit setup --policy <list>",
                    "поправь JSON или удали файл (setup в таком виде его не принимает), затем context-toolkit setup --policy <list>",
                )),
            ),
        });
    }
    out.extend(legacy_name(profile, &settings, md.as_ref().ok(), lang));
    out
}

/// The OpenCode plugin of `setup --opencode` in the OpenCode config `dir`: said only when the file is there, since
/// most profiles never wire OpenCode up.
pub fn opencode_findings(dir: &Path, lang: Lang) -> Vec<Finding> {
    use crate::setup::opencode::{plugin_exe, plugin_path, plugin_state, PluginState};
    let detail = Some(plugin_path(dir).display().to_string());
    let state = plugin_state(dir);
    // a rollback without --opencode removes the hook binary and leaves the plugin, which then passes every call
    if let (PluginState::Current | PluginState::Outdated, Some(exe)) = (&state, plugin_exe(dir)) {
        // only a path is checked: a bare program name from `--hook-cmd` (`node`) is found through PATH
        if exe.is_absolute() && !exe.is_file() {
            return vec![f(
                "opencode_plugin",
                "warn",
                t(
                    lang,
                    "the OpenCode plugin runs a hook program that is not there, so it checks nothing: rerun setup with --opencode, or roll back with --opencode to remove the plugin",
                    "плагин OpenCode запускает программу хука, которой нет, и ничего не проверяет: снова запустите setup с --opencode или откат с --opencode, чтобы убрать плагин",
                ),
                Some(exe.display().to_string()),
                Some("context-toolkit setup --opencode"),
            )];
        }
    }
    match state {
        PluginState::Missing => vec![],
        PluginState::Current => vec![f(
            "opencode_plugin",
            "ok",
            t(lang, "OpenCode plugin installed", "плагин OpenCode установлен"),
            detail,
            None,
        )],
        PluginState::Outdated => vec![f(
            "opencode_plugin",
            "warn",
            t(
                lang,
                "the OpenCode plugin differs from the one this version writes (an older version, or edited by hand): rerun setup with --opencode and restart OpenCode",
                "плагин OpenCode отличается от того, что пишет эта версия (старая версия или правка вручную): снова запустите setup с --opencode и перезапустите OpenCode",
            ),
            detail,
            Some("context-toolkit setup --opencode"),
        )],
        PluginState::Foreign => vec![f(
            "opencode_plugin",
            "warn",
            t(
                lang,
                "a file that is not ours sits at the OpenCode plugin path: setup --opencode will not overwrite it",
                "на месте плагина OpenCode лежит чужой файл: setup --opencode его не перезапишет",
            ),
            detail,
            None,
        )],
    }
}

/// What of the installation still has the old name `ctxkit`: setup moves it all (the rules block only with
/// `--with-rules`). A warning while the hooks still run the old binary, a note for leftovers.
fn legacy_name(
    profile: &Path,
    settings: &Value,
    md: Option<&String>,
    lang: Lang,
) -> Option<Finding> {
    let old_hooks = ["PreToolUse", "PostToolUse", "Stop"].iter().any(|ev| {
        settings["hooks"][ev]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|g| g["hooks"].as_array().into_iter().flatten())
            .any(|h| h["command"].as_str().and_then(crate::setup::our_name) == Some("ctxkit"))
    });
    let old_markers = md.is_some_and(|m| crate::setup::has_old_markers(m));
    let hooks_dir = profile.join("hooks");
    // The owner's own old policy file next to the new one: setup leaves it (it is theirs), so only they can drop it.
    let old_cfg = profile.join(crate::policy::LEGACY_FILE);
    let owners_leftover = profile.join(crate::policy::FILE).exists()
        && serde_json::from_slice::<Value>(&fs::read(&old_cfg).unwrap_or_default())
            .map_or(true, |v| !crate::policy::made_by_setup(v.get("created_by")));
    let cfg_part = if owners_leftover {
        t(
            lang,
            "ctxkit.json (yours, no longer read: delete it by hand)",
            "ctxkit.json (ваш, больше не читается: удалите вручную)",
        )
    } else {
        crate::policy::LEGACY_FILE
    };
    let parts: Vec<String> = [
        (
            old_hooks,
            format!("hooks -> {}", crate::setup::OLD_BIN_NAME),
        ),
        (
            hooks_dir.join(crate::setup::OLD_BIN_NAME).exists(),
            hooks_dir
                .join(crate::setup::OLD_BIN_NAME)
                .display()
                .to_string(),
        ),
        (
            settings["env"].get("CTXKIT_LANG").is_some(),
            "env.CTXKIT_LANG".to_string(),
        ),
        (old_markers, "<!-- ctxkit:start -->".to_string()),
        (old_cfg.exists(), cfg_part.to_string()),
    ]
    .into_iter()
    .filter_map(|(on, what)| on.then_some(what))
    .collect();
    if parts.is_empty() {
        return None;
    }
    let only_owners = owners_leftover && parts.len() == 1;
    Some(f(
        "legacy_name",
        if old_hooks { "warn" } else { "info" },
        if only_owners {
            t(
                lang,
                "a file of the old name ctxkit is left: your own policy file, which is no longer read",
                "остался файл старого имени ctxkit: ваш файл политик, который больше не читается",
            )
        } else {
            t(
                lang,
                "parts of the installation still have the old name ctxkit: setup moves them to Context Toolkit",
                "часть установки ещё на старом имени ctxkit: setup переведёт её на Инструменты контекста",
            )
        },
        Some(parts.join("; ")),
        if only_owners {
            None
        } else if old_markers {
            Some("context-toolkit setup --with-rules")
        } else {
            Some("context-toolkit setup")
        },
    ))
}

pub fn profile_path(custom: Option<PathBuf>) -> Option<PathBuf> {
    custom
        .or_else(|| env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from))
        .or_else(|| home_dir().map(|h| h.join(".claude")))
}

pub fn run_doctor(args: &[String]) -> i32 {
    let (mut json_out, mut custom, mut opencode_home) = (false, None, None);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json_out = true,
            flag @ ("--profile" | "--opencode-home") => {
                let Some(v) = args.get(i + 1) else {
                    eprintln!("ERR: missing value for {flag}");
                    return 2;
                };
                if flag == "--profile" {
                    custom = Some(PathBuf::from(v));
                } else {
                    opencode_home = Some(PathBuf::from(v));
                }
                i += 1;
            }
            "--help" | "-h" => {
                println!("Usage: context-toolkit doctor [--json] [--profile <dir>] [--opencode-home <dir>] [--lang en|ru]");
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
                eprintln!("ERR: unknown option '{other}'. Usage: context-toolkit doctor [--json] [--profile <dir>] [--opencode-home <dir>] [--lang en|ru]");
                return 2;
            }
        }
        i += 1;
    }
    let Some(profile) = profile_path(custom.clone()) else {
        eprintln!("ERR: cannot determine USERPROFILE / HOME directory");
        return 1;
    };
    let lang = detect_lang(args);
    crate::set_lang(lang); // the helpers shared with setup (parse errors of the policy file, ...) speak the same language
    let mut findings = diagnose(&profile, lang);
    // A profile given by path (a test or another home) is not checked against the real OpenCode config.
    let opencode_dir = opencode_home.or_else(|| {
        custom
            .is_none()
            .then(home_dir)
            .flatten()
            .map(|h| crate::setup::opencode::config_dir(None, &h))
    });
    if let Some(dir) = opencode_dir {
        findings.extend(opencode_findings(&dir, lang));
    }
    let failed = findings.iter().any(|x| x.severity == "error");
    if json_out {
        let list: Vec<Value> = findings
            .iter()
            .map(|x| json!({"id": x.id, "severity": x.severity, "message": x.message, "detail": x.detail, "fix": x.fix}))
            .collect();
        let doc = json!({
            "schema": 1,
            "tool": "context-toolkit",
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
    fn opencode_plugin_is_said_only_when_there() {
        use crate::setup::opencode::{plugin_path, plugin_text};
        let d = temp("ctk_doctor_opencode");
        assert!(opencode_findings(&d, Lang::En).is_empty());
        let p = plugin_path(&d);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        let exe = d.join("context-toolkit.exe");
        let ours = plugin_text(&exe.to_string_lossy(), &["--opencode".into()]);
        fs::write(&p, &ours).unwrap();
        // the hook program is gone (a rollback without --opencode): the plugin checks nothing
        let gone = opencode_findings(&d, Lang::En);
        assert_eq!(sev(&gone, "opencode_plugin"), "warn");
        assert!(gone[0].message.contains("not there"));
        // a program name from --hook-cmd is looked up in PATH by OpenCode, not here
        fs::write(
            &p,
            plugin_text("node", &["g.mjs".into(), "--opencode".into()]),
        )
        .unwrap();
        assert_eq!(
            sev(&opencode_findings(&d, Lang::En), "opencode_plugin"),
            "ok"
        );
        fs::write(&p, &ours).unwrap();
        fs::write(&exe, "x").unwrap();
        assert_eq!(
            sev(&opencode_findings(&d, Lang::En), "opencode_plugin"),
            "ok"
        );
        fs::write(&p, ours.replace("TIMEOUT_MS = 15000", "TIMEOUT_MS = 1")).unwrap();
        assert_eq!(
            sev(&opencode_findings(&d, Lang::En), "opencode_plugin"),
            "warn"
        );
        fs::write(&p, "export default {}\n").unwrap();
        assert_eq!(
            sev(&opencode_findings(&d, Lang::En), "opencode_plugin"),
            "warn"
        );
        let _ = fs::remove_dir_all(&d);
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
        let exe = d.join("context-toolkit.exe");
        fs::write(&exe, b"x").unwrap();
        let cmd = format!("\"{}\"", exe.to_string_lossy().replace('\\', "/"));
        let settings = json!({
            "model": "sonnet",
            "modelSettings": {"claude-sonnet-5-5": {"effortLevel": "high"}},
            "env": {"CLAUDE_CODE_SUBAGENT_MODEL": "sonnet"},
            "hooks": {"PreToolUse": [{"matcher": "Read", "hooks": [{"type": "command", "command": cmd}]}]}
        });
        fs::write(d.join("settings.json"), settings.to_string()).unwrap();
        fs::write(d.join("agents").join("Explore.md"), "x").unwrap();
        fs::write(d.join("agents").join("checker.md"), "x").unwrap();
        fs::write(
            d.join("CLAUDE.md"),
            "<!-- context-toolkit:start -->\nr\n<!-- context-toolkit:end -->\n",
        )
        .unwrap();
        let v = diagnose(&d, Lang::En);
        assert!(v
            .iter()
            .all(|x| x.severity != "warn" && x.severity != "error"));
        assert!(v.iter().all(|x| x.id != "legacy_name"));
        fs::remove_file(&exe).unwrap();
        assert_eq!(sev(&diagnose(&d, Lang::En), "hooks"), "error");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn an_installation_of_the_old_name_is_installed_and_named_legacy() {
        let d = temp("ctk_doctor_legacy");
        fs::create_dir_all(d.join("hooks")).unwrap();
        let exe = d.join("hooks").join(crate::setup::OLD_BIN_NAME);
        fs::write(&exe, b"x").unwrap();
        let cmd = format!("\"{}\"", exe.to_string_lossy().replace('\\', "/"));
        let settings = json!({
            "env": {"CTXKIT_LANG": "ru"},
            "hooks": {"PreToolUse": [{"matcher": "Read", "hooks": [{"type": "command", "command": cmd}]}]}
        });
        fs::write(d.join("settings.json"), settings.to_string()).unwrap();
        fs::write(
            d.join("CLAUDE.md"),
            "<!-- ctxkit:start -->\nr\n<!-- ctxkit:end -->\n",
        )
        .unwrap();
        fs::write(
            d.join("ctxkit.json"),
            r#"{"policies":{"stray_files":true}}"#,
        )
        .unwrap();
        let v = diagnose(&d, Lang::En);
        assert_eq!(sev(&v, "hooks"), "ok", "the old binary still guards");
        assert_eq!(sev(&v, "rules_block"), "ok");
        let legacy = v.iter().find(|x| x.id == "legacy_name").unwrap();
        assert_eq!(legacy.severity, "warn");
        assert_eq!(legacy.fix, Some("context-toolkit setup --with-rules"));
        let detail = legacy.detail.as_deref().unwrap();
        for part in [
            "hooks ->",
            "env.CTXKIT_LANG",
            "<!-- ctxkit:start -->",
            "ctxkit.json",
        ] {
            assert!(detail.contains(part), "{part}: {detail}");
        }
        let pol = v.iter().find(|x| x.id == "policies").unwrap();
        assert!(
            pol.message.contains("ctxkit.json") && pol.detail.as_deref() == Some("stray_files")
        );
        // after the move only a leftover file of the owner's is named, as a note
        let new_cmd = cmd.replace("ctxkit", "context-toolkit");
        fs::write(exe.with_file_name(crate::setup::BIN_NAME), b"x").unwrap();
        fs::remove_file(&exe).unwrap();
        let settings = json!({"hooks": {"PreToolUse": [{"hooks": [{"command": new_cmd}]}]}});
        fs::write(d.join("settings.json"), settings.to_string()).unwrap();
        fs::write(
            d.join("CLAUDE.md"),
            "<!-- context-toolkit:start -->\nr\n<!-- context-toolkit:end -->\n",
        )
        .unwrap();
        let v = diagnose(&d, Lang::Ru);
        let legacy = v.iter().find(|x| x.id == "legacy_name").unwrap();
        assert_eq!(legacy.severity, "info");
        assert_eq!(legacy.detail.as_deref(), Some("ctxkit.json"));
        assert_eq!(legacy.fix, Some("context-toolkit setup"));
        assert!(legacy.message.contains("Инструменты контекста"));
        // the owner's own old file next to the new one: setup leaves it, so there is no setup fix
        fs::write(d.join("context-toolkit.json"), "{}").unwrap();
        let v = diagnose(&d, Lang::Ru);
        let legacy = v.iter().find(|x| x.id == "legacy_name").unwrap();
        assert_eq!(legacy.fix, None);
        assert!(legacy
            .detail
            .as_deref()
            .unwrap()
            .contains("больше не читается"));
        fs::remove_file(d.join("ctxkit.json")).unwrap();
        assert!(diagnose(&d, Lang::En).iter().all(|x| x.id != "legacy_name"));
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
    fn missing_model_settings_for_a_known_model_warns() {
        let d = temp("ctxkit_doctor_model_settings");
        let has = |s: Value| {
            fs::write(d.join("settings.json"), s.to_string()).unwrap();
            diagnose(&d, Lang::En)
                .into_iter()
                .find(|x| x.id == "model_settings")
        };
        let w = has(json!({"model": "sonnet"})).unwrap();
        assert_eq!(w.severity, "warn");
        assert_eq!(
            w.fix,
            Some("context-toolkit setup --main-model <model> --effort <level>")
        );
        let detail = w.detail.unwrap();
        assert!(
            detail.contains("modelSettings.claude-sonnet-5-5")
                && detail.contains(crate::setup::MODEL_ALIASES_AS_OF)
        );
        // a full id is a known model as well; an entry for it (even an empty one) is enough
        assert!(has(json!({"model": "claude-opus-5-5"})).is_some());
        assert!(
            has(json!({"model": "claude-opus-5-5", "modelSettings": {"claude-opus-5-5": {}}}))
                .is_none()
        );
        assert!(
            has(json!({"model": "opus", "modelSettings": {"claude-sonnet-5-5": {}}})).is_some()
        );
        // an unnamed model (no key, an id setup cannot map) gives no such finding
        assert!(has(json!({})).is_none());
        assert!(has(json!({"model": "sonnet[1m]"})).is_none());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn doubled_or_unbalanced_markers_warn_with_the_path() {
        let d = temp("ctxkit_doctor_markers");
        let block = "<!-- ctxkit:start -->\nr\n<!-- ctxkit:end -->\n";
        let find = |text: &str| {
            fs::write(d.join("CLAUDE.md"), text).unwrap();
            diagnose(&d, Lang::En)
                .into_iter()
                .find(|x| x.id == "rules_markers")
        };
        assert!(find(block).is_none());
        assert!(
            find("see <!-- ctxkit:start --> in text\n").is_none(),
            "a mention in a sentence is not a marker"
        );
        let doubled = find(&format!("{block}\n{block}")).unwrap();
        assert_eq!(doubled.severity, "warn");
        assert!(doubled.detail.unwrap().contains("CLAUDE.md"));
        assert!(find("a\n<!-- ctxkit:start -->\nno end\n").is_some());
        assert!(find("<!-- ctxkit:end -->\n").is_some());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn stop_gate_without_checker_and_advisor_is_called_silent() {
        let d = temp("ctxkit_doctor_gate");
        let stop = json!({"hooks": {"Stop": [{"hooks": [{"command": "C:/x/ctxkit.exe"}]}]}});
        fs::write(d.join("settings.json"), stop.to_string()).unwrap();
        let msg = |d: &Path| {
            let v = diagnose(d, Lang::En);
            v.iter().find(|x| x.id == "stop_gate").unwrap().message
        };
        assert!(msg(&d).contains("stays silent"));
        fs::write(d.join("agents").join("checker.md"), "x").unwrap();
        assert_eq!(msg(&d), "Stop gate installed");
        let _ = fs::remove_dir_all(&d);
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
    fn ctxkit_json_is_reported_only_when_present_and_a_broken_one_warns() {
        let d = temp("ctxkit_doctor_policies");
        let find = |text: Option<&str>| {
            match text {
                Some(t) => fs::write(d.join("ctxkit.json"), t).unwrap(),
                None => {
                    let _ = fs::remove_file(d.join("ctxkit.json"));
                }
            }
            diagnose(&d, Lang::En)
                .into_iter()
                .find(|x| x.id == "policies")
        };
        assert!(find(None).is_none());
        let ok = find(Some(
            r#"{"policies":{"commit_hygiene":true,"build_slots":2}}"#,
        ))
        .unwrap();
        assert_eq!(ok.severity, "info");
        assert_eq!(ok.detail.unwrap(), "commit_hygiene, build_slots=2");
        let bad = find(Some(r#"{"policies":{"commit_hygiene":"yes"}}"#)).unwrap();
        assert_eq!(bad.severity, "warn");
        assert!(bad.detail.unwrap().contains("commit_hygiene"));
        assert_eq!(find(Some("{")).unwrap().severity, "warn");
        // a file with a byte that is not UTF-8 is unreadable for the hooks, so it is not "fine" here either
        fs::write(
            d.join("ctxkit.json"),
            b"{\"policies\":{\"stray_files\":true}} \xff",
        )
        .unwrap();
        let utf = diagnose(&d, Lang::En)
            .into_iter()
            .find(|x| x.id == "policies")
            .unwrap();
        assert_eq!(utf.severity, "warn");
        assert!(utf.fix.unwrap().contains("delete the file"));
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
