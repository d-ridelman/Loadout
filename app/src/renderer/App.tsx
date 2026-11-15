import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CLIENTS } from '../shared/model'
import type { ClientId, Entity, ScanResult } from '../shared/model'
import { buildRows, groupOf, onlyUnknown } from './aggregate'
import type { Row } from './aggregate'
import { diagnose } from './doctor'
import { Doctor } from './views/Doctor'
import { Hooks } from './views/Hooks'
import { Inspector } from './views/Inspector'
import { Matrix, keyOf } from './views/Matrix'
import type { Filters, Sel } from './views/Matrix'
import { Palette } from './views/Palette'
import type { PaletteItem } from './views/Palette'
import { Radar } from './views/Radar'

type View = 'matrix' | 'radar' | 'hooks' | 'doctor' | 'journal'
type Fx = 'off' | 'low' | 'full'
type ScanState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: ScanResult; ms: number }

const VIEWS: readonly { id: View; label: string }[] = [
  { id: 'matrix', label: 'Матрица' },
  { id: 'radar', label: 'Радар' },
  { id: 'hooks', label: 'Хуки' },
  { id: 'doctor', label: 'Доктор' },
  { id: 'journal', label: 'Журнал' },
]

const DEFAULT_FILTERS: Filters = { q: '', group: 'all', state: 'all', hideUnknown: true, client: null }

function initialFx(): Fx {
  try {
    const saved = localStorage.getItem('loadout.fx')
    if (saved === 'off' || saved === 'low' || saved === 'full') return saved
  } catch {
    /* localStorage недоступен: берём значение по умолчанию */
  }
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'full'
}

function applyFilters(rows: Row[], f: Filters): Row[] {
  const q = f.q.trim().toLowerCase()
  return rows.filter((r) => {
    if (f.group !== 'all' && r.group !== f.group) return false
    if (q && !r.name.toLowerCase().includes(q) && !r.key.toLowerCase().includes(q)) return false
    if (f.client && !r.cells[f.client]) return false
    if (f.state !== 'all' && !Object.values(r.cells).some((c) => c.state === f.state)) return false
    if (f.hideUnknown && f.state !== 'unknown' && onlyUnknown(r)) return false
    return true
  })
}

export function App() {
  const [scan, setScan] = useState<ScanState>({ status: 'loading' })
  const [view, setView] = useState<View>('matrix')
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [sel, setSel] = useState<Sel | null>(null)
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [fx, setFx] = useState<Fx>(initialFx)
  const searchRef = useRef<HTMLInputElement>(null)

  /** Записи, изменившиеся при последнем обновлении с диска (подсвечиваются на несколько секунд). */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const freshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /** `silent`: данные меняются на месте, без экрана «загрузка»: он размонтировал бы таблицу и сбросил фокус и выбор. */
  const load = useCallback(async (silent = false) => {
    if (!silent) setScan({ status: 'loading' })
    try {
      const r = await window.loadout.scan()
      setScan(r.ok ? { status: 'ready', data: r.data, ms: r.ms } : { status: 'error', error: r.error })
      if (r.ok) setUpdatedAt(new Date())
    } catch (e) {
      setScan({ status: 'error', error: e instanceof Error ? e.message : 'не удалось запросить скан' })
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  // Сторож файлов: ядро заметило смысловое изменение, данные приходят уже проверенными.
  useEffect(() => {
    const off = window.loadout.onChanged((e) => {
      setScan((prev) => ({ status: 'ready', data: e.data, ms: prev.status === 'ready' ? prev.ms : 0 }))
      setUpdatedAt(new Date())
      setFresh(new Set([...e.diff.added, ...e.diff.changed]))
      clearTimeout(freshTimer.current)
      freshTimer.current = setTimeout(() => setFresh(new Set()), 8000)
    })
    return () => {
      off()
      clearTimeout(freshTimer.current)
    }
  }, [])

  const entities = useMemo<Entity[]>(() => (scan.status === 'ready' ? scan.data.entities : []), [scan])
  const warnings = scan.status === 'ready' ? scan.data.warnings : []
  const facts = scan.status === 'ready' ? scan.data.facts : undefined
  const rows = useMemo(() => buildRows(entities), [entities])
  const visible = useMemo(() => applyFilters(rows, filters), [rows, filters])
  const findings = useMemo(() => diagnose(entities, warnings, facts), [entities, warnings, facts])
  const hooks = useMemo(() => entities.filter((e) => e.kind === 'hook'), [entities])
  const selRow = sel ? rows.find((r) => r.key === sel.rowKey) : undefined

  useEffect(() => {
    document.documentElement.dataset['fx'] = fx
    try {
      localStorage.setItem('loadout.fx', fx)
    } catch {
      /* не критично */
    }
  }, [fx])

  // Анимации на паузу, когда окно скрыто или без фокуса (CONCEPT.md §8).
  useEffect(() => {
    const pause = () => document.body.classList.toggle('paused', document.hidden || !document.hasFocus())
    window.addEventListener('blur', pause)
    window.addEventListener('focus', pause)
    document.addEventListener('visibilitychange', pause)
    return () => {
      window.removeEventListener('blur', pause)
      window.removeEventListener('focus', pause)
      document.removeEventListener('visibilitychange', pause)
    }
  }, [])

  const showEntity = useCallback(
    (e: Entity) => {
      const key = `${groupOf(e.kind)}:${e.logicalKey}`
      const row = rows.find((r) => r.key === key)
      setFilters({ ...DEFAULT_FILTERS, hideUnknown: e.state !== 'unknown' })
      setSel({ rowKey: key, client: e.client, id: row?.cells[e.client]?.instances.some((x) => x.id === e.id) ? e.id : null })
      setView('matrix')
    },
    [rows],
  )

  const showRow = useCallback((row: Row) => {
    const client = CLIENTS.find((c) => row.cells[c.id])?.id ?? 'claude-code'
    setFilters({ ...DEFAULT_FILTERS, hideUnknown: false })
    setSel({ rowKey: row.key, client, id: null })
    setView('matrix')
  }, [])

  const filterClient = useCallback((c: ClientId) => {
    setFilters({ ...DEFAULT_FILTERS, client: c })
    setView('matrix')
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keyOf(e)
      if ((e.ctrlKey || e.metaKey) && k === 'k') {
        e.preventDefault()
        setPalette(true)
        return
      }
      if (e.key === 'Escape') {
        setHelp(false)
        return
      }
      const t = e.target
      if (t instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return
      if (palette) return
      if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) {
        setHelp((h) => !h)
      } else if ((e.code === 'Slash' || e.key === '/') && view === 'matrix') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (/^[1-5]$/.test(e.key)) {
        setView(VIEWS[Number(e.key) - 1]?.id ?? 'matrix')
      } else if (k === 'r' && !e.ctrlKey && !e.metaKey) {
        void load(true)
      } else if (view === 'matrix' && /^[jkhl]$/.test(k)) {
        const grid = document.getElementById('grid')
        if (grid && document.activeElement !== grid) {
          grid.focus()
          grid.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, code: e.code, bubbles: true }))
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [palette, view, load])

  const paletteItems = useMemo<PaletteItem[]>(
    () => [
      ...VIEWS.map((v) => ({ label: `Раздел: ${v.label}`, hint: 'раздел', run: () => setView(v.id) })),
      { label: 'Пересканировать', hint: 'действие', run: () => void load(true) },
      ...(['off', 'low', 'full'] as const).map((m) => ({ label: `Эффекты: ${m === 'off' ? 'выкл' : m === 'low' ? 'лёгкие' : 'полные'}`, hint: 'действие', run: () => setFx(m) })),
      ...rows.map((r) => ({ label: r.name, hint: r.kinds.join('+'), run: () => showRow(r) })),
    ],
    [rows, load, showRow],
  )

  const problems = findings.filter((f) => f.severity === 'error').length

  return (
    <div id="app">
      <header>
        <span className="logo">
          LOAD<i>/</i>OUT
        </span>
        <span className="mute mono" id="scanInfo">
          {scan.status === 'ready' ? `скан: ${scan.ms} мс` : scan.status === 'loading' ? 'скан…' : 'скан не удался'}
        </span>
        <span className="sp" />
        <label className="mute">
          FX{' '}
          <select aria-label="Уровень эффектов" value={fx} onChange={(e) => setFx(e.target.value as Fx)}>
            <option value="off">выкл</option>
            <option value="low">лёгкие</option>
            <option value="full">полные</option>
          </select>
        </label>
        <span className="mono s-on" title="Приложение работает только на чтение. Запись — этапы M3–M4 (docs/CONCEPT.md)">
          R0 · только чтение
        </span>
        <button onClick={() => void load(scan.status === 'ready')} aria-label="Пересканировать (клавиша R)">Скан</button>
        <button onClick={() => setPalette(true)} aria-label="Палитра команд">Ctrl+K</button>
      </header>

      <nav aria-label="Разделы">
        {VIEWS.map((v, i) => (
          <button key={v.id} aria-current={view === v.id ? 'page' : undefined} onClick={() => setView(v.id)}>
            <span>{v.label}</span>
            <small>{i + 1}</small>
          </button>
        ))}
      </nav>

      <main tabIndex={-1}>
        {scan.status === 'loading' ? (
          <div className="state" role="status">
            <span className="pulse">◌</span> Сканирование конфигов клиентов…
          </div>
        ) : scan.status === 'error' ? (
          <div className="hud state error" role="alert">
            <h2>Не удалось получить данные</h2>
            <p>{scan.error}</p>
            <button onClick={() => void load()}>Повторить</button>
          </div>
        ) : view === 'matrix' ? (
          <Matrix rows={visible} total={rows.length} filters={filters} setFilters={setFilters} sel={sel} onSelect={setSel} searchRef={searchRef} fresh={fresh} />
        ) : view === 'radar' ? (
          <Radar entities={entities} findings={findings} activeClient={filters.client} onClient={filterClient} onDoctor={() => setView('doctor')} />
        ) : view === 'hooks' ? (
          <Hooks hooks={hooks} onShow={showEntity} />
        ) : view === 'doctor' ? (
          <Doctor findings={findings} onShow={showEntity} />
        ) : (
          <>
            <h2>Журнал</h2>
            <div className="hud card">
              <p>Здесь будут снимки состояния, diff «что изменилось» и откат. Раздел появляется с этапа M3 (docs/CONCEPT.md §5, §10).</p>
            </div>
          </>
        )}
      </main>

      <aside aria-label="Инспектор">
        <Inspector row={selRow} sel={sel} onPick={(id) => sel && setSel({ ...sel, id })} />
      </aside>

      <footer>
        <span>{entities.length} записей · {rows.length} строк · {CLIENTS.length} клиентов</span>
        {updatedAt ? (
          <span title="Ядро следит за конфигами клиентов и присылает изменения само; если слежение не поднялось, обновляйте вручную">
            обновлено {updatedAt.toLocaleTimeString('ru-RU')}
          </span>
        ) : null}
        {problems > 0 ? <span className="s-broken">✕ сломано: {problems}</span> : null}
        {warnings.length > 0 ? <span className="s-stale">◐ предупреждений: {warnings.length}</span> : null}
        <span className="sp" />
        <span>? — клавиши · данные читаются с диска, ничего не отправляется</span>
      </footer>

      {help ? (
        <div className="hud help" role="dialog" aria-label="Клавиши">
          <h2>Клавиши</h2>
          <dl className="kv">
            <dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>строка вниз / вверх</dd>
            <dt><kbd>h</kbd> <kbd>l</kbd></dt><dd>клиент влево / вправо</dd>
            <dt><kbd>/</kbd></dt><dd>поиск</dd>
            <dt><kbd>1</kbd>–<kbd>5</kbd></dt><dd>разделы</dd>
            <dt><kbd>r</kbd></dt><dd>пересканировать</dd>
            <dt><kbd>Ctrl+K</kbd></dt><dd>палитра</dd>
            <dt><kbd>?</kbd> <kbd>Esc</kbd></dt><dd>справка / закрыть</dd>
          </dl>
        </div>
      ) : null}
      {palette ? <Palette items={paletteItems} onClose={() => setPalette(false)} /> : null}
    </div>
  )
}
