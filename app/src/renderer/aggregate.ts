import { getLang, t } from '../shared/i18n'
import type { ClientId, Entity, EntityState, Kind } from '../shared/model'

/**
 * Группы строк матрицы. Плагины и MCP-серверы разведены по разным строкам и фильтрам (так удобнее: у них разные
 * действия и разная природа); запись одного типа с тем же именем в разных клиентах по-прежнему сводится в одну строку.
 */
export type Group = 'plugin' | 'mcp' | 'connector' | 'skill' | 'agent' | 'command' | 'hook' | 'marketplace'

/** Подписи — геттеры: `t()` вычисляется при обращении (во время рендера), а не при импорте модуля. */
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
 * Какая запись говорит за ячейку, когда экземпляров несколько: пользовательская область раньше проектной,
 * проектная раньше «встроенной» и облачной. Десятки project-записей плагина не перекрывают user-запись.
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
  /** Все экземпляры, главный первым. */
  instances: Entity[]
  state: EntityState
}

export interface Row {
  key: string
  group: Group
  /** Имя для показа без суффикса `@маркетплейс`. */
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
      // суффикс `@маркетплейс` убираем, ведущую `@` областного пакета (`@scope/name`) оставляем
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
      // sort стабилен: при равных областях сохраняется порядок файла
      cell.instances.sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope))
      cell.state = cell.instances[0]?.state ?? 'unknown'
    }
  }
  return [...rows.values()].sort(
    (a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name, getLang()),
  )
}

/** Строка из одних неопределённых ячеек (флаг включения лежит в настройках проекта, которых M1 не читает). */
export function onlyUnknown(row: Row): boolean {
  const cells = Object.values(row.cells)
  return cells.length > 0 && cells.every((c) => c.state === 'unknown')
}

/** Подписи — геттеры по той же причине, что и у `GROUPS`. */
export const GLYPH: Record<EntityState | 'none', { ch: string; label: string }> = {
  on: { ch: '●', get label() { return t('включено', 'enabled') } },
  off: { ch: '○', get label() { return t('выключено', 'disabled') } },
  broken: { ch: '✕', get label() { return t('сломано', 'broken') } },
  stale: { ch: '◐', get label() { return t('расхождение версий', 'version mismatch') } },
  cloud: { ch: '☁', get label() { return t('только в приложении', 'app only') } },
  unknown: { ch: '◌', get label() { return t('не определено', 'unknown') } },
  none: { ch: '–', get label() { return t('нет', 'none') } },
}
