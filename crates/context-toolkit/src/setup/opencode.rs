//! OpenCode 2 (`setup --opencode`): it has no command hooks, so setup writes a plugin of ours
//! (`<config>/plugins/loadout-context-toolkit/index.js`, loaded automatically) that runs the hook binary with
//! `--opencode` on `execute.before`. The rules block goes to `<config>/AGENTS.md`, which OpenCode reads globally.
use super::*;

const TEMPLATE: &str = include_str!("opencode-plugin.js");
/// The first line of the plugin: a file at our path without it is not ours and is left alone.
const HEAD: &str = "// Context Toolkit (Loadout) for OpenCode 2:";
const EXE_LINE: &str = "const EXE = ";
const ARGS_LINE: &str = "const ARGS = ";

/// OpenCode's global config directory: `--opencode-home`, else `$OPENCODE_CONFIG_DIR`, else
/// `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode` (the same on Windows; packages/util/src/global.ts).
pub(crate) fn config_dir(custom: Option<&Path>, home: &Path) -> PathBuf {
    custom
        .map(Path::to_path_buf)
        // an empty variable counts as unset, as in OpenCode (`||`)
        .or_else(|| {
            env::var_os("OPENCODE_CONFIG_DIR")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| {
            env::var_os("XDG_CONFIG_HOME")
                .filter(|v| !v.is_empty())
                .map(|x| PathBuf::from(x).join("opencode"))
        })
        .unwrap_or_else(|| home.join(".config").join("opencode"))
}

pub(crate) fn plugin_path(dir: &Path) -> PathBuf {
    dir.join("plugins")
        .join("loadout-context-toolkit")
        .join("index.js")
}

/// The plugin for the hook command `exe args..`.
pub(crate) fn plugin_text(exe: &str, args: &[String]) -> String {
    TEMPLATE
        .replacen("\"@EXE@\"", &Value::from(exe).to_string(), 1)
        .replacen("\"@ARGS@\"", &Value::from(args.to_vec()).to_string(), 1)
}

/// The program and arguments the plugin runs for the installed hook command (`"C:/x/context-toolkit.exe"`, or
/// `--hook-cmd` with arguments of its own): `--opencode` and, in Russian, `--lang ru` are added unless present.
fn plugin_command(hook_cmd: &str, lang: Lang) -> (String, Vec<String>) {
    let mut words = first_words(hook_cmd, usize::MAX).into_iter();
    let exe = words.next().unwrap_or_default();
    let mut args: Vec<String> = words.collect();
    if !args.iter().any(|a| a == "--opencode") {
        args.push("--opencode".into());
    }
    if lang == Lang::Ru && !args.iter().any(|a| a == "--lang") {
        args.extend(["--lang".into(), "ru".into()]);
    }
    (exe, args)
}

/// What is at the plugin path: nothing, our plugin as this build writes it (for the command in it), our plugin of
/// another build, or a foreign file.
#[derive(Debug, PartialEq)]
pub(crate) enum PluginState {
    Missing,
    Current,
    Outdated,
    Foreign,
}

pub(crate) fn plugin_state(dir: &Path) -> PluginState {
    let Ok(bytes) = fs::read(plugin_path(dir)) else {
        return PluginState::Missing;
    };
    // not UTF-8 is not ours (and must not be overwritten); a BOM added by an editor still is
    let Ok(text) = String::from_utf8(bytes) else {
        return PluginState::Foreign;
    };
    if !text.trim_start_matches('\u{feff}').starts_with(HEAD) {
        return PluginState::Foreign;
    }
    match command_in(&text) {
        Some((exe, args)) if plugin_text(&exe, &args) == text => PluginState::Current,
        _ => PluginState::Outdated,
    }
}

/// The program and arguments written into a plugin text of ours (its `EXE` and `ARGS` lines).
fn command_in(text: &str) -> Option<(String, Vec<String>)> {
    let value = |prefix: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(prefix))
            .and_then(|v| serde_json::from_str::<Value>(v).ok())
    };
    let exe = value(EXE_LINE)?.as_str()?.to_string();
    let args = serde_json::from_value(value(ARGS_LINE)?).ok()?;
    Some((exe, args))
}

/// The hook program the installed plugin runs, when the plugin is ours.
pub(crate) fn plugin_exe(dir: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(plugin_path(dir)).ok()?;
    command_in(&text).map(|(exe, _)| PathBuf::from(exe))
}

/// Writes the plugin (a backup of an earlier one of ours goes to `<config>/backups`: a folder under `plugins/`
/// would be loaded as a plugin). A foreign file at our path stops setup before anything is written (`preflight`).
pub(super) fn install(dir: &Path, hook_cmd: &str, lang: Lang, dry_run: bool) -> Result<(), String> {
    let path = plugin_path(dir);
    let (exe, args) = plugin_command(hook_cmd, lang);
    let text = plugin_text(&exe, &args);
    if fs::read_to_string(&path).is_ok_and(|t| t == text) {
        say!(
            "  ok OpenCode plugin (unchanged): {}",
            "  ок плагин OpenCode (без изменений): {}",
            path.display()
        );
        return Ok(());
    }
    if dry_run {
        say!(
            "  [dry-run] write OpenCode plugin: {}",
            "  [dry-run] запись плагина OpenCode: {}",
            path.display()
        );
        return Ok(());
    }
    if path.exists() {
        let b = backup_file(&path, &dir.join("backups"))?;
        say!("  backup -> {}", "  копия -> {}", b.display());
    } else if let Some(parent) = path.parent() {
        mkdir(parent)?;
    }
    write_atomic(&path, text.as_bytes())?;
    say!(
        "  wrote OpenCode plugin: {}",
        "  записан плагин OpenCode: {}",
        path.display()
    );
    say!(
        "  [note] OpenCode loads the plugin when it starts: restart OpenCode (Desktop or opencode) to use it",
        "  [note] OpenCode загружает плагин при запуске: перезапустите OpenCode (Desktop или opencode), чтобы он заработал"
    );
    Ok(())
}

/// Refuses a file at the plugin path that is not ours: setup would overwrite someone else's plugin.
pub(super) fn preflight(dir: &Path) -> Result<(), String> {
    if plugin_state(dir) == PluginState::Foreign {
        return Err(msg!(
            "{} is not a Context Toolkit plugin; move it away and rerun",
            "{} не плагин Инструментов контекста; уберите его и запустите снова",
            plugin_path(dir).display()
        ));
    }
    Ok(())
}

/// Removes our plugin (after a backup in `<config>/backups`) and its folder when that is left empty. A foreign file is kept.
pub(super) fn remove(dir: &Path, dry_run: bool) -> Result<(), String> {
    let path = plugin_path(dir);
    match plugin_state(dir) {
        PluginState::Missing => {
            say!(
                "  ok OpenCode plugin (not present): {}",
                "  ок плагина OpenCode нет: {}",
                path.display()
            );
            return Ok(());
        }
        PluginState::Foreign => {
            say!(
                "  left (not ours): {}",
                "  оставлен (не наш): {}",
                path.display()
            );
            return Ok(());
        }
        PluginState::Current | PluginState::Outdated => {}
    }
    let what = msg!("removed OpenCode plugin", "плагин OpenCode удалён");
    uninstall::delete_created(&path, &dir.join("backups"), &what, dry_run)?;
    if !dry_run {
        // our folder, then `plugins/` that setup may have made: only an empty one goes (`remove_dir` refuses the rest)
        for folder in path.ancestors().skip(1).take(2) {
            let _ = fs::remove_dir(folder);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn command_words_get_the_client_flag_once() {
        let (exe, args) = plugin_command(
            "\"C:/Users/x y/.claude/hooks/context-toolkit.exe\"",
            Lang::Ru,
        );
        assert_eq!(exe, "C:/Users/x y/.claude/hooks/context-toolkit.exe");
        assert_eq!(args, ["--opencode", "--lang", "ru"]);
        let (exe, args) = plugin_command("D:/t/guard.exe --opencode --lang en", Lang::Ru);
        assert_eq!(
            (exe.as_str(), args),
            (
                "D:/t/guard.exe",
                vec!["--opencode".to_string(), "--lang".into(), "en".into()]
            )
        );
        assert_eq!(plugin_command("ctk", Lang::En).1, ["--opencode"]);
    }

    #[test]
    fn plugin_text_holds_the_command_as_json() {
        let text = plugin_text("C:/a \"b\"/ctk.exe", &["--opencode".into()]);
        assert!(text.starts_with(HEAD));
        assert!(text.contains(r#"const EXE = "C:/a \"b\"/ctk.exe""#));
        assert!(text.contains(r#"const ARGS = ["--opencode"]"#));
        assert!(!text.contains("@EXE@") && !text.contains("@ARGS@"));
    }

    #[test]
    fn install_state_and_remove_round_trip() {
        let dir = temp("ctk_opencode_plugin_test");
        assert_eq!(plugin_state(&dir), PluginState::Missing);
        install(&dir, "\"C:/h/context-toolkit.exe\"", Lang::En, true).unwrap();
        assert_eq!(
            plugin_state(&dir),
            PluginState::Missing,
            "a dry run writes nothing"
        );
        install(&dir, "\"C:/h/context-toolkit.exe\"", Lang::En, false).unwrap();
        assert_eq!(plugin_state(&dir), PluginState::Current);
        assert!(!dir.join("backups").exists(), "a new file needs no backup");
        // another language rewrites it with a backup outside plugins/
        install(&dir, "\"C:/h/context-toolkit.exe\"", Lang::Ru, false).unwrap();
        assert!(fs::read_to_string(plugin_path(&dir))
            .unwrap()
            .contains(r#"["--opencode","--lang","ru"]"#));
        assert_eq!(fs::read_dir(dir.join("backups")).unwrap().count(), 1);
        // an edited copy is ours but not current
        let edited = fs::read_to_string(plugin_path(&dir))
            .unwrap()
            .replace("15000", "1");
        fs::write(plugin_path(&dir), edited).unwrap();
        assert_eq!(plugin_state(&dir), PluginState::Outdated);
        assert!(preflight(&dir).is_ok());
        assert_eq!(
            plugin_exe(&dir),
            Some(PathBuf::from("C:/h/context-toolkit.exe"))
        );
        // a BOM from an editor keeps it ours; bytes that are not UTF-8 make it foreign (setup must not overwrite them)
        let ours = fs::read(plugin_path(&dir)).unwrap();
        fs::write(
            plugin_path(&dir),
            [b"\xef\xbb\xbf".as_slice(), &ours].concat(),
        )
        .unwrap();
        assert_eq!(plugin_state(&dir), PluginState::Outdated);
        fs::write(plugin_path(&dir), [&ours[..], b"\xe9"].concat()).unwrap();
        assert_eq!(plugin_state(&dir), PluginState::Foreign);
        assert!(preflight(&dir).is_err());
        fs::write(plugin_path(&dir), &ours).unwrap();
        remove(&dir, false).unwrap();
        assert_eq!(plugin_state(&dir), PluginState::Missing);
        assert!(
            !dir.join("plugins").exists(),
            "the empty plugin folders go too"
        );
        assert!(dir.exists(), "the OpenCode folder itself stays");
        // a foreign file at our path stops setup and survives the rollback
        mkdir(plugin_path(&dir).parent().unwrap()).unwrap();
        fs::write(plugin_path(&dir), "export default {}\n").unwrap();
        assert_eq!(plugin_state(&dir), PluginState::Foreign);
        assert!(preflight(&dir).is_err());
        remove(&dir, false).unwrap();
        assert!(plugin_path(&dir).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
