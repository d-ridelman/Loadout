//! Policy `confirm_irreversible`: commands that are hard to take back make the hook answer "ask", so Claude
//! Code shows its permission prompt (an `ask` is not a block: the owner decides).
//!
//! Covered: `git push` (any; `--force`, `-f`, `--force-with-lease`, `+ref` are named as force pushes),
//! `git reset --hard`, `git clean -f`, `git branch -D`, `git checkout -- .` / `git restore .`, `rm -rf`
//! (`-r -f`, `--recursive --force`), `Remove-Item -Recurse -Force`, and `Remove-Item`/`rm -r` on a drive root
//! or the home directory. Only the command itself counts: the same words in a commit message, an `echo`
//! or a heredoc body do not, and a command that cannot be parsed gives no answer (a miss is cheaper than a
//! false alarm). Not covered: `cmd /c rmdir /s /q`, `git stash drop`, `git reflog expire`, shell aliases.
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

fn git_check(args: &[String]) -> Option<&'static str> {
    let (sub, rest) = shell::git_sub(args)?;
    let f = Flags::of(rest);
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
            Some("git push --force (rewrites history on the remote)")
        }
        "push" => Some("git push"),
        "reset" if f.has_long(&["--hard"]) => Some("git reset --hard (drops uncommitted changes)"),
        "clean" if f.force() && !f.dry_run() => {
            Some("git clean -f (deletes untracked files for good)")
        }
        "branch"
            if f.has_short('D')
                || ((f.has_short('d') || f.has_long(&["--delete"])) && f.force()) =>
        {
            Some("git branch -D (deletes a branch that may be unmerged)")
        }
        "checkout" if f.pos.iter().any(|p| p == ".") => {
            Some("git checkout -- . (drops uncommitted changes)")
        }
        // `restore .` drops worktree changes unless it is `--staged` alone (which only unstages)
        "restore"
            if f.pos.iter().any(|p| p == ".")
                && (!(f.has_long(&["--staged"]) || f.has_short('S'))
                    || f.has_long(&["--worktree"])
                    || f.has_short('W')) =>
        {
            Some("git restore . (drops uncommitted changes)")
        }
        _ => None,
    }
}

/// `path` normalised for comparison: forward slashes, lower case, quotes off.
fn norm(p: &str) -> String {
    p.trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .replace('\\', "/")
        .to_lowercase()
}

/// The home directory in the form `is_root_or_home` compares with.
pub fn home_norm() -> Option<String> {
    crate::setup::home_dir().map(|h| norm(&h.to_string_lossy()))
}

/// A drive root (`C:\`, `/`), the home directory (`~`, `$HOME`, `$env:USERPROFILE`, `%USERPROFILE%`, its real
/// path) or the contents of one of them (`C:\*`, `~/*`).
fn is_root_or_home(target: &str, home: Option<&str>) -> bool {
    let s = norm(target);
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

fn rm_check(args: &[String], home: Option<&str>) -> Option<&'static str> {
    let f = Flags::of(args);
    let recursive = f.has_long(&["--recursive"]) || f.has_short('r') || f.has_short('R');
    let force = f.has_long(&["--force"]) || f.has_short('f');
    if recursive && force {
        Some("rm -rf (deletes recursively, with no way back)")
    } else if recursive && f.pos.iter().any(|p| is_root_or_home(p, home)) {
        Some("rm -r on a drive root or the home directory")
    } else {
        None
    }
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

fn ps_remove_check(args: &[String], home: Option<&str>) -> Option<&'static str> {
    if args.iter().any(|a| ps_switch(a, "whatif", 2)) {
        return None;
    }
    let recurse = args.iter().any(|a| ps_switch(a, "recurse", 1));
    let force = args.iter().any(|a| ps_switch(a, "force", 2));
    if recurse && force {
        return Some("Remove-Item -Recurse -Force (deletes recursively, with no way back)");
    }
    args.iter()
        .filter(|a| !a.starts_with('-'))
        .flat_map(|a| a.split(','))
        .any(|p| is_root_or_home(p, home))
        .then_some("Remove-Item on a drive root or the home directory")
}

/// What is irreversible about one simple command, if anything.
fn check(c: &Cmd, d: Dialect, home: Option<&str>) -> Option<&'static str> {
    let (name, args) = shell::command_of(&c.words)?;
    match (name.as_str(), d) {
        ("git", _) => git_check(args),
        ("rm", Dialect::Posix) => rm_check(args, home),
        ("remove-item" | "ri" | "rm" | "del" | "erase" | "rd" | "rmdir", Dialect::Ps) => {
            ps_remove_check(args, home)
        }
        _ => None,
    }
}

/// The question put to the owner when `cmd` holds an irreversible command.
pub fn reason(cmd: &str, d: Dialect, lang: Lang, home: Option<&str>) -> Option<String> {
    let what = shell::scan(cmd, d, &mut |c: &Cmd, d| check(c, d, home))?;
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
        assert!(is_root_or_home("C:\\Users\\Ann\\", Some("c:/users/ann")));
        assert!(!is_root_or_home(
            "C:\\Users\\Ann\\src",
            Some("c:/users/ann")
        ));
        assert!(!is_root_or_home("", Some("c:/users/ann")));
    }
}
