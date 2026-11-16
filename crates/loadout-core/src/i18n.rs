//! Language of the core's messages (errors, plan notes, the words "enabled/disabled", findings).
//!
//! There is one language per process, set once at startup (`loadout serve --lang ru|en`, `ru` by default);
//! it is not switched in tests: tests share the process. A string is written as a pair at the place where it appears:
//! `tr!("<ru text>", "<en text>")` or with substitutions `tr!("<ru {x}>", "<en {x}>")` (captured from the environment, as in `format!`).

use std::sync::atomic::{AtomicBool, Ordering};

static EN: AtomicBool = AtomicBool::new(false);

/// Message language choice: `en` is English, anything else is Russian.
pub fn set_lang(lang: &str) {
    EN.store(lang == "en", Ordering::Relaxed);
}

pub fn is_en() -> bool {
    EN.load(Ordering::Relaxed)
}

/// A message in the process language. Returns `String`; the `{name}` placeholders are taken from the environment, as in `format!`.
#[macro_export]
macro_rules! tr {
    ($ru:literal, $en:literal $(, $arg:expr)* $(,)?) => {{
        #[allow(clippy::useless_format)]
        let s: String = if $crate::i18n::is_en() {
            format!($en $(, $arg)*)
        } else {
            format!($ru $(, $arg)*)
        };
        s
    }};
}

#[cfg(test)]
mod tests {
    #[test]
    fn default_is_russian_and_args_are_substituted() {
        let n = 3;
        assert_eq!(tr!("файлов: {n}", "files: {n}"), "файлов: 3");
        assert_eq!(tr!("нет", "none"), "нет");
        assert_eq!(tr!("{} из {}", "{} of {}", 1, 2), "1 из 2");
    }
}
