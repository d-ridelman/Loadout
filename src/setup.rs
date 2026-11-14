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
            flag @ ("--profile" | "--main-model" | "--advisor" | "--subagent" | "--effort"
            | "--desktop-model" | "--desktop-file" | "--agy-file" | "--dsh-home" | "--hook-cmd"
            | "--claude-json" | "--lang") => {
                let Some(val) = args.get(i + 1) else {
                    eprintln!("ERR: missing value for {flag}");
                    return 2;
                };
                match flag {
                    "--profile" => opts.profile_dir = Some(PathBuf::from(val)),
                    "--main-model" => opts.main_model = val.clone(),
                    "--advisor" => opts.advisor = val.clone(),
                    "--subagent" => opts.subagent = val.clone(),
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

    let bin_name = if cfg!(windows) { "ctxkit.exe" } else { "ctxkit" };
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
        if let Err(e) = install_binary(&hook_bin_path, &home, bin_name, custom_profile, opts.dry_run) {
            eprintln!("ERR: binary install failed: {e}");
            return 1;
        }
    }

    let settings_path = profile.join("settings.json");
    let backup_dir = profile.join("backups");
    let mut settings_root = match update_claude_settings(&settings_path, &backup_dir, &hook_cmd, &opts) {
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
    }

    if opts.desktop {
        let dpath = opts
            .desktop_file
            .clone()
            .or_else(|| default_desktop_presets_path(&home));
        if let Some(p) = dpath {
            if p.exists() {
                if let Err(e) = update_desktop_presets(&p, &opts.desktop_model, &opts.effort, opts.dry_run) {
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

fn home_dir() -> Option<PathBuf> {
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
        Some(home.join(".config").join("Claude").join("ccd-session-presets.json"))
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

fn read_json_object(path: &Path) -> Result<Value, String> {
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
    fs::create_dir_all(backup_dir)
        .map_err(|e| format!("mkdir {}: {e}", backup_dir.display()))?;
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
    fs::copy(path, &dst).map_err(|e| format!("backup {} -> {}: {e}", path.display(), dst.display()))?;
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
        if let Some(bdir) = backup_dir {
            let b = backup_file(path, bdir)?;
            println!("  backup -> {}", b.display());
        } else {
            let parent = path.parent().unwrap_or_else(|| Path::new("."));
            let b = backup_file(path, parent)?;
            println!("  backup -> {}", b.display());
        }
    } else if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let pretty =
        serde_json::to_string_pretty(updated).map_err(|e| format!("serialize {label}: {e}"))?;
    fs::write(path, format!("{pretty}\n"))
        .map_err(|e| format!("write {}: {e}", path.display()))?;
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
        root.insert("advisorModel".to_string(), Value::String(opts.advisor.clone()));
    }
    root.insert("effortLevel".to_string(), Value::String(opts.effort.clone()));

    let env_obj = ensure_object(root, "env")?;
    env_obj.insert(
        "CLAUDE_CODE_SUBAGENT_MODEL".to_string(),
        Value::String(opts.subagent.clone()),
    );
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
        "Bash|PowerShell|Write|Read",
        hook_cmd,
    );
    upsert_claude_hook_event(hooks_obj, "PostToolUse", "Edit|Write", hook_cmd);

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

fn is_our_hook_group(group: &Value) -> bool {
    let Some(arr) = group.get("hooks").and_then(|h| h.as_array()) else {
        return false;
    };
    arr.iter().any(|h| {
        let cmd = h.get("command").and_then(|c| c.as_str()).unwrap_or("");
        cmd.contains("ctxkit") || cmd.contains("claude-guard") || cmd.contains("no-inline-backslash")
    })
}

fn upsert_claude_hook_event(
    hooks: &mut Map<String, Value>,
    event: &str,
    matcher: &str,
    command: &str,
) {
    let mut list = hooks
        .get(event)
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    list.retain(|item| !is_our_hook_group(item));
    list.insert(
        0,
        json!({
            "matcher": matcher,
            "hooks": [{
                "type": "command",
                "command": command,
                "timeout": 10
            }]
        }),
    );
    hooks.insert(event.to_string(), Value::Array(list));
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

fn marker_span(text: &str) -> Option<(usize, usize)> {
    for (start_m, end_m) in [(MARKER_START, MARKER_END), (LEGACY_MARKER_START, LEGACY_MARKER_END)] {
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
    let root = next.as_object_mut().ok_or("hooks.json root is not object")?;
    root.remove("claude-guard");
    root.insert(
        "ctxkit".to_string(),
        json!({
            "PreToolUse": [
                {
                    "matcher": "read_file|write_file|run_command",
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

/// Writes `<dsh_home>/ctxkit-hooks.json` and mounts the official Claude Code hook
/// bridge on it from the desktop profile's `cordis.patch.yml`.
fn update_dsh_hooks(dsh_home: &Path, command: &str, dry_run: bool) -> Result<(), String> {
    let profile = dsh_home.join("profiles").join("desktop");
    let patch_path = profile.join("cordis.patch.yml");
    if !patch_path.exists() {
        println!("  skip DeepSeek Harness (not found: {})", patch_path.display());
        return Ok(());
    }

    let hooks_path = dsh_home.join("ctxkit-hooks.json");
    let group = |matcher: &str| {
        json!([{ "matcher": matcher, "hooks": [{ "type": "command", "command": command, "timeout": 10 }] }])
    };
    let hooks = json!({ "hooks": {
        "PreToolUse": group("read|write|bash|pwsh"),
        "PostToolUse": group("write|edit"),
    }});
    let orig = read_json_object(&hooks_path)?;
    write_json_if_changed(&hooks_path, None, &orig, &hooks, dry_run, "DeepSeek Harness hooks")?;

    let config_path = hooks_path.to_string_lossy().replace('\'', "''");
    let block = format!(
        "{DSH_MARKER_START}\n- insert:\n    - id: ctxkit-hooks\n      name: '{DSH_HOOKS_PLUGIN}'\n      config:\n        configPath: '{config_path}'\n{DSH_MARKER_END}"
    );
    let existing =
        fs::read_to_string(&patch_path).map_err(|e| format!("read {}: {e}", patch_path.display()))?;
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
        println!("  ok DeepSeek Harness profile patch (unchanged): {}", patch_path.display());
    } else if dry_run {
        println!("  [dry-run] update DeepSeek Harness profile patch: {}", patch_path.display());
    } else {
        let b = backup_file(&patch_path, &profile)?;
        println!("  backup -> {}", b.display());
        fs::write(&patch_path, updated).map_err(|e| format!("write {}: {e}", patch_path.display()))?;
        println!("  updated DeepSeek Harness profile patch: {}", patch_path.display());
    }

    // The bridge is not bundled with the desktop app; without it the insert loads nothing.
    // Its peer dependencies pin the exact app version, so an app update needs a matching reinstall.
    let json_str = |path: PathBuf, key: &str| {
        let v = if path.exists() { read_json_object(&path).ok() } else { None };
        v.and_then(|v| v.get(key).and_then(|s| s.as_str()).map(String::from))
    };
    let plugin_dir = DSH_HOOKS_PLUGIN.split('/').fold(profile.join("node_modules"), |p, s| p.join(s));
    let installed = json_str(plugin_dir.join("package.json"), "version");
    let app = json_str(
        dsh_home.join("dsh-runtimes").join("dsh-primary-runtime").join("runtime.json"),
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
    match opts.lang {
        Lang::Ru => {
            let adv_line = match adv {
                Some(a) => format!(
                    "- Основная сессия — **{}**. Советуйся с **advisor ({a})** до фиксации подхода на нетривиальной задаче, когда одна ошибка повторяется дважды, и перед тем как объявить задачу готовой.\n",
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
- Поиск по коду, греп и чтение документации отправляй в `Explore` ({sub}); мелкую правку 1-2 файлов делай сам, перед сдачей нетривиальной работы прогоняй `checker` (Opus).\n\
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
                    "- Main session runs on **{}**. Consult **advisor ({a})** before locking a non-trivial plan, when the same error repeats twice, and before calling work done.\n",
                    opts.main_model
                ),
                None => format!("- Main session runs on **{}**.\n", opts.main_model),
            };
            format!(
                "{MARKER_START}\n\
## Model Team & Context Discipline (ctxkit)\n\n\
{adv_line}\
- Delegate codebase search/grep/docs reading to `Explore` ({sub}); keep tiny 1-2 file fixes local; run `checker` (Opus) before finishing non-trivial changes.\n\
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
                    println!("  [ok]   claude CLI {}.{}.{} (>= 2.1.321)", ver.0, ver.1, ver.2);
                }
            }
            None => println!("  [info] `claude` CLI not found in PATH (Desktop client uses bundled version)"),
        }
    }

    if let Some(enabled) = settings.get("enabledPlugins").and_then(|v| v.as_object()) {
        let on: Vec<&str> = enabled
            .iter()
            .filter_map(|(k, v)| if v.as_bool() == Some(true) { Some(k.as_str()) } else { None })
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
            println!("  [ok]   {} is {} lines ({:.1} KB)", claude_md.display(), lines, kb);
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
                println!("  [ok]   {} global MCP server(s) in {}", mcps.len(), claude_json.display());
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
            Some(home.join(".gemini").join("antigravity-cli").join("settings.json"))
        } else {
            None
        };
        print_antigravity_diagnostics(&agy_dir, agy_cli_settings.as_deref());
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
            parts.push(format!("{} in mcp_config.json [{}]", global_mcps.len(), global_mcps.join(", ")));
        }
        if !plugin_mcps.is_empty() {
            parts.push(format!("{} in plugins [{}]", plugin_mcps.len(), plugin_mcps.join(", ")));
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
            println!("  [ok]   Antigravity: {} active global MCP server(s){breakdown}", total_mcps);
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
    AGY_PLUGIN_MANIFESTS.iter().any(|rel| dir.join(rel).exists())
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
        Command::new("cmd.exe").args(["/d", "/c", "claude", "--version"]).output().ok()?
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
         - Audits enabled plugins, CLAUDE.md size, global MCPs, Claude CLI version, and Antigravity configs\n\n\
         Options:\n\
           --dry-run              Preview changes without writing files\n\
           --profile <dir>        Claude config dir (default: ~/.claude or CLAUDE_CONFIG_DIR)\n\
           --main-model <name>    Main model (default: sonnet)\n\
           --advisor <name>       Advisor model (default: fable; pass \"none\" to omit)\n\
           --subagent <name>      CLAUDE_CODE_SUBAGENT_MODEL (default: haiku)\n\
           --effort <level>       effortLevel (default: high)\n\
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
        upsert_claude_hook_event(&mut hooks, "PreToolUse", "Bash|PowerShell|Write|Read", "\"C:/h/ctxkit.exe\"");
        let arr = hooks["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert!(arr[0]["hooks"][0]["command"].as_str().unwrap().contains("ctxkit.exe"));
        assert_eq!(arr[1]["hooks"][0]["command"], "custom-other-hook");
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
    fn dsh_setup_is_idempotent_and_keeps_foreign_patch_entries() {
        assert!(format_dsh_command(Path::new("/opt/ctxkit"), Lang::Ru).ends_with("/opt/ctxkit' --dsh --lang ru"));
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
        assert_eq!(fs::read_to_string(&patch).unwrap(), foreign, "dry-run must not write");

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
        assert!(fs::read_to_string(&patch).unwrap().contains("id: ctxkit-hooks"));

        // An orphan end marker above must not make the block multiply.
        fs::write(&patch, format!("{DSH_MARKER_END}\n{foreign}")).unwrap();
        update_dsh_hooks(&home, "ctxkit --dsh", false).unwrap();
        update_dsh_hooks(&home, "ctxkit --dsh", false).unwrap();
        assert_eq!(fs::read_to_string(&patch).unwrap().matches("id: ctxkit-hooks").count(), 1);
        // A start marker without its end is refused instead of guessing what to replace.
        let half = format!("{foreign}{DSH_MARKER_START}\n- id: user-later\n");
        fs::write(&patch, &half).unwrap();
        assert!(update_dsh_hooks(&home, "ctxkit --dsh", false).is_err());
        assert_eq!(fs::read_to_string(&patch).unwrap(), half);

        let hooks = read_json_object(&home.join("ctxkit-hooks.json")).unwrap();
        assert_eq!(hooks["hooks"]["PreToolUse"][0]["matcher"], "read|write|bash|pwsh");
        assert_eq!(hooks["hooks"]["PostToolUse"][0]["hooks"][0]["command"], "ctxkit --dsh");
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

        fs::write(dir.join("plugins").join("active-one").join("plugin.json"), "{}").unwrap();
        fs::write(
            dir.join("plugins").join("active-one").join("mcp_config.json"),
            r#"{"mcpServers":{"s1":{},"off":{"disabled":true}}}"#,
        )
        .unwrap();
        fs::write(
            dir.join("plugins").join("active-one").join("rules").join("AGENTS.md"),
            "x".repeat(25_000),
        )
        .unwrap();
        fs::write(dir.join("plugins").join("disabled-cfg").join("plugin.json"), "{}").unwrap();
        fs::write(
            dir.join("plugins").join("disabled-manifest").join("plugin.json"),
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
        assert_eq!(collect_active_mcp_names(&dir.join("mcp_config.json")), vec!["g1"]);
        assert_eq!(
            collect_active_mcp_names(&dir.join("plugins").join("active-one").join("mcp_config.json")),
            vec!["s1"]
        );
        let (rcount, rbytes, oversized) = audit_agy_plugin_rules(&plugins);
        assert_eq!(rcount, 1);
        assert_eq!(rbytes, 25_000);
        assert_eq!(oversized, vec![("active-one/AGENTS.md".to_string(), 25_000)]);

        let _ = fs::remove_dir_all(&dir);
    }
}
