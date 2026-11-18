import { t } from '../shared/i18n'
import type { CtxkitDoctor, CtxkitReport, DayStats, SetupOptions } from '../shared/model'
import { MAX_BUILD_SLOTS } from '../shared/model'

/** Totals for the period. Arithmetic over Context Toolkit counters only: there are no "saved tokens" here, the report has no "before" baseline. */
export interface Summary {
  days: number
  mainTurns: number
  /** Share of main-session turns on Sonnet and Haiku (cheap models), 0..1; `null` if there were no turns. */
  cheapShare: number | null
  /** Share of turns on Opus and Fable. */
  expensiveShare: number | null
  subTurns: number
  /** Share of subagent turns among all turns. */
  subShare: number | null
  advisorCalls: number
  /** Subagent calls by name, most frequent first. */
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

export const pct = (v: number | null): string => (v === null ? '—' : t(`${(v * 100).toFixed(0)} %`, `${(v * 100).toFixed(0)}%`))

/** Size in characters as a human-readable number: 1 234 567 → "1,2 М". */
export function chars(n: number): string {
  if (n >= 1_000_000) return t(`${(n / 1_000_000).toFixed(1).replace('.', ',')} М`, `${(n / 1_000_000).toFixed(1)} M`)
  if (n >= 1_000) return t(`${(n / 1_000).toFixed(0)} К`, `${(n / 1_000).toFixed(0)} K`)
  return String(n)
}

/** Days from newest to oldest. */
export function daysDesc(r: CtxkitReport): [string, DayStats][] {
  return Object.entries(r.days).sort((a, b) => b[0].localeCompare(a[0]))
}

/** Segments of the main-session turn bar by model; width as a fraction of the day's total. */
export function segments(d: DayStats): { key: 'sonnet' | 'haiku' | 'opusFable' | 'other'; label: string; n: number; w: number }[] {
  const m = d.mainTurns
  const total = m.sonnet + m.haiku + m.opusFable + m.other
  const all = [
    { key: 'sonnet' as const, label: 'Sonnet', n: m.sonnet },
    { key: 'haiku' as const, label: 'Haiku', n: m.haiku },
    { key: 'opusFable' as const, label: 'Opus/Fable', n: m.opusFable },
    { key: 'other' as const, label: t('другие', 'other'), n: m.other },
  ]
  return all.filter((s) => s.n > 0).map((s) => ({ ...s, w: total > 0 ? s.n / total : 0 }))
}

/**
 * Whether the "no Stop gate" checkbox should be ticked for the current profile state: `true` if Context Toolkit is installed but the gate is not
 * (an info-level `stop_gate` finding), `false` if the gate is there. `null` if it is not installed (a warn-level `hooks`
 * finding) or there are no findings: then the default stays (the gate is installed).
 */
export function stopGateOff(d: CtxkitDoctor): boolean | null {
  const sev = (id: string): string | undefined => d.findings.find((f) => f.id === id)?.severity
  if (sev('hooks') === 'warn') return null
  const g = sev('stop_gate')
  return g === 'ok' ? false : g === 'info' ? true : null
}

/**
 * The "currently enabled: ..." label for the "Protections" block, from the `policies` finding (present only if the policy file exists):
 * `{ text, broken }`, or `null` if there is no file. `policySet` reads the same finding into form checkboxes.
 */
export function policiesNow(d: CtxkitDoctor): { text: string; broken: boolean } | null {
  const f = d.findings.find((x) => x.id === 'policies')
  if (!f) return null
  if (f.severity === 'warn' || f.severity === 'error') return { text: f.message, broken: true }
  return { text: f.detail ?? '', broken: false }
}

export type PolicySet = Pick<SetupOptions, 'commitHygiene' | 'confirmIrreversible' | 'strayFiles' | 'buildSlots' | 'buildSlotsN'>
export const NO_POLICIES: PolicySet = { commitHygiene: false, confirmIrreversible: false, strayFiles: false, buildSlots: false, buildSlotsN: 2 }

/**
 * The policies that are on now, as form checkboxes, from the same `policies` finding (`commit_hygiene, build_slots=3`).
 * No file means none is on; `null` means the file is broken and the state is unknown.
 */
export function policySet(d: CtxkitDoctor): PolicySet | null {
  const now = policiesNow(d)
  if (!now) return NO_POLICIES
  if (now.broken) return null
  const on = new Map(now.text.split(',').map((s) => s.trim().split('=') as [string, string | undefined]))
  const n = Number(on.get('build_slots'))
  return {
    commitHygiene: on.has('commit_hygiene'),
    confirmIrreversible: on.has('confirm_irreversible'),
    strayFiles: on.has('stray_files'),
    buildSlots: on.has('build_slots'),
    // the window allows 1-8 (main refuses more), Context Toolkit up to 64: a larger limit in the file is lowered to 8
    buildSlotsN: Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_BUILD_SLOTS) : 2,
  }
}

/**
 * A tick on a policy checkbox. "Turn on the selected" turns everything unticked off, so leaving "keep" starts from what is
 * on now (nothing gets switched off silently), and leaving "turn all off" starts from nothing.
 */
export function tickPolicy(o: SetupOptions, patch: Partial<PolicySet>, now: PolicySet | null): SetupOptions {
  if (o.policyMode === 'on') return { ...o, ...patch }
  const from = o.policyMode === 'keep' && now ? now : NO_POLICIES
  return { ...o, ...from, ...patch, policyMode: 'on' }
}

/**
 * A doctor fix that is a plain `context-toolkit setup` command, as settings for the "Apply" form; `null` for anything else
 * (prose, or a command with placeholders the person has to choose).
 */
export function fixPatch(fix: string | null): Partial<SetupOptions> | null {
  const m = /^context-toolkit setup((?: --[\w-]+(?: [a-z]+)?)*)$/.exec(fix?.trim() ?? '')
  if (!m) return null
  const patch: Partial<SetupOptions> = {}
  const words = (m[1] ?? '').trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === '--with-rules') patch.withRules = true
    else if (w === '--opencode') patch.opencode = true
    else if (w === '--main-model' && /^(sonnet|opus|haiku)$/.test(words[i + 1] ?? '')) patch.mainModel = words[++i] as SetupOptions['mainModel']
    else if (w === '--effort' && /^(low|medium|high|xhigh)$/.test(words[i + 1] ?? '')) patch.effort = words[++i] as SetupOptions['effort']
    else return null
  }
  return patch
}
