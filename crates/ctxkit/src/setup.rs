use crate::{parse_lang, Lang};
use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const MARKER_START: &str = "<!-- ctxkit:start -->";
const MARKER_END: &str = "<!-- ctxkit:end -->";
const LEGACY_MARKER_START: &str = "<!-- claude-guard:start -->";
const LEGACY_MARKER_END: &str = "<!-- claude-guard:end -->";

struct SetupOpts {
    dry_run: bool,
    profile_dir: Option<PathBuf>,
    main_model: String,
    advisor: String,
    subagent: String,
    /// `--subagent` given: only then `CLAUDE_CODE_SUBAGENT_MODEL` is written (it would put every
    /// subagent without its own `model`, code writers included, on that model); `subagent` alone sets Explore.md.
    subagent_env: bool,
    effort: String,
    no_agents: bool,
    force_agents: bool,
    with_rules: bool,
    desktop: bool,
    desktop_model: String,
    desktop_file: Option<PathBuf>,
    antigravity: bool,
    agy_file: Option<PathBuf>,
    dsh: bool,
    dsh_home: Option<PathBuf>,
    hook_cmd: Option<String>,
    claude_json: Option<PathBuf>,
    skip_version_check: bool,
    no_stop_gate: bool,
    lang: Lang,
}

impl Default for SetupOpts {
    fn default() -> Self {
        Self {
            dry_run: false,
            profile_dir: None,
            main_model: "sonnet".to_string(),
            advisor: "fable".to_string(),
            subagent: "haiku".to_string(),
            subagent_env: false,
            effort: "high".to_string(),
            no_agents: false,
            force_agents: false,
            with_rules: false,
            desktop: false,
            desktop_model: "claude-sonnet-5-5".to_string(),
            desktop_file: None,
            antigravity: false,
            agy_file: None,
            dsh: false,
            dsh_home: None,
            hook_cmd: None,
            claude_json: None,
            skip_version_check: false,
            no_stop_gate: false,
            lang: Lang::En,
        }
    }
}

pub fn run_setup(args: &[String]) -> i32 {
    let mut opts = SetupOpts::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => {
                print_help();
                return 0;
            }
            "--dry-run" => opts.dry_run = true,
            "--no-agents" => opts.no_agents = true,
            "--force-agents" => opts.force_agents = true,
            "--with-rules" => opts.with_rules = true,
            "--desktop" => opts.desktop = true,
            "--antigravity" => opts.antigravity = true,
            "--dsh" => opts.dsh = true,
            "--skip-version-check" => opts.skip_version_check = true,
            "--no-stop-gate" => opts.no_stop_gate = true,
            flag @ ("--profile" | "--main-model" | "--advisor" | "--subagent" | "--effort"
            | "--desktop-model" | "--desktop-file" | "--agy-file" | "--dsh-home"
            | "--hook-cmd" | "--claude-json" | "--lang") => {
                let Some(val) = args.get(i + 1) else {
                    eprintln!("ERR: missing value for {flag}");
                    return 2;
                };
                match flag {
                    "--profile" => opts.profile_dir = Some(PathBuf::from(val)),
                    "--main-model" => opts.main_model = val.clone(),
                    "--advisor" => opts.advisor = val.clone(),
                    "--subagent" => {
                        opts.subagent = val.clone();
                        opts.subagent_env = true;
                    }
                    "--effort" => opts.effort = val.clone(),
                    "--desktop-model" => opts.desktop_model = val.clone(),
                    "--desktop-file" => opts.desktop_file = Some(PathBuf::from(val)),
                    "--agy-file" => opts.agy_file = Some(PathBuf::from(val)),
                    "--dsh-home" => opts.dsh_home = Some(PathBuf::from(val)),
                    "--hook-cmd" => opts.hook_cmd = Some(val.clone()),
                    "--claude-json" => opts.claude_json = Some(PathBuf::from(val)),
                    "--lang" => {
                        let Some(parsed) = parse_lang(val) else {
                            eprintln!("ERR: unsupported --lang '{val}' (use en or ru)");
                            return 2;
                        };
                        opts.lang = parsed;
                    }
                    _ => {}
                }
                i += 1;
            }
            other => {
                eprintln!("ERR: unknown option '{other}'. Run `ctxkit setup --help`.");
                return 2;
            }
        }
        i += 1;
    }

    let Some(home) = home_dir() else {
        eprintln!("ERR: cannot determine USERPROFILE / HOME directory");
        return 1;
    };

    let custom_profile = opts.profile_dir.is_some();
    let profile = opts
        .profile_dir
        .clone()
        .or_else(|| env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from))
        .unwrap_or_else(|| home.join(".claude"));

    let bin_name = if cfg!(windows) {
        "ctxkit.exe"
    } else {
        "ctxkit"
    };
    let hook_bin_path = profile.join("hooks").join(bin_name);
    let hook_cmd = opts.hook_cmd.clone().unwrap_or_else(|| {
        let s = hook_bin_path.to_string_lossy().replace('\\', "/");
        format!("\"{s}\"")
    });

    if opts.dry_run {
        println!("[dry-run] profile: {}", profile.display());
    } else {
        println!("Setting up profile: {}", profile.display());
    }

    // Install current binary into hooks/ and .local/bin/ unless explicit --hook-cmd
    if opts.hook_cmd.is_none() {
        if let Err(e) = install_binary(
            &hook_bin_path,
            &home,
            bin_name,
            custom_profile,
            opts.dry_run,
        ) {
            eprintln!("ERR: binary install failed: {e}");
            return 1;
        }
    }

    let settings_path = profile.join("settings.json");
    let backup_dir = profile.join("backups");
    let mut settings_root =
        match update_claude_settings(&settings_path, &backup_dir, &hook_cmd, &opts) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("ERR: {e}");
                return 1;
            }
        };

    if !opts.no_agents {
        let agents_dir = profile.join("agents");
        if let Err(e) = write_agent_file(
            &agents_dir.join("Explore.md"),
            explore_prompt(&opts.subagent, opts.lang),
            opts.force_agents,
            opts.dry_run,
        ) {
            eprintln!("ERR: {e}");
            return 1;
        }
        if let Err(e) = write_agent_file(
            &agents_dir.join("checker.md"),
            checker_prompt(opts.lang),
            opts.force_agents,
            opts.dry_run,
        ) {
            eprintln!("ERR: {e}");
            return 1;
        }
    }

    if opts.with_rules {
        if let Err(e) = upsert_claude_md(
            &profile.join("CLAUDE.md"),
            &backup_dir,
            &rules_snippet(&opts),
            opts.dry_run,
        ) {
            eprintln!("ERR: {e}");
            return 1;
        }
        if opts.dsh {
            let dsh_home = opts
                .dsh_home
                .clone()
                .or_else(|| env::var_os("DSH_HOME").map(PathBuf::from))
                .unwrap_or_else(|| home.join(".dsh"));
            let dsh_agents = dsh_home.join("AGENTS.md");
            let dsh_backup = dsh_home.join("backups");
            if let Err(e) = upsert_claude_md(
                &dsh_agents,
                &dsh_backup,
                &rules_snippet(&opts),
                opts.dry_run,
            ) {
                eprintln!("ERR: {e}");
                return 1;
            }
        }
    }

    if opts.desktop {
        let dpath = opts
            .desktop_file
            .clone()
            .or_else(|| default_desktop_presets_path(&home));
        if let Some(p) = dpath {
            // The running app keeps its presets in memory and saves them over the file, so a
            // write now would be lost silently. A file passed with --desktop-file is not the app's.
            if p.exists() && opts.desktop_file.is_none() && claude_desktop_running() {
                println!(
                    "  [warn] Claude Desktop is running: it keeps session presets in memory and overwrites {}. Presets left unchanged. Quit it fully (tray icon too) and rerun `ctxkit setup --desktop` from a terminal, or choose the model in the app's model picker.",
                    p.display()
                );
            } else if p.exists() {
                if let Err(e) =
                    update_desktop_presets(&p, &opts.desktop_model, &opts.effort, opts.dry_run)
                {
                    eprintln!("ERR: {e}");
                    return 1;
                }
            } else {
                println!("  skip desktop presets (not found: {})", p.display());
            }
        }
    }

    if opts.antigravity {
        let apath = opts
            .agy_file
            .clone()
            .unwrap_or_else(|| home.join(".gemini").join("config").join("hooks.json"));
        let agy_cmd = opts
            .hook_cmd
            .clone()
            .unwrap_or_else(|| format_antigravity_command(&hook_bin_path, opts.lang));
        if let Err(e) = update_antigravity_hooks(&apath, &agy_cmd, opts.dry_run) {
            eprintln!("ERR: {e}");
            return 1;
        }
    }

    if opts.dsh {
        let dsh_home = opts
            .dsh_home
            .clone()
            .or_else(|| env::var_os("DSH_HOME").map(PathBuf::from))
            .unwrap_or_else(|| home.join(".dsh"));
        let dsh_cmd = opts
            .hook_cmd
            .clone()
            .map(|cmd| format_custom_dsh_command(&cmd, opts.lang))
            .unwrap_or_else(|| format_dsh_command(&hook_bin_path, opts.lang));
        if let Err(e) = update_dsh_hooks(&dsh_home, &dsh_cmd, opts.dry_run) {
            eprintln!("ERR: {e}");
            return 1;
        }
    }

    let claude_json = opts
        .claude_json
        .clone()
        .unwrap_or_else(|| home.join(".claude.json"));
    print_diagnostics(&profile, &mut settings_root, &claude_json, &home, &opts);
    0
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
}

fn default_desktop_presets_path(home: &Path) -> Option<PathBuf> {
    if cfg!(windows) {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("Claude").join("ccd-session-presets.json"))
            .or_else(|| {
                Some(
                    home.join("AppData")
                        .join("Roaming")
                        .join("Claude")
                        .join("ccd-session-presets.json"),
                )
            })
    } else if cfg!(target_os = "macos") {
        Some(
            home.join("Library")
                .join("Application Support")
                .join("Claude")
                .join("ccd-session-presets.json"),
        )
    } else {
        Some(
            home.join(".config")
                .join("Claude")
                .join("ccd-session-presets.json"),
        )
    }
}

fn install_binary(
    hook_bin: &Path,
    home: &Path,
    bin_name: &str,
    custom_profile: bool,
    dry_run: bool,
) -> Result<(), String> {
    let exe = env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let mut targets = vec![hook_bin.to_path_buf()];
    if !custom_profile {
        targets.push(home.join(".local").join("bin").join(bin_name));
    }
    for dst in targets {
        if same_file_bytes(&exe, &dst) {
            println!("  ok bin {}", dst.display());
            continue;
        }
        if dry_run {
            println!("  [dry-run] install bin -> {}", dst.display());
            continue;
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        fs::copy(&exe, &dst).map_err(|e| format!("copy to {}: {e}", dst.display()))?;
        println!("  installed {}", dst.display());
    }
    Ok(())
}

fn same_file_bytes(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    let (Ok(ma), Ok(mb)) = (fs::metadata(a), fs::metadata(b)) else {
        return false;
    };
    if ma.len() != mb.len() {
        return false;
    }
    matches!((fs::read(a), fs::read(b)), (Ok(ba), Ok(bb)) if ba == bb)
}

pub(crate) fn read_json_object(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let clean = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    let val: Value =
        serde_json::from_str(clean).map_err(|e| format!("parse JSON {}: {e}", path.display()))?;
    if !val.is_object() {
        return Err(format!("expected JSON object in {}", path.display()));
    }
    Ok(val)
}

fn backup_file(path: &Path, backup_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(backup_dir).map_err(|e| format!("mkdir {}: {e}", backup_dir.display()))?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("config.json");
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut dst = backup_dir.join(format!("{name}.{ts}.bak"));
    let mut seq = 1u32;
    while dst.exists() {
        dst = backup_dir.join(format!("{name}.{ts}.{seq}.bak"));
        seq += 1;
    }
    fs::copy(path, &dst)
        .map_err(|e| format!("backup {} -> {}: {e}", path.display(), dst.display()))?;
    Ok(dst)
}

fn write_json_if_changed(
    path: &Path,
    backup_dir: Option<&Path>,
    orig: &Value,
    updated: &Value,
    dry_run: bool,
    label: &str,
) -> Result<(), String> {
    if orig == updated {
        println!("  ok {label} (unchanged): {}", path.display());
        return Ok(());
    }
    if dry_run {
        println!("  [dry-run] update {label}: {}", path.display());
        return Ok(());
    }
    if path.exists() {
        let bdir = backup_dir.map(Path::to_path_buf).unwrap_or_else(|| {
            let parent = path.parent().unwrap_or_else(|| Path::new("."));
            parent.join("backups")
        });
        let b = backup_file(path, &bdir)?;
        println!("  backup -> {}", b.display());
    } else if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let pretty =
        serde_json::to_string_pretty(updated).map_err(|e| format!("serialize {label}: {e}"))?;
    fs::write(path, format!("{pretty}\n")).map_err(|e| format!("write {}: {e}", path.display()))?;
    println!("  updated {label}: {}", path.display());
    Ok(())
}

fn update_claude_settings(
    path: &Path,
    backup_dir: &Path,
    hook_cmd: &str,
    opts: &SetupOpts,
) -> Result<Value, String> {
    let orig = read_json_object(path)?;
    let mut next = orig.clone();
    let root = next.as_object_mut().ok_or("settings root is not object")?;

    root.insert("model".to_string(), Value::String(opts.main_model.clone()));
    if opts.advisor.eq_ignore_ascii_case("none") {
        root.remove("advisorModel");
    } else {
        root.insert(
            "advisorModel".to_string(),
            Value::String(opts.advisor.clone()),
        );
    }
    root.insert(
        "effortLevel".to_string(),
        Value::String(opts.effort.clone()),
    );

    // Claude Code ignores a top-level user-level `effortLevel` on Opus 5.5 and later models; the per-model
    // `modelSettings` entry (v2.1.251+) is the documented way. `max` is not accepted there.
    match (
        canonical_model_id(&opts.main_model),
        matches!(opts.effort.as_str(), "low" | "medium" | "high" | "xhigh"),
    ) {
        (Some(id), true) => {
            let entry = ensure_object(ensure_object(root, "modelSettings")?, &id)?;
            entry.insert("effortLevel".to_string(), Value::String(opts.effort.clone()));
            println!("  effort: modelSettings.{id}.effortLevel = {}", opts.effort);
        }
        _ => println!(
            "  effort: modelSettings not written (needs a known main model and low|medium|high|xhigh); top-level effortLevel only"
        ),
    }

    let env_obj = ensure_object(root, "env")?;
    if opts.subagent_env {
        env_obj.insert(
            "CLAUDE_CODE_SUBAGENT_MODEL".to_string(),
            Value::String(opts.subagent.clone()),
        );
    }
    match opts.lang {
        Lang::Ru => {
            env_obj.insert("CTXKIT_LANG".to_string(), Value::String("ru".to_string()));
        }
        Lang::En => {
            env_obj.remove("CTXKIT_LANG");
        }
    }

    let hooks_obj = ensure_object(root, "hooks")?;
    upsert_claude_hook_event(
        hooks_obj,
        "PreToolUse",
        Some("Bash|PowerShell|Write|Read|Edit|MultiEdit"),
        hook_cmd,
    );
    upsert_claude_hook_event(
        hooks_obj,
        "PostToolUse",
        Some("Edit|Write|MultiEdit"),
        hook_cmd,
    );
    // Stop takes no matcher. The gate fires once per turn (see gate.rs); --no-stop-gate removes our group.
    if opts.no_stop_gate {
        remove_our_hook_event(hooks_obj, "Stop", Some(hook_cmd));
        println!("  Stop gate: off (--no-stop-gate); our Stop hook is removed if present");
    } else {
        upsert_claude_hook_event(hooks_obj, "Stop", None, hook_cmd);
        println!(
            "  Stop gate: on, hook Stop sends the model back once per turn if code edits lack checker/advisor; remove with --no-stop-gate"
        );
    }

    write_json_if_changed(
        path,
        Some(backup_dir),
        &orig,
        &next,
        opts.dry_run,
        "settings.json",
    )?;
    Ok(next)
}

/// Canonical id for the `modelSettings` key. shortcut: alias table of 2026-11-15 (docs: `sonnet` is Sonnet 5.5,
/// `opus` Opus 5.5, `haiku` Haiku 5.5, `fable` Fable 5.2); refresh when the aliases move to new releases.
fn canonical_model_id(model: &str) -> Option<String> {
    match model {
        "sonnet" => Some("claude-sonnet-5-5".to_string()),
        "opus" => Some("claude-opus-5-5".to_string()),
        "haiku" => Some("claude-haiku-5-5".to_string()),
        "fable" => Some("claude-fable-5-2".to_string()),
        m if m.starts_with("claude-") => Some(m.to_string()),
        _ => None,
    }
}

fn ensure_object<'a>(
    parent: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    if !parent.contains_key(key) {
        parent.insert(key.to_string(), Value::Object(Map::new()));
    }
    parent
        .get_mut(key)
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| format!("'{key}' is not a JSON object"))
}

/// Splits the first `n` words of a command line; quotes (" or ') keep a path with spaces in one word.
fn first_words(cmd: &str, n: usize) -> Vec<String> {
    let (mut words, mut cur, mut quote) = (Vec::new(), String::new(), None::<char>);
    for c in cmd.trim().chars() {
        match c {
            '"' | '\'' if quote.is_none() => quote = Some(c),
            c if quote == Some(c) => quote = None,
            c if c.is_whitespace() && quote.is_none() => {
                if !cur.is_empty() {
                    words.push(std::mem::take(&mut cur));
                    if words.len() == n {
                        return words;
                    }
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
}

/// The one rule for "this hook command is ctxkit's": it equals the command being installed
/// (`--hook-cmd`), or one of its first two words (the exe, or `node <script>`) is a file named
/// `ctxkit` / `claude-guard` / `no-inline-backslash` (any case, .exe/.js/.mjs/.cmd or none).
/// A foreign command that merely has "ctxkit" somewhere in its path is not ours.
pub(crate) fn command_is_ours(cmd: &str, current: Option<&str>) -> bool {
    if current.is_some_and(|c| c.trim() == cmd.trim()) {
        return true;
    }
    first_words(cmd, 2).iter().any(|w| {
        let base = w
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        let stem = [".exe", ".js", ".mjs", ".cmd"]
            .iter()
            .find_map(|e| base.strip_suffix(e))
            .unwrap_or(&base);
        matches!(stem, "ctxkit" | "claude-guard" | "no-inline-backslash")
    })
}

fn hook_is_ours(h: &Value, current: Option<&str>) -> bool {
    h.get("command")
        .and_then(|c| c.as_str())
        .is_some_and(|c| command_is_ours(c, current))
}

pub(crate) fn is_our_hook_group(group: &Value, current: Option<&str>) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .is_some_and(|a| a.iter().any(|h| hook_is_ours(h, current)))
}

/// Removes only our elements from `hooks[]` of every group; a group is dropped only when it ends up
/// empty, so foreign elements (and their matcher) survive even when they shared a group with ours.
fn strip_our_hooks(list: Vec<Value>, current: Option<&str>) -> Vec<Value> {
    list.into_iter()
        .filter_map(|mut g| {
            if !is_our_hook_group(&g, current) {
                return Some(g);
            }
            let arr = g.get_mut("hooks")?.as_array_mut()?;
            arr.retain(|h| !hook_is_ours(h, current));
            (!arr.is_empty()).then_some(g)
        })
        .collect()
}

fn upsert_claude_hook_event(
    hooks: &mut Map<String, Value>,
    event: &str,
    matcher: Option<&str>,
    command: &str,
) {
    let list = hooks
        .get(event)
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut list = strip_our_hooks(list, Some(command));
    let mut group = json!({
        "hooks": [{
            "type": "command",
            "command": command,
            "timeout": 10
        }]
    });
    if let Some(m) = matcher {
        group["matcher"] = Value::String(m.to_string());
    }
    list.insert(0, group);
    hooks.insert(event.to_string(), Value::Array(list));
}

/// Drops our hook elements from `event`, keeps foreign ones, and removes the key when nothing is left.
fn remove_our_hook_event(hooks: &mut Map<String, Value>, event: &str, current: Option<&str>) {
    let Some(list) = hooks.get(event).and_then(|v| v.as_array()) else {
        return;
    };
    let kept = strip_our_hooks(list.clone(), current);
    if kept.is_empty() {
        hooks.remove(event);
    } else {
        hooks.insert(event.to_string(), Value::Array(kept));
    }
}

fn write_agent_file(
    path: &Path,
    content: String,
    force: bool,
    dry_run: bool,
) -> Result<(), String> {
    if path.exists() && !force {
        let existing = fs::read_to_string(path).unwrap_or_default();
        if existing == content {
            println!("  ok agent (unchanged): {}", path.display());
        } else {
            println!(
                "  keep existing agent (pass --force-agents to overwrite): {}",
                path.display()
            );
        }
        return Ok(());
    }
    if dry_run {
        println!("  [dry-run] write agent: {}", path.display());
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(path, content).map_err(|e| format!("write {}: {e}", path.display()))?;
    println!("  wrote agent: {}", path.display());
    Ok(())
}

fn upsert_claude_md(
    path: &Path,
    backup_dir: &Path,
    block: &str,
    dry_run: bool,
) -> Result<(), String> {
    let existing = if path.exists() {
        fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?
    } else {
        String::new()
    };

    let updated = if let Some((s, end_idx)) = marker_span(&existing) {
        format!("{}{}{}", &existing[..s], block, &existing[end_idx..])
    } else {
        append_block(&existing, block)
    };

    if existing == updated {
        println!("  ok CLAUDE.md rules (unchanged): {}", path.display());
        return Ok(());
    }
    if dry_run {
        println!("  [dry-run] update CLAUDE.md rules: {}", path.display());
        return Ok(());
    }
    if path.exists() {
        let b = backup_file(path, backup_dir)?;
        println!("  backup -> {}", b.display());
    } else if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(path, updated).map_err(|e| format!("write {}: {e}", path.display()))?;
    println!("  updated CLAUDE.md rules: {}", path.display());
    Ok(())
}

pub(crate) fn marker_span(text: &str) -> Option<(usize, usize)> {
    for (start_m, end_m) in [
        (MARKER_START, MARKER_END),
        (LEGACY_MARKER_START, LEGACY_MARKER_END),
    ] {
        if let (Some(s), Some(e)) = (text.find(start_m), text.find(end_m)) {
            if s < e {
                return Some((s, e + end_m.len()));
            }
        }
    }
    None
}

fn append_block(existing: &str, block: &str) -> String {
    if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{}\n\n{block}\n", existing.trim_end())
    }
}

/// Whether the Claude Desktop app (not the `claude` CLI) is running. Unknown counts as not running.
fn claude_desktop_running() -> bool {
    if cfg!(windows) {
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-Process claude -ErrorAction SilentlyContinue).Path",
            ])
            .output()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .any(is_desktop_exe)
            })
            .unwrap_or(false)
    } else if cfg!(target_os = "macos") {
        Command::new("pgrep")
            .args(["-f", "Claude.app/Contents/MacOS/Claude"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        false
    }
}

/// The Desktop app's `claude.exe`, as opposed to the Claude Code CLI binary of the same name.
// shortcut: known Windows install locations only; extend if Desktop ships to a new folder.
fn is_desktop_exe(path: &str) -> bool {
    let p = path.trim().replace('/', "\\").to_ascii_lowercase();
    p.ends_with("\\claude.exe")
        && (p.contains("\\anthropicclaude\\")
            || p.contains("\\windowsapps\\claude")
            || p.contains("\\programs\\claude\\"))
}

fn update_desktop_presets(
    path: &Path,
    model_id: &str,
    effort: &str,
    dry_run: bool,
) -> Result<(), String> {
    let orig = read_json_object(path)?;
    let mut next = orig.clone();
    let Some(accounts) = next.get_mut("byAccount").and_then(|v| v.as_object_mut()) else {
        println!("  skip desktop presets (no byAccount): {}", path.display());
        return Ok(());
    };
    for (_acct_id, acct) in accounts.iter_mut() {
        if let Some(presets) = acct.get_mut("presets").and_then(|v| v.as_array_mut()) {
            for p in presets.iter_mut() {
                if let Some(s) = p.get_mut("settings").and_then(|v| v.as_object_mut()) {
                    s.insert("modelId".to_string(), Value::String(model_id.to_string()));
                    s.insert("effort".to_string(), Value::String(effort.to_string()));
                }
            }
        }
        if let Some(built_ins) = acct.get_mut("builtIns").and_then(|v| v.as_object_mut()) {
            for (_k, b) in built_ins.iter_mut() {
                if let Some(s) = b.get_mut("settings").and_then(|v| v.as_object_mut()) {
                    s.insert("modelId".to_string(), Value::String(model_id.to_string()));
                    s.insert("effort".to_string(), Value::String(effort.to_string()));
                }
            }
        }
    }
    write_json_if_changed(path, None, &orig, &next, dry_run, "desktop presets")
}

fn format_antigravity_command(hook_bin_path: &Path, lang: Lang) -> String {
    let raw = hook_bin_path.to_string_lossy();
    let base = if raw.contains(' ') {
        if cfg!(windows) {
            format!("\"{}\"", raw.replace('/', "\\"))
        } else {
            format!("\"{raw}\"")
        }
    } else {
        raw.replace('\\', "/")
    };
    match lang {
        Lang::Ru => format!("{base} --lang ru"),
        Lang::En => base,
    }
}

fn update_antigravity_hooks(path: &Path, command: &str, dry_run: bool) -> Result<(), String> {
    let orig = read_json_object(path)?;
    let mut next = orig.clone();
    let root = next
        .as_object_mut()
        .ok_or("hooks.json root is not object")?;
    root.remove("claude-guard");
    root.insert(
        "ctxkit".to_string(),
        json!({
            "PreToolUse": [
                {
                    "matcher": "read_file|write_file|edit_file|run_command",
                    "hooks": [
                        {
                            "type": "command",
                            "command": command,
                            "timeout": 10
                        }
                    ]
                }
            ]
        }),
    );
    write_json_if_changed(path, None, &orig, &next, dry_run, "antigravity hooks.json")
}

const DSH_MARKER_START: &str = "# >>> ctxkit (managed by `ctxkit setup --dsh`; do not edit) >>>";
const DSH_MARKER_END: &str = "# <<< ctxkit <<<";
const DSH_HOOKS_PLUGIN: &str = "@deepseek-ai/dsh-hooks-claude-code";

/// DSH runs hook commands via `pwsh -Command` on Windows and `bash -c` elsewhere.
fn format_dsh_command(hook_bin_path: &Path, lang: Lang) -> String {
    let raw = hook_bin_path.to_string_lossy().replace('\\', "/");
    // Always single-quote: a bare path breaks on `'`, `$`, `;` or spaces.
    let base = if cfg!(windows) {
        format!("& '{}'", raw.replace('\'', "''"))
    } else {
        format!("'{}'", raw.replace('\'', "'\\''"))
    };
    match lang {
        Lang::Ru => format!("{base} --dsh --lang ru"),
        Lang::En => format!("{base} --dsh"),
    }
}

fn format_custom_dsh_command(cmd: &str, lang: Lang) -> String {
    let mut res = cmd.trim().to_string();
    if !res.contains("--dsh") {
        res.push_str(" --dsh");
    }
    if lang == Lang::Ru && !res.contains("--lang") {
        res.push_str(" --lang ru");
    }
    if cfg!(windows) && res.starts_with('"') && !res.starts_with("& ") {
        res = format!("& {res}");
    }
    res
}

/// Writes `<dsh_home>/ctxkit-hooks.json` and mounts the official Claude Code hook
/// bridge on it from the desktop profile's `cordis.patch.yml`.
fn update_dsh_hooks(dsh_home: &Path, command: &str, dry_run: bool) -> Result<(), String> {
    let profile = dsh_home.join("profiles").join("desktop");
    if !profile.exists() {
        println!("  skip DeepSeek Harness (not found: {})", profile.display());
        return Ok(());
    }
    let patch_path = profile.join("cordis.patch.yml");
    if !patch_path.exists() {
        if dry_run {
            println!(
                "  [dry-run] create DeepSeek Harness profile patch: {}",
                patch_path.display()
            );
        } else {
            fs::write(&patch_path, "# DeepSeek Harness profile patch\n")
                .map_err(|e| format!("write {}: {e}", patch_path.display()))?;
            println!(
                "  created DeepSeek Harness profile patch: {}",
                patch_path.display()
            );
        }
    }

    let global_patch = dsh_home.join("cordis.patch.yml");
    if global_patch.exists() {
        if let Ok(content) = fs::read_to_string(&global_patch) {
            if content.contains(DSH_HOOKS_PLUGIN) || content.contains("orca-agent-hooks") {
                println!(
                    "  [warn] {} contains hook plugins (might conflict or duplicate hooks with profile desktop)",
                    global_patch.display()
                );
            }
        }
    }

    let hooks_path = dsh_home.join("ctxkit-hooks.json");
    let group = |matcher: &str| json!([{ "matcher": matcher, "hooks": [{ "type": "command", "command": command, "timeout": 10 }] }]);
    let hooks = json!({ "hooks": {
        "PreToolUse": group("read|write|edit|apply_patch|bash|pwsh"),
        "PostToolUse": group("write|edit|apply_patch"),
    }});
    let orig = read_json_object(&hooks_path)?;
    write_json_if_changed(
        &hooks_path,
        None,
        &orig,
        &hooks,
        dry_run,
        "DeepSeek Harness hooks",
    )?;

    let config_path = hooks_path.to_string_lossy().replace('\'', "''");
    let block = format!(
        "{DSH_MARKER_START}\n- insert:\n    - id: ctxkit-hooks\n      name: '{DSH_HOOKS_PLUGIN}'\n      config:\n        configPath: '{config_path}'\n{DSH_MARKER_END}"
    );
    let existing = fs::read_to_string(&patch_path)
        .map_err(|e| format!("read {}: {e}", patch_path.display()))?;
    let updated = match existing.find(DSH_MARKER_START) {
        // Pair the start marker only with an end marker after it; guessing the span of a
        // half-deleted block would eat the user's own entries.
        Some(s) => match existing[s..].find(DSH_MARKER_END) {
            Some(len) => {
                format!("{}{block}{}", &existing[..s], &existing[s + len + DSH_MARKER_END.len()..])
            }
            None => {
                return Err(format!(
                    "{}: ctxkit start marker has no end marker; remove the leftover ctxkit block by hand and rerun",
                    patch_path.display()
                ))
            }
        },
        None => {
            // The block is a sequence item: appending it to a flow list or a mapping breaks the YAML.
            let first = existing.lines().find(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'));
            if first.is_some_and(|l| l.trim_end() != "-" && !l.starts_with("- ")) {
                return Err(format!(
                    "{}: top level is not a block list (`- ...`); add the entry from examples/dsh-cordis.patch.yml by hand",
                    patch_path.display()
                ));
            }
            append_block(&existing, &block)
        }
    };
    if existing == updated {
        println!(
            "  ok DeepSeek Harness profile patch (unchanged): {}",
            patch_path.display()
        );
    } else if dry_run {
        println!(
            "  [dry-run] update DeepSeek Harness profile patch: {}",
            patch_path.display()
        );
    } else {
        let b = backup_file(&patch_path, &profile)?;
        println!("  backup -> {}", b.display());
        fs::write(&patch_path, updated)
            .map_err(|e| format!("write {}: {e}", patch_path.display()))?;
        println!(
            "  updated DeepSeek Harness profile patch: {}",
            patch_path.display()
        );
    }

    // The bridge is not bundled with the desktop app; without it the insert loads nothing.
    // Its peer dependencies pin the exact app version, so an app update needs a matching reinstall.
    let json_str = |path: PathBuf, key: &str| {
        let v = if path.exists() {
            read_json_object(&path).ok()
        } else {
            None
        };
        v.and_then(|v| v.get(key).and_then(|s| s.as_str()).map(String::from))
    };
    let plugin_dir = DSH_HOOKS_PLUGIN
        .split('/')
        .fold(profile.join("node_modules"), |p, s| p.join(s));
    let installed = json_str(plugin_dir.join("package.json"), "version");
    let app = json_str(
        dsh_home
            .join("dsh-runtimes")
            .join("dsh-primary-runtime")
            .join("runtime.json"),
        "desktopVersion",
    );
    let problem = match (&installed, &app) {
        (None, _) => "is not installed",
        (Some(i), Some(a)) if i != a => "does not match the app version",
        _ => "",
    };
    if problem.is_empty() {
        println!("  [ok]   DeepSeek Harness: {DSH_HOOKS_PLUGIN} is installed; restart the app to load hooks");
    } else {
        let version = app.unwrap_or_else(|| "<DSH version>".to_string());
        println!(
            "  [warn] DeepSeek Harness: {DSH_HOOKS_PLUGIN} {problem} in {} (installed: {}) - hooks stay inactive. Run there: pnpm add -E {DSH_HOOKS_PLUGIN}@{version} @deepseek-ai/dsh-hook-protocol@{version} and restart the app.",
            profile.display(),
            installed.as_deref().unwrap_or("none")
        );
    }
    Ok(())
}

fn explore_prompt(model: &str, lang: Lang) -> String {
    match lang {
        Lang::Ru => format!(
            "---\n\
name: Explore\n\
description: Fast read-only search and codebase/docs research on {model}. Use for finding files, grepping symbols, and reading specific line ranges instead of doing broad searches in the main session.\n\
model: {model}\n\
tools: Read, Grep, Glob\n\
---\n\n\
Ты быстрый read-only исследователь кодовой базы. Не редактируй файлы и не создавай отчёты на диске.\n\n\
- Сначала локализуй цель через `Glob` и `Grep`, затем читай только нужные диапазоны строк через `Read` (не выгружай длинные файлы целиком).\n\
- Возвращай короткий структурированный ответ на русском: точные пути, номера строк, имена символов и краткую суть без воды.\n"
        ),
        Lang::En => format!(
            "---\n\
name: Explore\n\
description: Fast read-only search and codebase/docs research on {model}. Use for finding files, grepping symbols, and reading specific line ranges instead of keeping broad searches in the main context.\n\
model: {model}\n\
tools: Read, Grep, Glob\n\
---\n\n\
You are a fast read-only codebase explorer. Never edit files or write reports to disk.\n\n\
- Locate targets via `Glob` and `Grep` first, then `Read` only needed line ranges (never dump large files).\n\
- Return a concise structured summary: exact file paths, line numbers, symbol names, and key facts only.\n"
        ),
    }
}

fn checker_prompt(lang: Lang) -> String {
    match lang {
        Lang::Ru => "---\n\
name: checker\n\
description: Independent Opus verifier. Reads the diff, runs tests, and tries edge cases before a non-trivial task is declared done. Never edits code.\n\
model: opus\n\
effort: high\n\
tools: Read, Grep, Glob, Bash\n\
---\n\n\
Ты независимый проверяющий. Ты не писал этот код и не имеешь права его править.\n\n\
- Проверь изменения по сути задачи: изучи `git diff`, прогони релевантные тесты и проверки типов/линтера, проверь граничные случаи.\n\
- Не создавай временных отчётов на диске и удали/закрой за собой всё, что запустил.\n\
- Отвечай по-русски. Сообщай только о реальных проблемах: файл, строка или команда, что именно сломано или не проверено. Если всё чисто — напиши это в одну строку и перечисли, что именно проверил.\n"
            .to_string(),
        Lang::En => "---\n\
name: checker\n\
description: Independent Opus verifier. Reads the diff, runs tests, and probes edge cases before a non-trivial task is declared done. Never edits code.\n\
model: opus\n\
effort: high\n\
tools: Read, Grep, Glob, Bash\n\
---\n\n\
You are an independent verifier. You did not write this code and must never modify it.\n\n\
- Inspect `git diff`, run relevant tests and type/lint checks, and probe edge cases.\n\
- Do not write reports to disk and clean up anything temporary you start.\n\
- Report only real issues (file, line/command, failure mode). If everything is clean, confirm in one line listing exact verified checks.\n"
            .to_string(),
    }
}

fn rules_snippet(opts: &SetupOpts) -> String {
    let adv = if opts.advisor.eq_ignore_ascii_case("none") {
        None
    } else {
        Some(opts.advisor.as_str())
    };
    // The gate sentence must match what setup really wires (--no-stop-gate) and what is configured (--advisor none).
    let gate = match (opts.no_stop_gate, adv.is_some(), opts.lang) {
        (true, _, _) => "",
        (false, true, Lang::Ru) => {
            "; хук Stop один раз вернёт тебя, если правки остались без `checker` или advisor"
        }
        (false, false, Lang::Ru) => {
            "; хук Stop один раз вернёт тебя, если правки остались без `checker`"
        }
        (false, true, Lang::En) => {
            "; the Stop hook sends you back once if edits were left without `checker` or advisor"
        }
        (false, false, Lang::En) => {
            "; the Stop hook sends you back once if edits were left without `checker`"
        }
    };
    match opts.lang {
        Lang::Ru => {
            let adv_line = match adv {
                Some(a) => format!(
                    "- Основная сессия — **{}**. Не фиксируй подход и не правь код по задаче больше чем в одном файле, не вызвав **advisor ({a})**; зови его и при второй одинаковой ошибке подряд.\n",
                    opts.main_model
                ),
                None => format!(
                    "- Основная сессия — **{}**; для сложной архитектуры подключай старшую модель точечно.\n",
                    opts.main_model
                ),
            };
            format!(
                "{MARKER_START}\n\
## Команда моделей и экономия контекста (ctxkit)\n\n\
{adv_line}\
- Поиск по коду, греп и чтение документации отправляй в `Explore` ({sub}); правку одного файла без изменения логики делай сам.\n\
- Не объявляй задачу готовой без `checker` (Opus), кроме правки одного файла без изменения логики{gate}.\n\
- Группируй независимые `Read`/`Edit`; не читай длинные файлы целиком: сначала `Grep` или LSP, затем диапазон.\n\
- Для сборок, тестов и `typecheck`, когда не нужен полный лог, запускай `ctxkit check <cmd>`.\n\
- Закрывай длинную задачу через `/clear`, не тяни одну сессию дальше ~100-150 ходов.\n\
{MARKER_END}",
                sub = opts.subagent
            )
        }
        Lang::En => {
            let adv_line = match adv {
                Some(a) => format!(
                    "- Main session runs on **{}**. Do not lock a plan or edit code across more than one file without calling **advisor ({a})** first; call it again when the same error repeats twice.\n",
                    opts.main_model
                ),
                None => format!("- Main session runs on **{}**.\n", opts.main_model),
            };
            format!(
                "{MARKER_START}\n\
## Model Team & Context Discipline (ctxkit)\n\n\
{adv_line}\
- Delegate codebase search/grep/docs reading to `Explore` ({sub}); keep a one-file fix with no logic change local.\n\
- Do not declare work done without `checker` (Opus), except a one-file change with no logic change{gate}.\n\
- Batch independent `Read`/`Edit` calls; locate symbols via `Grep`/LSP first, then read tight line ranges.\n\
- Run `ctxkit check <cmd>` for build/test/lint when full verbose logs aren't needed.\n\
- Clear finished tasks with `/clear` instead of dragging sessions past ~100-150 turns.\n\
{MARKER_END}",
                sub = opts.subagent
            )
        }
    }
}

fn print_diagnostics(
    profile: &Path,
    settings: &mut Value,
    claude_json: &Path,
    home: &Path,
    opts: &SetupOpts,
) {
    println!("\nDiagnostics:");
    if !opts.skip_version_check && opts.advisor.eq_ignore_ascii_case("fable") {
        match check_claude_version() {
            Some(ver) => {
                if ver < (2, 1, 321) {
                    println!(
                        "  [warn] claude CLI {}.{}.{} < 2.1.321 (required for Fable advisor). Run `claude update`.",
                        ver.0, ver.1, ver.2
                    );
                } else {
                    println!(
                        "  [ok]   claude CLI {}.{}.{} (>= 2.1.321)",
                        ver.0, ver.1, ver.2
                    );
                }
            }
            None => println!(
                "  [info] `claude` CLI not found in PATH (Desktop client uses bundled version)"
            ),
        }
    }

    if let Some(enabled) = settings.get("enabledPlugins").and_then(|v| v.as_object()) {
        let on: Vec<&str> = enabled
            .iter()
            .filter_map(|(k, v)| {
                if v.as_bool() == Some(true) {
                    Some(k.as_str())
                } else {
                    None
                }
            })
            .collect();
        if on.len() > 8 {
            println!(
                "  [warn] {} global plugins enabled ({}). Disable niche plugins globally and enable per-project in .claude/settings.json to cut tool-schema bloat.",
                on.len(),
                on.join(", ")
            );
        } else {
            println!("  [ok]   {} global plugins enabled", on.len());
        }
    }

    let claude_md = profile.join("CLAUDE.md");
    if let Ok(raw) = fs::read_to_string(&claude_md) {
        let lines = raw.lines().count();
        let kb = raw.len() as f64 / 1024.0;
        if lines > 200 || raw.len() > 8192 {
            println!(
                "  [warn] {} is {} lines ({:.1} KB) — trim below 200 lines / ~6 KB and move area rules into .claude/rules/*.md",
                claude_md.display(),
                lines,
                kb
            );
        } else {
            println!(
                "  [ok]   {} is {} lines ({:.1} KB)",
                claude_md.display(),
                lines,
                kb
            );
        }
    }

    if let Ok(cj) = read_json_object(claude_json) {
        if let Some(mcps) = cj.get("mcpServers").and_then(|v| v.as_object()) {
            if mcps.len() > 2 {
                let names: Vec<&str> = mcps.keys().map(String::as_str).collect();
                println!(
                    "  [warn] {} global MCP servers in {} ({}): OpenAPI/fat schemas load on every turn.",
                    mcps.len(),
                    claude_json.display(),
                    names.join(", ")
                );
            } else {
                println!(
                    "  [ok]   {} global MCP server(s) in {}",
                    mcps.len(),
                    claude_json.display()
                );
            }
        }
    }

    if opts.antigravity {
        let agy_dir = opts
            .agy_file
            .as_ref()
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| home.join(".gemini").join("config"));
        let agy_cli_settings = if opts.agy_file.is_none() {
            Some(
                home.join(".gemini")
                    .join("antigravity-cli")
                    .join("settings.json"),
            )
        } else {
            None
        };
        print_antigravity_diagnostics(&agy_dir, agy_cli_settings.as_deref());
    }

    if opts.dsh {
        let dsh_home = opts
            .dsh_home
            .clone()
            .or_else(|| env::var_os("DSH_HOME").map(PathBuf::from))
            .unwrap_or_else(|| home.join(".dsh"));
        print_dsh_diagnostics(&dsh_home);
    }
}

fn print_dsh_diagnostics(dsh_home: &Path) {
    println!("\nDeepSeek Harness Diagnostics:");
    let agents_md = dsh_home.join("AGENTS.md");
    if let Ok(raw) = fs::read_to_string(&agents_md) {
        let lines = raw.lines().count();
        let kb = raw.len() as f64 / 1024.0;
        if lines > 200 || raw.len() > 8192 {
            println!(
                "  [warn] {} is {} lines ({:.1} KB) — trim below 200 lines / ~8 KB.",
                agents_md.display(),
                lines,
                kb
            );
        } else {
            println!(
                "  [ok]   {} is {} lines ({:.1} KB)",
                agents_md.display(),
                lines,
                kb
            );
        }
    } else {
        println!("  [info] no global {} found", agents_md.display());
    }

    let global_patch = dsh_home.join("cordis.patch.yml");
    if global_patch.exists() {
        if let Ok(raw) = fs::read_to_string(&global_patch) {
            let mcps = raw
                .lines()
                .filter(|l| {
                    l.trim_start().starts_with("- id: mcp-")
                        || l.trim_start().starts_with("- id: rea-mcp")
                })
                .count();
            if mcps > 2 {
                println!(
                    "  [warn] {} global MCP servers found in {}",
                    mcps,
                    global_patch.display()
                );
            } else if mcps > 0 {
                println!(
                    "  [ok]   {} global MCP server(s) in {}",
                    mcps,
                    global_patch.display()
                );
            }
        }
    }

    let skills_dir = dsh_home.join("skills");
    if skills_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&skills_dir) {
            let count = entries
                .filter_map(Result::ok)
                .filter(|e| e.path().is_dir())
                .count();
            if count > 15 {
                println!(
                    "  [warn] {} global skills in {} — consider pruning unused skills",
                    count,
                    skills_dir.display()
                );
            } else {
                println!(
                    "  [ok]   {} global skill(s) in {}",
                    count,
                    skills_dir.display()
                );
            }
        }
    }
}

fn print_antigravity_diagnostics(agy_dir: &Path, agy_cli_settings: Option<&Path>) {
    println!("\nAntigravity Diagnostics:");
    if let Some(cli_path) = agy_cli_settings {
        if let Ok(cfg) = read_json_object(cli_path) {
            if let Some(model) = cfg.get("model").and_then(|v| v.as_str()) {
                let lower = model.to_ascii_lowercase();
                if lower.contains("flash")
                    || lower.contains("lite")
                    || lower.contains("mini")
                    || lower.contains("haiku")
                {
                    println!("  [ok]   agy CLI model: {model}");
                } else if lower.contains("pro") || lower.contains("opus") {
                    println!(
                        "  [warn] agy CLI model: {model} (invoke_subagent defaults to Model='inherit'; pass 'flash'/'flash_lite' for search/routine subagents)"
                    );
                } else {
                    println!("  [info] agy CLI model: {model}");
                }
            }
        }
    }

    let enabled_plugins = discover_enabled_agy_plugins(agy_dir);
    if agy_dir.join("plugins").is_dir() || !enabled_plugins.is_empty() {
        let names: Vec<&str> = enabled_plugins.iter().map(|(n, _)| n.as_str()).collect();
        if enabled_plugins.len() > 6 {
            println!(
                "  [warn] Antigravity: {} global plugins enabled ({}). Disable niche plugins in {}/config.json or UI.",
                enabled_plugins.len(),
                names.join(", "),
                agy_dir.display()
            );
        } else if names.is_empty() {
            println!("  [ok]   Antigravity: 0 global plugins enabled");
        } else {
            println!(
                "  [ok]   Antigravity: {} global plugin(s) enabled ({})",
                enabled_plugins.len(),
                names.join(", ")
            );
        }
    }

    let global_mcps = collect_active_mcp_names(&agy_dir.join("mcp_config.json"));
    let mut plugin_mcps = Vec::new();
    for (pname, pdir) in &enabled_plugins {
        for srv in collect_active_mcp_names(&pdir.join("mcp_config.json")) {
            plugin_mcps.push(format!("{pname}/{srv}"));
        }
    }
    let total_mcps = global_mcps.len() + plugin_mcps.len();
    if agy_dir.join("mcp_config.json").is_file() || total_mcps > 0 {
        let mut parts = Vec::new();
        if !global_mcps.is_empty() {
            parts.push(format!(
                "{} in mcp_config.json [{}]",
                global_mcps.len(),
                global_mcps.join(", ")
            ));
        }
        if !plugin_mcps.is_empty() {
            parts.push(format!(
                "{} in plugins [{}]",
                plugin_mcps.len(),
                plugin_mcps.join(", ")
            ));
        }
        let breakdown = if parts.is_empty() {
            String::new()
        } else {
            format!(" ({})", parts.join(", "))
        };
        if total_mcps > 4 {
            println!(
                "  [warn] Antigravity: {} active global MCP servers{breakdown} - even with Lazy schemas, tool lists and plugin rules grow startup context; keep project-only MCPs in .agents/mcp_config.json or disable unused plugins.",
                total_mcps
            );
        } else {
            println!(
                "  [ok]   Antigravity: {} active global MCP server(s){breakdown}",
                total_mcps
            );
        }
    }

    let (rule_files, rule_bytes, oversized) = audit_agy_plugin_rules(&enabled_plugins);
    if !oversized.is_empty() {
        let list: Vec<String> = oversized
            .iter()
            .map(|(name, b)| format!("{name} ({:.1} KB)", *b as f64 / 1024.0))
            .collect();
        println!(
            "  [warn] Antigravity: plugin rule file(s) exceed 24 KB per-file cap: {}",
            list.join(", ")
        );
    } else if rule_bytes > 16_384 {
        println!(
            "  [warn] Antigravity: {} enabled plugin rule file(s) total {:.1} KB - trims startup token baseline when trimmed or scoped per project.",
            rule_files,
            rule_bytes as f64 / 1024.0
        );
    } else if rule_files > 0 {
        println!(
            "  [ok]   Antigravity: {} plugin rule file(s), {:.1} KB total (within 24 KB/file cap)",
            rule_files,
            rule_bytes as f64 / 1024.0
        );
    }
}

fn discover_enabled_agy_plugins(agy_dir: &Path) -> Vec<(String, PathBuf)> {
    let plugins_dir = agy_dir.join("plugins");
    let Ok(entries) = fs::read_dir(&plugins_dir) else {
        return Vec::new();
    };
    let config_plugins = read_json_object(&agy_dir.join("config.json"))
        .ok()
        .and_then(|v| v.get("plugins").cloned());

    let mut active = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if !looks_like_agy_plugin(&path) {
            continue;
        }
        let cfg_override = config_plugins
            .as_ref()
            .and_then(|m| m.get(&name))
            .and_then(|v| v.get("enabled"))
            .and_then(|v| v.as_bool());
        let enabled = cfg_override.unwrap_or_else(|| !plugin_manifest_disabled(&path));
        if enabled {
            active.push((name, path));
        }
    }
    active.sort_by(|a, b| a.0.cmp(&b.0));
    active
}

const AGY_PLUGIN_MANIFESTS: [&str; 4] = [
    "plugin.json",
    ".antigravity-plugin/plugin.json",
    ".gemini-plugin/plugin.json",
    ".claude-plugin/plugin.json",
];

fn looks_like_agy_plugin(dir: &Path) -> bool {
    AGY_PLUGIN_MANIFESTS
        .iter()
        .any(|rel| dir.join(rel).exists())
        || ["mcp_config.json", "hooks.json", "rules", "skills"]
            .iter()
            .any(|rel| dir.join(rel).exists())
}

fn plugin_manifest_disabled(dir: &Path) -> bool {
    for rel in AGY_PLUGIN_MANIFESTS {
        let p = dir.join(rel);
        if p.is_file() {
            if let Ok(v) = read_json_object(&p) {
                return v.get("disabled").and_then(|d| d.as_bool()) == Some(true);
            }
        }
    }
    false
}

fn collect_active_mcp_names(path: &Path) -> Vec<String> {
    let Ok(v) = read_json_object(path) else {
        return Vec::new();
    };
    let Some(mcps) = v.get("mcpServers").and_then(|m| m.as_object()) else {
        return Vec::new();
    };
    let mut names: Vec<String> = mcps
        .iter()
        .filter_map(|(k, entry)| {
            if entry.get("disabled").and_then(|d| d.as_bool()) == Some(true) {
                None
            } else {
                Some(k.clone())
            }
        })
        .collect();
    names.sort();
    names
}

fn audit_agy_plugin_rules(plugins: &[(String, PathBuf)]) -> (usize, usize, Vec<(String, usize)>) {
    let mut count = 0usize;
    let mut total_bytes = 0usize;
    let mut oversized = Vec::new();
    for (pname, pdir) in plugins {
        let rules_dir = pdir.join("rules");
        let Ok(entries) = fs::read_dir(&rules_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let is_md = p
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("md"));
            if !p.is_file() || !is_md {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                let len = meta.len() as usize;
                count += 1;
                total_bytes += len;
                if len > 24_000 {
                    let fname = entry.file_name().to_string_lossy().to_string();
                    oversized.push((format!("{pname}/{fname}"), len));
                }
            }
        }
    }
    oversized.sort_by(|a, b| a.0.cmp(&b.0));
    (count, total_bytes, oversized)
}

fn check_claude_version() -> Option<(u64, u64, u64)> {
    let out = if cfg!(windows) {
        Command::new("cmd.exe")
            .args(["/d", "/c", "claude", "--version"])
            .output()
            .ok()?
    } else {
        Command::new("claude").arg("--version").output().ok()?
    };
    if !out.status.success() {
        return None;
    }
    parse_semver(&String::from_utf8_lossy(&out.stdout))
}

fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    for tok in s.split_whitespace() {
        let clean = tok.trim_start_matches('v');
        let mut parts = clean.split('.');
        if let (Some(a), Some(b), Some(c)) = (parts.next(), parts.next(), parts.next()) {
            let c_num = c.split('-').next().unwrap_or(c);
            if let (Ok(x), Ok(y), Ok(z)) = (a.parse(), b.parse(), c_num.parse()) {
                return Some((x, y, z));
            }
        }
    }
    None
}

fn print_help() {
    println!(
        "Usage: ctxkit setup [options]\n\n\
         Automates low-waste setup for Claude Code, Claude Desktop, Antigravity, and DeepSeek Harness:\n\
         - Backs up existing configs before writing\n\
         - Configures Sonnet main + Fable advisor + Haiku subagents + Opus checker (preserving custom env/hooks/plugins)\n\
         - Wires ctxkit PreToolUse/PostToolUse hooks (replacing legacy claude-guard / no-inline-backslash entries)\n\
         - Wires a once-per-turn Stop gate: a turn that edited code without checker/advisor afterwards is sent back once\n\
         - Audits enabled plugins, CLAUDE.md size, global MCPs, Claude CLI version, and Antigravity configs\n\n\
         Options:\n\
           --dry-run              Preview changes without writing files\n\
           --profile <dir>        Claude config dir (default: ~/.claude or CLAUDE_CONFIG_DIR)\n\
           --main-model <name>    Main model (default: sonnet)\n\
           --advisor <name>       Advisor model (default: fable; pass \"none\" to omit)\n\
           --subagent <name>      Explore model and CLAUDE_CODE_SUBAGENT_MODEL (the env var is written only when this flag is given; Explore.md default: haiku)\n\
           --effort <level>       Main model effort (default: high), saved as modelSettings.<model>.effortLevel (known model, low|medium|high|xhigh) and as top-level effortLevel\n\
           --no-stop-gate         Do not wire the Stop gate (and remove ours if present; env CTXKIT_GATE=0 mutes it per session)\n\
           --no-agents            Skip creating Explore.md and checker.md\n\
           --force-agents         Overwrite existing Explore.md / checker.md\n\
           --with-rules           Add/update idempotent rules block in CLAUDE.md\n\
           --desktop              Update Claude Desktop ccd-session-presets.json to Sonnet\n\
           --desktop-model <id>   Desktop modelId (default: claude-sonnet-5-5)\n\
           --desktop-file <path>  Override ccd-session-presets.json path\n\
           --antigravity          Wire ctxkit into Antigravity hooks.json and audit MCPs/plugins\n\
           --agy-file <path>      Override Antigravity hooks.json path\n\
           --dsh                  Wire ctxkit into DeepSeek Harness Desktop (dsh-hooks-claude-code bridge)\n\
           --dsh-home <path>      Override DeepSeek Harness home (default: DSH_HOME or ~/.dsh)\n\
           --hook-cmd <cmd>       Override hook command path\n\
           --lang <en|ru>         Language for prompts, snippets, and hook messages (default: en)\n"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_goes_to_model_settings_and_subagent_env_only_when_asked() {
        let d = std::env::temp_dir().join(format!("ctxkit_setup_effort_{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let path = d.join("settings.json");
        fs::write(
            &path,
            r#"{"modelSettings":{"claude-opus-5-5":{"effortLevel":"low"}},"env":{"KEEP":"1"}}"#,
        )
        .unwrap();
        let mut opts = SetupOpts::default();
        let s = update_claude_settings(&path, &d.join("b"), "\"x\"", &opts).unwrap();
        assert_eq!(
            s["modelSettings"]["claude-sonnet-5-5"]["effortLevel"],
            "high"
        );
        assert_eq!(
            s["modelSettings"]["claude-opus-5-5"]["effortLevel"], "low",
            "other models stay"
        );
        assert_eq!(s["effortLevel"], "high");
        assert!(
            s["env"]["CLAUDE_CODE_SUBAGENT_MODEL"].is_null(),
            "no env without --subagent"
        );
        assert_eq!(s["env"]["KEEP"], "1");
        opts.subagent_env = true;
        opts.effort = "max".to_string(); // not accepted in modelSettings
        let s = update_claude_settings(&path, &d.join("b"), "\"x\"", &opts).unwrap();
        assert_eq!(s["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], "haiku");
        assert_eq!(
            s["modelSettings"]["claude-sonnet-5-5"]["effortLevel"], "high",
            "max is not written"
        );
        assert_eq!(
            canonical_model_id("claude-sonnet-5-5").as_deref(),
            Some("claude-sonnet-5-5")
        );
        assert_eq!(canonical_model_id("gpt"), None);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn parses_semver_strings() {
        assert_eq!(parse_semver("2.1.325 (Claude Code)"), Some((2, 1, 325)));
        assert_eq!(parse_semver("claude v2.1.319"), Some((2, 1, 319)));
        assert_eq!(parse_semver("unknown"), None);
    }

    #[test]
    fn upsert_hooks_replaces_only_guard_and_legacy_script() {
        let mut hooks = Map::new();
        hooks.insert(
            "PreToolUse".to_string(),
            json!([
                {
                    "matcher": "Bash|PowerShell|Write",
                    "hooks": [{ "type": "command", "command": "node C:/x/no-inline-backslash.mjs", "timeout": 10 }]
                },
                {
                    "matcher": "Bash|PowerShell|Write|Read",
                    "hooks": [{ "type": "command", "command": "\"C:/h/claude-guard.exe\"", "timeout": 10 }]
                },
                {
                    "matcher": "Bash",
                    "hooks": [{ "type": "command", "command": "custom-other-hook", "timeout": 5 }]
                }
            ]),
        );
        upsert_claude_hook_event(
            &mut hooks,
            "PreToolUse",
            Some("Bash|PowerShell|Write|Read"),
            "\"C:/h/ctxkit.exe\"",
        );
        let arr = hooks["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert!(arr[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("ctxkit.exe"));
        assert_eq!(arr[1]["hooks"][0]["command"], "custom-other-hook");
    }

    #[test]
    fn rules_mention_the_gate_and_advisor_only_when_configured() {
        let with = |no_gate: bool, advisor: &str, lang: Lang| {
            rules_snippet(&SetupOpts {
                no_stop_gate: no_gate,
                advisor: advisor.to_string(),
                lang,
                ..SetupOpts::default()
            })
        };
        for lang in [Lang::Ru, Lang::En] {
            let full = with(false, "fable", lang);
            assert!(full.contains("Stop") && full.contains("advisor"));
            assert!(!with(true, "fable", lang).contains("Stop"));
            let none = with(false, "none", lang);
            assert!(none.contains("Stop") && !none.contains("advisor"));
        }
    }

    #[test]
    fn stop_gate_group_has_no_matcher_is_idempotent_and_removable() {
        let mut hooks = Map::new();
        hooks.insert(
            "Stop".to_string(),
            json!([{ "hooks": [{ "type": "command", "command": "notify-me.exe" }] }]),
        );
        for _ in 0..2 {
            upsert_claude_hook_event(&mut hooks, "Stop", None, "\"C:/h/ctxkit.exe\"");
        }
        let ours = hooks["Stop"][0].clone();
        assert_eq!(hooks["Stop"].as_array().unwrap().len(), 2);
        assert!(ours.get("matcher").is_none());
        assert!(ours["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("ctxkit"));
        remove_our_hook_event(&mut hooks, "Stop", None);
        assert_eq!(hooks["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(hooks["Stop"][0]["hooks"][0]["command"], "notify-me.exe");
        hooks.insert("Stop".to_string(), json!([ours]));
        remove_our_hook_event(&mut hooks, "Stop", None);
        assert!(hooks.get("Stop").is_none());
    }

    #[test]
    fn recognises_our_command_by_file_name_not_substring() {
        for ours in [
            "\"C:/h/ctxkit.exe\"",
            "C:\\x\\CTXKIT.EXE --lang ru",
            "\"C:/Program Files/a/ctxkit.exe\" --dsh",
            "ctxkit",
            "node C:/x/no-inline-backslash.mjs",
            "\"C:/h/claude-guard.exe\"",
            "node \"C:/my dir/claude-guard.js\"",
        ] {
            assert!(command_is_ours(ours, None), "{ours}");
        }
        for foreign in [
            "node C:/tools/ctxkit-helper/stop.js",
            "D:/x/crates/ctxkit/notify.js",
            "\"C:/Program Files/ctxkit/other.exe\"",
            "custom-other-hook",
            "node x.js ctxkit",
            "",
        ] {
            assert!(!command_is_ours(foreign, None), "{foreign}");
        }
        assert!(command_is_ours("test-ctxkit", Some("test-ctxkit")));
        assert!(!command_is_ours("test-ctxkit", None));
    }

    #[test]
    fn foreign_hook_with_ctxkit_in_path_survives_upsert_and_remove() {
        let foreign_a =
            json!({ "type": "command", "command": "node C:/tools/ctxkit-helper/stop.js" });
        let foreign_b = json!({ "type": "command", "command": "D:/x/crates/ctxkit/notify.js" });
        let ours = "\"C:/h/ctxkit.exe\"";
        let mut hooks = Map::new();
        hooks.insert(
            "Stop".to_string(),
            json!([
                { "hooks": [foreign_a.clone()] },
                // foreign and ours in one group: only ours must go
                { "matcher": "Bash", "hooks": [{ "type": "command", "command": "\"C:/old/ctxkit.exe\"" }, foreign_b.clone()] }
            ]),
        );
        for _ in 0..2 {
            upsert_claude_hook_event(&mut hooks, "Stop", None, ours);
        }
        let list = hooks["Stop"].as_array().unwrap();
        assert_eq!(list.len(), 3, "ours + two foreign groups");
        assert_eq!(list[0]["hooks"][0]["command"], ours);
        assert_eq!(list[1]["hooks"], json!([foreign_a]));
        assert_eq!(list[2]["matcher"], "Bash");
        assert_eq!(list[2]["hooks"], json!([foreign_b]));
        remove_our_hook_event(&mut hooks, "Stop", Some(ours));
        assert_eq!(hooks["Stop"].as_array().unwrap().len(), 2);
        remove_our_hook_event(&mut hooks, "Stop", Some(ours));
        assert_eq!(hooks["Stop"].as_array().unwrap().len(), 2, "idempotent");
    }

    #[test]
    fn upsert_claude_md_is_idempotent_and_migrates_legacy_markers() {
        let dir = env::temp_dir().join("cg_setup_md_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let md = dir.join("CLAUDE.md");
        let bdir = dir.join("backups");
        fs::write(
            &md,
            "# My Custom Rules\n- Keep things simple.\n\n<!-- claude-guard:start -->\nold rules\n<!-- claude-guard:end -->\n",
        )
        .unwrap();

        let opts = SetupOpts::default();
        let snip = rules_snippet(&opts);
        upsert_claude_md(&md, &bdir, &snip, false).unwrap();
        let after_first = fs::read_to_string(&md).unwrap();
        assert!(after_first.contains("# My Custom Rules"));
        assert!(after_first.contains(MARKER_START));
        assert!(!after_first.contains(LEGACY_MARKER_START));
        assert!(!after_first.contains("old rules"));

        upsert_claude_md(&md, &bdir, &snip, false).unwrap();
        let after_second = fs::read_to_string(&md).unwrap();
        assert_eq!(after_first, after_second);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn formats_antigravity_hook_command_with_lang_and_spaces() {
        let plain = Path::new(r"C:\Users\alice\.claude\hooks\ctxkit.exe");
        assert_eq!(
            format_antigravity_command(plain, Lang::En),
            "C:/Users/alice/.claude/hooks/ctxkit.exe"
        );
        assert_eq!(
            format_antigravity_command(plain, Lang::Ru),
            "C:/Users/alice/.claude/hooks/ctxkit.exe --lang ru"
        );
        let spaced = Path::new("/Users/Alice Smith/.claude/hooks/ctxkit");
        let cmd_ru = format_antigravity_command(spaced, Lang::Ru);
        assert!(cmd_ru.starts_with('"') && cmd_ru.ends_with(" --lang ru"));
    }

    #[test]
    fn tells_desktop_app_from_claude_cli() {
        assert!(is_desktop_exe(
            r"C:\Users\a\AppData\Local\AnthropicClaude\app-5.11492.5\claude.exe"
        ));
        assert!(is_desktop_exe(
            r"C:\Program Files\WindowsApps\Claude_1.0.0.0_x64__abc\app\claude.exe"
        ));
        assert!(!is_desktop_exe(r"C:\Users\a\.local\bin\claude.exe"));
        assert!(!is_desktop_exe(
            r"C:\Users\a\AppData\Roaming\npm\node_modules\claude.exe"
        ));
        assert!(!is_desktop_exe(""));
    }

    #[test]
    fn dsh_setup_is_idempotent_and_keeps_foreign_patch_entries() {
        assert!(format_dsh_command(Path::new("/opt/ctxkit"), Lang::Ru)
            .ends_with("/opt/ctxkit' --dsh --lang ru"));
        let odd = format_dsh_command(Path::new("/Users/O'Brien Smith/ctxkit"), Lang::En);
        assert!(odd.ends_with("Brien Smith/ctxkit' --dsh") && !odd.contains("/O'Brien"));

        let home = env::temp_dir().join("cg_dsh_setup_test");
        let _ = fs::remove_dir_all(&home);
        // No desktop profile: nothing is created.
        update_dsh_hooks(&home, "ctxkit --dsh", false).unwrap();
        assert!(!home.exists());

        let profile = home.join("profiles").join("desktop");
        fs::create_dir_all(&profile).unwrap();
        let patch = profile.join("cordis.patch.yml");
        let foreign = "- id: ui-chat\n  config:\n    transcriptView: standard\n";
        fs::write(&patch, foreign).unwrap();

        update_dsh_hooks(&home, "ctxkit --dsh", true).unwrap();
        assert_eq!(
            fs::read_to_string(&patch).unwrap(),
            foreign,
            "dry-run must not write"
        );

        update_dsh_hooks(&home, "old-ctxkit --dsh", false).unwrap();
        update_dsh_hooks(&home, "ctxkit --dsh", false).unwrap();
        let first = fs::read_to_string(&patch).unwrap();
        update_dsh_hooks(&home, "ctxkit --dsh", false).unwrap();
        assert_eq!(first, fs::read_to_string(&patch).unwrap());
        assert!(first.starts_with(foreign));
        assert_eq!(first.matches("id: ctxkit-hooks").count(), 1);
        assert!(first.contains("name: '@deepseek-ai/dsh-hooks-claude-code'"));

        // A flow list or a mapping at the top level is refused, not corrupted.
        for root in ["[]\n", "foo: bar\n"] {
            fs::write(&patch, root).unwrap();
            assert!(update_dsh_hooks(&home, "ctxkit --dsh", false).is_err());
            assert_eq!(fs::read_to_string(&patch).unwrap(), root);
        }
        fs::write(&patch, "# only a comment\n").unwrap();
        update_dsh_hooks(&home, "ctxkit --dsh", false).unwrap();
        assert!(fs::read_to_string(&patch)
            .unwrap()
            .contains("id: ctxkit-hooks"));

        // An orphan end marker above must not make the block multiply.
        fs::write(&patch, format!("{DSH_MARKER_END}\n{foreign}")).unwrap();
        update_dsh_hooks(&home, "ctxkit --dsh", false).unwrap();
        update_dsh_hooks(&home, "ctxkit --dsh", false).unwrap();
        assert_eq!(
            fs::read_to_string(&patch)
                .unwrap()
                .matches("id: ctxkit-hooks")
                .count(),
            1
        );
        // A start marker without its end is refused instead of guessing what to replace.
        let half = format!("{foreign}{DSH_MARKER_START}\n- id: user-later\n");
        fs::write(&patch, &half).unwrap();
        assert!(update_dsh_hooks(&home, "ctxkit --dsh", false).is_err());
        assert_eq!(fs::read_to_string(&patch).unwrap(), half);

        let hooks = read_json_object(&home.join("ctxkit-hooks.json")).unwrap();
        assert_eq!(
            hooks["hooks"]["PreToolUse"][0]["matcher"],
            "read|write|edit|apply_patch|bash|pwsh"
        );
        assert_eq!(
            hooks["hooks"]["PostToolUse"][0]["matcher"],
            "write|edit|apply_patch"
        );
        assert_eq!(
            hooks["hooks"]["PostToolUse"][0]["hooks"][0]["command"],
            "ctxkit --dsh"
        );
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn audits_antigravity_plugins_mcps_and_rules() {
        let dir = env::temp_dir().join("cg_agy_diag_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("plugins").join("active-one").join("rules")).unwrap();
        fs::create_dir_all(dir.join("plugins").join("disabled-cfg")).unwrap();
        fs::create_dir_all(dir.join("plugins").join("disabled-manifest")).unwrap();
        fs::create_dir_all(dir.join("plugins").join("re-enabled")).unwrap();

        fs::write(
            dir.join("plugins").join("active-one").join("plugin.json"),
            "{}",
        )
        .unwrap();
        fs::write(
            dir.join("plugins")
                .join("active-one")
                .join("mcp_config.json"),
            r#"{"mcpServers":{"s1":{},"off":{"disabled":true}}}"#,
        )
        .unwrap();
        fs::write(
            dir.join("plugins")
                .join("active-one")
                .join("rules")
                .join("AGENTS.md"),
            "x".repeat(25_000),
        )
        .unwrap();
        fs::write(
            dir.join("plugins").join("disabled-cfg").join("plugin.json"),
            "{}",
        )
        .unwrap();
        fs::write(
            dir.join("plugins")
                .join("disabled-manifest")
                .join("plugin.json"),
            r#"{"disabled":true}"#,
        )
        .unwrap();
        fs::write(
            dir.join("plugins").join("re-enabled").join("plugin.json"),
            r#"{"disabled":true}"#,
        )
        .unwrap();
        fs::write(
            dir.join("config.json"),
            r#"{"plugins":{"disabled-cfg":{"enabled":false},"re-enabled":{"enabled":true}}}"#,
        )
        .unwrap();
        fs::write(
            dir.join("mcp_config.json"),
            r#"{"mcpServers":{"g1":{},"g2":{"disabled":true}}}"#,
        )
        .unwrap();

        let plugins = discover_enabled_agy_plugins(&dir);
        let pnames: Vec<&str> = plugins.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(pnames, vec!["active-one", "re-enabled"]);
        assert_eq!(
            collect_active_mcp_names(&dir.join("mcp_config.json")),
            vec!["g1"]
        );
        assert_eq!(
            collect_active_mcp_names(
                &dir.join("plugins")
                    .join("active-one")
                    .join("mcp_config.json")
            ),
            vec!["s1"]
        );
        let (rcount, rbytes, oversized) = audit_agy_plugin_rules(&plugins);
        assert_eq!(rcount, 1);
        assert_eq!(rbytes, 25_000);
        assert_eq!(
            oversized,
            vec![("active-one/AGENTS.md".to_string(), 25_000)]
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
