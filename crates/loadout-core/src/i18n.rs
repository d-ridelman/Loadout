//! Язык сообщений ядра (ошибки, примечания плана, слова «включено/выключено», находки).
//!
//! Язык один на процесс и задаётся один раз при запуске (`loadout serve --lang ru|en`, по умолчанию `ru`);
//! в тестах он не переключается: тесты делят процесс. Строка пишется парой на месте её появления:
//! `tr!("русский", "english")` или с подстановками `tr!("нет {x}", "no {x}")` (захват из окружения, как в `format!`).

use std::sync::atomic::{AtomicBool, Ordering};

static EN: AtomicBool = AtomicBool::new(false);

/// Выбор языка сообщений: `en` — английский, всё остальное — русский.
pub fn set_lang(lang: &str) {
    EN.store(lang == "en", Ordering::Relaxed);
}

pub fn is_en() -> bool {
    EN.load(Ordering::Relaxed)
}

/// Сообщение на языке процесса. Возвращает `String`; плейсхолдеры `{имя}` берутся из окружения, как в `format!`.
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
