/**
 * Interface language: Russian or English. A string is written as a pair where it appears: `t('русский', 'english')`;
 * with substitutions, as template strings on both sides: `t(`Файлов: ${n}`, `Files: ${n}`)`.
 * The language is one per process (the window and main each hold their own copy) and changes via `setLang`: the window then
 * redraws entirely (see `key` at the root in App.tsx), and main restarts the core with `--lang`.
 */
export type Lang = 'ru' | 'en'

let current: Lang = 'ru'

export const getLang = (): Lang => current
export const setLang = (l: Lang): void => {
  current = l
}
export const isLang = (v: unknown): v is Lang => v === 'ru' || v === 'en'
/** Default language: a Russian system locale gives Russian, any other gives English. */
export const langFromLocale = (locale: string): Lang => (locale.toLowerCase().startsWith('ru') ? 'ru' : 'en')

export const t = (ru: string, en: string): string => (current === 'en' ? en : ru)

/** Number inflection: Russian has three forms (1, 2-4, 5+), English two (1, the rest). */
export function plural(n: number, ru: readonly [string, string, string], en: readonly [string, string]): string {
  if (current === 'en') return n === 1 ? en[0] : en[1]
  const a = Math.abs(n) % 100
  const b = a % 10
  return a > 10 && a < 20 ? ru[2] : b === 1 ? ru[0] : b > 1 && b < 5 ? ru[1] : ru[2]
}
