//! `ctxkit.json` in `ctxkit setup`: `--policy` writes the `policies` section, every other run only reads it
//! (the rules block lists the policies that are on). The rollback side lives in `uninstall.rs`.
use super::*;
use crate::policy::{self, Config, Selection};

pub(super) fn path(profile: &Path) -> PathBuf {
    profile.join(policy::FILE)
}

/// `Err` when an existing `ctxkit.json` cannot be parsed: checked before anything is written.
pub(super) fn preflight(profile: &Path) -> Result<(), String> {
    let p = path(profile);
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

/// Applies `--policy` (when given) and returns the policies as they are after this run.
/// Without the flag nothing is written, and the file is not even created.
pub(super) fn run(
    profile: &Path,
    backup_dir: &Path,
    sel: Option<&Selection>,
    dry_run: bool,
) -> Result<Config, String> {
    let p = path(profile);
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
    let before = policy::parse(&orig.to_string())?;
    let mut next = orig.clone();
    let root = next.as_object_mut().ok_or_else(|| {
        msg!(
            "ctxkit.json root is not object",
            "корень ctxkit.json не является объектом"
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
            "  policies: none, so no ctxkit.json is created",
            "  политики: нет, поэтому ctxkit.json не создаётся"
        );
        return Ok(after);
    }
    write_json_if_changed(&p, Some(backup_dir), &orig, &next, dry_run, "ctxkit.json")?;
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
            err.contains("ctxkit.json") && err.contains("commit_hygiene"),
            "{err}"
        );
        fs::write(path(&d), "{").unwrap();
        assert!(preflight(&d).is_err());
        let _ = fs::remove_dir_all(&d);
        assert!(preflight(&d).is_ok(), "no file is fine");
    }
}
