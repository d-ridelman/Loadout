//! Хранение бэкапов операций (CONCEPT.md §5, «Копии и секреты»). Каталог операции `<мс>-<nn>` держит копию конфига клиента
//! целиком, открытым текстом, поэтому он живёт ограниченно: последние [`KEEP_OPS`] операций и не старше [`KEEP_DAYS`] дней.
//! Всё считается по имени каталога, манифест для этого не читается. Старые каталоги уходят перед новой записью и по команде
//! очистки. Корзина (`trash/`) не трогается: там единственная копия вынесенной записи, это живое состояние, а не история.

use serde::Serialize;
use std::path::Path;

/// Сколько последних операций хранить. Значение дублируется в тексте окна (`app/src/shared/model.ts`), тест сверяет.
pub const KEEP_OPS: usize = 100;
/// Сколько дней хранить операции. То же.
pub const KEEP_DAYS: u64 = 90;
/// Сколько последних операций разбирает журнал: остальные не читаются.
pub const JOURNAL_MAX: usize = 200;

const DAY_MS: u64 = 86_400_000;
/// Файл в каталоге бэкапов: наибольший id удалённой операции. По нему откат отвечает «удалена», а не «не найдена».
const MARK: &str = "pruned";

/// Каталог операции: 13 цифр времени в мс, дефис, 2 цифры счётчика (так называет их `new_op_dir`).
pub(super) fn is_op_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 16
        && b[13] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 13 || c.is_ascii_digit())
}

/// Id операций, новые первыми. Читает только имена каталогов: `trash`, `staging` и файлы отбрасываются.
pub(super) fn op_ids(store: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(store) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| is_op_id(n))
        .collect();
    ids.sort_unstable_by(|a, b| b.cmp(a));
    ids
}

fn id_ms(id: &str) -> u64 {
    id[..13].parse().unwrap_or(0)
}

/// Итог очистки: сколько каталогов операций удалено и сколько осталось.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pruned {
    pub removed: usize,
    pub kept: usize,
}

/// Оставляет первые `keep` операций (новые первыми) не старше [`KEEP_DAYS`] на момент `now`, а также `protect`.
/// Остальное удаляется. Сбой удаления одного каталога не останавливает остальные.
pub(super) fn prune_at(store: &Path, keep: usize, now: u64, protect: &[String]) -> Pruned {
    let (mut removed, mut kept, mut newest_gone) = (0, 0, String::new());
    for (i, id) in op_ids(store).into_iter().enumerate() {
        let fresh = i < keep && now.saturating_sub(id_ms(&id)) <= KEEP_DAYS * DAY_MS;
        if fresh || protect.contains(&id) {
            kept += 1;
        } else if std::fs::remove_dir_all(store.join(&id)).is_ok() {
            removed += 1;
            newest_gone = newest_gone.max(id);
        } else {
            kept += 1;
        }
    }
    if !newest_gone.is_empty() && newest_gone > pruned_mark(store).unwrap_or_default() {
        let _ = std::fs::write(store.join(MARK), newest_gone);
    }
    Pruned { removed, kept }
}

/// Перед новой записью: после неё операций должно быть не больше [`KEEP_OPS`]. Ошибки не мешают самой записи.
pub(super) fn before_write(store: &Path, protect: &[String]) {
    prune_at(store, KEEP_OPS - 1, super::now_ms(), protect);
}

/// Команда очистки: оставляет [`KEEP_OPS`] последних и не старше [`KEEP_DAYS`].
pub fn prune(store: &Path) -> Pruned {
    prune_at(store, KEEP_OPS, super::now_ms(), &[])
}

fn pruned_mark(store: &Path) -> Option<String> {
    std::fs::read_to_string(store.join(MARK))
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| is_op_id(s))
}

/// Операция уже была удалена очисткой (её id не новее последней удалённой).
pub(super) fn was_pruned(store: &Path, id: &str) -> bool {
    is_op_id(id) && pruned_mark(store).is_some_and(|m| id <= m.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("loadout-ret-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("trash")).unwrap();
        std::fs::create_dir_all(d.join("staging")).unwrap();
        std::fs::write(d.join("profiles.json"), "{}").unwrap();
        d
    }

    fn op(d: &Path, ms: u64, n: u32) -> String {
        let id = format!("{ms:013}-{n:02}");
        std::fs::create_dir_all(d.join(&id)).unwrap();
        std::fs::write(d.join(&id).join("before"), "секрет").unwrap();
        id
    }

    /// Текст окна называет те же числа, что хранит ядро.
    #[test]
    fn window_text_uses_the_same_limits() {
        let ts = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/src/shared/backups.ts"),
        )
        .unwrap();
        assert!(ts.contains(&format!("BACKUP_KEEP_OPS = {KEEP_OPS}\n")));
        assert!(ts.contains(&format!("BACKUP_KEEP_DAYS = {KEEP_DAYS}\n")));
    }

    #[test]
    fn ids_are_recognised_by_name_only() {
        assert!(is_op_id("1731700000000-00") && is_op_id("0000000000001-99"));
        for no in [
            "trash",
            "staging",
            "1731700000000",
            "1731700000000-0",
            "x731700000000-00",
            "1731700000000_00",
            "",
        ] {
            assert!(!is_op_id(no), "{no}");
        }
    }

    #[test]
    fn keeps_the_last_n_and_drops_older_than_the_age_limit_but_not_trash_or_profiles() {
        let d = store("keep");
        let now = 200 * DAY_MS;
        // 5 свежих, 3 из них внутри лимита N=3; ещё одна старше 90 дней при свободном месте
        let ids: Vec<String> = (0..5).map(|i| op(&d, now - 1000 + i, 0)).collect();
        let r = prune_at(&d, 3, now, &[]);
        assert_eq!(
            r,
            Pruned {
                removed: 2,
                kept: 3
            }
        );
        assert!(!d.join(&ids[0]).exists() && !d.join(&ids[1]).exists() && d.join(&ids[2]).exists());
        // метка знает самую новую из удалённых
        assert!(was_pruned(&d, &ids[1]) && was_pruned(&d, &ids[0]) && !was_pruned(&d, &ids[2]));
        // по возрасту: одна операция старше 90 дней уходит, даже когда лимит числа не исчерпан
        let old = op(&d, now - 91 * DAY_MS, 0);
        let edge = op(&d, now - 90 * DAY_MS, 0);
        assert_eq!(prune_at(&d, 10, now, &[]).removed, 1);
        assert!(!d.join(&old).exists() && d.join(&edge).exists());
        // корзина, подготовка и профили нетронуты
        assert!(
            d.join("trash").is_dir()
                && d.join("staging").is_dir()
                && d.join("profiles.json").is_file()
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn protected_ops_survive_and_the_mark_never_goes_back() {
        let d = store("protect");
        let now = 300 * DAY_MS;
        let (a, b, c) = (
            op(&d, now - 30, 0),
            op(&d, now - 20, 0),
            op(&d, now - 10, 0),
        );
        let r = prune_at(&d, 1, now, std::slice::from_ref(&a));
        assert_eq!(
            r,
            Pruned {
                removed: 1,
                kept: 2
            }
        );
        assert!(d.join(&a).exists() && !d.join(&b).exists() && d.join(&c).exists());
        assert!(was_pruned(&d, &b) && !was_pruned(&d, &c));
        // второй прогон с более старым удалением метку не уменьшает
        prune_at(&d, 0, now, &[]);
        assert!(was_pruned(&d, &c));
        let _ = std::fs::remove_dir_all(&d);
    }
}
