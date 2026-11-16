//! A small shell lexer for the policies (commit hygiene, confirmation of irreversible commands).
//!
//! It splits a Bash or PowerShell command line into simple commands (words) the way the shell would:
//! quotes, escapes (`\` in Bash, a backtick in PowerShell, where `\` is an ordinary character), `&&` `||` `;` `|`
//! and newlines, `$(...)` and backticks (their inner commands become commands too), Bash heredocs
//! (the body is data, not commands) and PowerShell here-strings. What it cannot read (an unclosed quote or
//! `$(`) gives `None`: the policies then have no opinion, because a false alarm costs more than a miss.
//! `guard.rs` has its own, simpler splitter for the read guard; it is left as it is.

use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Posix,
    Ps,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Cmd {
    id: usize,
    pub words: Vec<String>,
    /// Bodies of the heredocs started on this command (`<<EOF ... EOF`).
    pub heredocs: Vec<String>,
}

const MAX_DEPTH: usize = 24;

struct Lx {
    c: Vec<char>,
    i: usize,
    d: Dialect,
    out: Vec<Cmd>,
    bodies: Vec<(usize, String)>,
    next_id: usize,
    depth: usize,
}

/// Simple commands of `src`, in order; commands inside `$(...)` and backticks come before the command
/// that holds them.
pub fn parse(src: &str, d: Dialect) -> Option<Vec<Cmd>> {
    let mut lx = Lx {
        c: src.chars().collect(),
        i: 0,
        d,
        out: Vec::new(),
        bodies: Vec::new(),
        next_id: 0,
        depth: 0,
    };
    lx.commands(false)?;
    let Lx {
        mut out, bodies, ..
    } = lx;
    for (id, body) in bodies {
        if let Some(c) = out.iter_mut().find(|c| c.id == id) {
            c.heredocs.push(body);
        }
    }
    Some(out)
}

impl Lx {
    fn peek(&self, k: usize) -> Option<char> {
        self.c.get(self.i + k).copied()
    }

    fn fresh(&mut self) -> Cmd {
        self.next_id += 1;
        Cmd {
            id: self.next_id,
            ..Cmd::default()
        }
    }

    fn ps(&self) -> bool {
        self.d == Dialect::Ps
    }

    /// Reads commands until the end of the text, or (inside `$(`) until the matching `)`.
    #[allow(unused_assignments)] // the `flush!` of the last `end_cmd!` resets a flag nobody reads
    fn commands(&mut self, stop_at_rparen: bool) -> Option<()> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return None;
        }
        let mut cur = self.fresh();
        let mut word = String::new();
        let mut in_word = false;
        let mut pending: Vec<(usize, String, bool)> = Vec::new();
        let mut parens = 0usize;

        macro_rules! flush {
            () => {
                if in_word {
                    cur.words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            };
        }
        macro_rules! end_cmd {
            () => {
                flush!();
                if !cur.words.is_empty() {
                    let fresh = self.fresh();
                    self.out.push(std::mem::replace(&mut cur, fresh));
                }
            };
        }

        loop {
            let Some(ch) = self.peek(0) else {
                if stop_at_rparen {
                    return None;
                }
                break;
            };
            match ch {
                ' ' | '\t' | '\r' => {
                    flush!();
                    self.i += 1;
                }
                '\n' => {
                    // The heredoc bodies start on the next line and belong to the command that named them.
                    end_cmd!();
                    self.i += 1;
                    for (id, delim, strip) in pending.drain(..) {
                        let body = self.heredoc_body(&delim, strip);
                        self.bodies.push((id, body));
                    }
                }
                ';' | '|' => {
                    end_cmd!();
                    self.i += 1;
                }
                '&' => {
                    let redirect = self.i > 0 && matches!(self.c[self.i - 1], '>' | '<')
                        || self.peek(1) == Some('>');
                    if redirect {
                        word.push('&');
                        in_word = true;
                    } else {
                        end_cmd!();
                    }
                    self.i += 1;
                }
                '(' => {
                    end_cmd!();
                    parens += 1;
                    self.i += 1;
                }
                ')' => {
                    end_cmd!();
                    self.i += 1;
                    if parens > 0 {
                        parens -= 1;
                    } else if stop_at_rparen {
                        self.depth -= 1;
                        return Some(());
                    }
                }
                '#' if !in_word => {
                    while self.peek(0).is_some_and(|c| c != '\n') {
                        self.i += 1;
                    }
                }
                '<' if !self.ps()
                    && self.peek(1) == Some('<')
                    && self.peek(2) != Some('<')
                    && (self.i == 0 || self.c[self.i - 1] != '<') =>
                {
                    flush!();
                    self.i += 2;
                    let strip = self.peek(0) == Some('-');
                    if strip {
                        self.i += 1;
                    }
                    while matches!(self.peek(0), Some(' ' | '\t')) {
                        self.i += 1;
                    }
                    let delim = self.heredoc_delimiter()?;
                    pending.push((cur.id, delim, strip));
                }
                '@' if self.ps() && !in_word && self.here_string_start().is_some() => {
                    let q = self.here_string_start()?;
                    word = self.here_string(q)?;
                    in_word = true;
                }
                _ => {
                    self.word_char(&mut word)?;
                    in_word = true;
                }
            }
        }
        end_cmd!();
        // Heredocs named on the last line without a newline after it have no body.
        self.depth -= 1;
        Some(())
    }

    /// One piece of a word at the cursor: a plain character, an escape, a quoted part or a substitution.
    fn word_char(&mut self, word: &mut String) -> Option<()> {
        let ch = self.peek(0)?;
        match ch {
            '\\' if !self.ps() => {
                let next = self.peek(1);
                match next {
                    None => {
                        word.push('\\');
                        self.i += 1;
                    }
                    Some('\n') => self.i += 2,
                    // An escaped special character is that character; before an ordinary one (a Windows
                    // path such as `C:\Users`) the backslash stays.
                    Some(n) if n.is_whitespace() || "'\"\\$`;&|<>()*?#~!{}[]=".contains(n) => {
                        word.push(n);
                        self.i += 2;
                    }
                    Some(n) => {
                        word.push('\\');
                        word.push(n);
                        self.i += 2;
                    }
                }
            }
            '`' if self.ps() => {
                match self.peek(1) {
                    Some('\n') => {}
                    Some(n) => word.push(n),
                    None => {}
                }
                self.i += 2;
            }
            '\'' => {
                self.i += 1;
                loop {
                    let c = self.peek(0)?;
                    self.i += 1;
                    if c == '\'' {
                        break;
                    }
                    word.push(c);
                }
            }
            '"' => {
                self.i += 1;
                self.double_quoted(word)?;
            }
            '$' if self.peek(1) == Some('(') => self.substitution(word)?,
            '`' => self.backticks(word)?,
            _ => {
                word.push(ch);
                self.i += 1;
            }
        }
        Some(())
    }

    fn double_quoted(&mut self, word: &mut String) -> Option<()> {
        loop {
            let c = self.peek(0)?;
            match c {
                '"' => {
                    self.i += 1;
                    return Some(());
                }
                '\\' if !self.ps() => match self.peek(1)? {
                    '\n' => self.i += 2,
                    n @ ('"' | '\\' | '$' | '`') => {
                        word.push(n);
                        self.i += 2;
                    }
                    n => {
                        word.push('\\');
                        word.push(n);
                        self.i += 2;
                    }
                },
                '`' if self.ps() => {
                    word.push(self.peek(1)?);
                    self.i += 2;
                }
                '$' if self.peek(1) == Some('(') => self.substitution(word)?,
                '`' => self.backticks(word)?,
                _ => {
                    word.push(c);
                    self.i += 1;
                }
            }
        }
    }

    /// `$( ... )`: the inner commands are parsed as commands of their own; the raw text stays in the word
    /// (a commit message written as `"$(cat <<'EOF' ... EOF)"` must still be readable as the word).
    fn substitution(&mut self, word: &mut String) -> Option<()> {
        let start = self.i;
        self.i += 2;
        self.commands(true)?;
        word.extend(&self.c[start..self.i]);
        Some(())
    }

    fn backticks(&mut self, word: &mut String) -> Option<()> {
        let start = self.i;
        self.i += 1;
        let mut inner = String::new();
        loop {
            let c = self.peek(0)?;
            self.i += 1;
            match c {
                '`' => break,
                '\\' if matches!(self.peek(0), Some('`' | '\\' | '$')) => {
                    inner.push(self.peek(0)?);
                    self.i += 1;
                }
                _ => inner.push(c),
            }
        }
        for mut c in parse(&inner, self.d)? {
            self.next_id += 1;
            c.id = self.next_id; // the ids of the inner parse would collide with ours
            self.out.push(c);
        }
        word.extend(&self.c[start..self.i]);
        Some(())
    }

    fn heredoc_delimiter(&mut self) -> Option<String> {
        let mut delim = String::new();
        let mut any = false;
        while let Some(c) = self.peek(0) {
            match c {
                '\'' | '"' => {
                    self.i += 1;
                    loop {
                        let q = self.peek(0)?;
                        self.i += 1;
                        if q == c {
                            break;
                        }
                        delim.push(q);
                    }
                    any = true;
                }
                '\\' => {
                    self.i += 1;
                }
                c if c.is_whitespace() || ";|&()<>".contains(c) => break,
                c => {
                    delim.push(c);
                    self.i += 1;
                    any = true;
                }
            }
        }
        any.then_some(delim)
    }

    fn heredoc_body(&mut self, delim: &str, strip_tabs: bool) -> String {
        let mut body = String::new();
        while self.i < self.c.len() {
            let mut line = String::new();
            while let Some(c) = self.peek(0) {
                self.i += 1;
                if c == '\n' {
                    break;
                }
                line.push(c);
            }
            let probe = line.trim_end_matches('\r');
            let probe = if strip_tabs {
                probe.trim_start_matches('\t')
            } else {
                probe
            };
            if probe == delim {
                break;
            }
            body.push_str(&line);
            body.push('\n');
        }
        body
    }

    /// At `@`: the quote of a PowerShell here-string (`@'` or `@"` ending its line), else `None`.
    fn here_string_start(&self) -> Option<char> {
        let q = self.peek(1).filter(|q| matches!(q, '\'' | '"'))?;
        let mut k = 2;
        while let Some(c) = self.peek(k) {
            match c {
                '\n' => return Some(q),
                ' ' | '\t' | '\r' => k += 1,
                _ => return None,
            }
        }
        None
    }

    fn here_string(&mut self, q: char) -> Option<String> {
        while self.peek(0)? != '\n' {
            self.i += 1;
        }
        self.i += 1;
        let mut body: Vec<String> = Vec::new();
        loop {
            if self.i >= self.c.len() {
                return None;
            }
            let line_start = self.i;
            let mut line = String::new();
            while let Some(c) = self.peek(0) {
                self.i += 1;
                if c == '\n' {
                    break;
                }
                line.push(c);
            }
            if line.starts_with(q) && line[q.len_utf8()..].starts_with('@') {
                // what follows `'@` on the line (a `)` or more arguments) is lexed on as usual
                self.i = line_start + 2;
                return Some(body.join("\n"));
            }
            body.push(line.trim_end_matches('\r').to_string());
        }
    }
}

/// Visits every simple command of `src` (and of the scripts passed to `bash -c` / `pwsh -Command`) until the
/// visitor returns `Some`. A text that cannot be parsed has no commands.
pub fn scan<T>(src: &str, d: Dialect, f: &mut dyn FnMut(&Cmd, Dialect) -> Option<T>) -> Option<T> {
    scan_depth(src, d, f, 0)
}

fn scan_depth<T>(
    src: &str,
    d: Dialect,
    f: &mut dyn FnMut(&Cmd, Dialect) -> Option<T>,
    depth: usize,
) -> Option<T> {
    for c in parse(src, d)? {
        if let Some(t) = f(&c, d) {
            return Some(t);
        }
        if depth < 3 {
            if let Some((script, nd)) = nested_script(&c) {
                if let Some(t) = scan_depth(&script, nd, f, depth + 1) {
                    return Some(t);
                }
            }
        }
    }
    None
}

fn is_assignment(w: &str) -> bool {
    w.split_once('=').is_some_and(|(k, _)| {
        let mut ch = k.chars();
        ch.next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && ch.all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// The executable's name as a word: last path part, lower case, without `.exe` and friends.
pub fn base_name(w: &str) -> String {
    let last = w.rsplit(['/', '\\']).next().unwrap_or(w).to_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".com"] {
        if let Some(stem) = last.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    last
}

/// The command a simple command runs and its arguments, past `VAR=x` prefixes, `env`/`sudo`/`command`/...,
/// shell keywords and the PowerShell call operator.
pub fn command_of(words: &[String]) -> Option<(String, &[String])> {
    let mut i = 0;
    let mut wrapped = false;
    while let Some(w) = words.get(i) {
        let skip = is_assignment(w)
            || (wrapped && w.starts_with('-'))
            || matches!(
                w.as_str(),
                "!" | "{" | "}" | "then" | "do" | "else" | "elif" | "if" | "while" | "until" | "&"
            );
        let wrapper = matches!(
            w.as_str(),
            "env" | "sudo" | "command" | "nohup" | "exec" | "time" | "builtin"
        );
        if !(skip || wrapper) {
            return Some((base_name(w), &words[i + 1..]));
        }
        wrapped = wrapper || (wrapped && skip);
        i += 1;
    }
    None
}

/// `bash -c "..."` or `pwsh -Command "..."`: the script and the dialect it is written in.
fn nested_script(c: &Cmd) -> Option<(String, Dialect)> {
    let (name, args) = command_of(&c.words)?;
    match name.as_str() {
        "bash" | "sh" | "zsh" | "dash" | "ksh" => {
            let k = args.iter().position(|a| {
                a.len() > 1
                    && a.starts_with('-')
                    && !a.starts_with("--")
                    && a[1..].chars().all(|c| c.is_ascii_alphabetic())
                    && a.contains('c')
            })?;
            Some((args.get(k + 1)?.clone(), Dialect::Posix))
        }
        "pwsh" | "powershell" => {
            let k = args.iter().position(|a| {
                matches!(
                    a.to_lowercase().as_str(),
                    "-c" | "-command" | "/c" | "/command"
                )
            })?;
            let rest = &args[k + 1..];
            (!rest.is_empty()).then(|| (rest.join(" "), Dialect::Ps))
        }
        _ => None,
    }
}

/// `git [global options] <subcommand> args`: the subcommand and what follows it.
pub fn git_sub(args: &[String]) -> Option<(String, &[String])> {
    let mut i = 0;
    while let Some(a) = args.get(i) {
        if !a.starts_with('-') {
            return Some((a.clone(), &args[i + 1..]));
        }
        // options that take the next word as their value (the `--opt=value` forms are one word)
        if matches!(
            a.as_str(),
            "-C" | "-c"
                | "--git-dir"
                | "--work-tree"
                | "--namespace"
                | "--super-prefix"
                | "--config-env"
        ) {
            i += 1;
        }
        i += 1;
    }
    None
}

/// Reads a text file for a policy: only a small existing one, relative paths against `cwd`.
pub fn read_small(path: &str, cwd: Option<&Path>) -> Option<String> {
    let p = Path::new(path);
    let p = if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd?.join(p)
    };
    let meta = std::fs::metadata(&p).ok()?;
    if !meta.is_file() || meta.len() > 1 << 20 {
        return None;
    }
    String::from_utf8(std::fs::read(p).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(src: &str, d: Dialect) -> Vec<Vec<String>> {
        parse(src, d)
            .unwrap_or_else(|| panic!("unparsable: {src}"))
            .into_iter()
            .map(|c| c.words)
            .collect()
    }

    fn w(src: &str) -> Vec<Vec<String>> {
        words(src, Dialect::Posix)
    }

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn splits_on_operators_but_not_inside_quotes() {
        assert_eq!(
            w("a b && c; d | e || f\ng"),
            [
                v(&["a", "b"]),
                v(&["c"]),
                v(&["d"]),
                v(&["e"]),
                v(&["f"]),
                v(&["g"])
            ]
        );
        assert_eq!(
            w(r#"echo "a && b; c" 'd | e'"#),
            [v(&["echo", "a && b; c", "d | e"])]
        );
        assert_eq!(
            w("a 2>&1 | b &> f"),
            [v(&["a", "2>&1"]), v(&["b", "&>", "f"])]
        );
        assert_eq!(
            w("(a; b) && { c; }"),
            [v(&["a"]), v(&["b"]), v(&["{", "c"]), v(&["}"])]
        );
        assert_eq!(w("a # not b\nc"), [v(&["a"]), v(&["c"])]);
        assert_eq!(w("a#b"), [v(&["a#b"])]);
    }

    #[test]
    fn escapes_follow_bash_and_keep_windows_paths() {
        assert_eq!(w(r"echo a\ b"), [v(&["echo", "a b"])]);
        assert_eq!(w(r#"echo "a\"b""#), [v(&["echo", "a\"b"])]);
        assert_eq!(w(r"ls C:\Users\me"), [v(&["ls", r"C:\Users\me"])]);
        assert_eq!(w("a \\\nb"), [v(&["a", "b"])]);
        assert_eq!(w("echo 'a\\b'"), [v(&["echo", "a\\b"])]);
    }

    #[test]
    fn substitutions_become_commands_and_keep_their_text_in_the_word() {
        let cmds = parse("echo \"$(git push) x\" `date`", Dialect::Posix).unwrap();
        let ws: Vec<_> = cmds.iter().map(|c| c.words.clone()).collect();
        assert_eq!(ws[0], v(&["git", "push"]));
        assert_eq!(ws[1], v(&["date"]));
        assert_eq!(ws[2], v(&["echo", "$(git push) x", "`date`"]));
        // single quotes keep `$(` as text: no command inside
        assert_eq!(w("echo '$(git push)'"), [v(&["echo", "$(git push)"])]);
        assert_eq!(w("echo $((1 + 2))").len(), 2);
    }

    #[test]
    fn heredoc_bodies_are_data_not_commands() {
        let cmds = parse(
            "cat > f <<'EOF'\ngit push --force\n$(rm -rf /)\nEOF\nls",
            Dialect::Posix,
        )
        .unwrap();
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[0].words, v(&["cat", ">", "f"]));
        assert_eq!(cmds[0].heredocs, ["git push --force\n$(rm -rf /)\n"]);
        assert_eq!(cmds[1].words, v(&["ls"]));
        // <<- strips leading tabs; two heredocs on one line; <<< is a here-string, not a heredoc
        let cmds = parse("cat <<-A <<B\n\tbody a\n\tA\nbody b\nB\n", Dialect::Posix).unwrap();
        assert_eq!(
            cmds[0].heredocs,
            ["\tbody a\n".to_string(), "body b\n".to_string()]
        );
        assert_eq!(w("cat <<< \"x y\""), [v(&["cat", "<<<", "x y"])]);
    }

    #[test]
    fn the_usual_commit_message_form_with_quotes_inside_the_heredoc() {
        let src = "git commit -m \"$(cat <<'EOF'\nfix \"foo\" and it's (bad\n\nCo-Authored-By: X\nEOF\n)\"";
        let cmds = parse(src, Dialect::Posix).unwrap();
        // the substitution's cat, then the git commit whose message word holds the whole text
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[0].words[0], "cat");
        assert_eq!(cmds[1].words[..2], v(&["git", "commit"])[..]);
        assert!(cmds[1].words[3].contains("Co-Authored-By: X"));
        assert!(cmds[0].heredocs[0].contains("fix \"foo\" and it's (bad"));
    }

    #[test]
    fn unreadable_input_gives_none() {
        for bad in ["echo 'a", "echo \"a", "echo $(a", "echo `a", "cat <<"] {
            assert!(parse(bad, Dialect::Posix).is_none(), "{bad}");
        }
        assert!(parse("echo \"a", Dialect::Ps).is_none());
        assert!(parse("@'\nno end", Dialect::Ps).is_none());
        assert_eq!(parse("", Dialect::Posix).unwrap().len(), 0);
    }

    #[test]
    fn powershell_has_backtick_escapes_literal_backslashes_and_here_strings() {
        let p = |s: &str| words(s, Dialect::Ps);
        assert_eq!(
            p(r"Remove-Item C:\a\b -Force"),
            [v(&["Remove-Item", r"C:\a\b", "-Force"])]
        );
        assert_eq!(p("echo `\"x`\" 'it''s'"), [v(&["echo", "\"x\"", "its"])]);
        assert_eq!(
            p("a; b | c\nd && e"),
            [v(&["a"]), v(&["b"]), v(&["c"]), v(&["d"]), v(&["e"])]
        );
        let cmds = parse(
            "git commit -m @'\nline \"1\" 'q'\nCo-Authored-By: Z\n'@ -a\nnext",
            Dialect::Ps,
        )
        .unwrap();
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[0].words[3], "line \"1\" 'q'\nCo-Authored-By: Z");
        assert_eq!(cmds[0].words[4], "-a");
        assert_eq!(cmds[1].words, v(&["next"]));
        // `@` elsewhere is an ordinary character
        assert_eq!(p("echo a@b @x"), [v(&["echo", "a@b", "@x"])]);
        // `<<` is not a heredoc there
        assert_eq!(p("echo 1<<2").len(), 1);
    }

    #[test]
    fn command_of_skips_prefixes_and_normalises_the_name() {
        let c = |s: &str| {
            let ws = w(s).remove(0);
            command_of(&ws).map(|(n, a)| (n, a.to_vec()))
        };
        assert_eq!(
            c("FOO=1 BAR=2 git push"),
            Some(("git".into(), v(&["push"])))
        );
        assert_eq!(
            c("sudo -n env -i git push"),
            Some(("git".into(), v(&["push"])))
        );
        assert_eq!(c("/usr/bin/git push"), Some(("git".into(), v(&["push"]))));
        assert_eq!(
            c(r"C:\Program\ Files\Git\bin\git.exe push"),
            Some(("git".into(), v(&["push"])))
        );
        assert_eq!(c("if git push"), Some(("git".into(), v(&["push"]))));
        assert_eq!(c("FOO=1"), None);
        let ps = words("& 'C:/Git/git.exe' push", Dialect::Ps).remove(0);
        assert_eq!(command_of(&ps).unwrap().0, "git");
    }

    #[test]
    fn git_sub_skips_global_options() {
        let sub = |s: &str| {
            let ws = w(s).remove(0);
            let (_, a) = command_of(&ws).unwrap();
            git_sub(a).map(|(s, r)| (s, r.to_vec()))
        };
        assert_eq!(sub("git push -f"), Some(("push".into(), v(&["-f"]))));
        assert_eq!(
            sub("git -C d -c a=b --no-pager push x"),
            Some(("push".into(), v(&["x"])))
        );
        assert_eq!(sub("git --git-dir=x push"), Some(("push".into(), v(&[]))));
        assert_eq!(sub("git --version"), None);
    }

    #[test]
    fn scan_goes_into_bash_c_and_powershell_command_but_not_into_echo() {
        let hit = |src: &str, d: Dialect| {
            scan(src, d, &mut |c: &Cmd, _| {
                (command_of(&c.words).map(|(n, _)| n) == Some("target".to_string())).then_some(())
            })
            .is_some()
        };
        assert!(hit("target", Dialect::Posix));
        assert!(hit("bash -c \"echo x; target\"", Dialect::Posix));
        assert!(hit("sh -ec 'target'", Dialect::Posix));
        assert!(hit(
            "pwsh -NoProfile -Command \"a; target\"",
            Dialect::Posix
        ));
        assert!(hit("powershell -c target", Dialect::Ps));
        assert!(hit("bash -c \"bash -c 'target'\"", Dialect::Posix));
        assert!(!hit("echo target", Dialect::Posix));
        assert!(!hit("echo \"target\"", Dialect::Posix));
        assert!(!hit("bash script.sh target", Dialect::Posix));
        assert!(!hit("bash -c", Dialect::Posix));
        assert!(!hit("echo 'unclosed target", Dialect::Posix));
    }

    #[test]
    fn read_small_resolves_against_cwd_and_ignores_big_or_missing_files() {
        let d = std::env::temp_dir().join(format!("ctxkit-shell-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("m.txt"), "msg").unwrap();
        assert_eq!(read_small("m.txt", Some(&d)).as_deref(), Some("msg"));
        assert_eq!(
            read_small(d.join("m.txt").to_str().unwrap(), None).as_deref(),
            Some("msg")
        );
        assert!(read_small("m.txt", None).is_none());
        assert!(read_small("nope.txt", Some(&d)).is_none());
        std::fs::write(d.join("big.txt"), vec![b'a'; 2 << 20]).unwrap();
        assert!(read_small("big.txt", Some(&d)).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }
}
