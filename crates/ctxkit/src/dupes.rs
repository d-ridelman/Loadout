//! `doctor` check `rules_duplicate`: the same rule standing in two places of `CLAUDE.md` (the owner's own
//! sections and the ctxkit block say the same thing in different words). A model reads both, and the two
//! copies drift apart.
//!
//! What is compared: the clauses of the bullet lines (a clause ends at `.` `;` `!` `?`, a parenthesis or a
//! spaced dash), lower-cased, without markup or punctuation. Two clauses are duplicates when the share of
//! their common words (common / all distinct words of both) is at least 0.8, so identical wording and
//! small edits are found. Paraphrases with other words are not (that needs a person or a model).
//! Clauses under 5 words, headings, text outside bullets and fenced code are ignored, and two lines of the
//! ctxkit block never count against each other (they are generated).
use crate::{t, Lang};
use std::collections::HashSet;

const MIN_WORDS: usize = 5;
const SIMILAR: f64 = 0.8;
const MAX_CLAUSES: usize = 1500;

#[derive(Debug, PartialEq)]
pub struct Pair {
    /// 1-based line numbers, `a < b`.
    pub a: usize,
    pub b: usize,
    /// Which of the two lines is inside the ctxkit block.
    pub a_in_block: bool,
    pub b_in_block: bool,
    /// The clause of the first line, as written.
    pub text: String,
}

struct Clause {
    line: usize,
    in_block: bool,
    words: HashSet<String>,
    text: String,
}

/// The text of a bullet line (`- x`, `* x`, `+ x`, `1. x`, `2) x`), or `None` for anything else.
fn bullet_text(line: &str) -> Option<&str> {
    let t = line.trim_start();
    for p in ["- ", "* ", "+ "] {
        if let Some(r) = t.strip_prefix(p) {
            return Some(r);
        }
    }
    let digits = t.chars().take_while(char::is_ascii_digit).count();
    let rest = &t[digits..];
    if digits > 0 {
        return rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "));
    }
    None
}

fn clauses_of(text: &str) -> Vec<&str> {
    text.split(['.', ';', '!', '?', '(', ')'])
        .flat_map(|c| c.split(" — ").flat_map(|c| c.split(" – ")))
        .map(str::trim)
        .collect()
}

fn words_of(clause: &str) -> HashSet<String> {
    clause
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

fn similar(a: &HashSet<String>, b: &HashSet<String>) -> bool {
    let common = a.intersection(b).count();
    let all = a.len() + b.len() - common;
    all > 0 && common as f64 / all as f64 >= SIMILAR
}

/// The repeated rules of `md`, one pair per two lines (the first clause that matches), in line order.
pub fn find(md: &str) -> Vec<Pair> {
    let block = crate::setup::marker_span(md);
    let mut clauses: Vec<Clause> = Vec::new();
    let (mut offset, mut fenced) = (0usize, false);
    for (i, line) in md.split_inclusive('\n').enumerate() {
        let start = offset;
        offset += line.len();
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let Some(text) = bullet_text(line) else {
            continue;
        };
        let in_block = block.is_some_and(|(s, e)| start >= s && start < e);
        for c in clauses_of(text) {
            let words = words_of(c);
            if words.len() >= MIN_WORDS {
                clauses.push(Clause {
                    line: i + 1,
                    in_block,
                    words,
                    text: c.to_string(),
                });
            }
        }
    }
    if clauses.len() > MAX_CLAUSES {
        return Vec::new();
    }
    let mut out: Vec<Pair> = Vec::new();
    for (k, a) in clauses.iter().enumerate() {
        for b in &clauses[k + 1..] {
            if a.line == b.line || (a.in_block && b.in_block) {
                continue;
            }
            if out.iter().any(|p| p.a == a.line && p.b == b.line) || !similar(&a.words, &b.words) {
                continue;
            }
            out.push(Pair {
                a: a.line,
                b: b.line,
                a_in_block: a.in_block,
                b_in_block: b.in_block,
                text: a.text.clone(),
            });
        }
    }
    out.sort_by_key(|p| (p.a, p.b));
    out
}

/// The finding's detail: line numbers (and where each line sits) with the repeated clause, at most 8 pairs.
pub fn describe(pairs: &[Pair], lang: Lang) -> String {
    let tag = |in_block: bool| {
        if in_block {
            t(lang, " (ctxkit block)", " (блок ctxkit)")
        } else {
            ""
        }
    };
    let mut parts: Vec<String> = pairs
        .iter()
        .take(8)
        .map(|p| {
            let clip: String = p.text.chars().take(70).collect();
            format!(
                "{}{}{}{}{}: «{clip}»",
                p.a,
                tag(p.a_in_block),
                t(lang, " and ", " и "),
                p.b,
                tag(p.b_in_block)
            )
        })
        .collect();
    if pairs.len() > 8 {
        parts.push(format!("+{} {}", pairs.len() - 8, t(lang, "more", "ещё")));
    }
    format!("{}{}", t(lang, "lines ", "строки "), parts.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The owner's real `CLAUDE.md` layout: his own "Команда моделей" section, the tools section, and the
    /// ctxkit block (`setup --with-rules --lang ru`) that says much of the same.
    const OWNER: &str = "# Правила для всех сессий\n\
\n\
## Команда моделей (Advisor и субагенты)\n\
\n\
- Основная сессия — **Sonnet**. Советуйся с **advisor (Fable)** до выбора подхода, когда одна и та же ошибка возвращается дважды, и перед тем как объявить задачу готовой.\n\
- Поиск по коду, греп и чтение документации отправляй в `Explore` (Haiku). Перед сдачей нетривиальной задачи прогоняй `checker` (Opus).\n\
- Мелкую задачу на 1–2 файла делай сам без субагентов. Субагентам, которые правят код, задавай `model: \"sonnet\"`, никогда `haiku`.\n\
\n\
## Среда (Windows 11) и инструменты\n\
\n\
- Группируй независимые `Read`/`Edit` и шаги браузера (`browser_batch`, `browser_snapshot` с `interactive_only: true`).\n\
- Для сборок, тестов и `typecheck`, когда не нужен полный лог, запускай `ctxkit check <cmd>` (при успехе одна строка `OK (ms)`, при падении — суть ошибки и путь к полному логу).\n\
\n\
<!-- ctxkit:start -->\n\
## Команда моделей и экономия контекста (ctxkit)\n\
\n\
- Основная сессия — **sonnet**. Не фиксируй подход и не правь код по задаче больше чем в одном файле, не вызвав **advisor (fable)**; зови его и при второй одинаковой ошибке подряд.\n\
- Поиск по коду, греп и чтение документации отправляй в `Explore` (haiku); правку одного файла без изменения логики делай сам.\n\
- Не объявляй задачу готовой без `checker` (Opus), кроме правки одного файла без изменения логики; хук Stop один раз вернёт тебя, если правки остались без `checker` или advisor.\n\
- Группируй независимые `Read`/`Edit`; не читай длинные файлы целиком: сначала `Grep` или LSP, затем диапазон.\n\
- Для сборок, тестов и `typecheck`, когда не нужен полный лог, запускай `ctxkit check <cmd>`.\n\
<!-- ctxkit:end -->\n";

    fn line_of(md: &str, needle: &str) -> usize {
        md.lines().position(|l| l.contains(needle)).unwrap() + 1
    }

    #[test]
    fn finds_the_repeats_between_the_owners_sections_and_the_ctxkit_block() {
        let pairs = find(OWNER);
        let explore = (
            line_of(
                OWNER,
                "Поиск по коду, греп и чтение документации отправляй в `Explore` (Haiku)",
            ),
            line_of(
                OWNER,
                "Поиск по коду, греп и чтение документации отправляй в `Explore` (haiku)",
            ),
        );
        let check = (
            line_of(OWNER, "запускай `ctxkit check <cmd>` (при успехе"),
            line_of(OWNER, "запускай `ctxkit check <cmd>`."),
        );
        let found: Vec<(usize, usize, bool, bool)> = pairs
            .iter()
            .map(|p| (p.a, p.b, p.a_in_block, p.b_in_block))
            .collect();
        assert!(
            found.contains(&(explore.0, explore.1, false, true)),
            "Explore line: {found:?}"
        );
        assert!(
            found.contains(&(check.0, check.1, false, true)),
            "ctxkit check line (the owner's clause before the parenthesis): {found:?}"
        );
        assert_eq!(pairs.len(), 2, "only what really repeats: {pairs:?}");
        assert!(pairs.iter().any(|p| p.text.contains("Поиск по коду")));
    }

    #[test]
    fn paraphrases_with_other_words_are_not_flagged() {
        // the "Sonnet is the main session", "checker before done" and "fix a one-file change yourself" rules of
        // the two sections say the same in different words: a word count cannot tell, and does not guess
        let pairs = find(OWNER);
        for needle in ["Основная сессия — **Sonnet**", "Мелкую задачу на 1–2 файла"]
        {
            let l = line_of(OWNER, needle);
            assert!(pairs.iter().all(|p| p.a != l && p.b != l), "{needle}");
        }
    }

    #[test]
    fn ignores_short_lines_headings_prose_fences_and_the_blocks_own_lines() {
        let md = "# Заголовок для всех секций документа\n\
## Заголовок для всех секций документа\n\
\n\
- Use tabs here\n\
- Use tabs here\n\
- Always run the full test suite before every release\n\
Always run the full test suite before every release in prose\n\
```\n\
- Always run the full test suite before every release\n\
```\n\
<!-- ctxkit:start -->\n\
- Delegate codebase search to the Explore agent every time\n\
- Delegate codebase search to the Explore agent every time\n\
<!-- ctxkit:end -->\n";
        assert_eq!(find(md), vec![]);
        // the same long rule twice in the owner's text is found; out of the block, in the block
        let twice = "- Always run the full test suite before every release\n\
- Keep each commit small and focused on one change only\n\
- Always run the full test suite before every release!\n";
        let p = find(twice);
        assert_eq!(p.len(), 1);
        assert_eq!(
            (p[0].a, p[0].b, p[0].a_in_block, p[0].b_in_block),
            (1, 3, false, false)
        );
    }

    #[test]
    fn close_wording_counts_and_numbered_lists_work_but_the_threshold_holds() {
        let md = "1. Never commit secrets or tokens into the repository history\n\
2) Never commit secrets or tokens into the repository history now\n\
- Never commit secrets and keys into the history of the repository\n\
- Prefer small pure functions with clear names over clever one-liners\n";
        let p = find(md);
        // lines 1 and 2: 9 common words of 10 distinct (0.9); line 3 shares too few words
        assert_eq!(p.iter().map(|p| (p.a, p.b)).collect::<Vec<_>>(), [(1, 2)]);
        // the threshold: 8 common words of 12 are too few, 9 of 11 (0.82) are enough
        assert!(!similar(
            &words_of("a b c d e f g h i j"),
            &words_of("a b c d e f g h k l")
        ));
        assert!(similar(
            &words_of("a b c d e f g h i j"),
            &words_of("a b c d e f g h i k")
        ));
        assert!(similar(
            &words_of("a b c d e f g h i"),
            &words_of("a b c d e f g h i")
        ));
    }

    #[test]
    fn doctor_reports_a_warning_with_the_line_numbers_and_keeps_the_size_check_as_it_was() {
        let d = std::env::temp_dir().join(format!("ctxkit_dupes_doctor_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("CLAUDE.md"), OWNER).unwrap();
        let v = crate::doctor::diagnose(&d, crate::Lang::En);
        let dup = v
            .iter()
            .find(|x| x.id == "rules_duplicate")
            .expect("finding");
        assert_eq!(dup.severity, "warn");
        let detail = dup.detail.clone().unwrap();
        let explore = line_of(OWNER, "отправляй в `Explore` (Haiku)");
        assert!(detail.contains(&format!("{explore}")), "{detail}");
        assert!(detail.contains("ctxkit block"), "{detail}");
        assert!(dup.fix.is_some_and(|f| f.contains("one place")));
        assert!(
            v.iter().all(|x| x.id != "claude_md_size"),
            "short file: no size warning"
        );
        let ru = crate::doctor::diagnose(&d, crate::Lang::Ru);
        assert!(ru
            .iter()
            .find(|x| x.id == "rules_duplicate")
            .unwrap()
            .fix
            .is_some_and(|f| f.contains("одно место")));
        // a long file with the block: the size warning is unchanged and unique lines cause no duplicate finding
        let mut big = String::from("<!-- ctxkit:start -->\nr\n<!-- ctxkit:end -->\n");
        for i in 0..210 {
            big.push_str(&format!(
                "- Unique rule number {i} about topic{i} and thing{i}\n"
            ));
        }
        std::fs::write(d.join("CLAUDE.md"), &big).unwrap();
        let v = crate::doctor::diagnose(&d, crate::Lang::En);
        let size = v
            .iter()
            .find(|x| x.id == "claude_md_size")
            .expect("size warning");
        assert_eq!(size.severity, "warn");
        assert!(size.detail.as_deref().unwrap().starts_with("213 lines"));
        assert!(v.iter().all(|x| x.id != "rules_duplicate"));
        // no CLAUDE.md at all: no finding
        std::fs::remove_file(d.join("CLAUDE.md")).unwrap();
        assert!(crate::doctor::diagnose(&d, crate::Lang::En)
            .iter()
            .all(|x| x.id != "rules_duplicate"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
