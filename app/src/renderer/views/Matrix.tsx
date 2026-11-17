import { useEffect, useRef } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { t } from '../../shared/i18n'
import { CLIENTS } from '../../shared/model'
import type { ClientId, EntityState } from '../../shared/model'
import { GLYPH, GROUPS } from '../aggregate'
import type { Group, Row } from '../aggregate'
import { Glyph, KindBadge, PageHead } from '../ui'

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

/** Ctrl, Meta or Alt is held: single-key shortcuts (`j/k/h/l`, digits, `/`, Space, `r`) leave such presses alone, so Ctrl+K opens the palette without moving the selection. */
export function withModifier(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return e.ctrlKey || e.metaKey || e.altKey
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
  onRescan: () => void
  onAdd: () => void
}

/** What each mark of the table means, beyond its one-word name (t() during render only). */
const legendHint = (k: EntityState | 'none'): string | null =>
  (
    {
      broken: t('запись указывает на то, чего нет', 'the entry points to something missing'),
      cloud: t('облачный коннектор', 'cloud connector'),
      unknown: t('флаг лежит там, куда Loadout не заглядывает', 'the flag is somewhere Loadout does not read'),
      none: t('такой записи в этом клиенте нет', 'this client has no such entry'),
    } as Partial<Record<EntityState | 'none', string>>
  )[k] ?? null

export function Matrix({ rows, total, filters, setFilters, sel, onSelect, searchRef, fresh, onRescan, onAdd }: Props) {
  // The selected row may have disappeared (refresh from disk, filter): then there is no selected cell and movement starts from the first row.
  const foundRow = sel ? rows.findIndex((r) => r.key === sel.rowKey) : -1
  const curRow = Math.max(0, foundRow)
  const curCol = Math.max(0, sel ? CLIENTS.findIndex((c) => c.id === sel.client) : 0)

  // the selected cell is always on screen: a jump from the Doctor, Hooks or the palette centres it, a step with the arrows scrolls as little as it can;
  // a cell already in view (a mouse click) does not move; only a new selection scrolls, not rows shifting under it (a live update, a filter)
  const lastRow = useRef(-1)
  useEffect(() => {
    if (foundRow < 0) return
    const jump = lastRow.current < 0 || Math.abs(foundRow - lastRow.current) > 1
    const cell = document.getElementById(`cell-${foundRow}-${curCol}`)
    const box = cell?.closest('main')?.getBoundingClientRect()
    if (!cell || !box) return
    const head = document.querySelector('#grid thead')?.getBoundingClientRect().height ?? 0
    const r = cell.getBoundingClientRect()
    if (r.top >= box.top + head && r.bottom <= box.bottom) return
    cell.style.scrollMarginTop = `${head}px` // the sticky header must not cover the cell
    cell.scrollIntoView({ block: jump ? 'center' : 'nearest', inline: 'nearest' })
  }, [sel?.rowKey, sel?.client]) // keyed on the selection, not on the row index
  useEffect(() => {
    lastRow.current = foundRow
  })

  const pick = (ri: number, ci: number) => {
    const row = rows[Math.min(Math.max(ri, 0), rows.length - 1)]
    const client = CLIENTS[Math.min(Math.max(ci, 0), CLIENTS.length - 1)]
    if (row && client) onSelect({ rowKey: row.key, client: client.id, id: null })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    // Ctrl+Home / Ctrl+End still jump to the first / last row, as they always did
    if (withModifier(e) && e.key !== 'Home' && e.key !== 'End') return
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
      <PageHead title={t('Матрица', 'Matrix')} topic="matrix" sub={t('Что установлено в каждом клиенте. Выберите ячейку, справа появятся подробности.', 'What is installed in each client. Select a cell to see the details on the right.')} />
      <div className="bar">
        <input
          ref={searchRef}
          type="search"
          placeholder={t('Найти по названию ( / )', 'Find by name ( / )')}
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
          <button onClick={() => setFilters({ ...filters, client: null })} aria-label={t(`клиент: ${CLIENTS.find((c) => c.id === filters.client)?.name}, снять фильтр`, `client: ${CLIENTS.find((c) => c.id === filters.client)?.name}, clear the filter`)}>
            {t('клиент', 'client')}: {CLIENTS.find((c) => c.id === filters.client)?.name} <span aria-hidden="true">✕</span>
          </button>
        ) : null}
      </div>

      {/* above the table, not under it: under a long table the legend was out of sight */}
      <details className="legend-box">
        <summary>{t('Что значат значки', 'What the marks mean')}</summary>
        <ul className="legend">
          {(Object.keys(GLYPH) as (EntityState | 'none')[]).map((k) => (
            <li key={k}>
              <Glyph state={k} /> {GLYPH[k].label}
              {legendHint(k) ? <span className="mute">: {legendHint(k)}</span> : null}
            </li>
          ))}
          <li><span className="more">+N</span> {t('ещё N записей в других областях', 'N more entries in other scopes')}</li>
          <li><span className="delta">Δ</span> {t('изменилось на диске только что, метка гаснет через несколько секунд', 'just changed on disk, the mark fades after a few seconds')}</li>
        </ul>
      </details>

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
              <th scope="col">{t('Название', 'Name')}</th>
              {CLIENTS.map((c) => (
                <th key={c.id} scope="col">{c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r.key} role="row">
                <td className="name" role="rowheader">
                  <KindBadge kinds={r.kinds} />
                  <b title={r.hint ?? r.name}>{r.name}</b>
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
                  {total === 0 ? (
                    <>
                      <p>{t('Не найдено ни одного клиента: в домашней папке нет конфигов Claude Code, Claude Desktop, ChatGPT / Codex, Antigravity и DeepSeek, или они пусты.', 'No client found: the home folder has no configs of Claude Code, Claude Desktop, ChatGPT / Codex, Antigravity or DeepSeek, or they are empty.')}</p>
                      <p>{t('Установите клиент или добавьте в него MCP-сервер, затем пересканируйте.', 'Install a client or add an MCP server to one, then rescan.')}</p>
                      <div className="actions center">
                        <button className="primary" onClick={onRescan}>{t('Пересканировать', 'Rescan')}</button>
                        <button onClick={onAdd}>{t('Добавить MCP…', 'Add MCP…')}</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p>{t('По фильтрам ничего не найдено.', 'Nothing matches the filters.')}</p>
                      <div className="actions center">
                        <button onClick={() => setFilters({ q: '', group: 'all', state: 'all', hideUnknown: false, client: null })}>{t('Сбросить фильтры', 'Clear the filters')}</button>
                      </div>
                    </>
                  )}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  )
}
