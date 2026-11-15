/**
 * Язык интерфейса: русский или английский. Строка пишется парой на месте её появления: `t('русский', 'english')`;
 * с подстановками — шаблонными строками с обеих сторон: `t(`Файлов: ${n}`, `Files: ${n}`)`.
 * Язык один на процесс (окно и main держат свою копию) и меняется через `setLang`: окно после этого перерисовывается
 * целиком (см. `key` у корня в App.tsx), а main перезапускает ядро с `--lang`.
 */
export type Lang = 'ru' | 'en'

let current: Lang = 'ru'

export const getLang = (): Lang => current
export const setLang = (l: Lang): void => {
  current = l
}
export const isLang = (v: unknown): v is Lang => v === 'ru' || v === 'en'
/** Язык по умолчанию: русская локаль системы — русский, любая другая — английский. */
export const langFromLocale = (locale: string): Lang => (locale.toLowerCase().startsWith('ru') ? 'ru' : 'en')

export const t = (ru: string, en: string): string => (current === 'en' ? en : ru)

/** Склонение числа: у русского три формы (1, 2–4, 5+), у английского две (1, остальное). */
export function plural(n: number, ru: readonly [string, string, string], en: readonly [string, string]): string {
  if (current === 'en') return n === 1 ? en[0] : en[1]
  const a = Math.abs(n) % 100
  const b = a % 10
  return a > 10 && a < 20 ? ru[2] : b === 1 ? ru[0] : b > 1 && b < 5 ? ru[1] : ru[2]
}
