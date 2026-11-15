// Путь домашнего каталога в тексте ошибки показывается как `~`. Без electron, чтобы тестировалось vitest (tidy.test.ts).

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Заменяет `home` на `~` в произвольном тексте. То же правило, что у `tilde` в ядре (crates/loadout-core/src/lib.rs):
 * регистр букв не важен (Windows), оба вида слэшей (в том числе удвоенные обратные из JSON), а за домашним каталогом
 * должна идти граница: `C:\Users\имя2\x` и `C:\Users\имя.old\x` это другие каталоги и не сворачиваются.
 * Остаток пути не меняется (`~\x` остаётся с обратным слэшем), в отличие от ядра, которое приводит слэши к `/`.
 */
export function tidyHome(text: string, home: string): string {
  const h = home.replaceAll('\\', '/').replace(/\/+$/, '')
  if (h === '') return text
  const body = h.split('/').map(escapeRe).join('[\\\\/]+')
  // граница: дальше не продолжается имя (буква, цифра, `_`, `-`, либо `.` и снова знак имени)
  return text.replace(new RegExp(`${body}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_-])`, 'giu'), '~')
}
