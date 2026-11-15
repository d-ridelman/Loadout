import type { ClientId, Entity } from '../shared/model'
import { CLIENTS } from '../shared/model'

export type Severity = 'error' | 'warn' | 'info'

export interface Finding {
  id: string
  severity: Severity
  title: string
  detail: string
  /** Сущность, к которой ведёт «Показать». */
  entity?: Entity
}

const clientName = (id: ClientId): string => CLIENTS.find((c) => c.id === id)?.name ?? id
const SECRETISH = /token|secret|passw|credential|cookie|auth|key$/i

/** Автоматические находки Доктора. Чистая функция над результатом скана: проверяется без окна. */
export function diagnose(entities: readonly Entity[], warnings: readonly string[]): Finding[] {
  const out: Finding[] = []

  // Несколько записей одного плагина в одной области дают одну находку, а не по одной на запись.
  const seen = new Set<string>()
  for (const e of entities) {
    if (e.state !== 'broken' && e.state !== 'stale') continue
    const once = `${e.state}:${e.client}:${e.kind}:${e.name}`
    if (seen.has(once)) continue
    seen.add(once)
    const broken = e.state === 'broken'
    out.push({
      id: `${e.state}:${e.id}`,
      severity: broken ? 'error' : 'warn',
      title: `${e.name}: ${broken ? 'сломано' : 'расхождение'} в ${clientName(e.client)}`,
      detail: e.note ?? (broken ? 'запись есть, но указывает на отсутствующее' : 'версии расходятся'),
      entity: e,
    })
  }

  // Один и тот же скил или MCP в нескольких областях одного клиента: какая из записей действует, зависит от клиента.
  const byKey = new Map<string, Entity[]>()
  for (const e of entities) {
    if (e.kind !== 'skill' && e.kind !== 'mcp') continue
    const k = `${e.client}|${e.kind}|${e.logicalKey}`
    byKey.set(k, [...(byKey.get(k) ?? []), e])
  }
  for (const [k, list] of byKey) {
    const scopes = [...new Set(list.map((e) => e.scope))]
    const first = list[0]
    if (scopes.length > 1 && first) {
      out.push({
        id: `dup:${k}`,
        severity: 'warn',
        title: `${first.logicalKey}: есть в нескольких областях (${clientName(first.client)})`,
        detail: `области: ${scopes.join(', ')}. Какая запись действует, зависит от клиента.`,
        entity: first,
      })
    }
  }

  // Плагины project/local: флаг включения лежит в настройках проекта, ядро их не читает.
  const unknownByClient = new Map<ClientId, number>()
  for (const e of entities) {
    if (e.kind === 'plugin' && e.state === 'unknown') unknownByClient.set(e.client, (unknownByClient.get(e.client) ?? 0) + 1)
  }
  for (const [client, n] of unknownByClient) {
    out.push({
      id: `unknown:${client}`,
      severity: 'info',
      title: `${clientName(client)}: у ${n} ${plural(n, 'плагина', 'плагина', 'плагинов')} состояние не определено`,
      detail: 'Флаг включения лежит в настройках проекта (project/local), а их Loadout пока не читает.',
    })
  }

  // MCP, у которых в конфиге есть ключи секретов: значения там лежат как есть, Loadout их не показывает.
  for (const e of entities) {
    if (e.kind !== 'mcp') continue
    const keys = [...asStrings(e.detail['envKeys']), ...asStrings(e.detail['headerKeys'])].filter((k) => SECRETISH.test(k))
    if (keys.length > 0) {
      out.push({
        id: `secret:${e.id}`,
        severity: 'info',
        title: `${e.name} (${clientName(e.client)}): в конфиге есть ключи секретов`,
        detail: `Ключи: ${keys.slice(0, 5).join(', ')}. Значения лежат в файле клиента, Loadout их не читает и не показывает.`,
        entity: e,
      })
    }
  }

  warnings.forEach((w, i) =>
    out.push({ id: `warn:${i}`, severity: 'warn', title: 'Предупреждение сканера', detail: w }),
  )

  const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}

/** Русское число: 1 плагина, 2–4 плагина (родительный), 5+ плагинов (после «у»). */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

export function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
