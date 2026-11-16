//! Policy `commit_hygiene`: a `git commit` whose message carries `Co-Authored-By` or `Generated with`
//! (any case, also the `🤖 Generated` line) is blocked with a request to take those lines out.
//! Only text that is the message counts: `-m`, `--message`, `--trailer`, a heredoc or here-string fed to
//! `-F -`, a small existing `-F <file>`. Branch names, paths and other commands do not.
use crate::shell::{self, Cmd, Dialect};
use crate::{t, Lang};
use std::path::Path;

const MARKERS: [&str; 4] = [
    "co-authored-by",
    "co-authored by",
    "generated with",
    "🤖 generated",
];

pub fn is_marked(text: &str) -> bool {
    let low = text.to_lowercase();
    MARKERS.iter().any(|m| low.contains(m))
}

/// The pieces of text a `git commit` command takes as the commit message.
fn message_texts(c: &Cmd, cwd: Option<&Path>) -> Vec<String> {
    let Some((name, args)) = shell::command_of(&c.words) else {
        return Vec::new();
    };
    if name != "git" {
        return Vec::new();
    }
    let Some((sub, rest)) = shell::git_sub(args) else {
        return Vec::new();
    };
    if sub != "commit" {
        return Vec::new();
    }
    let (mut texts, mut files) = (Vec::new(), Vec::new());
    let mut i = 0;
    while i < rest.len() {
        let w = rest[i].as_str();
        let value = |i: &mut usize| {
            *i += 1;
            rest.get(*i).cloned().unwrap_or_default()
        };
        if w == "--" {
            break; // what follows are paths
        } else if let Some(v) = w
            .strip_prefix("--message=")
            .or_else(|| w.strip_prefix("--trailer="))
        {
            texts.push(v.to_string());
        } else if matches!(w, "--message" | "--trailer") {
            texts.push(value(&mut i));
        } else if let Some(v) = w.strip_prefix("--file=") {
            files.push(v.to_string());
        } else if w == "--file" {
            files.push(value(&mut i));
        } else if w.starts_with('-') && !w.starts_with("--") {
            // a cluster of short options: `-am "text"`, `-m"text"`, `-sF -`; letters that take a value end it
            let letters: Vec<char> = w[1..].chars().collect();
            for (k, ch) in letters.iter().enumerate() {
                if !matches!(ch, 'm' | 'F' | 'C' | 'c' | 't') {
                    continue;
                }
                let attached: String = letters[k + 1..].iter().collect();
                let v = if attached.is_empty() {
                    value(&mut i)
                } else {
                    attached
                };
                match ch {
                    'm' => texts.push(v),
                    'F' => files.push(v),
                    _ => {} // -C/-c reuse a commit, -t is a template: not text we can see
                }
                break;
            }
        }
        i += 1;
    }
    for f in files {
        if f == "-" {
            texts.extend(c.heredocs.iter().cloned());
            for (k, w) in c.words.iter().enumerate() {
                if w == "<<<" {
                    texts.extend(c.words.get(k + 1).cloned());
                } else if let Some(r) = w.strip_prefix("<<<") {
                    texts.push(r.to_string());
                }
            }
        } else if let Some(body) = shell::read_small(&f, cwd) {
            texts.push(body);
        }
    }
    texts
}

/// The block message when `cmd` commits with a marked message.
pub fn reason(cmd: &str, d: Dialect, lang: Lang, cwd: Option<&Path>) -> Option<String> {
    shell::scan(cmd, d, &mut |c: &Cmd, _| {
        message_texts(c, cwd)
            .iter()
            .any(|m| is_marked(m))
            .then_some(())
    })?;
    Some(
        t(
            lang,
            "The commit message has a `Co-Authored-By` or `Generated with` line. Remove those lines from the message and run the commit again (policy commit_hygiene in ctxkit.json).",
            "В сообщении коммита есть строка `Co-Authored-By` или `Generated with`. Убери эти строки из сообщения коммита и повтори коммит (политика commit_hygiene в ctxkit.json).",
        )
        .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(cmd: &str) -> bool {
        reason(cmd, Dialect::Posix, Lang::En, None).is_some()
    }

    fn hit_ps(cmd: &str) -> bool {
        reason(cmd, Dialect::Ps, Lang::En, None).is_some()
    }

    #[test]
    fn blocks_marked_messages_in_every_form_of_the_message_option() {
        for cmd in [
            r#"git commit -m "fix: x" -m "Co-Authored-By: Claude <c@x>""#,
            r#"git commit -m 'Generated with Claude Code'"#,
            r#"git commit -m "🤖 Generated with [Claude Code](https://claude.com)""#,
            r#"git commit -am "fix the thing Co-authored-by: A""#,
            r#"git commit -m"co-authored-by: a""#,
            r#"git commit --message="CO-AUTHORED-BY: a""#,
            r#"git commit --message "generated WITH tool""#,
            r#"git commit -m ok --trailer "Co-authored-by: A <a@b>""#,
            r#"git commit -sm "Co-Authored-By: x""#,
            r#"git -C sub commit -m "Co-Authored-By: x""#,
            r#"git add -A && git commit -m "x" -m "Generated with y""#,
            r#"cd repo; GIT_AUTHOR_NAME=a git commit --allow-empty -m "Co-Authored-By: x""#,
            r#"bash -c 'git commit -m "Co-Authored-By: x"'"#,
            r#"git commit -m "$(echo Co-Authored-By: x)""#,
        ] {
            assert!(hit(cmd), "{cmd}");
        }
    }

    #[test]
    fn blocks_the_heredoc_form_claude_writes_and_the_file_forms() {
        assert!(hit(
            "git commit -m \"$(cat <<'EOF'\nfix: it \"works\" now\n\nCo-Authored-By: Claude <c@x>\nEOF\n)\""
        ));
        assert!(hit(
            "git commit -F - <<'EOF'\nfix\n\n🤖 Generated with Claude Code\nEOF"
        ));
        assert!(hit("git commit -F - <<< \"x Co-Authored-By: y\""));
        assert!(hit("git commit --file=- <<EOF\nCo-Authored-By: x\nEOF"));
        // a message file that exists and holds a marker
        let d = std::env::temp_dir().join(format!("ctxkit-commit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("msg.txt"), "fix\n\nCo-Authored-By: x\n").unwrap();
        std::fs::write(d.join("ok.txt"), "fix\n").unwrap();
        let on = |c: &str| reason(c, Dialect::Posix, Lang::En, Some(&d)).is_some();
        assert!(on("git commit -F msg.txt"));
        assert!(on("git commit --file msg.txt"));
        assert!(!on("git commit -F ok.txt"));
        assert!(!on("git commit -F missing.txt"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn powershell_here_strings_and_quotes() {
        assert!(hit_ps(
            "git commit -m @'\nfix\n\nCo-Authored-By: Claude\n'@"
        ));
        assert!(hit_ps(
            "git commit -m @\"\nfix\n🤖 Generated with Claude Code\n\"@"
        ));
        assert!(hit_ps(r#"git commit -m "fix" -m "Co-Authored-By: x""#));
        assert!(hit_ps("git add .; git commit -m 'Generated with x'"));
        assert!(hit_ps(
            "pwsh -Command \"git commit -m 'Co-Authored-By: x'\""
        ));
        assert!(!hit_ps("git commit -m @'\nfix\nplain text\n'@"));
        assert!(!hit_ps("Write-Output 'git commit -m Co-Authored-By'"));
    }

    #[test]
    fn leaves_everything_that_is_not_the_message_alone() {
        for cmd in [
            // clean messages
            r#"git commit -m "fix: add parser""#,
            "git commit -m \"$(cat <<'EOF'\nfix: parser\n\nplain body\nEOF\n)\"",
            "git commit",
            "git commit --amend --no-edit",
            "git commit --amend --no-edit -a",
            // other git commands that mention the words
            r#"git log --grep "Co-Authored-By""#,
            r#"git log --format=%B | grep -i "generated with""#,
            r#"git show HEAD | grep Co-Authored-By"#,
            r#"git tag -m "Co-Authored-By: x" v1"#,
            r#"git stash push -m "Co-Authored-By: x""#,
            // words in a branch, a path or another command around the commit
            r#"git checkout -b feature/co-authored-by-parser"#,
            r#"git commit -m "fix" -- docs/Co-Authored-By.md"#,
            r#"git commit -m "fix" -- "src/generated with spaces.rs""#,
            r#"git commit -m fix && echo "Co-Authored-By: x""#,
            r#"git commit -m fix; cat Co-Authored-By.txt"#,
            r#"git commit -m fix --author="Generated with Bot <b@x>""#,
            r#"echo git commit -m "Co-Authored-By: x""#,
            r#"echo "git commit -m 'Co-Authored-By: x'""#,
            r#"grep -r "git commit -m 'Generated with" ."#,
            "cat > note.txt <<'EOF'\ngit commit -m \"Co-Authored-By: x\"\nEOF",
            "git commit -F - <<'EOF'\nclean message\nEOF\necho Co-Authored-By",
            // the reuse and template options carry no text
            "git commit -C HEAD",
            "git commit -c HEAD~1 --amend",
            // text that cannot be read gives no decision
            r#"git commit -m "Co-Authored-By: x"#,
        ] {
            assert!(!hit(cmd), "{cmd}");
        }
    }

    #[test]
    fn the_message_is_in_the_language_of_the_settings() {
        let en = reason(
            "git commit -m 'Generated with x'",
            Dialect::Posix,
            Lang::En,
            None,
        )
        .unwrap();
        let ru = reason(
            "git commit -m 'Generated with x'",
            Dialect::Posix,
            Lang::Ru,
            None,
        )
        .unwrap();
        assert!(en.contains("Remove those lines"));
        assert!(ru.contains("Убери эти строки из сообщения коммита"));
        assert!(is_marked("Co-authored-by: A") && !is_marked("generated by hand"));
    }
}
