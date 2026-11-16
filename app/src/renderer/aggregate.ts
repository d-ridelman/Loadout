import { getLang, t } from '../shared/i18n'
import type { ClientId, Entity, EntityState, Kind } from '../shared/model'

/**
 * Matrix row groups. Plugins and MCP servers are split into separate rows and filters (more convenient: they have different
 * actions and a different nature); entries of one type with the same name in different clients are still merged into one row.
 */
export type Group = 'plugin' | 'mcp' | 'connector' | 'skill' | 'agent' | 'command' | 'hook' | 'marketplace'

/** Labels are getters: `t()` is evaluated on access (during render), not when the module is imported. */
export const GROUPS: readonly { id: Group; label: string }[] = [
  { id: 'plugin', get label() { return t('плагины', 'plugins') } },
  { id: 'mcp', label: 'MCP' },
  { id: 'connector', get label() { return t('коннекторы', 'connectors') } },
  { id: 'skill', get label() { return t('скилы', 'skills') } },
  { id: 'agent', get label() { return t('агенты', 'agents') } },
  { id: 'command', get label() { return t('команды', 'commands') } },
  { id: 'hook', get label() { return t('хуки', 'hooks') } },
  { id: 'marketplace', get label() { return t('маркетплейсы', 'marketplaces') } },
]

export function groupOf(kind: Kind): Group {
  return kind
}

/**
 * Which entry speaks for the cell when there are several instances: user scope before project scope,
 * project before "built-in" and cloud. Dozens of project entries of a plugin do not override the user entry.
 */
export function scopeRank(scope: string): number {
  if (scope === 'user') return 0
  if (scope === 'local') return 1
  if (scope === 'managed' || scope === 'enterprise') return 1.5
  if (scope.startsWith('plugin:')) return 2
  if (scope.startsWith('profile:')) return 3
  if (scope === 'builtin') return 4
  if (scope.startsWith('project:')) return 5
  if (scope === 'cloud') return 6
  return 7
}

export interface Cell {
  client: ClientId
  /** All instances, the main one first. */
  instances: Entity[]
  state: EntityState
}

export interface Row {
  key: string
  group: Group
  /** Display name without the `@marketplace` suffix. */
  name: string
  kinds: Kind[]
  cells: Partial<Record<ClientId, Cell>>
}

const DISPLAY_NAME_KINDS: ReadonlySet<Kind> = new Set(['plugin', 'mcp', 'skill', 'agent', 'command', 'marketplace', 'connector'])

export function buildRows(entities: readonly Entity[]): Row[] {
  const rows = new Map<string, Row>()
  for (const e of entities) {
    const group = groupOf(e.kind)
    const key = `${group}:${e.logicalKey}`
    let row = rows.get(key)
    if (!row) {
      // strip the `@marketplace` suffix, keep the leading `@` of a scoped package (`@scope/name`)
      const at = e.name.lastIndexOf('@')
      const name = DISPLAY_NAME_KINDS.has(e.kind) ? (at > 0 ? e.name.slice(0, at) : e.name) : e.logicalKey
      row = { key, group, name, kinds: [], cells: {} }
      rows.set(key, row)
    }
    if (!row.kinds.includes(e.kind)) row.kinds.push(e.kind)
    const cell = row.cells[e.client]
    if (cell) cell.instances.push(e)
    else row.cells[e.client] = { client: e.client, instances: [e], state: e.state }
  }
  const order = GROUPS.map((g) => g.id)
  for (const row of rows.values()) {
    for (const cell of Object.values(row.cells)) {
      // sort is stable: with equal scopes the file order is kept
      cell.instances.sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope))
      cell.state = cell.instances[0]?.state ?? 'unknown'
    }
  }
  return [...rows.values()].sort(
    (a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name, getLang()),
  )
}

/** A row made only of undetermined cells (the enable flag lives in project settings, which M1 does not read). */
export function onlyUnknown(row: Row): boolean {
  const cells = Object.values(row.cells)
  return cells.length > 0 && cells.every((c) => c.state === 'unknown')
}

/** Labels are getters for the same reason as in `GROUPS`. */
export const GLYPH: Record<EntityState | 'none', { ch: string; label: string }> = {
  on: { ch: '●', get label() { return t('включено', 'enabled') } },
  off: { ch: '○', get label() { return t('выключено', 'disabled') } },
  broken: { ch: '✕', get label() { return t('сломано', 'broken') } },
  stale: { ch: '◐', get label() { return t('расхождение версий', 'version mismatch') } },
  cloud: { ch: '☁', get label() { return t('только в приложении', 'app only') } },
  unknown: { ch: '◌', get label() { return t('не определено', 'unknown') } },
  none: { ch: '–', get label() { return t('нет', 'none') } },
}
