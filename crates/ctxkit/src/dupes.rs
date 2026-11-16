//! `doctor` check `rules_duplicate`: the same rule standing in two places of `CLAUDE.md` (the owner's own
//! sections and the ctxkit block say the same thing). A model reads both, and the two copies drift apart.
//!
//! Two tests, both over bullet lines only (headings, prose and fenced code are ignored):
//!
//! * **Same wording**, any two lines except two lines of the block: the clauses of the lines (a clause ends at
//!   `.` `;` `!` `?`, a parenthesis or a spaced dash), lower-cased, without markup, of 5 words or more, share at
//!   least 0.8 of their distinct words.
//! * **Paraphrase**, an owner's line against a line of the ctxkit block only (the block's rules are known and
//!   few; two of the owner's own neighbouring points on one topic are the common false alarm, so they get the
//!   strict test alone). An owner's sentences and their clauses (split also at `;` and `: `) are compared
//!   with each clause of the block line (a clause "X, not Y" also as `X` and `not Y`; a clause that two block
//!   lines share, "the ctxkit hook asks", is boilerplate and skipped). Each
//!   side gives *anchors* (the words of `code` and **bold** spans and the names `sonnet`, `opus`, `haiku`,
//!   `fable`, `advisor`, `checker`, `explore`, `lsp`, `grep`, case-folded) and *concepts* (the other words
//!   without stop words: a small Russian/English synonym group such as "ask: спрашивай / подтверждение /
//!   confirm", else the word cut to a stem). A group marked as an *action* is the verb of a rule (ask,
//!   irreversible, declare done, consult, run, send, batch, do it yourself, at once). The pair is a repeat when
//!   the block clause has anchors and they share one or more and: 3+ anchors and 1 concept; or 2 anchors, 2
//!   concepts and an action; or 1 anchor, 2 concepts, an action and half of the clause's concepts; or 3
//!   concepts covering 60% of the clause with the same polarity (both or neither negated). A clause without
//!   anchors needs 3 shared concepts with an action covering half of it. An exception or the opposite of the
//!   rule is no repeat: when a piece has exactly one negation (`не`, `без`, `never`, `without`, `запрещён`...),
//!   the next two words that count are negated (unless they stood before it), and a shared anchor or action
//!   negated on one side only cancels the pair ("`git push` to my fork without confirmation"). Two or more
//!   negations ("do not lock a plan without calling the advisor") mark nothing: such a rule is positive.
//!   One negation against none, wherever it stands ("confirmation is not required"), also cancels the pair.
//!
//! Measured on the corpus of the tests (the real block of `setup --with-rules`, 18 paraphrases, 34 + 8 lines
//! on the same topics with another meaning) and on a set of 12 + 15 written blind by another model; see README.
use crate::{t, Lang};
use std::collections::{HashMap, HashSet};

const MIN_WORDS: usize = 5;
const SIMILAR: f64 = 0.8;
/// A file of one line copied thousands of times would make every clause a candidate of every other: the
/// same-wording test stops collecting there (the finding lists 8 pairs anyway).
const MAX_CANDIDATES: usize = 200_000;

#[derive(Debug, PartialEq)]
pub struct Pair {
    /// 1-based line numbers, `a < b`.
    pub a: usize,
    pub b: usize,
    /// Which of the two lines is inside the ctxkit block.
    pub a_in_block: bool,
    pub b_in_block: bool,
    /// The repeated part of each line, as written.
    pub a_text: String,
    pub b_text: String,
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

/// The pairs of clauses that can reach `SIMILAR` at all, without comparing every two (prefix filtering): with
/// each clause's words ordered rarest first, two sets with a share of at least `SIMILAR` have a common word
/// among the first `n - ceil(SIMILAR * n) + 1` words of each. A file of unique lines gives almost none.
fn candidates(clauses: &[Clause]) -> Vec<(usize, usize)> {
    let mut freq: HashMap<&str, usize> = HashMap::new();
    for c in clauses {
        for w in &c.words {
            *freq.entry(w.as_str()).or_default() += 1;
        }
    }
    let mut index: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut out: HashSet<(usize, usize)> = HashSet::new();
    for (i, c) in clauses.iter().enumerate() {
        let mut words: Vec<&str> = c.words.iter().map(String::as_str).collect();
        words.sort_by_key(|w| (freq[w], *w));
        let n = words.len();
        let prefix = n - (SIMILAR * n as f64).ceil() as usize + 1;
        for w in &words[..prefix.min(n)] {
            let seen = index.entry(w).or_default();
            out.extend(seen.iter().map(|&j| (j, i)));
            seen.push(i);
        }
        if out.len() > MAX_CANDIDATES {
            break;
        }
    }
    let mut out: Vec<(usize, usize)> = out.into_iter().collect();
    out.sort_unstable();
    out
}

// ---- the paraphrase test ----

#[rustfmt::skip]
const STOP: &[&str] = &[
    "и", "в", "во", "на", "с", "со", "к", "ко", "по", "о", "об", "от", "до", "за", "из", "у", "а", "но",
    "или", "же", "ли", "бы", "то", "это", "этот", "эта", "эти", "тот", "та", "те", "как", "что", "чтобы",
    "когда", "если", "там", "тут", "уже", "ещё", "еще", "его", "её", "ее", "их", "им", "ему", "ей", "мне",
    "меня", "мой", "моя", "моё", "мои", "свой", "свою", "свои", "для", "при", "через", "про", "под", "над",
    "между", "также", "только", "всё", "все", "весь", "вся", "так", "ты", "вы", "он", "она", "оно", "они",
    "я", "мы", "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "by", "with", "from",
    "into", "as", "is", "are", "be", "it", "its", "this", "that", "these", "those", "your", "you", "when",
    "then", "than", "so", "if", "any", "each", "every", "via", "per", "before", "after", "first", "again",
    "once", "such", "do", "get", "go", "have", "has", "let", "make", "keep", "put", "use", "t", "s",
    "должно", "должен", "должна", "должны", "быть", "нужно", "надо", "must", "should", "be", "been",
];
/// Negation words: their presence is the polarity of a sentence, they are never concepts.
#[rustfmt::skip]
const NEG: &[&str] = &[
    "не", "нет", "никогда", "без", "never", "no", "not", "without", "unless", "don", "dont", "aren",
    "isn", "doesn", "won", "cannot",
];
const KNOWN: &[&str] = &[
    "sonnet", "opus", "haiku", "fable", "advisor", "checker", "explore", "lsp", "grep",
];
/// Endings cut off a Russian word (longest first) before it is clipped to 6 letters.
#[rustfmt::skip]
const RU_END: &[&str] = &[
    "ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими", "ешь", "ете", "ишь", "ите", "ает", "яет",
    "уют", "ают", "ой", "ей", "ий", "ый", "ая", "яя", "ое", "ее", "ые", "ие", "ую", "юю", "ом", "ем",
    "ам", "ям", "ах", "ях", "ых", "их", "ов", "ев", "ть", "ти", "ла", "ли", "ло", "а", "я", "о", "е",
    "ы", "и", "у", "ю", "ь", "й",
];
const EN_END: &[&str] = &["ing", "ed", "es", "s", "ly"];

/// Whole words with a fixed concept (short words a prefix would over-match: `log` is not `logic`).
#[rustfmt::skip]
const EXACT: &[(&str, &str)] = &[
    ("один", "ONE"), ("одна", "ONE"), ("одно", "ONE"), ("одного", "ONE"), ("одной", "ONE"),
    ("одном", "ONE"), ("одну", "ONE"), ("one", "ONE"), ("single", "ONE"), ("1", "ONE"),
    ("два", "TWO"), ("две", "TWO"), ("двух", "TWO"), ("two", "TWO"), ("2", "TWO"),
    ("лог", "LOG"), ("лога", "LOG"), ("логи", "LOG"), ("логов", "LOG"), ("логу", "LOG"),
    ("логе", "LOG"), ("логом", "LOG"), ("логах", "LOG"), ("log", "LOG"), ("logs", "LOG"),
    ("work", "TASK"), ("read", "READ"), ("reads", "READ"), ("reading", "READ"),
];
/// Synonym groups by the start of the word or of its stem; `true` marks an action (the verb of a rule).
#[rustfmt::skip]
const GROUPS: &[(&str, bool, &[&str])] = &[
    ("ASK", true, &["спраш", "спрос", "подтвер", "confirm", "ask"]),
    ("IRREV", true, &["необрат", "отмен", "откат", "безвозв", "irrevers", "undo", "destruct", "revert"]),
    ("DONE", true, &["готов", "сдач", "сдава", "done", "finish", "complet"]),
    ("CONSULT", true, &["совет", "вызв", "вызов", "зов", "consult", "calling"]),
    ("RUN", true, &["запуск", "прогон", "гоня", "run", "wrap"]),
    ("SEND", true, &["отправ", "отдав", "поруч", "delegat", "send"]),
    ("BATCH", true, &["групп", "batch", "group"]),
    ("SELF", true, &["сам", "yourself", "local"]),
    ("PARALLEL", true, &["параллел", "одноврем", "concurr", "parallel"]),
    ("APPROACH", false, &["подход", "plan", "approach"]),
    ("ERROR", false, &["ошибк", "error"]),
    ("TWICE", false, &["дважд", "втор", "twice", "second", "repeat", "возвращ"]),
    ("FILE", false, &["файл", "file"]),
    ("BUILD", false, &["сборк", "сборок", "build"]),
    ("TEST", false, &["тест", "test"]),
    ("REPORT", false, &["отчёт", "отчет", "report"]),
    ("NOTE", false, &["заметк", "note"]),
    ("CHAT", false, &["чат", "chat"]),
    ("ROOT", false, &["корн", "корен", "root"]),
    ("COMMIT", false, &["коммит", "commit"]),
    ("MESSAGE", false, &["сообщ", "messag"]),
    ("SEARCH", false, &["поиск", "search", "греп", "grep"]),
    ("DOCS", false, &["документ", "docs"]),
    ("READ", false, &["чтени", "чита"]),
    ("MACHINE", false, &["машин", "machine"]),
    ("MAIN", false, &["основн", "main"]),
    ("SESSION", false, &["сесси", "session"]),
    ("INDEP", false, &["независ", "independ"]),
    ("TASK", false, &["задач", "task"]),
    ("FIX", false, &["правк", "fix", "edit", "change"]),
];

fn is_cyrillic(w: &str) -> bool {
    w.chars()
        .next()
        .is_some_and(|c| ('а'..='я').contains(&c) || c == 'ё')
}

fn stem(w: &str) -> String {
    let cyr = is_cyrillic(w);
    let n = w.chars().count();
    let cut = (if cyr { RU_END } else { EN_END })
        .iter()
        .find(|e| w.ends_with(*e) && n - e.chars().count() >= 3)
        .map_or(w, |e| &w[..w.len() - e.len()]);
    cut.chars().take(if cyr { 6 } else { 7 }).collect()
}

/// The concept of a lower-case word: its synonym group, else its stem.
fn concept(w: &str) -> String {
    if let Some((_, c)) = EXACT.iter().find(|(x, _)| *x == w) {
        return (*c).to_string();
    }
    let s = stem(w);
    for (name, _, starts) in GROUPS {
        if starts.iter().any(|p| w.starts_with(p) || s.starts_with(p)) {
            return (*name).to_string();
        }
    }
    s
}

fn is_action(c: &str) -> bool {
    GROUPS.iter().any(|(name, act, _)| *act && *name == c)
}

/// Sentences of `text` (at `.` `!` `?`), and with `clauses` also at `;` and `: `; never inside `code`.
fn pieces(text: &str, clauses: bool) -> Vec<String> {
    let mut out = Vec::new();
    let (mut start, mut code) = (0, false);
    let mut it = text.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        if c == '`' {
            code = !code;
            continue;
        }
        let next_blank = it.peek().is_none_or(|(_, n)| n.is_whitespace());
        let end = !code
            && next_blank
            && (matches!(c, '.' | '!' | '?') || (clauses && matches!(c, ';' | ':')));
        if end {
            out.push(&text[start..i]);
            start = i + c.len_utf8();
        }
    }
    out.push(&text[start..]);
    out.into_iter()
        .map(|u| {
            u.trim()
                .trim_end_matches(['.', ';', ':'])
                .trim()
                .to_string()
        })
        .filter(|u| !u.is_empty())
        .collect()
}

/// What is compared: of an owner's line its sentences and their clauses; of a block line its clauses, and a
/// clause "X, not Y" also as `X` and `not Y` (the place and the place it is not are two rules).
fn units(text: &str, block: bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut keep = |u: String| {
        if !out.contains(&u) {
            out.push(u);
        }
    };
    if block {
        for c in pieces(text, true) {
            let mut parts = vec![c.clone()];
            for sep in [", не ", ", not "] {
                parts = parts
                    .iter()
                    .flat_map(|p| match p.split_once(sep) {
                        Some((head, tail)) => vec![
                            head.to_string(),
                            format!("{}{tail}", sep.trim_start_matches(", ")),
                        ],
                        None => vec![p.clone()],
                    })
                    .collect();
            }
            keep(c);
            parts.into_iter().for_each(&mut keep);
        }
    } else {
        pieces(text, false)
            .into_iter()
            .chain(pieces(text, true))
            .for_each(keep);
    }
    out
}

struct Unit {
    anchors: HashSet<String>,
    concepts: HashSet<String>,
    negated: bool,
    /// How many negation words the piece has.
    negations: usize,
    /// The anchors and concepts a single negation stands before ("без `ctxkit check`", "needs no confirmation").
    neg_anchors: HashSet<String>,
    neg_concepts: HashSet<String>,
}

fn is_negation(w: &str) -> bool {
    NEG.contains(&w)
        || ["запрещ", "forbid", "prohibit"]
            .iter()
            .any(|p| w.starts_with(p))
        || w == "нельзя"
}

fn unit_of(text: &str) -> Unit {
    // the words in order, with whether they stand in `code` or **bold** (an anchor) or in the text (a concept)
    let mut words: Vec<(String, bool)> = Vec::new();
    let mut push = |s: &str, marked: bool| {
        words.extend(
            s.split(|c: char| !(c.is_alphanumeric() || c == '_'))
                .filter(|w| !w.is_empty())
                .map(|w| (w.to_lowercase(), marked)),
        );
    };
    for (k, part) in text.split('`').enumerate() {
        if k % 2 == 1 {
            push(part, true);
        } else {
            for (b, piece) in part.split("**").enumerate() {
                push(piece, b % 2 == 1);
            }
        }
    }
    let is_anchor = |(w, marked): &(String, bool)| {
        (*marked && w.chars().count() >= 2 && !STOP.contains(&w.as_str()))
            || KNOWN.contains(&w.as_str())
    };
    let anchors: HashSet<String> = words
        .iter()
        .filter(|x| is_anchor(x))
        .map(|(w, _)| w.clone())
        .collect();
    let is_concept = |w: &str| {
        !STOP.contains(&w)
            && !is_negation(w)
            && !anchors.contains(w)
            && (w.chars().count() >= 2 || w.chars().all(|c| c.is_ascii_digit()))
    };
    let concepts = words
        .iter()
        .filter(|(w, _)| is_concept(w))
        .map(|(w, _)| concept(w))
        .collect();
    // One negation turns the next two words that count; two or more ("do not lock a plan without calling the
    // advisor") make a rule of the positive kind ("call the advisor first"), so nothing is marked.
    let negations: Vec<usize> = (0..words.len())
        .filter(|&k| is_negation(&words[k].0))
        .collect();
    let (mut neg_anchors, mut neg_concepts) = (HashSet::new(), HashSet::new());
    if let [k] = negations[..] {
        let counted: Vec<usize> = (k + 1..words.len())
            .filter(|&j| is_anchor(&words[j]) || is_concept(&words[j].0))
            .take(2)
            .collect();
        // a word that already stood before the negation ("a fix with no logic change") keeps its sign
        let outside = |key: &dyn Fn(usize) -> Option<String>, s: &str| {
            (0..k).any(|j| key(j).as_deref() == Some(s))
        };
        let anchor_at = |j: usize| is_anchor(&words[j]).then(|| words[j].0.clone());
        let concept_at = |j: usize| {
            (!is_anchor(&words[j]) && is_concept(&words[j].0)).then(|| concept(&words[j].0))
        };
        for &j in &counted {
            if let Some(a) = anchor_at(j).filter(|a| !outside(&anchor_at, a)) {
                neg_anchors.insert(a);
            } else if let Some(c) = concept_at(j).filter(|c| !outside(&concept_at, c)) {
                neg_concepts.insert(c);
            }
        }
    }
    Unit {
        anchors,
        concepts,
        negated: !negations.is_empty(),
        negations: negations.len(),
        neg_anchors,
        neg_concepts,
    }
}

/// Does the owner's sentence `u` say what the block clause `v` says.
fn paraphrase(u: &Unit, v: &Unit) -> bool {
    let common: Vec<&String> = u.concepts.intersection(&v.concepts).collect();
    let shared_anchors: Vec<&String> = u.anchors.intersection(&v.anchors).collect();
    // an exception or the opposite of the rule ("`git push` to my fork without confirmation") is no repeat;
    // the sign is read on the verbs of the rule and on the anchors only (a negated "log" is too often the
    // grammar of the sentence, "logs aren't needed")
    let flipped = common
        .iter()
        .filter(|c| is_action(c))
        .any(|c| u.neg_concepts.contains(*c) != v.neg_concepts.contains(*c))
        || shared_anchors
            .iter()
            .any(|a| u.neg_anchors.contains(*a) != v.neg_anchors.contains(*a));
    // one negation against none, wherever it stands ("confirmation is not required"), is the other polarity
    let one_against_none = matches!((u.negations, v.negations), (1, 0) | (0, 1));
    if flipped || one_against_none {
        return false;
    }
    let n = common.len();
    let action = common.iter().any(|c| is_action(c));
    let cover = n as f64 / v.concepts.len().max(1) as f64;
    if v.anchors.is_empty() {
        return n >= 3 && action && cover >= 0.5;
    }
    let na = shared_anchors.len();
    na >= 1
        && ((na >= 3 && n >= 1)
            || (na == 2 && n >= 2 && action)
            || (na == 1 && n >= 2 && action && cover >= 0.5)
            || (n >= 3 && cover >= 0.6 && u.negated == v.negated))
}

struct Line<'a> {
    no: usize,
    in_block: bool,
    text: &'a str,
}

/// The repeated rules of `md`, one pair per two lines, in line order.
pub fn find(md: &str) -> Vec<Pair> {
    let block = crate::setup::marker_span(md);
    let mut lines: Vec<Line> = Vec::new();
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
        if let Some(text) = bullet_text(line) {
            lines.push(Line {
                no: i + 1,
                in_block: block.is_some_and(|(s, e)| start >= s && start < e),
                text: text.trim_end(),
            });
        }
    }
    let mut out: Vec<Pair> = Vec::new();
    let mut seen: HashSet<(usize, usize)> = HashSet::new();
    let mut add = |a: (usize, bool, &str), b: (usize, bool, &str)| {
        let (a, b) = if a.0 < b.0 { (a, b) } else { (b, a) };
        if seen.insert((a.0, b.0)) {
            out.push(Pair {
                a: a.0,
                b: b.0,
                a_in_block: a.1,
                b_in_block: b.1,
                a_text: a.2.to_string(),
                b_text: b.2.to_string(),
            });
        }
    };

    // the same wording
    let clauses: Vec<Clause> = lines
        .iter()
        .flat_map(|l| {
            clauses_of(l.text).into_iter().filter_map(|c| {
                let words = words_of(c);
                (words.len() >= MIN_WORDS).then(|| Clause {
                    line: l.no,
                    in_block: l.in_block,
                    words,
                    text: c.to_string(),
                })
            })
        })
        .collect();
    for (i, j) in candidates(&clauses) {
        let (a, b) = (&clauses[i], &clauses[j]);
        if a.line != b.line && !(a.in_block && b.in_block) && similar(&a.words, &b.words) {
            add((a.line, a.in_block, &a.text), (b.line, b.in_block, &b.text));
        }
    }

    // paraphrases of the block's rules
    let block_units: Vec<Vec<String>> = lines
        .iter()
        .filter(|l| l.in_block)
        .map(|l| units(l.text, true))
        .collect();
    let all: Vec<&String> = block_units.iter().flatten().collect();
    let block_lines: Vec<(&Line, Vec<(&str, Unit)>)> = lines
        .iter()
        .filter(|l| l.in_block)
        .zip(&block_units)
        .map(|(l, us)| {
            let kept = us
                .iter()
                .filter(|u| all.iter().filter(|x| **x == *u).count() < 2)
                .map(|u| (u.as_str(), unit_of(u)))
                .collect();
            (l, kept)
        })
        .collect();
    for l in lines.iter().filter(|l| !l.in_block) {
        let mine: Vec<(String, Unit)> = units(l.text, false)
            .into_iter()
            .map(|u| {
                let unit = unit_of(&u);
                (u, unit)
            })
            .collect();
        for (b, theirs) in &block_lines {
            let hit = mine.iter().find_map(|(ut, u)| {
                theirs
                    .iter()
                    .find(|(_, v)| paraphrase(u, v))
                    .map(|(vt, _)| (ut.as_str(), *vt))
            });
            if let Some((ut, vt)) = hit {
                add((l.no, false, ut), (b.no, true, vt));
            }
        }
    }
    out.sort_by_key(|p| (p.a, p.b));
    out
}

/// The finding's detail: line numbers (and where each line sits) with both texts, at most 8 pairs.
pub fn describe(pairs: &[Pair], lang: Lang) -> String {
    let tag = |in_block: bool| {
        if in_block {
            t(lang, " (ctxkit block)", " (блок ctxkit)")
        } else {
            ""
        }
    };
    let clip = |s: &str| -> String {
        let mut c: String = s.chars().take(60).collect();
        if s.chars().count() > 60 {
            c.push('…');
        }
        c
    };
    let mut parts: Vec<String> = pairs
        .iter()
        .take(8)
        .map(|p| {
            format!(
                "{}{}{}{}{}: «{}» ≈ «{}»",
                p.a,
                tag(p.a_in_block),
                t(lang, " and ", " и "),
                p.b,
                tag(p.b_in_block),
                clip(&p.a_text),
                clip(&p.b_text)
            )
        })
        .collect();
    if pairs.len() > 8 {
        parts.push(format!("+{} {}", pairs.len() - 8, t(lang, "more", "ещё")));
    }
    format!("{}{}", t(lang, "lines ", "строки "), parts.join("; "))
}

#[cfg(test)]
mod tests;
