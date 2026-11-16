import type { KeyboardEvent, RefObject } from 'react'
import { t } from '../../shared/i18n'
import { CLIENTS } from '../../shared/model'
import type { ClientId, EntityState } from '../../shared/model'
import { GLYPH, GROUPS } from '../aggregate'
import type { Group, Row } from '../aggregate'
import { Glyph, KindBadge } from '../ui'

export interface Sel {
  rowKey: string
  client: ClientId
  /** Selected entry in the cell by id (not by index: indexes shift when data is refreshed); `null` means the main one. */
  id: string | null
}

export interface Filters {
  q: string
  group: 'all' | Group
  state: 'all' | EntityState
  hideUnknown: boolean
  client: ClientId | null
}

/** Key regardless of keyboard layout: `j/k/h/l` work on the Russian layout too (by physical key). */
export function keyOf(e: { key: string; code: string }): string {
  return e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key
}

const STATES: EntityState[] = ['on', 'off', 'broken', 'stale', 'cloud', 'unknown']

interface Props {
  rows: Row[]
  total: number
  filters: Filters
  setFilters: (f: Filters) => void
  sel: Sel | null
  onSelect: (s: Sel) => void
  searchRef: RefObject<HTMLInputElement | null>
  /** Entries that changed in the last refresh from disk: marked with a Δ badge (not by color alone). */
  fresh: ReadonlySet<string>
}

export function Matrix({ rows, total, filters, setFilters, sel, onSelect, searchRef, fresh }: Props) {
  // The selected row may have disappeared (refresh from disk, filter): then there is no selected cell and movement starts from the first row.
  const foundRow = sel ? rows.findIndex((r) => r.key === sel.rowKey) : -1
  const curRow = Math.max(0, foundRow)
  const curCol = Math.max(0, sel ? CLIENTS.findIndex((c) => c.id === sel.client) : 0)

  const pick = (ri: number, ci: number) => {
    const row = rows[Math.min(Math.max(ri, 0), rows.length - 1)]
    const client = CLIENTS[Math.min(Math.max(ci, 0), CLIENTS.length - 1)]
    if (row && client) onSelect({ rowKey: row.key, client: client.id, id: null })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    const k = keyOf(e.nativeEvent)
    const move: Record<string, [number, number]> = {
      j: [1, 0], ArrowDown: [1, 0], k: [-1, 0], ArrowUp: [-1, 0],
      h: [0, -1], ArrowLeft: [0, -1], l: [0, 1], ArrowRight: [0, 1],
    }
    const d = move[k]
    if (d) {
      e.preventDefault()
      pick(curRow + d[0], curCol + d[1])
    } else if (k === 'Home') {
      e.preventDefault()
      pick(0, curCol)
    } else if (k === 'End') {
      e.preventDefault()
      pick(rows.length - 1, curCol)
    }
  }

  return (
    <>
      <div className="bar">
        <input
          ref={searchRef}
          type="search"
          placeholder={t('Поиск ( / )', 'Search ( / )')}
          aria-label={t('Поиск', 'Search')}
          value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })}
        />
        <button className="chip" aria-pressed={filters.group === 'all'} onClick={() => setFilters({ ...filters, group: 'all' })}>
          {t('все типы', 'all types')}
        </button>
        {GROUPS.map((g) => (
          <button key={g.id} className="chip" aria-pressed={filters.group === g.id} onClick={() => setFilters({ ...filters, group: g.id })}>
            {g.label}
          </button>
        ))}
        <select
          aria-label={t('Фильтр по состоянию', 'Filter by state')}
          value={filters.state}
          onChange={(e) => setFilters({ ...filters, state: e.target.value as Filters['state'] })}
        >
          <option value="all">{t('любое состояние', 'any state')}</option>
          {STATES.map((s) => (
            <option key={s} value={s}>{`${GLYPH[s].ch} ${GLYPH[s].label}`}</option>
          ))}
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.hideUnknown}
            onChange={(e) => setFilters({ ...filters, hideUnknown: e.target.checked })}
          />
          {t('скрыть «не определено»', 'hide "unknown"')}
        </label>
        {filters.client ? (
          <button onClick={() => setFilters({ ...filters, client: null })}>
            {t('клиент', 'client')}: {CLIENTS.find((c) => c.id === filters.client)?.name} ✕
          </button>
        ) : null}
      </div>

      <div className="hud tablewrap">
        <table
          role="grid"
          id="grid"
          tabIndex={0}
          aria-label={t('Матрица сущностей по клиентам', 'Entity matrix by client')}
          aria-rowcount={rows.length + 1}
          aria-activedescendant={foundRow >= 0 ? `cell-${curRow}-${curCol}` : undefined}
          onKeyDown={onKeyDown}
        >
          <thead>
            <tr>
              <th scope="col">{t('СУЩНОСТЬ', 'ENTITY')}</th>
              {CLIENTS.map((c) => (
                <th key={c.id} scope="col">{c.name.toUpperCase()}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r.key} role="row">
                <td className="name" role="rowheader">
                  <KindBadge kinds={r.kinds} />
                  <b title={r.name}>{r.name}</b>
                </td>
                {CLIENTS.map((c, ci) => {
                  const cell = r.cells[c.id]
                  const state = cell?.state ?? 'none'
                  const active = ri === foundRow && ci === curCol
                  const more = (cell?.instances.length ?? 0) - 1
                  const isFresh = cell?.instances.some((i) => fresh.has(i.id)) ?? false
                  return (
                    <td
                      key={c.id}
                      id={`cell-${ri}-${ci}`}
                      role="gridcell"
                      className={`c${active ? ' cur' : ''}${isFresh ? ' fresh' : ''}`}
                      aria-selected={active}
                      aria-label={`${r.name}, ${c.name}: ${GLYPH[state].label}${more > 0 ? t(`, ещё записей: ${more}`, `, ${more} more entries`) : ''}${isFresh ? t(', изменено только что', ', just changed') : ''}`}
                      onClick={() => {
                        pick(ri, ci)
                        document.getElementById('grid')?.focus()
                      }}
                    >
                      <Glyph state={state} pulse />
                      {more > 0 ? <span className="more">+{more}</span> : null}
                      {isFresh ? <span className="delta" aria-hidden="true">Δ</span> : null}
                    </td>
                  )
                })}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={CLIENTS.length + 1} className="empty">
                  {total === 0
                    ? t('Сущностей не найдено: клиенты не установлены или их конфиги пусты.', 'No entities found: the clients are not installed or their configs are empty.')
                    : t('Ничего не найдено по фильтрам', 'Nothing matches the filters')}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="legend">
        {(Object.keys(GLYPH) as (EntityState | 'none')[]).map((k) => (
          <span key={k}>
            <Glyph state={k} /> {GLYPH[k].label}
          </span>
        ))}
        <span>{t('+N — ещё записей в других областях', '+N — more entries in other scopes')}</span>
      </div>
    </>
  )
}
