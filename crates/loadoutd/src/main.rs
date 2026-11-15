//! `loadout scan [--json] [--pretty] [--home ПУТЬ] [--client claude-code|claude-desktop|codex|antigravity|deepseek]` — только чтение.

mod serve;

use loadout_core::model::{Client, ScanResult};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

fn home_or_default(home: Option<PathBuf>) -> Option<PathBuf> {
    home.or_else(|| {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
    })
}

fn no_home() -> ExitCode {
    eprintln!(
        "{}",
        loadout_core::tr!(
            "не удалось определить домашний каталог, укажите --home",
            "cannot determine the home directory, pass --home"
        )
    );
    ExitCode::from(2)
}

/// `loadout serve [--home ПУТЬ] [--backups КАТАЛОГ] [--lang ru|en]`: постоянный процесс для окна (JSON-RPC по stdio и сторож файлов).
/// Без `--backups` методы записи (R1) отказывают.
fn serve_main(args: &[String]) -> ExitCode {
    let (mut home, mut backups) = (None, None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--home" => home = it.next().map(PathBuf::from),
            "--backups" => backups = it.next().map(PathBuf::from),
            "--lang" => loadout_core::i18n::set_lang(it.next().map_or("ru", String::as_str)),
            other => {
                eprintln!(
                    "{}",
                    loadout_core::tr!("неизвестный аргумент: {other}", "unknown argument: {other}")
                );
                return ExitCode::from(2);
            }
        }
    }
    let Some(home) = home_or_default(home) else {
        return no_home();
    };
    serve::run(&home, backups);
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("serve") {
        return serve_main(&args[1..]);
    }
    if args.first().map(String::as_str) != Some("scan") {
        eprintln!(
            "{}",
            loadout_core::tr!(
                "использование: loadout scan [--json] [--pretty] [--lang ru|en] [--home ПУТЬ] [--client claude-code|claude-desktop|codex|antigravity|deepseek]",
                "usage: loadout scan [--json] [--pretty] [--lang ru|en] [--home PATH] [--client claude-code|claude-desktop|codex|antigravity|deepseek]"
            )
        );
        eprintln!(
            "{}",
            loadout_core::tr!(
                "             loadout serve [--home ПУТЬ] [--backups КАТАЛОГ] [--lang ru|en]",
                "             loadout serve [--home PATH] [--backups DIR] [--lang ru|en]"
            )
        );
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
            "--lang" => loadout_core::i18n::set_lang(it.next().map_or("ru", String::as_str)),
            other => {
                eprintln!(
                    "{}",
                    loadout_core::tr!("неизвестный аргумент: {other}", "unknown argument: {other}")
                );
                return ExitCode::from(2);
            }
        }
    }
    let Some(home) = home_or_default(home) else {
        return no_home();
    };

    let mut res: ScanResult = loadout_core::scan(&home);
    if let Some(want) = client {
        let Some(want) = Client::from_slug(&want) else {
            eprintln!(
                "{}",
                loadout_core::tr!("неизвестный клиент: {want}", "unknown client: {want}")
            );
            return ExitCode::from(2);
        };
        res.entities.retain(|e| e.client == want);
    }
    for w in &res.warnings {
        eprintln!(
            "{}",
            loadout_core::tr!("предупреждение: {w}", "warning: {w}")
        );
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
    println!(
        "{}",
        loadout_core::tr!("всего: {}", "total: {}", res.entities.len())
    );
}

fn to_s<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}
