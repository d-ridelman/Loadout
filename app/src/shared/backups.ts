import { t } from './i18n'

/**
 * How many operation backups the core keeps: the last N and not older than D days (`crates/loadout-core/src/write/retention.rs`,
 * `KEEP_OPS` and `KEEP_DAYS`). The numbers here are only for the window text; a core test checks them against Rust.
 */
export const BACKUP_KEEP_OPS = 100
export const BACKUP_KEEP_DAYS = 90

/** Default backup location: Electron's `userData` is named after `name` in package.json (`loadout-app`). For text only; main substitutes the real path in the dialog. */
export const BACKUP_DIR_HINT = '%APPDATA%\\loadout-app\\backups'

/**
 * Plain statement of what the backups contain and where they are. Shown in the write-enable dialog (R1/R2) and in the journal.
 * `dir` is the backup directory as the window will display it.
 */
export function backupNotice(dir: string): string {
  return t(
    `Копии (бэкапы) и корзина хранят конфиги клиентов ЦЕЛИКОМ и открытым текстом, включая значения env у MCP-серверов (ключи, токены). Они лежат в ${dir} и доступны так же, как остальные файлы вашего профиля Windows. Хранятся последние ${BACKUP_KEEP_OPS} операций не старше ${BACKUP_KEEP_DAYS} дней, остальное удаляется перед новой записью и кнопкой «Очистить старые копии» в журнале; корзина сама не чистится. При удалении приложения данные остаются: удалите папку вручную.`,
    `Backups and the trash keep client configs IN FULL and as plain text, including the env values of MCP servers (keys, tokens). They are in ${dir} and are as accessible as the other files of your Windows profile. The last ${BACKUP_KEEP_OPS} operations not older than ${BACKUP_KEEP_DAYS} days are kept; the rest is deleted before a new write and by the “Clean up old copies” button in the journal; the trash is not cleaned by itself. Uninstalling the app leaves the data: delete the folder by hand.`,
  )
}
