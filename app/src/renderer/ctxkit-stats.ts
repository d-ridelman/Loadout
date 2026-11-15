import type { CtxkitReport, DayStats } from '../shared/model'

/** Итоги по периоду. Только арифметика над счётчиками ctxkit: «сэкономленных токенов» здесь нет, базовой линии «до» у отчёта нет. */
export interface Summary {
  days: number
  mainTurns: number
  /** Доля ходов основной сессии на Sonnet и Haiku (дешёвые модели), 0..1; `null`, если ходов не было. */
  cheapShare: number | null
  /** Доля ходов на Opus и Fable. */
  expensiveShare: number | null
  subTurns: number
  /** Доля ходов субагентов среди всех. */
  subShare: number | null
  advisorCalls: number
  /** Вызовы субагентов по имени, частые первыми. */
  agents: [string, number][]
  toolResultChars: number
  readChars: number
  shellInspectChars: number
  readBlocked: number
  checkCalls: number
  checkChars: number
}

const share = (n: number, total: number): number | null => (total > 0 ? n / total : null)

export function summarize(r: CtxkitReport): Summary {
  const list = Object.values(r.days)
  const sum = (f: (d: DayStats) => number): number => list.reduce((s, d) => s + f(d), 0)
  const mainTurns = sum((d) => d.mainTurns.sonnet + d.mainTurns.haiku + d.mainTurns.opusFable + d.mainTurns.other)
  const subTurns = sum((d) => d.subTurns)
  const agents = new Map<string, number>()
  for (const d of list) for (const [k, n] of Object.entries(d.agentCalls)) agents.set(k, (agents.get(k) ?? 0) + n)
  return {
    days: list.length,
    mainTurns,
    cheapShare: share(sum((d) => d.mainTurns.sonnet + d.mainTurns.haiku), mainTurns),
    expensiveShare: share(sum((d) => d.mainTurns.opusFable), mainTurns),
    subTurns,
    subShare: share(subTurns, mainTurns + subTurns),
    advisorCalls: sum((d) => d.advisorCalls),
    agents: [...agents.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    toolResultChars: sum((d) => d.toolResultChars),
    readChars: sum((d) => d.readChars),
    shellInspectChars: sum((d) => d.shellInspectChars),
    readBlocked: sum((d) => d.readBlocked),
    checkCalls: sum((d) => d.checkCalls),
    checkChars: sum((d) => d.checkChars),
  }
}

export const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(0)} %`)

/** Объём в знаках человеческим числом: 1 234 567 → «1,2 М». */
export function chars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} М`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)} К`
  return String(n)
}

/** Дни от новых к старым. */
export function daysDesc(r: CtxkitReport): [string, DayStats][] {
  return Object.entries(r.days).sort((a, b) => b[0].localeCompare(a[0]))
}

/** Сегменты столбика ходов основной сессии по моделям; ширина в долях от суммы дня. */
export function segments(d: DayStats): { key: 'sonnet' | 'haiku' | 'opusFable' | 'other'; label: string; n: number; w: number }[] {
  const m = d.mainTurns
  const total = m.sonnet + m.haiku + m.opusFable + m.other
  const all = [
    { key: 'sonnet' as const, label: 'Sonnet', n: m.sonnet },
    { key: 'haiku' as const, label: 'Haiku', n: m.haiku },
    { key: 'opusFable' as const, label: 'Opus/Fable', n: m.opusFable },
    { key: 'other' as const, label: 'другие', n: m.other },
  ]
  return all.filter((s) => s.n > 0).map((s) => ({ ...s, w: total > 0 ? s.n / total : 0 }))
}
