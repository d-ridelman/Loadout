//! Generative masking check: a "canary" is inserted into randomly assembled command lines,
//! and in no case may it reach the output. There are two kinds of canary: a mix of cases with digits
//! and an ordinary lower-case word. There is one exception: the executable name in the command position is shown by design,
//! so no canary is placed there.
//!
//! The generator is deterministic (xorshift with a fixed seed): a failure is reproducible. This is not a proof
//! that there are no bypasses, but a safety net against the return of forms already found by audits.

use loadout_core::mask::{mask_args, mask_line, mask_url};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[(self.next() % items.len() as u64) as usize]
    }
}

const PROGRAMS: [&str; 8] = [
    "node", "python", "curl", "uvx", "npx", "tool", "mysql", "git",
];
const SAFE_ARGS: [&str; 10] = [
    "-y",
    "--lang",
    "ru",
    "--port",
    "8080",
    "C:/tools/a.exe",
    "server.js",
    "mcp",
    "--verbose",
    "2>&1",
];
const FLAGS: [&str; 12] = [
    "--token",
    "--api-key",
    "--password",
    "--auth",
    "-p",
    "-a",
    "--header",
    "-H",
    "--user",
    "--passphrase",
    "-e",
    "--env",
];

fn canary(rng: &mut Rng) -> &'static str {
    if rng.next().is_multiple_of(2) {
        "Qz9kP4xW7vL2mN8"
    } else {
        "hunterpw"
    }
}

/// One random command line with a canary in a random place.
fn build(rng: &mut Rng) -> (String, &'static str) {
    let c = canary(rng);
    let program = rng.pick(&PROGRAMS);
    let mut parts: Vec<String> = vec![program.to_owned()];
    for _ in 0..(rng.next() % 4) {
        parts.push(rng.pick(&SAFE_ARGS).to_owned());
    }
    let secret_form = match rng.next() % 14 {
        0 => format!("{} {c}", rng.pick(&FLAGS)),
        1 => format!("{}={c}", rng.pick(&FLAGS)),
        2 => format!("-H \"Authorization: Bearer {c}\""),
        3 => format!("-H 'X-Api-Key: {c}'"),
        4 => format!("TOKEN={c}"),
        5 => format!("https://user:{c}@host.example/x"),
        6 => format!("https://{c}@host.example/x"),
        7 => format!("https://host.example/{c}-{c}/mcp?key={c}"),
        8 => format!("bash -c \"tool --token {c}\""),
        9 => format!("sh -c \"bash -c 'tool --api-key={c}'\""),
        10 => format!("--config {{\"token\":\"{c}\"}}"),
        11 => format!("2>/dev/null {c}"),
        12 => format!("-p{c}"),
        _ => format!("Server=h;Password={c}"),
    };
    parts.push(secret_form);
    for _ in 0..(rng.next() % 3) {
        parts.push(rng.pick(&SAFE_ARGS).to_owned());
    }
    (parts.join(" "), c)
}

#[test]
fn canary_never_reaches_output() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for i in 0..20_000 {
        let (line, c) = build(&mut rng);
        let out = mask_line(&line);
        assert!(!out.contains(c), "case {i}: {line:?} -> {out:?}");
    }
}

#[test]
fn canary_in_url_never_reaches_output() {
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    for i in 0..5_000 {
        let c = canary(&mut rng);
        let url = match rng.next() % 6 {
            0 => format!("https://u:{c}@h.example/a"),
            1 => format!("https://{c}@h.example/a"),
            2 => format!("https://h.example/a?token={c}"),
            3 => format!("https://h.example/a#{c}"),
            4 => format!("https://h.example:{c}/a"),
            _ => format!("{c}://h.example/a"),
        };
        let out = mask_url(&url);
        assert!(!out.contains(c), "case {i}: {url:?} -> {out:?}");
        let args = mask_args(std::slice::from_ref(&url)).join(" ");
        assert!(
            !args.contains(c),
            "case {i} (as an argument): {url:?} -> {args:?}"
        );
    }
}
