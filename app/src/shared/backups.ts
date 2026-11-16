import { t } from './i18n'

/**
 * Сколько копий операций хранит ядро: последние N и не старше D дней (`crates/loadout-core/src/write/retention.rs`,
 * `KEEP_OPS` и `KEEP_DAYS`). Числа здесь только для текста окна; тест ядра сверяет их с Rust.
 */
export const BACKUP_KEEP_OPS = 100
export const BACKUP_KEEP_DAYS = 90

/** Где лежат копии по умолчанию: `userData` Electron называется по `name` из package.json (`loadout-app`). Для текста; в диалоге main подставляет настоящий путь. */
export const BACKUP_DIR_HINT = '%APPDATA%\\loadout-app\\backups'

/**
 * Прямым текстом о том, что лежит в копиях и где. Показывается в диалоге включения записи (R1/R2) и в журнале.
 * `dir` — каталог копий, как его покажет окно.
 */
export function backupNotice(dir: string): string {
  return t(
    `Копии (бэкапы) и корзина хранят конфиги клиентов ЦЕЛИКОМ и открытым текстом, включая значения env у MCP-серверов (ключи, токены). Они лежат в ${dir} и доступны так же, как остальные файлы вашего профиля Windows. Хранятся последние ${BACKUP_KEEP_OPS} операций не старше ${BACKUP_KEEP_DAYS} дней, остальное удаляется перед новой записью и кнопкой «Очистить старые копии» в журнале; корзина сама не чистится. При удалении приложения данные остаются: удалите папку вручную.`,
    `Backups and the trash keep client configs IN FULL and as plain text, including the env values of MCP servers (keys, tokens). They are in ${dir} and are as accessible as the other files of your Windows profile. The last ${BACKUP_KEEP_OPS} operations not older than ${BACKUP_KEEP_DAYS} days are kept; the rest is deleted before a new write and by the “Clean up old copies” button in the journal; the trash is not cleaned by itself. Uninstalling the app leaves the data: delete the folder by hand.`,
  )
}
