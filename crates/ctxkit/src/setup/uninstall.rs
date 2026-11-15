//! `ctxkit setup --uninstall`: removes only what `ctxkit setup` added (our hook elements, `CTXKIT_LANG`,
//! the rules block, Antigravity/DSH entries, our binary). Model choices are not undone because the
//! previous values are not known: they are printed with the path to the settings.json backups instead.
use super::*;
use crate::t;

/// Flags that only make sense for an install; passing them with `--uninstall` is an error, not a no-op.
pub(super) const SETUP_ONLY_FLAGS: [&str; 9] = [
    "--no-agents",
    "--force-agents",
    "--with-rules",
    "--no-stop-gate",
    "--main-model",
    "--advisor",
    "--subagent",
    "--effort",
    "--desktop-model",
];

pub(super) fn reject_setup_only_flags(args: &[String]) -> Option<&str> {
    args.iter()
        .map(String::as_str)
        .find(|a| SETUP_ONLY_FLAGS.contains(a))
}

/// Settings without our hook elements and `env.CTXKIT_LANG`. A container (`hooks`, `env`) that this
/// emptied is dropped; everything else is left as it is.
fn remove_from_settings(orig: &Value, hook_cmd: &str) -> Value {
    let mut next = orig.clone();
    let Some(root) = next.as_object_mut() else {
        return next;
    };
    let mut drop_keys = Vec::new();
    if let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        let had = !hooks.is_empty();
        for ev in ["PreToolUse", "PostToolUse", "Stop"] {
            remove_our_hook_event(hooks, ev, Some(hook_cmd));
        }
        if had && hooks.is_empty() {
            drop_keys.push("hooks");
        }
    }
    if let Some(env_obj) = root.get_mut("env").and_then(|e| e.as_object_mut()) {
        if env_obj.remove("CTXKIT_LANG").is_some() && env_obj.is_empty() {
            drop_keys.push("env");
        }
    }
    for k in drop_keys {
        root.remove(k);
    }
    next
}

/// `before` and `after` a removed block, joined the way `append_block` laid them out.
fn join_cut(before: &str, after: &str) -> String {
    let (before, after) = (before.trim_end(), after.trim_start());
    match (before.is_empty(), after.is_empty()) {
        (true, true) => String::new(),
        (true, false) => after.to_string(),
        (false, true) => format!("{before}\n"),
        (false, false) => format!("{before}\n\n{after}"),
    }
}

/// Text without every ctxkit (and legacy claude-guard) rules block.
fn strip_rules_blocks(text: &str) -> String {
    let mut text = text.to_string();
    while let Some((s, e)) = marker_span(&text) {
        text = join_cut(&text[..s], &text[e..]);
    }
    text
}

/// Text without the managed DSH block; `Err` when a start marker has no end marker after it.
fn strip_dsh_block(text: &str) -> Result<String, ()> {
    let mut text = text.to_string();
    while let Some(s) = text.find(DSH_MARKER_START) {
        let len = text[s..].find(DSH_MARKER_END).ok_or(())?;
        text = join_cut(&text[..s], &text[s + len + DSH_MARKER_END.len()..]);
    }
    Ok(text)
}

fn remove_rules_block(path: &Path, backup_dir: &Path, dry_run: bool) -> Result<(), String> {
    if !path.exists() {
        println!("  skip rules (not found): {}", path.display());
        return Ok(());
    }
    let existing = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let updated = strip_rules_blocks(&existing);
    if existing == updated {
        if existing.contains(MARKER_START) || existing.contains(LEGACY_MARKER_START) {
            println!(
                "  [warn] {}: a ctxkit start marker has no end marker; remove the leftover block by hand",
                path.display()
            );
        } else {
            println!("  ok rules block (not present): {}", path.display());
        }
    } else if dry_run {
        println!("  [dry-run] remove rules block: {}", path.display());
    } else {
        let b = backup_file(path, backup_dir)?;
        println!("  backup -> {}", b.display());
        fs::write(path, updated).map_err(|e| format!("write {}: {e}", path.display()))?;
        println!("  removed rules block: {}", path.display());
    }
    Ok(())
}

fn remove_antigravity_hooks(path: &Path, dry_run: bool) -> Result<(), String> {
    if !path.exists() {
        println!("  skip antigravity hooks (not found): {}", path.display());
        return Ok(());
    }
    let orig = read_json_object(path)?;
    let mut next = orig.clone();
    if let Some(root) = next.as_object_mut() {
        root.remove("ctxkit");
        root.remove("claude-guard");
    }
    write_json_if_changed(path, None, &orig, &next, dry_run, "antigravity hooks.json")
}

fn remove_dsh(dsh_home: &Path, dry_run: bool) -> Result<(), String> {
    let hooks_path = dsh_home.join("ctxkit-hooks.json");
    if !hooks_path.exists() {
        println!(
            "  ok DeepSeek Harness hooks (not present): {}",
            hooks_path.display()
        );
    } else if dry_run {
        println!(
            "  [dry-run] remove DeepSeek Harness hooks: {}",
            hooks_path.display()
        );
    } else {
        let b = backup_file(&hooks_path, &dsh_home.join("backups"))?;
        println!("  backup -> {}", b.display());
        fs::remove_file(&hooks_path)
            .map_err(|e| format!("remove {}: {e}", hooks_path.display()))?;
        println!("  removed DeepSeek Harness hooks: {}", hooks_path.display());
    }
    let profile = dsh_home.join("profiles").join("desktop");
    let patch = profile.join("cordis.patch.yml");
    if !patch.exists() {
        return Ok(());
    }
    let existing =
        fs::read_to_string(&patch).map_err(|e| format!("read {}: {e}", patch.display()))?;
    let Ok(updated) = strip_dsh_block(&existing) else {
        println!(
            "  [warn] {}: ctxkit start marker has no end marker; remove the leftover ctxkit block by hand",
            patch.display()
        );
        return Ok(());
    };
    if existing == updated {
        println!(
            "  ok DeepSeek Harness profile patch (no ctxkit block): {}",
            patch.display()
        );
    } else if dry_run {
        println!(
            "  [dry-run] remove ctxkit block from DeepSeek Harness profile patch: {}",
            patch.display()
        );
    } else {
        let b = backup_file(&patch, &profile)?;
        println!("  backup -> {}", b.display());
        fs::write(&patch, updated).map_err(|e| format!("write {}: {e}", patch.display()))?;
        println!(
            "  removed ctxkit block from DeepSeek Harness profile patch: {}",
            patch.display()
        );
    }
    Ok(())
}

/// `settings.json.*.bak` in `dir`, oldest first.
fn list_backups(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<(SystemTime, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.starts_with("settings.json.") && n.ends_with(".bak")
        })
        .map(|e| {
            let mtime = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
            (mtime, e.path())
        })
        .collect();
    found.sort();
    found.into_iter().map(|(_, p)| p).collect()
}

fn show(v: &Value) -> String {
    if v.is_null() {
        "(not set)".to_string()
    } else {
        v.to_string()
    }
}

/// What uninstall deliberately leaves: values the user may want to change back by hand.
fn print_kept(
    settings: &Value,
    profile: &Path,
    desktop: Option<&Path>,
    backups: &[PathBuf],
    lang: Lang,
) {
    println!(
        "{}",
        t(
            lang,
            "Left as is (ctxkit does not know the previous values; change by hand if you want them back):",
            "Не тронуто (прежние значения ctxkit неизвестны; верните вручную, если нужно):"
        )
    );
    for k in ["model", "advisorModel", "effortLevel", "modelSettings"] {
        println!("  {k}: {}", show(&settings[k]));
    }
    println!(
        "  env.CLAUDE_CODE_SUBAGENT_MODEL: {}",
        show(&settings["env"]["CLAUDE_CODE_SUBAGENT_MODEL"])
    );
    for name in ["Explore.md", "checker.md"] {
        let p = profile.join("agents").join(name);
        if p.exists() {
            println!("  agent file: {}", p.display());
        }
    }
    if let Some(d) = desktop.filter(|d| d.exists()) {
        if let Ok(v) = read_json_object(d) {
            for (_, acct) in v["byAccount"].as_object().into_iter().flatten() {
                let presets = acct["presets"].as_array().into_iter().flatten();
                let built_ins = acct["builtIns"]
                    .as_object()
                    .into_iter()
                    .flat_map(|m| m.values());
                for p in presets.chain(built_ins) {
                    let name = p["name"].as_str().unwrap_or("(built-in)");
                    println!(
                        "  desktop preset {name}: model {}, effort {}",
                        show(&p["settings"]["modelId"]),
                        show(&p["settings"]["effort"])
                    );
                }
            }
        }
    }
    match (backups.last(), backups.first()) {
        (Some(last), Some(first)) => {
            println!(
                "  settings.json backups: {}",
                last.parent().unwrap_or(profile).display()
            );
            println!("    latest:   {}", last.display());
            if first != last {
                println!(
                    "    earliest: {} {}",
                    first.display(),
                    t(
                        lang,
                        "(most likely the state before the first setup)",
                        "(скорее всего, состояние до первого setup)"
                    )
                );
            }
            println!(
                "  {}",
                t(
                    lang,
                    "To restore the old values open a backup, copy the keys above into settings.json, or copy the whole file back.",
                    "Чтобы вернуть прежние значения, откройте бэкап и перенесите ключи выше в settings.json или верните файл целиком."
                )
            );
        }
        _ => println!("  (no settings.json backups found)"),
    }
}

/// Deletes `path` unless it is the running binary; on failure says how to do it by hand.
fn remove_bin(path: &Path, running: &Path, dry_run: bool, lang: Lang) {
    let manual = |why: &str| {
        println!(
            "  {}: {} ({why})",
            t(lang, "remove manually", "удалите вручную"),
            path.display()
        );
    };
    let is_running = matches!(
        (fs::canonicalize(path), fs::canonicalize(running)),
        (Ok(a), Ok(b)) if a == b
    );
    if dry_run {
        println!("  [dry-run] remove bin {}", path.display());
    } else if is_running {
        manual("this is the binary that is running now");
    } else if let Err(e) = fs::remove_file(path) {
        manual(&e.to_string());
    } else {
        println!("  removed bin {}", path.display());
        // `hooks/` was created by setup; remove_dir only succeeds when nothing else is in it.
        if let Some(dir) = path.parent().filter(|d| d.ends_with("hooks")) {
            let _ = fs::remove_dir(dir);
        }
    }
}

pub(super) fn run(
    opts: &SetupOpts,
    home: &Path,
    profile: &Path,
    custom_profile: bool,
    hook_bin: &Path,
    bin_name: &str,
    hook_cmd: &str,
) -> i32 {
    let tag = if opts.dry_run { "[dry-run] " } else { "" };
    println!("{tag}Removing ctxkit from profile: {}", profile.display());
    let backup_dir = profile.join("backups");
    let settings_path = profile.join("settings.json");
    // Listed before any write so that the backup made by this very run is not mistaken for an old one.
    let backups = list_backups(&backup_dir);
    let run = || -> Result<Value, String> {
        let orig = read_json_object(&settings_path)?;
        let next = remove_from_settings(&orig, hook_cmd);
        write_json_if_changed(
            &settings_path,
            Some(&backup_dir),
            &orig,
            &next,
            opts.dry_run,
            "settings.json",
        )?;
        remove_rules_block(&profile.join("CLAUDE.md"), &backup_dir, opts.dry_run)?;
        let dsh_home = || {
            opts.dsh_home
                .clone()
                .or_else(|| env::var_os("DSH_HOME").map(PathBuf::from))
                .unwrap_or_else(|| home.join(".dsh"))
        };
        if opts.antigravity || opts.agy_file.is_some() {
            let apath = opts
                .agy_file
                .clone()
                .unwrap_or_else(|| home.join(".gemini").join("config").join("hooks.json"));
            remove_antigravity_hooks(&apath, opts.dry_run)?;
        }
        if opts.dsh || opts.dsh_home.is_some() {
            let dsh_home = dsh_home();
            remove_rules_block(
                &dsh_home.join("AGENTS.md"),
                &dsh_home.join("backups"),
                opts.dry_run,
            )?;
            remove_dsh(&dsh_home, opts.dry_run)?;
        }
        Ok(orig)
    };
    let orig = match run() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("ERR: {e}");
            return 1;
        }
    };

    let desktop = opts.desktop_file.clone().or_else(|| {
        opts.desktop
            .then(|| default_desktop_presets_path(home))
            .flatten()
    });
    print_kept(&orig, profile, desktop.as_deref(), &backups, opts.lang);

    // The binary goes last: removed earlier, a settings.json failure would leave a hook on a missing file.
    if opts.hook_cmd.is_none() {
        let exe = env::current_exe().unwrap_or_default();
        let local = home.join(".local").join("bin").join(bin_name);
        // ~/.local/bin is shared; it is ours only when it is a byte copy of this binary or of the hooks/ one.
        let local_is_ours = !custom_profile
            && local.exists()
            && (same_file_bytes(&exe, &local) || same_file_bytes(hook_bin, &local));
        if hook_bin.exists() {
            remove_bin(hook_bin, &exe, opts.dry_run, opts.lang);
            if !(opts.antigravity || opts.agy_file.is_some() || opts.dsh || opts.dsh_home.is_some())
            {
                println!(
                    "  {}",
                    t(
                        opts.lang,
                        "[note] If setup ran with --antigravity / --dsh, their hooks now point at the removed binary: run the rollback again with the same flags.",
                        "[note] Если setup запускался с --antigravity / --dsh, их хуки указывают на удалённый бинарь: запустите откат с теми же флагами."
                    )
                );
            }
        }
        if local_is_ours {
            remove_bin(&local, &exe, opts.dry_run, opts.lang);
        } else if !custom_profile && local.exists() {
            println!("  left (differs from ours): {}", local.display());
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_ours_from_settings_and_empty_containers() {
        let ours = "\"C:/h/ctxkit.exe\"";
        let orig = json!({
            "model": "opus", "keep": 1,
            "env": { "CTXKIT_LANG": "ru" },
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [{ "type": "command", "command": ours }] },
                    { "matcher": "Edit", "hooks": [{ "type": "command", "command": "node C:/tools/ctxkit-helper/x.js" }] },
                    { "hooks": [{ "command": "\"D:/old/ctxkit.exe\" --lang ru" }, { "command": "mine" }] }
                ],
                "PostToolUse": [{ "hooks": [{ "command": ours }] }],
                "Stop": [{ "hooks": [{ "command": ours }] }],
                "SessionStart": [{ "hooks": [{ "command": "echo" }] }]
            }
        });
        let next = remove_from_settings(&orig, ours);
        assert_eq!(next["model"], "opus", "models are not touched");
        assert_eq!(next["keep"], 1);
        assert!(next.get("env").is_none(), "env emptied by us is dropped");
        let h = &next["hooks"];
        assert!(h.get("PostToolUse").is_none() && h.get("Stop").is_none());
        assert_eq!(h["SessionStart"], orig["hooks"]["SessionStart"]);
        let pre = h["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2);
        assert_eq!(
            pre[0]["hooks"][0]["command"],
            "node C:/tools/ctxkit-helper/x.js"
        );
        assert_eq!(pre[1]["hooks"], json!([{ "command": "mine" }]));
        assert_eq!(remove_from_settings(&next, ours), next, "idempotent");
        let foreign_env = json!({ "env": { "CTXKIT_LANG": "ru", "KEEP": "1" } });
        assert_eq!(
            remove_from_settings(&foreign_env, ours),
            json!({ "env": { "KEEP": "1" } })
        );
        let empty_hooks = json!({ "hooks": {}, "env": {} });
        assert_eq!(
            remove_from_settings(&empty_hooks, ours),
            empty_hooks,
            "untouched empties stay"
        );
    }

    #[test]
    fn strips_rules_blocks_new_and_legacy_and_keeps_user_text() {
        let block = format!("{MARKER_START}\nrules\n{MARKER_END}");
        assert_eq!(
            strip_rules_blocks(&append_block("# Mine\ntext\n", &block)),
            "# Mine\ntext\n"
        );
        assert_eq!(strip_rules_blocks(&append_block("", &block)), "");
        let both =
            format!("a\n\n{LEGACY_MARKER_START}\nold\n{LEGACY_MARKER_END}\n\nb\n\n{block}\n\nc\n");
        assert_eq!(strip_rules_blocks(&both), "a\n\nb\n\nc\n");
        let user_only = "# Mine\n";
        assert_eq!(strip_rules_blocks(user_only), user_only);
    }

    #[test]
    fn strips_dsh_block_and_refuses_a_half_block() {
        let patch = format!("- keep: 1\n\n{DSH_MARKER_START}\n- insert: x\n{DSH_MARKER_END}\n");
        assert_eq!(strip_dsh_block(&patch), Ok("- keep: 1\n".to_string()));
        assert_eq!(
            strip_dsh_block("- keep: 1\n"),
            Ok("- keep: 1\n".to_string())
        );
        assert_eq!(
            strip_dsh_block(&format!("a\n{DSH_MARKER_START}\nb\n")),
            Err(())
        );
    }

    #[test]
    fn setup_only_flags_are_rejected() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            reject_setup_only_flags(&a(&["--uninstall", "--no-agents"])),
            Some("--no-agents")
        );
        assert_eq!(
            reject_setup_only_flags(&a(&["--uninstall", "--dry-run", "--dsh"])),
            None
        );
    }
}
