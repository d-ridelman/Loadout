//! `loadout scan [--json] [--pretty] [--home ПУТЬ] [--client claude-code|codex]` — только чтение.

use loadout_core::model::{Client, ScanResult};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("scan") {
        eprintln!("использование: loadout scan [--json] [--pretty] [--home ПУТЬ] [--client claude-code|codex]");
        return ExitCode::from(2);
    }
    let (mut json, mut pretty) = (false, false);
    let (mut home, mut client): (Option<PathBuf>, Option<String>) = (None, None);
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--json" => json = true,
            "--pretty" => pretty = true,
            "--home" => home = it.next().map(PathBuf::from),
            "--client" => client = it.next().cloned(),
            other => {
                eprintln!("неизвестный аргумент: {other}");
                return ExitCode::from(2);
            }
        }
    }
    let Some(home) = home.or_else(|| {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
    }) else {
        eprintln!("не удалось определить домашний каталог, укажите --home");
        return ExitCode::from(2);
    };

    let mut res: ScanResult = loadout_core::scan(&home);
    if let Some(want) = client {
        let want = match want.as_str() {
            "claude-code" => Client::ClaudeCode,
            "codex" => Client::Codex,
            other => {
                eprintln!("неизвестный клиент: {other}");
                return ExitCode::from(2);
            }
        };
        res.entities.retain(|e| e.client == want);
    }
    for w in &res.warnings {
        eprintln!("предупреждение: {w}");
    }

    if json {
        let out = if pretty {
            serde_json::to_string_pretty(&res)
        } else {
            serde_json::to_string(&res)
        };
        println!("{}", out.expect("ScanResult сериализуется"));
    } else {
        summary(&res);
    }
    ExitCode::SUCCESS
}

fn summary(res: &ScanResult) {
    let mut table: BTreeMap<(String, String), BTreeMap<String, usize>> = BTreeMap::new();
    for e in &res.entities {
        let key = (to_s(&e.client), to_s(&e.kind));
        *table
            .entry(key)
            .or_default()
            .entry(to_s(&e.state))
            .or_default() += 1;
    }
    for ((client, kind), states) in &table {
        let parts: Vec<String> = states.iter().map(|(s, n)| format!("{s}={n}")).collect();
        println!("{client:<12} {kind:<12} {}", parts.join(" "));
    }
    println!("всего: {}", res.entities.len());
}

fn to_s<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}
