//! Writing files that belong to someone else (settings.json, CLAUDE.md, hooks.json, presets, YAML patches).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

/// Where a write to `path` really lands: a symbolic link is followed (the link itself must stay a link),
/// a missing target of a dangling link is the link's target as written.
fn resolve_link(path: &Path) -> PathBuf {
    let is_link = fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
    if !is_link {
        return path.to_path_buf();
    }
    fs::canonicalize(path).unwrap_or_else(|_| match fs::read_link(path) {
        Ok(t) if t.is_absolute() => t,
        Ok(t) => path.parent().unwrap_or_else(|| Path::new(".")).join(t),
        Err(_) => path.to_path_buf(),
    })
}

/// Replaces the file with `bytes` all at once: the bytes go to a temporary file beside it (same folder,
/// so the same volume), are flushed, and the temporary file is renamed over the target. A crash or a full
/// disk leaves the old file whole, never a half-written one. The permissions of the old file carry over
/// and a symbolic link is written through. The parent folder must exist.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let target = resolve_link(path);
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = target.with_file_name(format!(".{name}.ctxkit-{}.tmp", std::process::id()));
    let res = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        // An editor or an antivirus may hold the target open for a moment (Windows refuses the replace).
        let mut last = Ok(());
        for _ in 0..5 {
            last = fs::rename(&tmp, &target);
            if last.is_ok() {
                break;
            }
            sleep(Duration::from_millis(60));
        }
        last
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res.map_err(|e| format!("write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ctxkit-fsx-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn leftovers(d: &Path) -> Vec<String> {
        fs::read_dir(d)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn creates_replaces_and_leaves_no_temp_file() {
        let d = temp("replace");
        let f = d.join("settings.json");
        write_atomic(&f, b"one").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"one");
        write_atomic(&f, b"two\r\nlines").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"two\r\nlines");
        assert!(leftovers(&d).is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_failed_write_keeps_the_target_and_removes_the_temp_file() {
        let d = temp("fail");
        // A directory with the target's name: the rename cannot replace it.
        let target = d.join("hooks.json");
        fs::create_dir_all(target.join("inner")).unwrap();
        let err = write_atomic(&target, b"x").unwrap_err();
        assert!(err.starts_with("write "), "{err}");
        assert!(target.join("inner").is_dir());
        assert!(leftovers(&d).is_empty());
        // A missing parent folder is an error too, not a silent success.
        assert!(write_atomic(&d.join("no").join("x.json"), b"x").is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_symbolic_link_stays_a_link_and_its_target_is_rewritten() {
        let d = temp("link");
        let real = d.join("real.json");
        fs::write(&real, "old").unwrap();
        let link = d.join("link.json");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(&real, &link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&real, &link);
        if made.is_err() {
            // Windows needs the symlink privilege (developer mode); without it there is nothing to test.
            let _ = fs::remove_dir_all(&d);
            return;
        }
        write_atomic(&link, b"new").unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&real).unwrap(), b"new");
        assert!(leftovers(&d).is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn permissions_of_the_old_file_carry_over() {
        use std::os::unix::fs::PermissionsExt;
        let d = temp("mode");
        let f = d.join("secret.json");
        fs::write(&f, "a").unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o600)).unwrap();
        write_atomic(&f, b"b").unwrap();
        assert_eq!(
            fs::metadata(&f).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_dir_all(&d);
    }
}
