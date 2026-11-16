use super::*;

/// An owner's line, the block lines (0-based bullets of the block) it must be found against, and the ones
/// it may also be found against (two block lines that really overlap: `ctxkit check` for builds is in the
/// line about the logs and in the line about the build slots).
struct Pos {
    text: &'static str,
    want: &'static [usize],
    also: &'static [usize],
}

const fn pos(text: &'static str, want: &'static [usize], also: &'static [usize]) -> Pos {
    Pos { text, want, also }
}

/// Paraphrases of the Russian block: the first five are the repeats of the owner's real file the task names.
const POS_RU: &[Pos] = &[
    pos("Основная сессия — **Sonnet**. Советуйся с **advisor (Fable)** до выбора подхода, когда одна и та же ошибка возвращается дважды, и перед тем как объявить задачу готовой.", &[0], &[2]),
    pos("Поиск по коду, греп и чтение документации отправляй в `Explore` (Haiku). Перед сдачей нетривиальной задачи прогоняй `checker` (Opus).", &[1, 2], &[]),
    pos("Мелкую задачу на 1–2 файла делай сам без субагентов.", &[1], &[]),
    pos("Группируй независимые `Read`/`Edit` и шаги браузера (`browser_batch`, `browser_snapshot` с `interactive_only: true`).", &[3], &[]),
    pos("Для сборок, тестов и `typecheck`, когда не нужен полный лог, запускай `ctxkit check <cmd>` (при успехе одна строка `OK (ms)`, при падении — суть ошибки и путь к полному логу).", &[4], &[8]),
    pos("Коммить сам в рабочую ветку (язык коммитов — как в истории; без `Co-Authored-By` и `Generated with`).", &[5], &[]),
    pos("Результаты анализа и отчёты отдавай в чат; файл на диске (`report.md` и т.п.) создавай только по прямой просьбе.", &[7], &[]),
    pos("Спрашивай перед действиями, которые трудно отменить: удаление чужого, `force-push`, релиз.", &[6], &[]),
    pos("Машина общая: не шире 2 параллельных сборок или тестов (`-j2`).", &[8], &[]),
];
const POS_EN: &[Pos] = &[
    pos("Use **Sonnet** for the main session and consult the **advisor** (Fable) before you settle on an approach.", &[0], &[]),
    pos("Send code search, grepping and reading docs to the `Explore` subagent (Haiku).", &[1], &[]),
    pos("Before you report a non-trivial task as done, have the `checker` agent (Opus) review it.", &[2], &[]),
    pos("Group independent `Read` and `Edit` calls into one message.", &[3], &[]),
    pos("Wrap builds, tests and lint in `ctxkit check <cmd>` unless you need the whole log.", &[4], &[8]),
    pos("Never put `Co-Authored-By` or `Generated with` lines into commit messages.", &[5], &[]),
    pos("Save reports in the chat, never as a `report.md` file in the repository root.", &[7], &[]),
    pos("Do small one-file fixes yourself, without subagents.", &[1], &[]),
];
/// The same topics and names with another meaning: none of them repeats a block line.
const NEG_RU: &[&str] = &[
    "`Explore` сам читает CLAUDE.md и правила проекта, повторять их в задаче не нужно.",
    "`checker` (Opus) никогда не правит код, только читает дифф и гоняет тесты.",
    "Субагентам, которые правят код, задавай `model: \"sonnet\"`, никогда `haiku`.",
    "`ctxkit check` пишет полный лог во временную папку и печатает путь при падении.",
    "Не открывай через `Read` бинарные файлы и картинки больше 5 МБ.",
    "Код с обратной косой чертой пиши через `Write`/`Edit`, не через `python -c` или heredoc.",
    "Вместо `grep -r` используй инструмент `Grep`; не делай `cd` в соседние каталоги.",
    "Задачу на 3 и больше файлов отдавай субагенту `general-purpose`.",
    "Делай без спроса: чтение файлов, правки в текущем проекте, тесты и повторные запуски.",
    "Технические решения выбирай сам и не спрашивай «А или Б?».",
    "Временное складывай в `mktemp -d` внутри `$TEMP`, никогда в корень проекта.",
    "Перед тем как объявить задачу готовой, удали временную папку и закрой запущенные процессы.",
    "Ошибку, которая повторилась дважды, сначала воспроизведи тестом.",
    "Логику меняй с тестом: упал, правка, прошёл.",
    "Сообщения коммитов пиши на языке истории репозитория.",
    "Сборки и тесты гоняй в каталоге крейта, не в корне репозитория.",
    "Длинные логи сборки не вставляй в чат целиком, давай суть ошибки.",
    "Браузер и окна — через `glidehand`; сначала прочитай его навык.",
    "Заметки о встречах храни в `docs/notes/` с датой в имени файла.",
    "Отвечай по-русски, код и пути не переводи.",
];
const NEG_EN: &[&str] = &[
    "`Explore` runs on haiku, so never give it a task that edits files.",
    "The `checker` agent (Opus) never edits code; it only reads the diff.",
    "Never `Edit` a file you have not `Read` in this session.",
    "`ctxkit check` keeps the full log in a temp file and prints its path on failure.",
    "Subagents that edit code get `model: sonnet`, never haiku.",
    "Run `git status` before every commit.",
    "After `git push`, open the pull request link it prints.",
    "Use LSP rename instead of search-and-replace across files.",
    "Before you call a task done, delete the temp folder and stop the processes you started.",
    "Write commit messages in the language of the history.",
    "Keep meeting notes in `docs/notes/` with the date in the file name.",
    "A task that touches three or more files goes to a `general-purpose` subagent.",
    "When the same test fails twice, read its log before changing code.",
    "Builds and tests run in the crate folder, not in the repository root.",
];

/// Written by another model that saw only the block lines, not this code (12 paraphrases, 15 lines with
/// another meaning). The first run gave 11 of 12 and 3 false pairs; after that the boilerplate clause, the
/// polarity check and the synonyms `откат`/`destruct`/`поруч` were added (12 of 12, 0), then the sign of
/// negated words for the review's exceptions (11 of 12, 0), so it is not blind any more.
const BLIND_POS_RU: &[Pos] = &[
    pos("Прежде чем утверждать план или лезть сразу в несколько файлов, советуйся с **advisor (fable)**; если одна и та же ошибка выскочила дважды подряд, тоже иди к нему. Основная сессия — **sonnet**.", &[0], &[]),
    pos("Поиск по коду, греп и чтение документации поручай `Explore` (haiku); правку одного файла без изменения логики делай сам.", &[1], &[2]),
    pos("Когда не нужен полный лог, сборки, тесты и `typecheck` гоняй через `ctxkit check <cmd>`.", &[4], &[8]),
    pos("В тексте коммита не должно быть `Co-Authored-By` и `Generated with`: хук ctxkit такой коммит не пропустит.", &[5], &[]),
    pos("Команды, которые не откатить (`git push`, `git reset --hard`, `git branch -D`, `rm -rf`), без моего ОК не запускай: хук ctxkit задаст вопрос.", &[6], &[]),
    pos("Больше двух сборок или тестов одновременно на машине быть не должно, поэтому гоняй их через `ctxkit check`.", &[8], &[4]),
];
const BLIND_POS_EN: &[Pos] = &[
    pos("Searching the repo and reading docs is a job for `Explore` (haiku); tiny single-file edits that don't touch logic you do yourself.", &[1], &[2]),
    pos("Never call a task finished before `checker` (Opus) has looked at it, unless it's a one-file edit with no logic change; the Stop hook will bounce you back once if edits have no `checker` or advisor pass.", &[2], &[]),
    pos("Use `ctxkit check <cmd>` for builds, tests and lint when you don't need the whole log.", &[4], &[8]),
    pos("Don't run destructive stuff (`rm -rf`, `git push`, `git reset --hard`, `git clean -f`, `git branch -D`) without asking the owner first; the ctxkit hook will prompt.", &[6], &[]),
    pos("Don't write reports or notes to `report.md` / `notes.md` in the repo root, post them in chat instead (the ctxkit hook asks).", &[7], &[]),
    pos("At most two builds/tests may run at the same time on this box, so go through `ctxkit check`.", &[8], &[4]),
];
const BLIND_NEG_RU: &[&str] = &[
    "Для поиска одной константы в одном файле используй `Grep` сам, `Explore` (haiku) зови, только когда искать нужно по всему репозиторию.",
    "Вердикт `checker` пересказывай мне коротко: итог и список замечаний, без полного вывода.",
    "Сборки и тесты не запускай из корня монорепозитория, заходи в каталог пакета.",
    "`git push` делай сам после каждого коммита в рабочую ветку, спрашивать не нужно.",
    "Правку одного файла коммить отдельным коммитом, не смешивай её с остальными изменениями.",
    "Если `report.md` уже лежит в проекте и его просил владелец, обновляй его, а не создавай `report2.md`.",
    "Рутину (переименования, форматирование) отдавай haiku, а **sonnet** оставь для задач, где меняется логика.",
    "`Read` и `Edit` вызывай по одному: параллельные правки одного каталога ломают порядок применения.",
];
const BLIND_NEG_EN: &[&str] = &[
    "Use `Explore` (haiku) only for questions that span more than ten files; anything smaller, grep it yourself.",
    "Paste the full `checker` output into the final answer so the owner can audit it.",
    "Never wrap interactive dev servers in `ctxkit check`; start them in a separate terminal tab.",
    "Run `git push` only after the tests pass locally, and never push from a detached HEAD.",
    "Use `Read` and `Edit` instead of shell `cat` and `sed` when touching files.",
    "When the owner asks for a `report.md`, write it in the project root and name the path in chat.",
    "Switch to sonnet for one-file fixes and keep haiku for bulk search only; never let haiku edit code.",
];

/// Exceptions to a block rule and its opposite, found by the review (`checker`) as false pairs of the first
/// version: they name the same commands but say "without confirmation" / "without `ctxkit check`".
const REVIEW_NEG_RU: &[&str] = &[
    "`git push` в свой форк делай без подтверждения владельца.",
    "`git reset --hard` в локальной ветке-черновике делай без подтверждения.",
    "`rm -rf node_modules` и `git clean -fdx` в песочнице — без подтверждения.",
    "`git push --force` в `main` запрещён даже с подтверждением владельца.",
    "Сборки на CI запускай без `ctxkit check`, там нужен полный лог.",
];
const REVIEW_NEG_EN: &[&str] = &[
    "Never ask the owner for confirmation before `git push` to my own fork.",
    "`rm -rf node_modules` in a scratch checkout needs no owner confirmation.",
    "Builds on CI run without `ctxkit check`, the full log is needed there.",
];

struct Score {
    found: usize,
    total: usize,
    false_pairs: Vec<String>,
    missed: Vec<&'static str>,
}

/// One `CLAUDE.md` per language: the owner's section with every line of the set, then the real block.
/// Every pair that is not wanted or allowed counts as false, the owner's own lines against each other too.
fn score(lang: Lang, pos: &[Pos], neg: &[&'static str]) -> Score {
    let block = crate::setup::sample_block(lang);
    let mut md = String::from("# Mine\n\n");
    for p in pos {
        md.push_str(&format!("- {}\n", p.text));
    }
    for n in neg {
        md.push_str(&format!("- {n}\n"));
    }
    md.push('\n');
    md.push_str(&block);
    md.push('\n');
    // 1-based line numbers: owner line k is line 3 + k; block bullets in order
    let block_bullets: Vec<usize> = md
        .lines()
        .enumerate()
        .skip(3 + pos.len() + neg.len())
        .filter(|(_, l)| l.starts_with("- "))
        .map(|(i, _)| i + 1)
        .collect();
    assert_eq!(
        block_bullets.len(),
        9,
        "the block of setup has 9 lines:\n{block}"
    );
    let pairs = find(&md);
    let index = |line: usize| block_bullets.iter().position(|&b| b == line);
    let mut s = Score {
        found: 0,
        total: 0,
        false_pairs: Vec::new(),
        missed: Vec::new(),
    };
    for (k, p) in pos.iter().enumerate() {
        let line = 3 + k;
        for &w in p.want {
            s.total += 1;
            let hit = pairs.iter().any(|x| x.a == line && index(x.b) == Some(w));
            s.found += usize::from(hit);
            if !hit {
                s.missed.push(p.text);
            }
        }
    }
    for x in &pairs {
        let ok = match (x.a.checked_sub(3), index(x.b)) {
            (Some(k), Some(j)) if k < pos.len() => {
                pos[k].want.contains(&j) || pos[k].also.contains(&j)
            }
            _ => false,
        };
        if !ok {
            s.false_pairs
                .push(format!("{}~{}: {} ≈ {}", x.a, x.b, x.a_text, x.b_text));
        }
    }
    s
}

fn report(name: &str, parts: &[(Lang, &[Pos], &[&'static str])]) -> (usize, usize, Vec<String>) {
    let (mut found, mut total, mut false_pairs, mut missed) = (0, 0, Vec::new(), Vec::new());
    let mut negatives = 0;
    for (lang, pos, neg) in parts {
        let s = score(*lang, pos, neg);
        found += s.found;
        total += s.total;
        false_pairs.extend(s.false_pairs);
        missed.extend(s.missed);
        negatives += neg.len();
    }
    eprintln!(
        "{name}: found {found} of {total} repeats, {} false pairs over {negatives} lines with another meaning; missed: {missed:?}",
        false_pairs.len()
    );
    (found, total, false_pairs)
}

#[test]
fn the_corpus_finds_the_paraphrases_and_no_false_pair() {
    let (found, total, false_pairs) = report(
        "corpus",
        &[(Lang::Ru, POS_RU, NEG_RU), (Lang::En, POS_EN, NEG_EN)],
    );
    assert!(total >= 12 && NEG_RU.len() + NEG_EN.len() >= 25);
    assert!(false_pairs.is_empty(), "{false_pairs:#?}");
    assert!(found * 10 >= total * 8, "{found} of {total}");
    // the repeats of the owner's real file, every one of them
    for (k, p) in POS_RU.iter().take(5).enumerate() {
        let s = score(Lang::Ru, &POS_RU[k..=k], &[]);
        assert_eq!(s.found, p.want.len(), "{}", p.text);
    }
}

#[test]
fn exceptions_and_the_opposite_of_a_block_rule_are_not_repeats() {
    let (_, _, false_pairs) = report(
        "review exceptions",
        &[
            (Lang::Ru, POS_RU, REVIEW_NEG_RU),
            (Lang::En, POS_EN, REVIEW_NEG_EN),
        ],
    );
    assert!(false_pairs.is_empty(), "{false_pairs:#?}");
    // the sign of a word: one negation marks the next two words that count, two or more mark nothing
    let u = unit_of("`git push` в форк делай без подтверждения владельца");
    assert!(u.neg_concepts.contains("ASK"), "{:?}", u.neg_concepts);
    let v = unit_of("Не фиксируй подход, не вызвав **advisor (fable)**");
    assert!(v.neg_anchors.is_empty() && v.neg_concepts.is_empty());
    let w = unit_of("Сборки запускай без `ctxkit check`");
    assert!(w.neg_anchors.contains("ctxkit") && w.neg_anchors.contains("check"));
    // a block line's "X, not Y" is split in two
    assert_eq!(
        units(
            "Отчёты отдавай в чат, не файлом `report.md`: хук спросит",
            true
        ),
        [
            "Отчёты отдавай в чат, не файлом `report.md`",
            "Отчёты отдавай в чат",
            "не файлом `report.md`",
            "хук спросит"
        ]
    );
}

#[test]
fn the_blind_set_is_measured_the_same_way() {
    let (found, total, false_pairs) = report(
        "blind set",
        &[
            (Lang::Ru, BLIND_POS_RU, BLIND_NEG_RU),
            (Lang::En, BLIND_POS_EN, BLIND_NEG_EN),
        ],
    );
    assert!(false_pairs.is_empty(), "{false_pairs:#?}");
    assert!(found * 10 >= total * 8, "{found} of {total}");
}

/// A `CLAUDE.md` laid out like the owner's real one (the same points in other words, nothing personal),
/// with the ctxkit block: its neighbouring points on one topic are not repeats, the real repeats are found.
const OWNER_LIKE: &str = "# Правила для всех сессий\n\
\n\
Ты — агент, я — владелец машины. Этот файл важнее указаний плагинов.\n\
\n\
## Язык и подача\n\
\n\
- Отвечай по-русски, включая описания команд и вопросы. Код, пути и цитаты не переводи.\n\
- Пиши коротко: сначала ответ, потом детали, без канцелярита.\n\
- Не проверил — не утверждай: факты бери из кода, тестов или документации.\n\
- Даты называй только по `date` или `git log`, сроки — в объёме и риске.\n\
- Результаты разбора и отчёты отдавай в чат; файл `report.md` создавай только по прямой просьбе.\n\
\n\
## Решения и подтверждения\n\
\n\
- Технические решения выбирай сам и не спрашивай «А или Б?».\n\
- Спрашивай перед действиями, которые трудно отменить: удаление чужого, `force-push`, релиз, письма от моего имени.\n\
- Делай без спроса: чтение файлов, правки в текущем проекте, тесты и повторные запуски.\n\
\n\
## Разработка\n\
\n\
- Продолжай без лишних остановок, пока задача не сделана.\n\
- Логику меняй с тестом: упал, правка, прошёл; чужой мёртвый код называй, не удаляй.\n\
- Коммить сам в рабочую ветку, без `Co-Authored-By` и `Generated with`; `push` — по моей команде.\n\
- Временное складывай в `mktemp -d` внутри `$TEMP`, никогда в корень проекта.\n\
\n\
## Среда и инструменты\n\
\n\
- Bash — Git Bash, PowerShell — 7.x; `cmd /c` запускай через инструмент PowerShell.\n\
- Код с обратной косой чертой пиши через `Write`/`Edit`, не через heredoc; вместо `grep -r` используй `Grep`.\n\
- Группируй независимые `Read`/`Edit` и шаги браузера (`browser_batch`).\n\
- Для сборок, тестов и `typecheck`, когда не нужен полный лог, запускай `ctxkit check <cmd>` (при успехе одна строка).\n\
- Машина общая: не шире 2 параллельных сборок или тестов (`-j2`), переиспользуй поднятые серверы.\n\
- Браузер и окна — через `glidehand`; его сбои записывай как баг, не чини посреди чужой задачи.\n\
\n";

#[test]
fn an_owner_like_file_gives_only_its_real_repeats() {
    let md = format!("{OWNER_LIKE}{}\n", crate::setup::sample_block(Lang::Ru));
    let line_of = |needle: &str| md.lines().position(|l| l.contains(needle)).unwrap() + 1;
    let block = |needle: &str| {
        let start = md.find("<!-- ctxkit:start").unwrap();
        md[start..]
            .lines()
            .position(|l| l.contains(needle))
            .unwrap()
            + md[..start].lines().count()
            + 1
    };
    let got: Vec<(usize, usize)> = find(&md).iter().map(|p| (p.a, p.b)).collect();
    let want = vec![
        (line_of("отчёты отдавай в чат"), block("Отчёты и заметки")),
        (line_of("трудно отменить"), block("Необратимое")),
        (line_of("Коммить сам"), block("В сообщениях коммитов")),
        (
            line_of("Группируй независимые"),
            block("Группируй независимые"),
        ),
        (line_of("Для сборок, тестов"), block("Для сборок, тестов")),
        (
            line_of("Для сборок, тестов"),
            block("Сборки и тесты запускай"),
        ),
        (line_of("Машина общая"), block("Сборки и тесты запускай")),
    ];
    let mut want = want;
    want.sort();
    assert_eq!(got, want, "{:#?}", find(&md));
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
    assert!(p[0].a_text.contains("full test suite") && p[0].b_text.contains("full test suite"));
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
}

#[test]
fn prefix_filtering_keeps_every_pair_the_full_comparison_finds() {
    // near copies of the corpus lines (a word dropped, a word added) next to the lines themselves
    let mut texts: Vec<String> = Vec::new();
    for t in POS_RU
        .iter()
        .map(|p| p.text)
        .chain(NEG_RU.iter().copied())
        .chain(NEG_EN.iter().copied())
    {
        let words: Vec<&str> = t.split_whitespace().collect();
        texts.push(t.to_string());
        texts.push(words[1..].join(" "));
        texts.push(format!("{t} extra"));
        texts.push(words[..words.len().saturating_sub(2)].join(" "));
    }
    let clauses: Vec<Clause> = texts
        .iter()
        .enumerate()
        .map(|(k, t)| Clause {
            line: k,
            in_block: false,
            words: words_of(t),
            text: t.clone(),
        })
        .filter(|c| c.words.len() >= MIN_WORDS)
        .collect();
    let fast: HashSet<(usize, usize)> = candidates(&clauses).into_iter().collect();
    let mut similar_pairs = 0;
    for i in 0..clauses.len() {
        for j in i + 1..clauses.len() {
            if similar(&clauses[i].words, &clauses[j].words) {
                similar_pairs += 1;
                assert!(
                    fast.contains(&(i, j)),
                    "{} / {}",
                    clauses[i].text,
                    clauses[j].text
                );
            }
        }
    }
    assert!(
        similar_pairs > 50,
        "the test has pairs to lose: {similar_pairs}"
    );
}

#[test]
fn the_pieces_of_the_paraphrase_test() {
    // an owner's line: its sentences, then their clauses; a block line: its clauses; never split in `code`
    assert_eq!(
        units("Пиши `report.md` сам. Потом: проверь; всё", false),
        [
            "Пиши `report.md` сам",
            "Потом: проверь; всё",
            "Потом",
            "проверь",
            "всё"
        ]
    );
    assert_eq!(
        units("Пиши `a; b` сам. Потом: проверь; всё", true),
        ["Пиши `a; b` сам", "Потом", "проверь", "всё"]
    );
    // stems and synonym groups, both languages
    assert_eq!(
        stem("независимые"),
        "независ".chars().take(6).collect::<String>()
    );
    assert_eq!(concept("Спрашивай".to_lowercase().as_str()), "ASK");
    assert_eq!(concept("confirmation"), "ASK");
    assert_eq!(concept("логики"), stem("логики"), "logic is not a log");
    assert_eq!(concept("логи"), "LOG");
    assert_eq!(concept("одновременных"), "PARALLEL");
    assert_eq!(concept("двух"), "TWO");
    // anchors: code and bold spans, model names anywhere, case folded
    let u = unit_of("Основная сессия — **Sonnet**, `Read`/`Edit` и Opus, не `x`");
    for a in ["sonnet", "read", "edit", "opus"] {
        assert!(u.anchors.contains(a), "{a}: {:?}", u.anchors);
    }
    assert!(!u.anchors.contains("x"), "one letter is not an anchor");
    assert!(u.concepts.contains("MAIN") && u.concepts.contains("SESSION"));
    assert!(u.negated);
    // the tiers: two shared anchors need an action, one anchor needs half of the clause
    let v = unit_of("Не объявляй задачу готовой без `checker` (Opus)");
    assert!(paraphrase(
        &unit_of("Перед сдачей задачи прогоняй `checker` (Opus)"),
        &v
    ));
    assert!(!paraphrase(
        &unit_of("`checker` (Opus) не правит код и задачу не трогает"),
        &v
    ));
    // a clause without anchors: three shared concepts with an action
    let w = unit_of("правку одного файла без изменения логики делай сам");
    assert!(paraphrase(
        &unit_of("Мелкую задачу на 1–2 файла делай сам"),
        &w
    ));
    assert!(!paraphrase(
        &unit_of("Правки одного файла коммить отдельно"),
        &w
    ));
}

#[test]
fn a_big_file_is_checked_fast_and_a_planted_repeat_is_still_found() {
    let block = crate::setup::sample_block(Lang::Ru);
    let mut md = String::from("# Mine\n\n");
    for i in 0..2000 {
        md.push_str(&format!(
            "- Rule number {i}: keep the module{i} tidy, test feature{} and document thing{} well.\n",
            i % 97,
            i * 7
        ));
    }
    md.push_str("- Мелкую задачу на 1–2 файла делай сам без субагентов.\n\n");
    md.push_str(&block);
    let t0 = std::time::Instant::now();
    let pairs = find(&md);
    let took = t0.elapsed();
    eprintln!("2000 lines + block: {} pairs in {took:?}", pairs.len());
    assert!(
        pairs.iter().any(|p| p.a == 2003 && p.b_in_block),
        "{:?}",
        pairs.iter().take(3).collect::<Vec<_>>()
    );
    // generous for a debug build on a shared machine; the release figure is in README
    assert!(took.as_secs() < 20, "{took:?}");
}

#[test]
fn doctor_reports_a_warning_with_both_lines_and_keeps_the_size_check_as_it_was() {
    let d = std::env::temp_dir().join(format!("ctxkit_dupes_doctor_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    let md = format!("{OWNER_LIKE}{}\n", crate::setup::sample_block(Lang::Ru));
    std::fs::write(d.join("CLAUDE.md"), &md).unwrap();
    let v = crate::doctor::diagnose(&d, crate::Lang::En);
    let dup = v
        .iter()
        .find(|x| x.id == "rules_duplicate")
        .expect("finding");
    assert_eq!(dup.severity, "warn");
    let detail = dup.detail.clone().unwrap();
    let group = md
        .lines()
        .position(|l| l.contains("Группируй независимые `Read`/`Edit` и шаги"))
        .unwrap()
        + 1;
    assert!(detail.contains(&format!("{group} and ")), "{detail}");
    assert!(
        detail.contains("ctxkit block") && detail.contains(" ≈ "),
        "{detail}"
    );
    let fix = dup.fix.unwrap();
    assert!(
        fix.contains("one place") && fix.contains("ctxkit.json") && fix.contains("rules"),
        "{fix}"
    );
    assert!(
        v.iter().all(|x| x.id != "claude_md_size"),
        "short file: no size warning"
    );
    let ru = crate::doctor::diagnose(&d, crate::Lang::Ru);
    let ru = ru.iter().find(|x| x.id == "rules_duplicate").unwrap();
    assert!(ru
        .fix
        .is_some_and(|f| f.contains("одно место") && f.contains("ctxkit.json")));
    assert!(ru
        .detail
        .as_deref()
        .is_some_and(|f| f.contains("блок ctxkit")));
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
