//! `context-toolkit.json` in `context-toolkit setup`: `--policy` writes the `policies` section, every other run only reads it
//! (the rules block lists the policies that are on). The rollback side lives in `uninstall.rs`.
use super::*;
use crate::policy::{self, Config, Selection};

pub(super) fn path(profile: &Path) -> PathBuf {
    profile.join(policy::FILE)
}

/// `Err` when the policy file that is read (`policy::file_in`) cannot be parsed: checked before anything is written.
pub(super) fn preflight(profile: &Path) -> Result<(), String> {
    let p = policy::file_in(profile);
    if !p.exists() {
        return Ok(());
    }
    let text = read_text(&p)?;
    policy::parse(&text).map(|_| ()).map_err(|e| {
        msg!(
            "{}: {e}; fix or delete the file, then rerun",
            "{}: {e}; исправьте или удалите файл и запустите снова",
            p.display()
        )
    })
}

/// The policy file of the old name (`ctxkit.json`) goes to `context-toolkit.json`, byte for byte. One that setup
/// had created (its `created_by` mark) is moved: the old file goes after the new one is written (a backup stays).
/// One the owner wrote is copied and kept, and the output says it is no longer read. With both files present
/// nothing moves: the new one is read, and the old one is named.
pub(super) fn migrate(profile: &Path, backup_dir: &Path, dry_run: bool) -> Result<(), String> {
    let (new, old) = (path(profile), profile.join(policy::LEGACY_FILE));
    if !old.exists() {
        return Ok(());
    }
    if new.exists() {
        say!(
            "  [note] {} is not read while {} exists; delete it when you no longer need it",
            "  [note] {} не читается, пока есть {}; удалите его, когда он больше не нужен",
            old.display(),
            new.display()
        );
        return Ok(());
    }
    let bytes = fs::read(&old).map_err(|e| {
        msg!(
            "read {}: {e}",
            "не удалось прочитать {}: {e}",
            old.display()
        )
    })?;
    let ours = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
        .is_some_and(|v| policy::made_by_setup(v.get("created_by")));
    if dry_run {
        say!(
            "  [dry-run] old name: {} {} -> {}",
            "  [dry-run] старое имя: {} {} -> {}",
            if ours {
                msg!("move", "перенос")
            } else {
                msg!("copy", "копирование")
            },
            old.display(),
            new.display()
        );
        return Ok(());
    }
    write_atomic(&new, &bytes)?;
    if ours {
        let b = backup_file(&old, backup_dir)?;
        say!("  backup -> {}", "  копия -> {}", b.display());
        remove_file(&old)?;
        say!(
            "  old name: moved {} -> {}",
            "  старое имя: перенесён {} -> {}",
            old.display(),
            new.display()
        );
    } else {
        say!(
            "  old name: copied {} -> {}; the old file is yours and stays, but it is no longer read: delete it when you like",
            "  старое имя: скопирован {} -> {}; старый файл ваш и остаётся, но больше не читается: удалите его, когда захотите",
            old.display(),
            new.display()
        );
    }
    Ok(())
}

/// Applies `--policy` (when given) and returns the policies as they are after this run.
/// Without the flag nothing is written, and the file is not even created.
pub(super) fn run(
    profile: &Path,
    backup_dir: &Path,
    sel: Option<&Selection>,
    dry_run: bool,
) -> Result<Config, String> {
    let p = policy::file_in(profile);
    let Some(sel) = sel else {
        // not an error without `--policy`/`--with-rules` (preflight guards those), but the owner is told:
        // a file that does not parse means every policy is off
        if p.exists() {
            let broken = fs::read_to_string(&p)
                .map_err(|e| e.to_string())
                .and_then(|t| policy::parse(&t))
                .err();
            if let Some(e) = broken {
                say!(
                    "  [warn] {}: {e}; every policy is off until it is fixed or deleted",
                    "  [warn] {}: {e}; все политики выключены, пока файл не исправлен или не удалён",
                    p.display()
                );
            }
        }
        let cfg = policy::load_from(profile);
        println!(
            "{}",
            kept_line(
                if is_ru() {
                    "политики"
                } else {
                    "policies"
                },
                Some(&cfg.describe()),
                "--policy commit-hygiene,confirm-irreversible,stray-files,build-slots=2"
            )
        );
        return Ok(cfg);
    };
    let existed = p.exists();
    let orig = read_json_object(&p)?;
    let p = path(profile); // written under the new name, also when the old file was read (a dry run moved nothing)
    let before = policy::parse(&orig.to_string())?;
    let mut next = orig.clone();
    let root = next.as_object_mut().ok_or_else(|| {
        msg!(
            "context-toolkit.json root is not object",
            "корень context-toolkit.json не является объектом"
        )
    })?;
    sel.apply(root);
    if !existed {
        root.insert("created_by".to_string(), json!(policy::CREATED_BY));
    }
    let after = policy::parse(&next.to_string())?;

    let onoff = |b: bool| {
        Some(match (b, is_ru()) {
            (true, false) => "on",
            (false, false) => "off",
            (true, true) => "вкл",
            (false, true) => "выкл",
        })
    };
    for (label, old, new) in [
        (
            "commit_hygiene",
            before.commit_hygiene,
            after.commit_hygiene,
        ),
        (
            "confirm_irreversible",
            before.confirm_irreversible,
            after.confirm_irreversible,
        ),
        ("stray_files", before.stray_files, after.stray_files),
    ] {
        println!(
            "{}",
            change_line(
                &msg!("policy {label}", "политика {label}"),
                onoff(old),
                onoff(new)
            )
        );
    }
    let slots = |c: &Config| c.build_slots.map(|n| n.to_string());
    println!(
        "{}",
        change_line(
            &msg!("policy build_slots", "политика build_slots"),
            slots(&before).as_deref().or(onoff(false)),
            slots(&after).as_deref().or(onoff(false))
        )
    );
    if !existed && after == Config::default() {
        say!(
            "  policies: none, so no context-toolkit.json is created",
            "  политики: нет, поэтому context-toolkit.json не создаётся"
        );
        return Ok(after);
    }
    write_json_if_changed(&p, Some(backup_dir), &orig, &next, dry_run, policy::FILE)?;
    Ok(after)
}

#[cfg(test)]
pub(super) fn temp_profile(name: &str) -> PathBuf {
    let d = env::temp_dir().join(format!("ctxkit-pol-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sel(list: &str) -> Selection {
        policy::parse_selection(list).unwrap()
    }

    #[test]
    fn without_the_flag_nothing_is_created_or_rewritten() {
        let d = temp_profile("noflag");
        let bak = d.join("backups");
        // no file: none is created
        let cfg = run(&d, &bak, None, false).unwrap();
        assert_eq!(cfg, Config::default());
        assert!(!path(&d).exists() && !bak.exists());
        // a hand-written file with its own formatting stays byte for byte
        let hand = "{ \"policies\": {\"stray_files\":true},\n   \"rules\": [\"a b c d e\"] }";
        fs::write(path(&d), hand).unwrap();
        let cfg = run(&d, &bak, None, false).unwrap();
        assert!(cfg.stray_files);
        assert_eq!(fs::read_to_string(path(&d)).unwrap(), hand);
        assert!(!bak.exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn policy_flag_writes_keeps_foreign_keys_backs_up_and_dry_run_writes_nothing() {
        let d = temp_profile("write");
        let bak = d.join("backups");
        // dry run: nothing on disk
        run(&d, &bak, Some(&sel("commit-hygiene,build-slots=2")), true).unwrap();
        assert!(!path(&d).exists());
        // real run creates the file with the marker of our own creation
        let cfg = run(&d, &bak, Some(&sel("commit-hygiene,build-slots=2")), false).unwrap();
        assert!(cfg.commit_hygiene && cfg.build_slots == Some(2) && !cfg.stray_files);
        let v: Value = serde_json::from_str(&fs::read_to_string(path(&d)).unwrap()).unwrap();
        assert_eq!(v["created_by"], policy::CREATED_BY);
        assert_eq!(
            v["policies"],
            json!({"commit_hygiene": true, "build_slots": 2})
        );
        assert!(!bak.exists(), "a new file has nothing to back up");
        // the owner adds a key; a later run keeps it, backs the file up, switches what was asked
        let mut v = v;
        v["rules"] = json!(["my own line of text here"]);
        v["policies"]["future"] = json!(1);
        fs::write(path(&d), serde_json::to_string(&v).unwrap()).unwrap();
        let cfg = run(&d, &bak, Some(&sel("stray-files")), false).unwrap();
        assert!(cfg.stray_files && !cfg.commit_hygiene && cfg.build_slots.is_none());
        let v: Value = serde_json::from_str(&fs::read_to_string(path(&d)).unwrap()).unwrap();
        assert_eq!(v["rules"], json!(["my own line of text here"]));
        assert_eq!(v["policies"], json!({"stray_files": true, "future": 1}));
        assert_eq!(
            v["created_by"],
            policy::CREATED_BY,
            "the marker of a file we created stays"
        );
        assert_eq!(fs::read_dir(&bak).unwrap().count(), 1);
        // the same selection again changes nothing and makes no second backup
        run(&d, &bak, Some(&sel("stray-files")), false).unwrap();
        assert_eq!(fs::read_dir(&bak).unwrap().count(), 1);
        // `none` on a profile without the file creates nothing
        let e = temp_profile("none");
        let cfg = run(&e, &e.join("backups"), Some(&sel("none")), false).unwrap();
        assert_eq!(cfg, Config::default());
        assert!(!path(&e).exists());
        let _ = fs::remove_dir_all(&d);
        let _ = fs::remove_dir_all(&e);
    }

    #[test]
    fn a_file_that_existed_gets_no_marker_and_a_broken_one_stops_setup() {
        let d = temp_profile("owned");
        fs::write(path(&d), r#"{"stray_patterns":["x*.md"]}"#).unwrap();
        run(&d, &d.join("backups"), Some(&sel("commit-hygiene")), false).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(path(&d)).unwrap()).unwrap();
        assert!(v.get("created_by").is_none());
        assert_eq!(v["stray_patterns"], json!(["x*.md"]));
        // preflight: a broken file is refused before anything is written
        assert!(preflight(&d).is_ok());
        fs::write(path(&d), r#"{"policies":{"commit_hygiene":"yes"}}"#).unwrap();
        let err = preflight(&d).unwrap_err();
        assert!(
            err.contains("context-toolkit.json") && err.contains("commit_hygiene"),
            "{err}"
        );
        fs::write(path(&d), "{").unwrap();
        assert!(preflight(&d).is_err());
        let _ = fs::remove_dir_all(&d);
        assert!(preflight(&d).is_ok(), "no file is fine");
    }

    #[test]
    fn the_old_policy_file_is_moved_when_setup_made_it_and_copied_when_it_is_the_owners() {
        let d = temp_profile("migrate");
        let (new, old, bak) = (path(&d), d.join(policy::LEGACY_FILE), d.join("backups"));
        // nothing to move
        migrate(&d, &bak, false).unwrap();
        assert!(!new.exists() && !bak.exists());
        // made by setup under the old name: a dry run moves nothing, a real run moves it byte for byte
        let ours = "{\"created_by\":\"ctxkit setup\",\r\n \"policies\":{\"stray_files\":true}}";
        fs::write(&old, ours).unwrap();
        migrate(&d, &bak, true).unwrap();
        assert!(old.exists() && !new.exists(), "dry run");
        migrate(&d, &bak, false).unwrap();
        assert!(!old.exists());
        assert_eq!(fs::read_to_string(&new).unwrap(), ours);
        assert_eq!(
            fs::read_dir(&bak).unwrap().count(),
            1,
            "the old file is backed up"
        );
        assert!(policy::load_from(&d).stray_files);
        // a second run: nothing left to move
        migrate(&d, &bak, false).unwrap();
        assert_eq!(fs::read_to_string(&new).unwrap(), ours);
        // the owner's own old file: copied, and it stays
        let e = temp_profile("migrate-own");
        let own = r#"{"policies":{"commit_hygiene":true},"rules":["mine of five words"]}"#;
        fs::write(e.join(policy::LEGACY_FILE), own).unwrap();
        migrate(&e, &e.join("backups"), false).unwrap();
        assert_eq!(fs::read_to_string(path(&e)).unwrap(), own);
        assert_eq!(
            fs::read_to_string(e.join(policy::LEGACY_FILE)).unwrap(),
            own
        );
        // both present: nothing moves, the new file is the one read
        fs::write(path(&e), r#"{"policies":{}}"#).unwrap();
        migrate(&e, &e.join("backups"), false).unwrap();
        assert_eq!(fs::read_to_string(path(&e)).unwrap(), r#"{"policies":{}}"#);
        assert!(!policy::load_from(&e).commit_hygiene);
        // `--policy` on an old file in a dry run reads it and writes nothing
        let f = temp_profile("migrate-dry");
        fs::write(f.join(policy::LEGACY_FILE), own).unwrap();
        let cfg = run(&f, &f.join("backups"), Some(&sel("stray-files")), true).unwrap();
        assert!(cfg.stray_files && !path(&f).exists());
        for x in [d, e, f] {
            let _ = fs::remove_dir_all(&x);
        }
    }
}
