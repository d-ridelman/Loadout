// The home directory path in error text is shown as `~`. No electron, so it can be tested with vitest (tidy.test.ts).

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replaces `home` with `~` in arbitrary text. Same rule as `tilde` in the core (crates/loadout-core/src/lib.rs):
 * case-insensitive (Windows), both kinds of slashes (including doubled backslashes from JSON), and the home directory
 * must be followed by a boundary: `C:\Users\name2\x` and `C:\Users\name.old\x` are other directories and are not collapsed.
 * The rest of the path is unchanged (`~\x` keeps its backslash), unlike the core, which normalizes slashes to `/`.
 */
export function tidyHome(text: string, home: string): string {
  const h = home.replaceAll('\\', '/').replace(/\/+$/, '')
  if (h === '') return text
  const body = h.split('/').map(escapeRe).join('[\\\\/]+')
  // boundary: the name must not continue (a letter, digit, `_`, `-`, or `.` followed by a name character)
  return text.replace(new RegExp(`${body}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_-])`, 'giu'), '~')
}
