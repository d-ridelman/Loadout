//! Property tests of the write promise: whatever the formatting of a config around the flag (comments, blank lines,
//! trailing spaces, CRLF, tab or wide indents, a BOM), a toggle changes only the flag's value, and both a rollback
//! and the opposite toggle bring the file back byte for byte. The fixtures are copied to a temporary directory.

use loadout_core::model::{Client, Kind, State};
use loadout_core::write::{self, Intent};
use proptest::prelude::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static N: AtomicU32 = AtomicU32::new(0);
const ML: &str = "R2";

struct Env {
    home: PathBuf,
    store: PathBuf,
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.home.parent().unwrap());
    }
}

fn copy_tree(from: &Path, to: &Path, home: &str) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if src.is_dir() {
            copy_tree(&src, &dst, home);
        } else {
            let text = fs::read_to_string(&src)
                .unwrap()
                .replace("{HOME_UPPER}", &home.to_uppercase())
                .replace("{HOME}", home);
            fs::write(&dst, text).unwrap();
        }
    }
}

fn env() -> Env {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/home");
    let top = std::env::temp_dir().join(format!(
        "loadout-prop-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&top);
    let home = top.join("home");
    copy_tree(&root, &home, &home.to_string_lossy().replace('\\', "/"));
    Env {
        store: top.join("backups"),
        home,
    }
}

/// One change of formatting that keeps the meaning: where (a line number, wrapped) and what.
#[derive(Debug, Clone)]
enum Touch {
    Blank(usize),
    Comment(usize),
    Trailing(usize),
}

#[derive(Debug, Clone)]
struct Style {
    touches: Vec<Touch>,
    crlf: bool,
    bom: bool,
    /// 0: as is, 1: tabs, 2: four spaces per level (JSON only)
    indent: u8,
}

fn style() -> impl Strategy<Value = Style> {
    let touch = prop_oneof![
        (0usize..64).prop_map(Touch::Blank),
        (0usize..64).prop_map(Touch::Comment),
        (0usize..64).prop_map(Touch::Trailing),
    ];
    (
        proptest::collection::vec(touch, 0..6),
        any::<bool>(),
        any::<bool>(),
        0u8..3,
    )
        .prop_map(|(touches, crlf, bom, indent)| Style {
            touches,
            crlf,
            bom,
            indent,
        })
}

/// The same config in another dress. `toml`: comments are allowed; JSON gets no comments, only whitespace.
fn restyle(text: &str, s: &Style, toml: bool) -> String {
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    if !toml && s.indent > 0 {
        let unit = if s.indent == 1 { "\t" } else { "    " };
        for l in &mut lines {
            let lead = l.len() - l.trim_start_matches(' ').len();
            *l = format!("{}{}", unit.repeat(lead / 2), &l[lead..]);
        }
    }
    for t in &s.touches {
        let n = lines.len();
        match *t {
            Touch::Blank(i) => lines.insert(i % (n + 1), String::new()),
            Touch::Comment(i) if toml => lines.insert(i % (n + 1), "# kept by the user".into()),
            Touch::Comment(i) => lines.insert(i % (n + 1), String::new()),
            Touch::Trailing(i) => lines[i % n].push_str("  "),
        }
    }
    let nl = if s.crlf { "\r\n" } else { "\n" };
    let body = lines.join(nl) + nl;
    if s.bom {
        format!("\u{feff}{body}")
    } else {
        body
    }
}

/// The only place where the two texts differ: the common prefix and suffix are dropped.
fn middle(a: &str, b: &str) -> (String, String) {
    let pre = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
    let suf = a
        .bytes()
        .rev()
        .zip(b.bytes().rev())
        .take_while(|(x, y)| x == y)
        .count();
    let suf = suf.min(a.len() - pre).min(b.len() - pre);
    (
        a[pre..a.len() - suf].to_owned(),
        b[pre..b.len() - suf].to_owned(),
    )
}

fn find(home: &Path, client: Client, name: &str) -> Option<(String, State)> {
    loadout_core::scan(home)
        .entities
        .into_iter()
        .find(|e| e.client == client && e.kind == Kind::Plugin && e.name == name)
        .map(|e| (e.id, e.state))
}

fn toggle(e: &Env, id: &str, enable: bool) -> String {
    let i = Intent::Toggle {
        entity: id.to_owned(),
        enable,
    };
    let p = write::plan(&e.home, None, &i).expect("plan");
    write::apply(&e.home, &e.store, &i, &p.base_sha, ML)
        .expect("apply")
        .op
}

/// Toggle off, roll back, toggle off and on again: every way back ends in the very bytes we started with.
fn round_trip(
    rel: &str,
    client: Client,
    name: &str,
    s: &Style,
    toml: bool,
) -> Result<(), TestCaseError> {
    let e = env();
    let path = e.home.join(rel);
    let original = restyle(&fs::read_to_string(&path).unwrap(), s, toml);
    fs::write(&path, &original).unwrap();

    let (id, state) = find(&e.home, client, name).ok_or_else(|| {
        TestCaseError::fail(format!("{name} is not recognised in a restyled {rel}"))
    })?;
    prop_assert_eq!(state, State::On, "{} reads as on", name);

    let op = toggle(&e, &id, false);
    let after = fs::read_to_string(&path).unwrap();
    prop_assert_eq!(
        middle(&original, &after),
        ("tru".to_owned(), "fals".to_owned()),
        "the toggle touched nothing but the flag"
    );
    prop_assert_eq!(find(&e.home, client, name).map(|x| x.1), Some(State::Off));

    write::rollback(&e.home, &e.store, &op, ML).map_err(TestCaseError::fail)?;
    prop_assert_eq!(
        fs::read_to_string(&path).unwrap(),
        original.clone(),
        "rollback is byte for byte"
    );

    toggle(&e, &id, false);
    toggle(&e, &id, true);
    prop_assert_eq!(
        fs::read_to_string(&path).unwrap(),
        original,
        "off and on again is byte for byte"
    );
    Ok(())
}

/// An OpenCode config in JSONC around one MCP server: the generation, where the flag is (or that it is absent),
/// trailing commas, `//` comments on their own lines and at line ends, CRLF and a BOM.
#[derive(Debug, Clone)]
struct Oc {
    v2: bool,
    /// `None`: no flag key, the server is on by default; `Some(true)`: the flag is the first key, `Some(false)`: the last
    flag_first: Option<bool>,
    trailing: bool,
    comments: Vec<(usize, bool)>,
    crlf: bool,
    bom: bool,
}

fn oc() -> impl Strategy<Value = Oc> {
    (
        any::<bool>(),
        proptest::option::of(any::<bool>()),
        any::<bool>(),
        proptest::collection::vec((0usize..64, any::<bool>()), 0..5),
        any::<bool>(),
        any::<bool>(),
    )
        .prop_map(|(v2, flag_first, trailing, comments, crlf, bom)| Oc {
            v2,
            flag_first,
            trailing,
            comments,
            crlf,
            bom,
        })
}

fn oc_text(o: &Oc) -> String {
    let t = if o.trailing { "," } else { "" };
    let flag = if o.v2 {
        "\"disabled\": false"
    } else {
        "\"enabled\": true"
    };
    let mut keys = vec![
        "\"type\": \"local\"".to_owned(),
        "\"command\": [\"npx\", \"-y\", \"demo-mcp\"]".to_owned(),
        "\"environment\": { \"TOKEN\": \"x\" }".to_owned(),
    ];
    match o.flag_first {
        Some(true) => keys.insert(0, flag.to_owned()),
        Some(false) => keys.push(flag.to_owned()),
        None => {}
    }
    let pad = if o.v2 { "        " } else { "      " };
    let n = keys.len();
    let body: Vec<String> = keys
        .into_iter()
        .enumerate()
        .map(|(i, k)| format!("{pad}{k}{}", if i + 1 < n { "," } else { t }))
        .collect();
    let mut lines = vec!["{".to_owned(), "  \"mcp\": {".to_owned()];
    if o.v2 {
        lines.push("    \"servers\": {".into());
    }
    lines.push(format!("{}\"demo\": {{", &pad[2..]));
    lines.extend(body);
    lines.push(format!("{}}}{t}", &pad[2..]));
    if o.v2 {
        lines.push(format!("    }}{t}"));
    }
    lines.push(format!("  }}{t}"));
    lines.push("}".into());
    for &(i, at_end) in &o.comments {
        let n = lines.len();
        if at_end {
            lines[i % n].push_str(" // kept by the user");
        } else {
            lines.insert(i % (n + 1), "  // kept by the user".into());
        }
    }
    let nl = if o.crlf { "\r\n" } else { "\n" };
    let body = lines.join(nl) + nl;
    if o.bom {
        format!("\u{feff}{body}")
    } else {
        body
    }
}

fn mcp_state(home: &Path, name: &str) -> Option<(String, State)> {
    loadout_core::scan(home)
        .entities
        .into_iter()
        .find(|e| e.client == Client::OpenCode && e.kind == Kind::Mcp && e.name == name)
        .map(|e| (e.id, e.state))
}

fn opencode_round_trip(o: &Oc) -> Result<(), TestCaseError> {
    let e = env();
    let path = e.home.join(".config/opencode/opencode.jsonc");
    let original = oc_text(o);
    fs::write(&path, &original).unwrap();
    let (id, state) = mcp_state(&e.home, "demo")
        .ok_or_else(|| TestCaseError::fail(format!("demo is not recognised in {original:?}")))?;
    prop_assert_eq!(state, State::On);

    let op = toggle(&e, &id, false);
    let after = fs::read_to_string(&path).unwrap();
    let (gone, added) = middle(&original, &after);
    match (o.flag_first, o.v2) {
        (Some(_), true) => prop_assert_eq!((gone, added), ("fals".to_owned(), "tru".to_owned())),
        (Some(_), false) => prop_assert_eq!((gone, added), ("tru".to_owned(), "fals".to_owned())),
        // no flag: the key is only inserted, nothing else moves
        (None, v2) => prop_assert!(
            gone.is_empty()
                && added.contains(if v2 {
                    "\"disabled\": true"
                } else {
                    "\"enabled\": false"
                }),
            "{:?} → {:?}",
            original,
            after
        ),
    }
    prop_assert_eq!(mcp_state(&e.home, "demo").map(|x| x.1), Some(State::Off));

    write::rollback(&e.home, &e.store, &op, ML).map_err(TestCaseError::fail)?;
    prop_assert_eq!(
        fs::read_to_string(&path).unwrap(),
        original.clone(),
        "rollback is byte for byte"
    );

    toggle(&e, &id, false);
    toggle(&e, &id, true);
    let back = fs::read_to_string(&path).unwrap();
    if o.flag_first.is_some() {
        prop_assert_eq!(back, original, "off and on again is byte for byte");
    } else {
        // the inserted key stays with the "on" value
        prop_assert!(middle(&original, &back).0.is_empty(), "{:?}", back);
        prop_assert_eq!(mcp_state(&e.home, "demo").map(|x| x.1), Some(State::On));
    }
    Ok(())
}

proptest! {
    // each case copies the fixture home: keep the count modest so `cargo test` stays fast
    #![proptest_config(ProptestConfig::with_cases(40))]

    #[test]
    fn opencode_jsonc_toggle_and_rollback_keep_every_byte(o in oc()) {
        opencode_round_trip(&o)?;
    }

    #[test]
    fn codex_toml_toggle_and_rollback_keep_every_byte(s in style()) {
        round_trip(".codex/config.toml", Client::Codex, "p1@bundled", &s, true)?;
    }

    #[test]
    fn claude_json_toggle_and_rollback_keep_every_byte(s in style()) {
        round_trip(".claude/settings.json", Client::ClaudeCode, "alpha@mp", &s, false)?;
    }
}
