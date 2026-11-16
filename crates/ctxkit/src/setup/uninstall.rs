//! `ctxkit setup --uninstall`: removes only what `ctxkit setup` added (our hook elements, `CTXKIT_LANG`,
//! the rules block, Antigravity/DSH entries, our binary). Model choices are not undone because the
//! previous values are not known: they are printed with the path to the settings.json backups instead.
use super::*;
use crate::t;

/// Flags that only make sense for an install; passing them with `--uninstall` is an error, not a no-op.
pub(super) const SETUP_ONLY_FLAGS: [&str; 10] = [
    "--policy",
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
    let eol = if before.contains("\r\n") || after.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let (before, after) = (before.trim_end(), after.trim_start());
    match (before.is_empty(), after.is_empty()) {
        (true, true) => String::new(),
        (true, false) => after.to_string(),
        (false, true) => format!("{before}{eol}"),
        (false, false) => format!("{before}{eol}{eol}{after}"),
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

/// Whether any rules marker line is still in the text (after every whole block was cut out of it).
fn marker_lines_left(text: &str) -> bool {
    [
        MARKER_START,
        MARKER_END,
        LEGACY_MARKER_START,
        LEGACY_MARKER_END,
    ]
    .iter()
    .any(|m| marker_lines(text, m) > 0)
}

/// A backup and its bytes.
type Saved = (PathBuf, Vec<u8>);

/// Reads the backups of `name` in `dir` (oldest first). Taken before the rollback writes anything,
/// so the backup the rollback itself makes is never among them.
fn read_backups(dir: &Path, name: &str) -> Vec<Saved> {
    list_backups_of(dir, name)
        .into_iter()
        .filter_map(|p| fs::read(&p).ok().map(|b| (p, b)))
        .collect()
}

/// What "the same text" means when a backup is compared with the rolled-back file: line breaks unified,
/// trailing whitespace dropped (setup trims the end of the file before it appends its block).
fn text_key(s: &str) -> String {
    s.replace("\r\n", "\n").trim_end().to_string()
}

/// The latest backup that is the text as it was before setup (no ctxkit block in it, `clean`) and equals
/// the rolled-back `result` apart from line breaks and trailing whitespace: restoring its bytes gives the
/// user's file back byte for byte (CRLF, a missing final newline, extra blank lines at the end).
fn exact_text_backup<'a>(
    result: &str,
    backups: &'a [Saved],
    clean: impl Fn(&str) -> bool,
) -> Option<&'a Saved> {
    backups.iter().rev().find(|(_, bytes)| {
        std::str::from_utf8(bytes)
            .is_ok_and(|text| clean(text) && text_key(text) == text_key(result))
    })
}

/// Writes `bytes` over `path`, after a backup of what is there now (made by this run).
fn restore_bytes(
    path: &Path,
    backup_dir: &Path,
    bytes: &[u8],
    what: &str,
    dry_run: bool,
) -> Result<(), String> {
    if dry_run {
        println!("  [dry-run] {what}: {}", path.display());
        return Ok(());
    }
    let b = backup_file(path, backup_dir)?;
    println!("  backup -> {}", b.display());
    write_atomic(path, bytes)?;
    println!("  {what}: {}", path.display());
    Ok(())
}

/// Deletes a file that setup created (after a backup of it), so a rollback leaves no empty husk.
fn delete_created(path: &Path, backup_dir: &Path, what: &str, dry_run: bool) -> Result<(), String> {
    if dry_run {
        println!("  [dry-run] {what}: {}", path.display());
        return Ok(());
    }
    let b = backup_file(path, backup_dir)?;
    println!("  backup -> {}", b.display());
    fs::remove_file(path).map_err(|e| format!("remove {}: {e}", path.display()))?;
    println!("  {what}: {}", path.display());
    Ok(())
}

fn remove_rules_block(path: &Path, backup_dir: &Path, dry_run: bool) -> Result<(), String> {
    if !path.exists() {
        println!("  skip rules (not found): {}", path.display());
        return Ok(());
    }
    let existing = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let updated = strip_rules_blocks(&existing);
    // Markers that are still unbalanced after the whole blocks are gone (a start without an end).
    if marker_lines_left(&updated) {
        println!(
            "  [warn] {}: a ctxkit start or end marker has no pair; remove the leftover block by hand",
            path.display()
        );
    }
    if existing == updated {
        if !marker_lines_left(&updated) {
            println!("  ok rules block (not present): {}", path.display());
        }
        return Ok(());
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let backups = read_backups(backup_dir, name);
    if let Some((from, bytes)) = exact_text_backup(&updated, &backups, |t| !marker_lines_left(t)) {
        let what = format!(
            "removed rules block (restored byte for byte from {})",
            from.display()
        );
        return restore_bytes(path, backup_dir, bytes, &what, dry_run);
    }
    // Setup made the file when no backup exists, or every backup holds nothing but our block (a second
    // setup run backs up the first one's file): with only the block in it, the rollback deletes the file.
    let ours_only =
        |text: &str| marker_lines_left(text) && strip_rules_blocks(text).trim().is_empty();
    let made_by_setup = backups
        .iter()
        .all(|(_, b)| std::str::from_utf8(b).is_ok_and(ours_only));
    if updated.trim().is_empty() && made_by_setup {
        return delete_created(
            path,
            backup_dir,
            "removed rules file (setup had created it)",
            dry_run,
        );
    }
    restore_bytes(
        path,
        backup_dir,
        updated.as_bytes(),
        "removed rules block",
        dry_run,
    )
}

/// Settings with the empty `hooks` / `env` objects dropped: setup creates them and the rollback removes
/// them again, so a pre-setup file with an empty `"hooks": {}` still counts as the same settings.
fn canon_settings(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(root) = v.as_object_mut() {
        for k in ["hooks", "env"] {
            if root
                .get(k)
                .and_then(Value::as_object)
                .is_some_and(Map::is_empty)
            {
                root.remove(k);
            }
        }
    }
    v
}

fn parse_settings(bytes: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(bytes).ok()?;
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    v.is_object().then_some(v)
}

/// What the rollback does with settings.json.
#[derive(Debug, PartialEq)]
enum SettingsOutcome {
    /// Rewrite the cleaned settings (the usual case).
    Write,
    /// A backup holds the file as the user had it and nothing else changed since: put its bytes back.
    Restore(PathBuf, Vec<u8>),
    /// Setup created the file and nothing of the user's is in it: delete it, not leave `{}`.
    Delete,
}

fn settings_outcome(next: &Value, backups: &[Saved], hook_cmd: &str) -> SettingsOutcome {
    let ours = |v: &Value| remove_from_settings(v, hook_cmd) != *v;
    let exact = backups.iter().rev().find(|(_, bytes)| {
        parse_settings(bytes)
            .is_some_and(|v| !ours(&v) && canon_settings(&v) == canon_settings(next))
    });
    if let Some((path, bytes)) = exact {
        return SettingsOutcome::Restore(path.clone(), bytes.clone());
    }
    // Every earlier backup is a file of ours only (or there is none): the user's settings never existed.
    let created = backups.iter().all(|(_, bytes)| {
        parse_settings(bytes).is_some_and(|v| {
            ours(&v) && canon_settings(&remove_from_settings(&v, hook_cmd)) == json!({})
        })
    });
    if created && canon_settings(next) == json!({}) {
        return SettingsOutcome::Delete;
    }
    SettingsOutcome::Write
}

/// Takes the `policies` section out of `ctxkit.json`. The file goes only when setup created it and nothing
/// of the owner's is in it; otherwise the owner's keys stay and the output says which.
fn remove_policies(profile: &Path, backup_dir: &Path, dry_run: bool) -> Result<(), String> {
    let path = policies::path(profile);
    if !path.exists() {
        println!("  ok ctxkit.json (not present): {}", path.display());
        return Ok(());
    }
    let orig = match read_json_object(&path) {
        Ok(v) => v,
        Err(e) => {
            println!("  [warn] {e}; ctxkit.json left as it is");
            return Ok(());
        }
    };
    let Some(root) = orig.as_object().filter(|r| r.contains_key("policies")) else {
        println!("  ok ctxkit.json (no policies section): {}", path.display());
        return Ok(());
    };
    let created = root.get("created_by") == Some(&json!(policy::CREATED_BY));
    let mut next = root.clone();
    next.remove("policies");
    next.remove("created_by");
    let mut left: Vec<&str> = next.keys().map(String::as_str).collect();
    left.sort_unstable();
    if created && left.is_empty() {
        return delete_created(
            &path,
            backup_dir,
            "removed ctxkit.json (setup had created it)",
            dry_run,
        );
    }
    let note = if left.is_empty() {
        "kept the file, now empty: setup did not create it".to_string()
    } else {
        format!("kept your keys: {}", left.join(", "))
    };
    write_json_if_changed(
        &path,
        Some(backup_dir),
        &orig,
        &Value::Object(next),
        dry_run,
        "ctxkit.json (policies section removed)",
    )?;
    println!("  {note}");
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
        let backups = read_backups(&profile, "cordis.patch.yml");
        let exact = exact_text_backup(&updated, &backups, |t| !t.contains(DSH_MARKER_START));
        let (bytes, what) = match exact {
            Some((from, b)) => (
                b.clone(),
                format!(
                    "removed ctxkit block from DeepSeek Harness profile patch (restored byte for byte from {})",
                    from.display()
                ),
            ),
            None => (
                updated.into_bytes(),
                "removed ctxkit block from DeepSeek Harness profile patch".to_string(),
            ),
        };
        restore_bytes(&patch, &profile, &bytes, &what, false)?;
    }
    Ok(())
}

/// The `<name>.<timestamp>[.<n>].bak` files of `name` in `dir`, oldest first (by the timestamp in the name).
fn list_backups_of(dir: &Path, name: &str) -> Vec<PathBuf> {
    let prefix = format!("{name}.");
    let mut found: Vec<((u64, u64), PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().to_string();
            let middle = file
                .strip_prefix(&prefix)?
                .strip_suffix(".bak")?
                .to_string();
            let mut parts = middle.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
            let key = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
            Some((key, e.path()))
        })
        .collect();
    found.sort();
    found.into_iter().map(|(_, p)| p).collect()
}

/// `settings.json.*.bak` in `dir`, oldest first.
fn list_backups(dir: &Path) -> Vec<PathBuf> {
    list_backups_of(dir, "settings.json")
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
    earlier: &[PathBuf],
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
    for line in backup_lines(backups, earlier, profile, lang) {
        println!("{line}");
    }
}

/// The settings.json backups block. `backups` is the list after the rollback, `earlier` the one before it:
/// a backup that is only in `backups` was made by this very run (the state before the rollback, not before
/// the first setup), and is said so instead of the "none found" line.
fn backup_lines(
    backups: &[PathBuf],
    earlier: &[PathBuf],
    profile: &Path,
    lang: Lang,
) -> Vec<String> {
    let (Some(last), Some(first)) = (backups.last(), backups.first()) else {
        return vec![format!(
            "  {}",
            t(
                lang,
                "(no settings.json backups: settings.json was not changed)",
                "(бэкапов settings.json нет: файл не менялся)"
            )
        )];
    };
    let note = |p: &PathBuf| {
        if earlier.contains(p) {
            String::new()
        } else {
            t(
                lang,
                " (made by this run: the state before the rollback)",
                " (сделан этим запуском: состояние до отката)",
            )
            .to_string()
        }
    };
    let mut out = vec![
        format!(
            "  settings.json backups: {}",
            last.parent().unwrap_or(profile).display()
        ),
        format!("    latest:   {}{}", last.display(), note(last)),
    ];
    if first != last {
        let hint = if earlier.contains(first) {
            t(
                lang,
                " (most likely the state before the first setup)",
                " (скорее всего, состояние до первого setup)",
            )
            .to_string()
        } else {
            note(first)
        };
        out.push(format!("    earliest: {}{hint}", first.display()));
    }
    out.push(format!(
        "  {}",
        t(
            lang,
            "To restore the old values open a backup, copy the keys above into settings.json, or copy the whole file back.",
            "Чтобы вернуть прежние значения, откройте бэкап и перенесите ключи выше в settings.json или верните файл целиком."
        )
    ));
    out
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
    // Listed before any write, to tell the backup made by this very run from the old ones.
    let earlier = list_backups(&backup_dir);
    let run = || -> Result<Value, String> {
        // Everything the rollback will touch is checked before the first write, so a refusal leaves no half-done state.
        preflight_settings(&settings_path, false)?;
        readable_utf8(&profile.join("CLAUDE.md"))?;
        if opts.dsh || opts.dsh_home.is_some() {
            let dsh = opts
                .dsh_home
                .clone()
                .or_else(|| env::var_os("DSH_HOME").map(PathBuf::from))
                .unwrap_or_else(|| home.join(".dsh"));
            readable_utf8(&dsh.join("AGENTS.md"))?;
            readable_utf8(
                &dsh.join("profiles")
                    .join("desktop")
                    .join("cordis.patch.yml"),
            )?;
        }
        if opts.antigravity || opts.agy_file.is_some() {
            let apath = opts
                .agy_file
                .clone()
                .unwrap_or_else(|| home.join(".gemini").join("config").join("hooks.json"));
            if apath.exists() {
                read_json_object(&apath)?;
            }
        }
        let orig = read_json_object(&settings_path)?;
        let next = remove_from_settings(&orig, hook_cmd);
        let saved = read_backups(&backup_dir, "settings.json");
        let outcome = if orig == next {
            SettingsOutcome::Write // nothing to remove: write_json_if_changed reports "unchanged"
        } else {
            settings_outcome(&next, &saved, hook_cmd)
        };
        match outcome {
            SettingsOutcome::Write => write_json_if_changed(
                &settings_path,
                Some(&backup_dir),
                &orig,
                &next,
                opts.dry_run,
                "settings.json",
            )?,
            SettingsOutcome::Restore(from, bytes) => restore_bytes(
                &settings_path,
                &backup_dir,
                &bytes,
                &format!(
                    "restored settings.json byte for byte from {}",
                    from.display()
                ),
                opts.dry_run,
            )?,
            SettingsOutcome::Delete => delete_created(
                &settings_path,
                &backup_dir,
                "removed settings.json (setup had created it)",
                opts.dry_run,
            )?,
        }
        remove_rules_block(&profile.join("CLAUDE.md"), &backup_dir, opts.dry_run)?;
        remove_policies(profile, &backup_dir, opts.dry_run)?;
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
    let backups = list_backups(&backup_dir);
    print_kept(
        &orig,
        profile,
        desktop.as_deref(),
        &backups,
        &earlier,
        opts.lang,
    );

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

    fn saved(name: &str, text: &str) -> Saved {
        (
            PathBuf::from(format!("/b/{name}.bak")),
            text.as_bytes().to_vec(),
        )
    }

    #[test]
    fn exact_text_backup_needs_a_clean_backup_with_the_same_text() {
        let block = format!("{MARKER_START}\nrules\n{MARKER_END}");
        let clean = |t: &str| !marker_lines_left(t);
        let original = "# Mine\r\nkeep\r\n";
        let backups = [
            saved("CLAUDE.md.1", original),
            saved("CLAUDE.md.2", &append_block(original, &block)),
        ];
        // the one with the block in it is never a restore source; the clean one matches modulo CRLF / trailing blanks
        let hit = exact_text_backup("# Mine\nkeep", &backups, clean).unwrap();
        assert_eq!(hit.1, original.as_bytes());
        assert!(exact_text_backup("# Mine\nchanged", &backups, clean).is_none());
        assert!(exact_text_backup("anything", &backups[1..], clean).is_none());
        // an empty original file matches an empty result
        assert!(exact_text_backup("", &[saved("a.1", "")], clean).is_some());
        // the latest of several matching backups wins
        let two = [saved("a.1", "x\n"), saved("a.2", "x\r\n")];
        assert_eq!(exact_text_backup("x", &two, clean).unwrap().1, b"x\r\n");
    }

    #[test]
    fn settings_outcome_restores_deletes_or_writes() {
        let ours = "\"C:/h/ctxkit.exe\"";
        let setup_made = r#"{"hooks":{"Stop":[{"hooks":[{"command":"\"C:/h/ctxkit.exe\""}]}]}}"#;
        let users = "{\r\n  \"zeta\": 1,\r\n  \"hooks\": {}\r\n}";
        let b = |t: &str| saved("settings.json.1", t);
        // the user's file, nothing else changed since: its bytes come back (the empty "hooks" included)
        let next = json!({"zeta": 1});
        assert_eq!(
            settings_outcome(&next, &[b(users)], ours),
            SettingsOutcome::Restore(
                PathBuf::from("/b/settings.json.1.bak"),
                users.as_bytes().to_vec()
            )
        );
        // the user changed a value since: a plain write
        assert_eq!(
            settings_outcome(&json!({"zeta": 2}), &[b(users)], ours),
            SettingsOutcome::Write
        );
        // no backup, or only backups of files made by setup: the empty result means the file goes
        assert_eq!(
            settings_outcome(&json!({}), &[], ours),
            SettingsOutcome::Delete
        );
        assert_eq!(
            settings_outcome(&json!({}), &[b(setup_made)], ours),
            SettingsOutcome::Delete
        );
        // a user's own `{}` is restored, not deleted; a result with content is never deleted
        assert!(matches!(
            settings_outcome(&json!({}), &[b("{}")], ours),
            SettingsOutcome::Restore(..)
        ));
        assert_eq!(
            settings_outcome(&json!({"a": 1}), &[], ours),
            SettingsOutcome::Write
        );
        // a backup that already holds our hook is no restore source
        assert_eq!(
            settings_outcome(&json!({}), &[b(setup_made), b(users)], ours),
            SettingsOutcome::Write
        );
    }

    #[test]
    fn backups_are_listed_by_the_timestamp_in_their_name() {
        let d = std::env::temp_dir().join(format!("ctxkit-baklist-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        for n in [
            "settings.json.200.bak",
            "settings.json.100.1.bak",
            "settings.json.100.bak",
            "settings.json.1000.bak",
            "CLAUDE.md.50.bak",
            "settings.json.notes",
        ] {
            fs::write(d.join(n), "x").unwrap();
        }
        let names = |v: Vec<PathBuf>| -> Vec<String> {
            v.iter()
                .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
                .collect()
        };
        assert_eq!(
            names(list_backups(&d)),
            [
                "settings.json.100.bak",
                "settings.json.100.1.bak",
                "settings.json.200.bak",
                "settings.json.1000.bak"
            ]
        );
        assert_eq!(
            names(list_backups_of(&d, "CLAUDE.md")),
            ["CLAUDE.md.50.bak"]
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn join_cut_keeps_the_line_break_of_the_file() {
        assert_eq!(join_cut("a", "\r\nb\r\n"), "a\r\n\r\nb\r\n");
        assert_eq!(join_cut("a\r\nkeep", ""), "a\r\nkeep\r\n");
        assert_eq!(join_cut("a", "b"), "a\n\nb");
    }

    #[test]
    fn backup_lines_tell_this_runs_backup_from_old_ones() {
        let p = |n: &str| PathBuf::from(format!("/b/settings.json.{n}.bak"));
        let profile = Path::new("/profile");
        let none = backup_lines(&[], &[], profile, Lang::En);
        assert!(none[0].contains("no settings.json backups"));
        // the run made the only backup: it is the latest and is marked, never "none found"
        let fresh = backup_lines(&[p("2")], &[], profile, Lang::En).join("\n");
        assert!(fresh.contains("latest:") && fresh.contains("made by this run"));
        assert!(!fresh.contains("no settings.json backups"));
        // an old one plus this run's: the earliest keeps the "first setup" hint, the latest is marked
        let both = backup_lines(&[p("1"), p("2")], &[p("1")], profile, Lang::En).join("\n");
        assert!(both.contains("most likely the state before the first setup"));
        assert!(both
            .lines()
            .any(|l| l.contains("latest") && l.contains("made by this run")));
        let ru = backup_lines(&[p("2")], &[], profile, Lang::Ru).join("\n");
        assert!(ru.contains("сделан этим запуском"));
    }

    #[test]
    fn the_policies_section_goes_and_the_file_only_when_setup_made_it_and_it_holds_nothing_else() {
        let d = policies::temp_profile("rollback");
        let (file, bak) = (policies::path(&d), d.join("backups"));
        let read = || serde_json::from_str::<Value>(&fs::read_to_string(&file).unwrap()).unwrap();
        // absent file and a file without the section: nothing happens
        remove_policies(&d, &bak, false).unwrap();
        fs::write(&file, r#"{"rules":["a b c d e"]}"#).unwrap();
        remove_policies(&d, &bak, false).unwrap();
        assert_eq!(read(), json!({"rules":["a b c d e"]}));
        // broken file: left as it is
        fs::write(&file, "{ nope").unwrap();
        remove_policies(&d, &bak, false).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "{ nope");
        // made by setup, nothing of the owner's: deleted (after a backup), also with --dry-run first
        let ours = r#"{"created_by":"ctxkit setup","policies":{"stray_files":true}}"#;
        fs::write(&file, ours).unwrap();
        remove_policies(&d, &bak, true).unwrap();
        assert!(file.exists(), "dry run");
        remove_policies(&d, &bak, false).unwrap();
        assert!(!file.exists());
        assert_eq!(fs::read_dir(&bak).unwrap().count(), 1);
        // made by setup but the owner added a key: only the section (and the marker) go
        fs::write(
            &file,
            r#"{"created_by":"ctxkit setup","policies":{"stray_files":true},"rules":["a b c d e"],"stray_patterns":["x*"]}"#,
        )
        .unwrap();
        remove_policies(&d, &bak, false).unwrap();
        assert_eq!(
            read(),
            json!({"rules":["a b c d e"],"stray_patterns":["x*"]})
        );
        // not made by setup (no marker): the file stays, even when only the section was in it
        fs::write(&file, r#"{"policies":{"stray_files":true}}"#).unwrap();
        remove_policies(&d, &bak, false).unwrap();
        assert_eq!(read(), json!({}));
        // a second run changes nothing
        remove_policies(&d, &bak, false).unwrap();
        assert_eq!(read(), json!({}));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn setup_only_flags_are_rejected() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            reject_setup_only_flags(&a(&["--uninstall", "--no-agents"])),
            Some("--no-agents")
        );
        assert_eq!(
            reject_setup_only_flags(&a(&["--uninstall", "--policy", "none"])),
            Some("--policy")
        );
        assert_eq!(
            reject_setup_only_flags(&a(&["--uninstall", "--dry-run", "--dsh"])),
            None
        );
    }
}
