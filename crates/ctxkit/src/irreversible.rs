//! Policy `confirm_irreversible`: commands that are hard to take back make the hook answer "ask", so Claude
//! Code shows its permission prompt (an `ask` is not a block: the owner decides).
//!
//! Covered: `git push` (any; `--force`, `-f`, `--force-with-lease`, `+ref` are named as force pushes),
//! `git push --delete` / `:old`, `git reset --hard`, `git clean -f`, `git branch -D`, `git checkout -- .` /
//! `git restore .`, `git stash drop|clear`, `git reflog expire --expire=now` / `reflog delete`,
//! `git gc --prune=now`, `git prune`, `git worktree remove --force`, `git update-ref -d`, `rm -rf` (`-r -f`,
//! `--recursive --force`), `find -delete` and `find -exec rm -rf`, `Remove-Item -Recurse -Force` (any alias),
//! cmd.exe `rd /s /q` / `del /s /q` inside `cmd /c`, and recursive deletes of a drive root or the home
//! directory. Only the command itself counts: the same words in a commit message, an `echo` or a heredoc
//! body do not, and a command that cannot be parsed gives no answer (a miss is cheaper than a false
//! alarm). Not covered: shell aliases and functions, scripts (`./deploy.sh`), names built at run time.
use crate::shell::{self, Cmd, Dialect};
use crate::{t, Lang};

/// Flags of a git subcommand: long ones (`--force-with-lease=x` as `--force-with-lease`), the letters of
/// short clusters and the positional words. Everything after `--` is positional.
struct Flags {
    long: Vec<String>,
    short: Vec<char>,
    pos: Vec<String>,
}

impl Flags {
    fn of(args: &[String]) -> Flags {
        let mut f = Flags {
            long: Vec::new(),
            short: Vec::new(),
            pos: Vec::new(),
        };
        let mut options = true;
        for a in args {
            if options && a == "--" {
                options = false;
            } else if options && a.starts_with("--") {
                f.long.push(a.split('=').next().unwrap_or(a).to_string());
            } else if options && a.starts_with('-') && a.len() > 1 {
                f.short.extend(a[1..].chars());
            } else {
                f.pos.push(a.clone());
            }
        }
        f
    }

    fn has_long(&self, names: &[&str]) -> bool {
        self.long.iter().any(|l| names.contains(&l.as_str()))
    }

    fn has_short(&self, c: char) -> bool {
        self.short.contains(&c)
    }

    fn force(&self) -> bool {
        self.has_long(&["--force"]) || self.has_short('f')
    }

    fn dry_run(&self) -> bool {
        self.has_long(&["--dry-run"]) || self.has_short('n')
    }
}

/// What is irreversible, in English and in Russian (the command itself is the same in both).
type What = (&'static str, &'static str);

/// `--name=value` among `args` with a value from `values` (any case): `--expire=now`, `--prune=all`.
fn long_value(args: &[String], names: &[&str], values: &[&str]) -> bool {
    args.iter().any(|a| {
        a.split_once('=').is_some_and(|(k, v)| {
            names.contains(&k) && values.contains(&v.trim().to_lowercase().as_str())
        })
    })
}

fn git_check(args: &[String]) -> Option<What> {
    let (sub, rest) = shell::git_sub(args)?;
    let f = Flags::of(rest);
    let first = f.pos.first().map(String::as_str);
    // `-h` / `--help` only prints the usage
    if f.has_long(&["--help"]) || f.has_short('h') {
        return None;
    }
    match sub.as_str() {
        "push" if f.dry_run() => None,
        "push"
            if f.has_long(&[
                "--force",
                "--force-with-lease",
                "--force-if-includes",
                "--mirror",
            ]) || f.has_short('f')
                || f.pos.iter().any(|p| p.starts_with('+')) =>
        {
            Some((
                "git push --force (rewrites history on the remote)",
                "git push --force (переписывает историю на удалённом репозитории)",
            ))
        }
        // `--delete`, `-d`, or an empty source in the refspec (`:old`, not `HEAD:main`)
        "push"
            if f.has_long(&["--delete"])
                || f.has_short('d')
                || f.pos.iter().any(|p| p.len() > 1 && p.starts_with(':')) =>
        {
            Some((
                "git push --delete (deletes a branch or tag on the remote)",
                "git push --delete (удаляет ветку или тег на удалённом репозитории)",
            ))
        }
        "push" => Some(("git push", "git push")),
        "reset" if f.has_long(&["--hard"]) => Some((
            "git reset --hard (drops uncommitted changes)",
            "git reset --hard (выбрасывает незакоммиченные правки)",
        )),
        "clean" if f.force() && !f.dry_run() => Some((
            "git clean -f (deletes untracked files for good)",
            "git clean -f (насовсем удаляет неотслеживаемые файлы)",
        )),
        // `-d` alone refuses an unmerged branch, and a merged one is still in the history: not asked
        "branch"
            if f.has_short('D')
                || ((f.has_short('d') || f.has_long(&["--delete"])) && f.force()) =>
        {
            Some((
                "git branch -D (deletes a branch that may be unmerged)",
                "git branch -D (удаляет ветку, которая может быть не слита)",
            ))
        }
        "checkout" if f.pos.iter().any(|p| p == ".") => Some((
            "git checkout -- . (drops uncommitted changes)",
            "git checkout -- . (выбрасывает незакоммиченные правки)",
        )),
        // `restore .` drops worktree changes unless it is `--staged` alone (which only unstages)
        "restore"
            if f.pos.iter().any(|p| p == ".")
                && (!(f.has_long(&["--staged"]) || f.has_short('S'))
                    || f.has_long(&["--worktree"])
                    || f.has_short('W')) =>
        {
            Some((
                "git restore . (drops uncommitted changes)",
                "git restore . (выбрасывает незакоммиченные правки)",
            ))
        }
        "stash" if matches!(first, Some("drop" | "clear")) => Some((
            "git stash drop / clear (deletes stashed changes)",
            "git stash drop / clear (удаляет отложенные правки)",
        )),
        // the default expiry (90 days) is housekeeping; `now` / `all` throws away the safety net of the reflog
        "reflog" if f.dry_run() => None,
        "reflog"
            if first == Some("delete")
                || (first == Some("expire")
                    && long_value(
                        rest,
                        &["--expire", "--expire-unreachable"],
                        &["now", "all", "0"],
                    )) =>
        {
            Some((
                "git reflog expire --expire=now (drops the reflog, the way back to lost commits)",
                "git reflog expire --expire=now (стирает reflog, путь назад к потерянным коммитам)",
            ))
        }
        "gc" if long_value(rest, &["--prune"], &["now", "all"]) => Some((
            "git gc --prune=now (deletes unreachable commits at once)",
            "git gc --prune=now (сразу удаляет недостижимые коммиты)",
        )),
        "prune" if !f.dry_run() => Some((
            "git prune (deletes unreachable objects)",
            "git prune (удаляет недостижимые объекты)",
        )),
        "worktree" if first == Some("remove") && f.force() => Some((
            "git worktree remove --force (deletes the worktree with its uncommitted changes)",
            "git worktree remove --force (удаляет рабочую копию вместе с незакоммиченными правками)",
        )),
        "update-ref" if f.has_short('d') => Some((
            "git update-ref -d (deletes a ref)",
            "git update-ref -d (удаляет ссылку)",
        )),
        _ => None,
    }
}

/// `path` normalised for comparison: forward slashes, lower case, quotes off.
fn norm(p: &str, git_bash: bool) -> String {
    let mut s = p
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .replace('\\', "/")
        .to_lowercase();
    // Git Bash, WSL and Cygwin spell `C:\Users\x` as `/c/Users/x`, `/mnt/c/...`, `/cygdrive/c/...`; only a
    // Bash `rm` reads it so (in PowerShell or cmd `/q` and `/s` are switches, not a drive)
    if git_bash {
        for prefix in ["/mnt/", "/cygdrive/"] {
            if let Some(rest) = s.strip_prefix(prefix) {
                s = format!("/{rest}");
                break;
            }
        }
        let b = s.as_bytes();
        if b.len() >= 2
            && b[0] == b'/'
            && b[1].is_ascii_alphabetic()
            && (b.len() == 2 || b[2] == b'/')
        {
            s = format!("{}:{}", b[1] as char, &s[2..]);
        }
    }
    s
}

/// The home directory in the form `is_root_or_home` compares with.
pub fn home_norm() -> Option<String> {
    crate::setup::home_dir().map(|h| norm(&h.to_string_lossy(), false))
}

/// A drive root (`C:\`, `/`), the home directory (`~`, `$HOME`, `$env:USERPROFILE`, `%USERPROFILE%`, its real
/// path) or the contents of one of them (`C:\*`, `~/*`).
fn is_root_or_home(target: &str, home: Option<&str>, git_bash: bool) -> bool {
    let s = norm(target, git_bash);
    if s == "*" || s.is_empty() {
        return false;
    }
    let bare = s.trim_end_matches(['*', '/']);
    if bare.is_empty() {
        return s.starts_with('/');
    }
    let drive = bare.len() == 2 && bare.ends_with(':') && bare.as_bytes()[0].is_ascii_alphabetic();
    drive
        || matches!(
            bare,
            "~" | "$home"
                | "${home}"
                | "$env:userprofile"
                | "$env:home"
                | "$env:homepath"
                | "%userprofile%"
                | "%homepath%"
                | "$userprofile"
        )
        || home.is_some_and(|h| bare == h.trim_end_matches('/'))
}

const ROOT: What = (
    "deletion of a drive root or the home directory",
    "удаление корня диска или домашнего каталога",
);

fn rm_check(args: &[String], home: Option<&str>) -> Option<What> {
    let f = Flags::of(args);
    // a letter rm does not know (`-Recurse`, `-WhatIf` of a PowerShell line read as Bash) makes rm stop
    // with "invalid option" before it deletes anything
    if f.short.iter().any(|c| !"fiIrRdvPWx".contains(*c)) {
        return None;
    }
    let recursive = f.has_long(&["--recursive"]) || f.has_short('r') || f.has_short('R');
    let force = f.has_long(&["--force"]) || f.has_short('f');
    if recursive && force {
        Some((
            "rm -rf (deletes recursively, with no way back)",
            "rm -rf (рекурсивное удаление без возврата)",
        ))
    } else if recursive && f.pos.iter().any(|p| is_root_or_home(p, home, true)) {
        Some(ROOT)
    } else {
        None
    }
}

/// cmd.exe `rd /s /q`, `del /s /q` (`/S/Q` glued, any case): a recursive delete with no question, or a
/// recursive one on a drive root or the home directory. `rd /s` alone asks "Are you sure" itself.
fn cmd_remove_check(name: &str, args: &[String], home: Option<&str>) -> Option<What> {
    let switches: Vec<String> = args
        .iter()
        .filter(|a| a.starts_with('/'))
        .flat_map(|a| a.split('/').map(str::to_lowercase).collect::<Vec<_>>())
        .collect();
    let has = |s: &str| switches.iter().any(|w| w == s);
    if !has("s") {
        return None;
    }
    if has("q") {
        return Some(if name == "rd" || name == "rmdir" {
            (
                "rd /s /q (deletes a folder tree, with no way back)",
                "rd /s /q (удаляет дерево каталогов без возврата)",
            )
        } else {
            (
                "del /s /q (deletes files in every subfolder, with no way back)",
                "del /s /q (удаляет файлы во всех подкаталогах без возврата)",
            )
        });
    }
    args.iter()
        .filter(|a| !a.starts_with('/'))
        .any(|p| is_root_or_home(p, home, false))
        .then_some(ROOT)
}

/// `find` options whose next word is a value (so `-name -delete` names a file, it deletes nothing).
const FIND_VALUE: [&str; 10] = [
    "-name",
    "-iname",
    "-path",
    "-ipath",
    "-regex",
    "-iregex",
    "-wholename",
    "-iwholename",
    "-lname",
    "-ilname",
];

/// `find ... -delete`, and the command of `-exec` / `-execdir` / `-ok` (`find . -exec rm -rf {} +`).
fn find_check(args: &[String], home: Option<&str>) -> Option<What> {
    let mut k = 0;
    while let Some(a) = args.get(k) {
        k += 1;
        if FIND_VALUE.contains(&a.as_str()) {
            k += 1;
        } else if a == "-delete" {
            return Some((
                "find -delete (deletes every file it matches)",
                "find -delete (удаляет все найденные файлы)",
            ));
        } else if matches!(a.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir") {
            let end = args[k..]
                .iter()
                .position(|w| w == ";" || w == "+")
                .map_or(args.len(), |e| k + e);
            if let Some(w) = check(&args[k..end], Dialect::Posix, home) {
                return Some(w);
            }
            k = end + 1;
        }
    }
    None
}

/// PowerShell parameters may be shortened to any unambiguous prefix (`-Rec`, `-Fo`); `:$false` turns one off.
fn ps_switch(arg: &str, full: &str, min: usize) -> bool {
    let Some(rest) = arg.strip_prefix('-') else {
        return false;
    };
    let (name, value) = rest.split_once(':').unwrap_or((rest, ""));
    let name = name.to_lowercase();
    name.len() >= min
        && full.starts_with(&name)
        && !matches!(value.trim().to_lowercase().as_str(), "$false" | "0")
}

fn ps_remove_check(args: &[String], home: Option<&str>) -> Option<What> {
    if args.iter().any(|a| ps_switch(a, "whatif", 2)) {
        return None;
    }
    let recurse = args.iter().any(|a| ps_switch(a, "recurse", 1));
    let force = args.iter().any(|a| ps_switch(a, "force", 2));
    if recurse && force {
        return Some((
            "Remove-Item -Recurse -Force (deletes recursively, with no way back)",
            "Remove-Item -Recurse -Force (рекурсивное удаление без возврата)",
        ));
    }
    args.iter()
        .filter(|a| !a.starts_with('-'))
        .flat_map(|a| a.split(','))
        .any(|p| is_root_or_home(p, home, false))
        .then_some(ROOT)
}

/// The command of a cmd.exe `if` (`if [/i] [not] exist|defined X cmd`, `if errorlevel N cmd`, `if a==b cmd`).
fn cmd_if_body(words: &[String]) -> Option<&[String]> {
    let low = |k: usize| words.get(k).map(|w| w.to_lowercase());
    if low(0).as_deref() != Some("if") {
        return None;
    }
    let mut k = 1;
    while matches!(low(k).as_deref(), Some("/i" | "not")) {
        k += 1;
    }
    k += match low(k).as_deref() {
        Some("exist" | "defined" | "errorlevel" | "cmdextversion") => 2,
        _ if low(k + 1).as_deref() == Some("==") => 3,
        _ => 1,
    };
    words.get(k..).filter(|r| !r.is_empty())
}

/// What is irreversible about one simple command (its words), if anything.
fn check(words: &[String], d: Dialect, home: Option<&str>) -> Option<What> {
    if d == Dialect::Cmd {
        if let Some(body) = cmd_if_body(words) {
            return check(body, d, home);
        }
    }
    let (name, args) = shell::command_of(words)?;
    // `@rd /s /q x` in cmd: the `@` only hides the echo
    let name = if d == Dialect::Cmd {
        name.trim_start_matches('@')
    } else {
        name.as_str()
    };
    match (name, d) {
        ("git", _) => git_check(args),
        ("rm", Dialect::Posix | Dialect::Cmd) => rm_check(args, home),
        ("find", Dialect::Posix) => find_check(args, home),
        ("remove-item" | "ri" | "rm" | "del" | "erase" | "rd" | "rmdir", Dialect::Ps) => {
            ps_remove_check(args, home)
        }
        ("rd" | "rmdir" | "del" | "erase", Dialect::Cmd) => cmd_remove_check(name, args, home),
        _ => None,
    }
}

/// The question put to the owner when `cmd` holds an irreversible command.
pub fn reason(cmd: &str, d: Dialect, lang: Lang, home: Option<&str>) -> Option<String> {
    let (en, ru) = shell::scan(cmd, d, &mut |c: &Cmd, d| check(&c.words, d, home))?;
    let what = t(lang, en, ru);
    Some(format!(
        "{} {what}. {}",
        t(
            lang,
            "Hard to undo:",
            "Необратимое или трудно отменяемое действие:"
        ),
        t(
            lang,
            "Confirm to run it (policy confirm_irreversible in ctxkit.json).",
            "Подтверди запуск (политика confirm_irreversible в ctxkit.json)."
        )
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "c:/users/ann";

    fn bash(cmd: &str) -> bool {
        reason(cmd, Dialect::Posix, Lang::En, Some(HOME)).is_some()
    }

    fn ps(cmd: &str) -> bool {
        reason(cmd, Dialect::Ps, Lang::En, Some(HOME)).is_some()
    }

    #[test]
    fn asks_for_git_commands_that_cannot_be_taken_back() {
        for cmd in [
            "git push",
            "git push origin main",
            "git push -u origin feature",
            "git push --force",
            "git push -f origin main",
            "git push --force-with-lease",
            "git push --force-with-lease=main:abc origin main",
            "git push origin +main",
            "git push --mirror",
            "git push origin --delete old",
            "git reset --hard",
            "git reset --hard HEAD~3",
            "git clean -f",
            "git clean -fd",
            "git clean -fdx",
            "git clean -d --force",
            "git branch -D old",
            "git branch -d -f old",
            "git branch --delete --force old",
            "git checkout -- .",
            "git checkout .",
            "git restore .",
            "git restore --worktree .",
            "git restore --staged --worktree .",
            "git -C sub push",
            "git -c core.x=1 --no-pager push --force",
        ] {
            assert!(bash(cmd), "{cmd}");
        }
    }

    #[test]
    fn asks_for_forced_and_recursive_removal() {
        for cmd in [
            "rm -rf build",
            "rm -fr build",
            "rm -r -f build",
            "rm -R -f build",
            "rm --recursive --force build",
            "rm -rf /",
            "rm -r ~",
            "rm -r /",
            "rm -r $HOME",
            "rm -r \"$HOME/\"",
            "rm -rf -- -weird",
            "sudo rm -rf /var/x",
        ] {
            assert!(bash(cmd), "{cmd}");
        }
        for cmd in [
            "Remove-Item C:\\x -Recurse -Force",
            "Remove-Item -Force -Recurse C:\\x",
            "Remove-Item C:\\x -rec -fo",
            "ri .\\x -Recurse -Force:$true",
            "rm -Recurse -Force .\\x",
            "Remove-Item C:\\",
            "Remove-Item C:/",
            "Remove-Item -Path 'D:\\' -Recurse",
            "Remove-Item ~",
            "Remove-Item $HOME -Recurse",
            "Remove-Item $env:USERPROFILE\\*",
            "Remove-Item %USERPROFILE%",
            "Remove-Item C:\\Users\\ann",
            "Remove-Item C:\\Users\\ann\\",
            "Remove-Item .\\a, C:\\ -ErrorAction Stop",
        ] {
            assert!(ps(cmd), "{cmd}");
        }
    }

    #[test]
    fn finds_the_command_in_chains_substitutions_wrappers_and_nested_shells() {
        for cmd in [
            "cd repo && git push",
            "git add -A; git commit -m x; git push origin main",
            "git status || git push",
            "git log | cat\ngit push",
            "echo $(git push)",
            "echo \"done: $(git reset --hard)\"",
            "FOO=1 git push",
            "env GIT_SSH=x git push",
            "/usr/bin/git push",
            "'C:/Program Files/Git/bin/git.exe' push",
            "bash -c \"git push --force\"",
            "sh -c 'cd x && rm -rf build'",
            "if git push; then echo ok; fi",
            "time git push",
            "git commit -m x && git push",
            // redirects glued to the command, wrappers with option values, shell scripts on stdin
            "git push&>/dev/null",
            "git push>out.log",
            "git push 2>&1 | tail -3",
            "sudo -u bob git push",
            "timeout 60 git push",
            "nice -n 5 git push --force",
            "xargs -0 rm -rf",
            "bash <<'EOF'\ngit push\nEOF",
            "echo $((1<<2))\ngit push",
            "(( x = 1<<2 ))\ngit push",
            // Git Bash spellings of a drive root and of the home directory
            "rm -r /c",
            "rm -r /c/",
            "rm -r /mnt/c",
            "rm -r /c/Users/ann",
        ] {
            assert!(bash(cmd), "{cmd}");
        }
        assert!(ps("cd repo; git push"));
        assert!(ps("pwsh -NoProfile -Command \"git push -f\""));
        assert!(ps("& 'C:\\Program Files\\Git\\bin\\git.exe' push"));
        assert!(ps("git status; if ($?) { git reset --hard }"));
        assert!(bash(
            "powershell -Command \"Remove-Item C:\\x -Recurse -Force\""
        ));
    }

    #[test]
    fn stays_quiet_for_safe_lookalikes() {
        for cmd in [
            // git: other subcommands and the safe forms
            "git status",
            "git log --oneline -5",
            "git commit -m 'push it'",
            "git commit -m \"git push --force\"",
            "git push --dry-run",
            "git push -n origin main",
            "git stash push -m x",
            "git stash",
            "git config push.default simple",
            "git config --get push.default",
            "git remote set-url --push origin x",
            "git remote add origin x",
            "git fetch --force",
            "git pull --force",
            "git reset",
            "git reset --soft HEAD~1",
            "git reset HEAD file.txt",
            "git clean -n",
            "git clean -nfd",
            "git clean --dry-run -f",
            "git branch -d merged",
            "git branch -a",
            "git branch new-feature",
            "git checkout -- file.txt",
            "git checkout main",
            "git checkout -b feature",
            "git restore file.txt",
            "git restore --staged .",
            "git restore -S .",
            "git diff --stat",
            // rm
            "rm -r dir",
            "rm -f file",
            "rm file1 file2",
            "rm -i -r dir",
            "ls -rf",
            "grep -rf patterns src",
            "rmdir empty",
            // text is not a command
            "echo \"git push --force\"",
            "echo 'rm -rf /'",
            "printf 'git reset --hard\\n'",
            "grep \"rm -rf\" notes.txt",
            "cat <<'EOF'\ngit push\nrm -rf /\nEOF",
            "git commit -F - <<'EOF'\nrun git push later\nEOF",
            "echo git push",
            "man git-push",
            // unreadable input gives no answer
            "git push 'unclosed",
            "echo $(git push",
            "",
        ] {
            assert!(!bash(cmd), "{cmd}");
        }
        for cmd in [
            "Remove-Item file.txt",
            "Remove-Item file.txt -Force",
            "Remove-Item .\\dir -Recurse",
            "Remove-Item .\\dir -Recurse:$false -Force",
            "Remove-Item .\\dir -Recurse -Force:$false",
            "Remove-Item .\\dir -Recurse -Force -WhatIf",
            "Remove-Item C:\\Users\\ann\\Downloads\\x.zip",
            "Remove-Item .\\*.tmp",
            "Remove-Item *",
            "Write-Output 'Remove-Item C:\\ -Recurse -Force'",
            "Get-ChildItem C:\\ -Recurse -Force",
            "git status; Get-Content notes.txt",
            "git commit -m 'git push --force'",
            "echo \"rm -rf /\"",
        ] {
            assert!(!ps(cmd), "{cmd}");
        }
    }

    #[test]
    fn the_question_names_the_command_in_the_language_of_the_settings() {
        let en = reason("git push --force", Dialect::Posix, Lang::En, None).unwrap();
        assert!(
            en.contains("git push --force") && en.contains("Confirm to run it"),
            "{en}"
        );
        let ru = reason("git reset --hard", Dialect::Posix, Lang::Ru, None).unwrap();
        assert!(
            ru.contains("Необратимое") && ru.contains("Подтверди запуск"),
            "{ru}"
        );
        assert!(reason("git push", Dialect::Posix, Lang::En, None)
            .unwrap()
            .contains("git push."));
        // the home directory in its real spelling is found by comparison, not by name
        let h = Some("c:/users/ann");
        assert!(is_root_or_home("C:\\Users\\Ann\\", h, false));
        assert!(!is_root_or_home("C:\\Users\\Ann\\src", h, false));
        assert!(!is_root_or_home("", h, false));
        // Git Bash spellings count for a Bash `rm` only
        assert!(is_root_or_home("/c/Users/Ann", h, true));
        assert!(is_root_or_home("/mnt/c/Users/Ann/", h, true));
        assert!(!is_root_or_home("/c/Users/Ann/src", h, true));
        assert!(!is_root_or_home("/usr", h, true));
        assert!(!is_root_or_home("/mnt/data", None, true));
        assert!(
            !is_root_or_home("/c", h, false),
            "not a drive for PowerShell"
        );
    }

    /// The forms added on top of the first set: cmd.exe deletes, more git subcommands, `find`, every
    /// PowerShell alias of `Remove-Item` and every wrapper, each with its own line.
    #[test]
    fn asks_for_the_wider_set_of_irreversible_forms() {
        for cmd in [
            // cmd.exe from Bash (Git Bash users write `//c`)
            "cmd /c rmdir /s /q build",
            "cmd /c rd /s /q build",
            "cmd //c rd /s /q build",
            "cmd.exe /C RD /S /Q build",
            "cmd /c \"rd /s /q build\"",
            "cmd /c \"cd sub && rd /s/q out\"",
            "cmd /c del /s /q /f *.log",
            "cmd /c erase /s /q x",
            "cmd /c rd /s C:\\",
            "cmd /s /c \"@rd /s /q build\"",
            "cmd /c \"git push origin main\"",
            "cmd /k git reset --hard",
            "cmd /c \"if exist build rd /s /q build\"",
            "cmd /c \"if /i not exist keep rd /s /q build\"",
            "cmd /c \"if errorlevel 1 git push\"",
            // git
            "git stash drop",
            "git stash drop stash@{1}",
            "git stash clear",
            "git push origin --delete old",
            "git push -d origin old",
            "git push origin :old",
            "git reflog expire --expire=now --all",
            "git reflog expire --expire-unreachable=now --all",
            "git reflog expire --expire=all --all",
            "git reflog delete HEAD@{2}",
            "git gc --prune=now",
            "git gc --aggressive --prune=all",
            "git prune",
            "git worktree remove --force ../wt",
            "git worktree remove -f ../wt",
            "git update-ref -d refs/heads/old",
            // find
            "find . -name '*.log' -delete",
            "find build -type f -delete",
            "find . -name x -exec rm -rf {} +",
            "find . -type d -execdir rm -r -f {} \\;",
            // wrappers
            "doas rm -rf /var/x",
            "env GIT_TRACE=1 git push",
            "command git push",
            "nohup git push &",
            "exec git push",
            "time -p git push",
            "nice git reset --hard",
            "timeout 30 git push",
            "sudo -E timeout 30 git stash clear",
            "xargs rm -rf",
            "ls | xargs -I{} rm -rf {}",
            "bash -lc 'git push'",
            "sh -c \"git stash drop\"",
            "pwsh -c \"Remove-Item x -Recurse -Force\"",
            "powershell -Command \"git push --force\"",
        ] {
            assert!(bash(cmd), "{cmd}");
        }
        for cmd in [
            // every alias of Remove-Item, shortened parameters
            "rm x -Recurse -Force",
            "rm -r -fo x",
            "ri -r -fo x",
            "del x -Recurse -Force",
            "erase -rec -force x",
            "rmdir x -r -fo",
            "rd -Recurse -Force x",
            "Remove-Item -LiteralPath x -Recurse -Force",
            "cmd /c rd /s /q build",
            "cmd /c \"del /s /q *.tmp\"",
            "git stash clear",
            "git push origin :old",
            "pwsh -c 'git worktree remove --force ..\\wt'",
            "bash -lc 'rm -rf build'",
        ] {
            assert!(ps(cmd), "{cmd}");
        }
        // the question is in the language of the settings, the command is the same
        let ru = reason("cmd /c rd /s /q x", Dialect::Posix, Lang::Ru, None).unwrap();
        assert!(ru.contains("rd /s /q (удаляет дерево каталогов"), "{ru}");
        let en = reason("git stash drop", Dialect::Posix, Lang::En, None).unwrap();
        assert!(en.contains("git stash drop / clear (deletes"), "{en}");
    }

    /// The same words where they are text, a path, a safe form or a different command. Each line is
    /// checked in both dialects, as Antigravity's both-dialects pass does.
    #[test]
    fn stays_quiet_for_the_lookalikes_of_the_wider_set() {
        for cmd in [
            // text
            "echo cmd /c rd /s /q build",
            "echo 'git stash drop'",
            "git commit -m \"git stash clear and git reflog expire --expire=now\"",
            "git commit -m 'run: find . -delete'",
            "printf 'git gc --prune=now\\n'",
            "git log --grep=\"git push --delete\"",
            "grep -r -- \"-delete\" src",
            "# git stash drop",
            "ls ./find-delete/",
            "cat \"notes/rd /s /q.txt\"",
            // safe git forms
            "git stash list",
            "git stash show -p",
            "git stash push -m drop",
            "git stash apply",
            "git stash pop",
            "git push --dry-run origin --delete old",
            "git branch -d merged",
            "git branch --delete merged",
            "git reflog",
            "git reflog show HEAD",
            "git reflog expire --all",
            "git reflog expire --expire=90.days.ago --all",
            "git gc",
            "git gc --auto",
            "git gc --prune=2.weeks.ago",
            "git prune --dry-run",
            "git prune -n",
            "git remote prune origin",
            "git worktree prune",
            "git worktree remove ../wt",
            "git worktree list",
            "git update-ref refs/heads/x HEAD",
            "git tag -d v1",
            // other commands
            "rm file.txt",
            "rm -f file.txt",
            "find . -name x",
            "find . -name -delete",
            "find . -name '*.log' -print",
            "find . -exec ls {} \\;",
            "find . -exec rm {} \\;",
            "find . -exec echo -delete \\;",
            "xargs echo rm -rf",
            "env RM='rm -rf' make",
            "time git status",
            "nohup echo git push",
            "sudo ls -rf",
            "timeout 30 ls",
            "cmd /c dir /s",
            "cmd /c del file.txt",
            "cmd /c del /q file.txt",
            "cmd /c rd emptydir",
            "cmd /c rd /s build",
            "cmd /c \"echo rd /s /q x\"",
            "cmd /c type notes.txt",
            "cmd /c \"echo it's fine & dir\"",
            "cmd",
            // `;` is not a separator in cmd; quotes an outer shell took off still hold for cmd
            "cmd /c \"echo a;rd /s /q x\"",
            "cmd /c \"echo step 1; del /s /q later\"",
            "cmd /c echo \"a & rd /s /q x\"",
            "cmd /c git commit -m \"a & git stash clear\"",
            "cmd /c \"if exist build echo rd /s /q build\"",
            // dry runs and help
            "git reflog expire --expire=now --dry-run --all",
            "git reflog expire -n --expire=now --all",
            "git reflog delete --dry-run HEAD@{1}",
            "git prune -h",
            "git prune --help",
            "git stash drop -h",
            "git gc --prune=now --help",
            "git worktree remove -h --force",
            "git push --help",
            "git reset --hard -h",
            "bash -lc 'echo git push'",
            "pwsh -c \"Write-Output 'Remove-Item x -Recurse -Force'\"",
            "powershell -Command Get-ChildItem -Recurse -Force",
            "Remove-Item file",
            "Remove-Item file -Force",
            "Remove-Item dir -Recurse",
            "rm x -Recurse -WhatIf -Force",
        ] {
            assert!(!bash(cmd), "bash: {cmd}");
            assert!(!ps(cmd), "powershell: {cmd}");
        }
        // `HEAD:main` is an ordinary push (asked as one), not the `:old` that deletes
        let r = reason("git push origin HEAD:main", Dialect::Posix, Lang::En, None).unwrap();
        assert!(r.contains("git push.") && !r.contains("--delete"), "{r}");
        // a heredoc body is data in Bash (PowerShell has no heredoc: the line does not parse there at all)
        assert!(!bash(
            "cat <<'EOF'\ngit worktree remove --force x\nfind . -delete\nEOF"
        ));
    }

    #[test]
    fn cmd_scripts_have_their_own_quoting() {
        // `'` is a plain character in cmd, `^` escapes, `#` and `$(` are text
        let cmd = |s: &str| reason(s, Dialect::Cmd, Lang::En, Some(HOME)).is_some();
        assert!(cmd("echo it's & rd /s /q x"));
        assert!(cmd("rd ^/s /q x"));
        assert!(cmd("echo # & rd /s /q x"));
        assert!(!cmd("echo \"rd /s /q x\""));
        assert!(!cmd("echo rd /s /q x"));
        assert!(cmd("rd /s %USERPROFILE%"));
        assert!(
            !cmd("find \"rd /s /q\" notes.txt"),
            "cmd's find searches text"
        );
    }

    #[test]
    fn cmd_switches_are_not_drive_roots_in_powershell() {
        for cmd in [
            "del /q file.txt",
            "rd /s /q build",
            "rmdir /s /q build",
            "Remove-Item /f x",
            "Remove-Item /s x",
            "erase /q /f x.tmp",
        ] {
            assert!(!ps(cmd), "{cmd}");
        }
        // the same words as a Git Bash path still count for `rm`
        assert!(bash("rm -r /q"));
        // and through Antigravity's both-dialects pass nothing new asks
        let any = |c: &str| {
            reason(c, Dialect::Ps, Lang::En, None).is_some()
                || reason(c, Dialect::Posix, Lang::En, None).is_some()
        };
        assert!(!any("del /q file.txt") && !any("rd /s /q build"));
    }
}
