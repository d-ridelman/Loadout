import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getLang, t } from '../shared/i18n'
import type { Lang } from '../shared/i18n'
import { CLIENTS } from '../shared/model'
import type { ClientId, Entity, Intent, ScanResult, WriteLevel } from '../shared/model'
import { buildRows, groupOf, onlyUnknown } from './aggregate'
import type { Row } from './aggregate'
import { diagnose } from './doctor'
import { Logo } from './Logo'
import { Doctor } from './views/Doctor'
import { Hooks } from './views/Hooks'
import { Inspector, levelOk } from './views/Inspector'
import { Journal } from './views/Journal'
import { AddDialog } from './views/AddDialog'
import { CopyDialog } from './views/CopyDialog'
import { EditDialog } from './views/EditDialog'
import { PlanDialog } from './views/PlanDialog'
import { PluginDialog } from './views/PluginDialog'
import { Profiles } from './views/Profiles'
import { Ctxkit } from './views/Ctxkit'
import { Matrix, keyOf } from './views/Matrix'
import type { Filters, Sel } from './views/Matrix'
import { Palette } from './views/Palette'
import type { PaletteItem } from './views/Palette'
import { Radar } from './views/Radar'

type View = 'matrix' | 'radar' | 'hooks' | 'doctor' | 'journal' | 'profiles' | 'ctxkit'
/** Что сейчас открыто поверх окна: форма, а затем предпросмотр записи. */
type Flow =
  | { type: 'plan'; entity: Entity | null; intent: Intent }
  | { type: 'edit'; entity: Entity }
  | { type: 'copy'; entity: Entity }
  | { type: 'add' }
  | { type: 'plugin' }
type Fx = 'off' | 'low' | 'full'
type ScanState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: ScanResult; ms: number }

/** Функции, а не константы: подписи зависят от языка, который выбран уже после импорта модуля. */
const views = (): readonly { id: View; label: string }[] => [
  { id: 'matrix', label: t('Матрица', 'Matrix') },
  { id: 'radar', label: t('Радар', 'Radar') },
  { id: 'hooks', label: t('Хуки', 'Hooks') },
  { id: 'doctor', label: t('Доктор', 'Doctor') },
  { id: 'journal', label: t('Журнал', 'Journal') },
  { id: 'profiles', label: t('Профили', 'Profiles') },
  { id: 'ctxkit', label: 'ctxkit' },
]

const levelLabel = (l: WriteLevel): string =>
  l === 'R0'
    ? t('R0 · только чтение', 'R0 · read-only')
    : l === 'R1'
      ? t('R1 · флаги', 'R1 · flags')
      : t('R2 · полная запись', 'R2 · full write')

const fxLabel = (m: Fx): string => (m === 'off' ? t('выкл', 'off') : m === 'low' ? t('лёгкие', 'light') : t('полные', 'full'))

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

export function App({ lang, onLang }: { lang: Lang; onLang: (l: Lang) => void }) {
  const [scan, setScan] = useState<ScanState>({ status: 'loading' })
  const [view, setView] = useState<View>('matrix')
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [sel, setSel] = useState<Sel | null>(null)
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [fx, setFx] = useState<Fx>(initialFx)
  const searchRef = useRef<HTMLInputElement>(null)

  /** Уровень записи хранит main-процесс; здесь только его отражение. */
  const [level, setLevel] = useState<WriteLevel>('R0')
  const [flow, setFlow] = useState<Flow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const say = useCallback((m: string) => {
    setNotice(m)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 8000)
  }, [])
  useEffect(() => {
    void window.loadout.getWriteLevel().then(setLevel, () => undefined)
    return () => clearTimeout(noticeTimer.current)
  }, [])
  const changeLevel = useCallback(
    async (next: WriteLevel) => {
      try {
        setLevel(await window.loadout.setWriteLevel(next))
      } catch {
        say(t('Не удалось сменить уровень записи', 'Could not change the write level'))
      }
    },
    [say],
  )
  /** Закрывает диалог и возвращает фокус на таблицу, как палитра. */
  const closeFlow = useCallback(() => {
    setFlow(null)
    requestAnimationFrame(() => document.getElementById('grid')?.focus())
  }, [])
  /** Номер обновления данных: разделы «Журнал» и «Профили» перечитываются по нему (`canRollback` зависит от файла). */
  const [rev, setRev] = useState(0)

  const requestToggle = useCallback(
    (e: Entity, enable: boolean) => {
      if (!e.canToggle) return say(t(`Переключить нельзя: ${e.toggleWhy ?? 'не поддержано'}`, `Cannot toggle: ${e.toggleWhy ?? 'not supported'}`))
      const need = e.toggleLevel ?? 'R1'
      if (!levelOk(level, need))
        return say(
          t(
            `Запись выключена (${level}): для этой записи включите уровень ${need} в шапке окна`,
            `Writing is off (${level}): enable level ${need} in the window header for this entry`,
          ),
        )
      setFlow({ type: 'plan', entity: e, intent: { op: 'toggle', entity: e.id, enable } })
    },
    [level, say],
  )
  const requestForm = useCallback(
    (type: 'edit' | 'copy', e: Entity) => {
      if (!e.canEdit) return say(t('Эту запись править и копировать нельзя: она не в файле клиента', 'This entry cannot be edited or copied: it is not in a client file'))
      if (!levelOk(level, 'R2')) return say(t(`Запись выключена (${level}): включите уровень R2 в шапке окна`, `Writing is off (${level}): enable level R2 in the window header`))
      setFlow({ type, entity: e })
    },
    [level, say],
  )

  const requestAdd = useCallback(() => {
    if (!levelOk(level, 'R2')) return say(t(`Запись выключена (${level}): включите уровень R2 в шапке окна`, `Writing is off (${level}): enable level R2 in the window header`))
    setFlow({ type: 'add' })
  }, [level, say])

  const requestPlugin = useCallback(() => {
    if (!levelOk(level, 'R2')) return say(t(`Запись выключена (${level}): включите уровень R2 в шапке окна`, `Writing is off (${level}): enable level R2 in the window header`))
    setFlow({ type: 'plugin' })
  }, [level, say])

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
      if (r.ok) {
        setUpdatedAt(new Date())
        setRev((n) => n + 1)
      }
    } catch (e) {
      setScan({ status: 'error', error: e instanceof Error ? e.message : t('не удалось запросить скан', 'could not request the scan') })
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
      setRev((n) => n + 1)
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
  /** Выбранная запись: по id, а если выбрана главная в ячейке, то первая. */
  const selEntity = useMemo<Entity | undefined>(() => {
    const inst = sel ? selRow?.cells[sel.client]?.instances : undefined
    return inst?.find((x) => x.id === sel?.id) ?? inst?.[0]
  }, [sel, selRow])

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
      // Пока открыт диалог (форма, предпросмотр записи или пакета), остальные клавиши отключены; Esc закрывает диалог.
      if (flow || document.querySelector('.modal')) {
        if (e.key === 'Escape' && flow) closeFlow()
        return
      }
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
      const tg = e.target
      if (tg instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(tg.tagName)) return
      if (palette) return
      // Space на кнопке нажимает кнопку, а не переключает выбранную запись; прочие клавиши от фокуса на кнопке не зависят
      if (e.key === ' ' && view === 'matrix' && selEntity && !(tg instanceof HTMLButtonElement)) {
        e.preventDefault() // иначе пробел прокрутит страницу
        requestToggle(selEntity, selEntity.state === 'off' || selEntity.state === 'unknown')
      } else if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) {
        setHelp((h) => !h)
      } else if ((e.code === 'Slash' || e.key === '/') && view === 'matrix') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (/^[1-7]$/.test(e.key)) {
        setView(views()[Number(e.key) - 1]?.id ?? 'matrix')
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
  }, [palette, view, load, flow, selEntity, requestToggle, closeFlow])

  const paletteItems = useMemo<PaletteItem[]>(
    () => [
      ...views().map((v) => ({ label: t(`Раздел: ${v.label}`, `Section: ${v.label}`), hint: t('раздел', 'section'), run: () => setView(v.id) })),
      { label: t('Пересканировать', 'Rescan'), hint: t('действие', 'action'), run: () => void load(true) },
      { label: t('Добавить MCP-сервер', 'Add MCP server'), hint: t('действие', 'action'), run: requestAdd },
      { label: t('Установить плагин Claude Code', 'Install Claude Code plugin'), hint: t('действие', 'action'), run: requestPlugin },
      ...(['R0', 'R1', 'R2'] as const)
        .filter((l) => l !== level)
        .map((l) => ({ label: t(`Уровень записи: ${levelLabel(l)}`, `Write level: ${levelLabel(l)}`), hint: t('действие', 'action'), run: () => void changeLevel(l) })),
      ...(selEntity
        ? [{
            label: (selEntity.state === 'off' || selEntity.state === 'unknown' ? t('Включить', 'Enable') : t('Выключить', 'Disable')) + `: ${selEntity.name}`,
            hint: t('действие', 'action'),
            run: () => requestToggle(selEntity, selEntity.state === 'off' || selEntity.state === 'unknown'),
          }]
        : []),
      ...(['off', 'low', 'full'] as const).map((m) => ({ label: t(`Эффекты: ${fxLabel(m)}`, `Effects: ${fxLabel(m)}`), hint: t('действие', 'action'), run: () => setFx(m) })),
      ...rows.map((r) => ({ label: r.name, hint: r.kinds.join('+'), run: () => showRow(r) })),
    ],
    [rows, load, showRow, level, changeLevel, selEntity, requestToggle, requestAdd, requestPlugin],
  )

  const problems = findings.filter((f) => f.severity === 'error').length

  return (
    <div id="app" className={view === 'matrix' ? undefined : 'noaside'}>
      <header>
        <span className="brand">
          <Logo />
          <span className="logo">
            LOAD<i>/</i>OUT
          </span>
        </span>
        <span className="mute mono" id="scanInfo">
          {scan.status === 'ready'
            ? t(`скан: ${scan.ms} мс`, `scan: ${scan.ms} ms`)
            : scan.status === 'loading'
              ? t('скан…', 'scan…')
              : t('скан не удался', 'scan failed')}
        </span>
        <span className="sp" />
        <label className="mute">
          FX{' '}
          <select aria-label={t('Уровень эффектов', 'Effects level')} value={fx} onChange={(e) => setFx(e.target.value as Fx)}>
            <option value="off">{fxLabel('off')}</option>
            <option value="low">{fxLabel('low')}</option>
            <option value="full">{fxLabel('full')}</option>
          </select>
        </label>
        <label className="mute">
          {t('Запись', 'Write')}{' '}
          <select
            className={`mono level ${level === 'R0' ? 's-on' : 's-stale'}`}
            aria-label={t('Уровень записи', 'Write level')}
            title={t(
              'R0 — только чтение; R1 — включать и выключать по флагам; R2 — ещё корзина, правка команд, копирование, профили и применение ctxkit. Повышение подтверждается окном системы',
              'R0 — read-only; R1 — enable and disable by flags; R2 — also trash, command editing, copying, profiles and applying ctxkit. Raising the level is confirmed by a system dialog',
            )}
            value={level}
            onChange={(e) => void changeLevel(e.target.value as WriteLevel)}
          >
            {(['R0', 'R1', 'R2'] as const).map((l) => (
              <option key={l} value={l}>{levelLabel(l)}</option>
            ))}
          </select>
        </label>
        <button onClick={requestAdd} title={t('Записать новый MCP-сервер в конфиг клиента (R2)', 'Write a new MCP server to the client config (R2)')}>{t('Добавить MCP', 'Add MCP')}</button>
        <button onClick={requestPlugin} title={t('Установить плагин Claude Code из добавленного маркетплейса (R2)', 'Install a Claude Code plugin from an added marketplace (R2)')}>{t('Установить плагин', 'Install plugin')}</button>
        <button onClick={() => void load(scan.status === 'ready')} aria-label={t('Пересканировать (клавиша R)', 'Rescan (key R)')}>{t('Скан', 'Scan')}</button>
        <button onClick={() => setPalette(true)} aria-label={t('Палитра команд', 'Command palette')}>Ctrl+K</button>
        <select aria-label={t('Язык', 'Language')} title={t('Язык', 'Language')} className="mono" value={lang} onChange={(e) => onLang(e.target.value as Lang)}>
          <option value="ru">RU</option>
          <option value="en">EN</option>
        </select>
      </header>

      <nav aria-label={t('Разделы', 'Sections')}>
        {views().map((v, i) => (
          <button key={v.id} aria-current={view === v.id ? 'page' : undefined} onClick={() => setView(v.id)}>
            <span>{v.label}</span>
            <small>{i + 1}</small>
          </button>
        ))}
      </nav>

      <main tabIndex={-1}>
        {scan.status === 'loading' ? (
          <div className="state" role="status">
            <span className="pulse">◌</span> {t('Сканирование конфигов клиентов…', 'Scanning client configs…')}
          </div>
        ) : scan.status === 'error' ? (
          <div className="hud state error" role="alert">
            <h2>{t('Не удалось получить данные', 'Could not get the data')}</h2>
            <p>{scan.error}</p>
            <button onClick={() => void load()}>{t('Повторить', 'Retry')}</button>
          </div>
        ) : view === 'matrix' ? (
          <Matrix rows={visible} total={rows.length} filters={filters} setFilters={setFilters} sel={sel} onSelect={setSel} searchRef={searchRef} fresh={fresh} />
        ) : view === 'radar' ? (
          <Radar entities={entities} findings={findings} activeClient={filters.client} onClient={filterClient} onDoctor={() => setView('doctor')} />
        ) : view === 'hooks' ? (
          <Hooks hooks={hooks} onShow={showEntity} />
        ) : view === 'doctor' ? (
          <Doctor findings={findings} onShow={showEntity} />
        ) : view === 'journal' ? (
          <Journal level={level} refreshKey={rev} onNotice={say} />
        ) : view === 'profiles' ? (
          <Profiles level={level} refreshKey={rev} onNotice={say} />
        ) : (
          <Ctxkit level={level} onNotice={say} />
        )}
      </main>

      {/* инспектор показывает запись матрицы: в других разделах он не относится к экрану и скрыт */}
      <aside aria-label={t('Инспектор', 'Inspector')} hidden={view !== 'matrix'}>
        <Inspector
          row={selRow}
          sel={sel}
          onPick={(id) => sel && setSel({ ...sel, id })}
          level={level}
          onToggle={requestToggle}
          onEdit={(e) => requestForm('edit', e)}
          onCopy={(e) => requestForm('copy', e)}
        />
      </aside>

      <footer>
        <span>
          {t(
            `${entities.length} записей · ${rows.length} строк · ${CLIENTS.length} клиентов`,
            `${entities.length} entries · ${rows.length} rows · ${CLIENTS.length} clients`,
          )}
        </span>
        {updatedAt ? (
          <span title={t('Ядро следит за конфигами клиентов и присылает изменения само; если слежение не поднялось, обновляйте вручную', 'The core watches client configs and pushes changes by itself; if watching did not start, refresh manually')}>
            {t('обновлено', 'updated')} {updatedAt.toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'ru-RU')}
          </span>
        ) : null}
        {notice ? <span role="status" id="notice" className="s-stale">{notice}</span> : null}
        {problems > 0 ? <span className="s-broken">✕ {t('сломано', 'broken')}: {problems}</span> : null}
        {warnings.length > 0 ? <span className="s-stale">◐ {t('предупреждений', 'warnings')}: {warnings.length}</span> : null}
        <span className="sp" />
        <span>{t('? — клавиши · данные читаются с диска, ничего не отправляется', '? — shortcuts · data is read from disk, nothing is sent')}</span>
      </footer>

      {help ? (
        <div className="hud help" role="dialog" aria-label={t('Клавиши', 'Shortcuts')}>
          <h2>{t('Клавиши', 'Shortcuts')}</h2>
          <dl className="kv">
            <dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>{t('строка вниз / вверх', 'row down / up')}</dd>
            <dt><kbd>h</kbd> <kbd>l</kbd></dt><dd>{t('клиент влево / вправо', 'client left / right')}</dd>
            <dt><kbd>/</kbd></dt><dd>{t('поиск', 'search')}</dd>
            <dt><kbd>1</kbd>–<kbd>7</kbd></dt><dd>{t('разделы', 'sections')}</dd>
            <dt><kbd>Space</kbd></dt><dd>{t('включить / выключить выбранное (R1; без флага — R2)', 'enable / disable the selection (R1; without a flag — R2)')}</dd>
            <dt><kbd>r</kbd></dt><dd>{t('пересканировать', 'rescan')}</dd>
            <dt><kbd>Ctrl+K</kbd></dt><dd>{t('палитра', 'palette')}</dd>
            <dt><kbd>?</kbd> <kbd>Esc</kbd></dt><dd>{t('справка / закрыть', 'help / close')}</dd>
          </dl>
        </div>
      ) : null}
      {palette ? <Palette items={paletteItems} onClose={() => setPalette(false)} /> : null}
      {flow?.type === 'plan' ? (
        <PlanDialog
          entity={flow.entity}
          intent={flow.intent}
          onClose={closeFlow}
          onDone={(m) => {
            closeFlow()
            say(m)
          }}
        />
      ) : null}
      {flow?.type === 'edit' ? (
        <EditDialog entity={flow.entity} onClose={closeFlow} onSubmit={(intent) => setFlow({ type: 'plan', entity: flow.entity, intent })} />
      ) : null}
      {flow?.type === 'add' ? (
        <AddDialog onClose={closeFlow} onSubmit={(intent) => setFlow({ type: 'plan', entity: null, intent })} />
      ) : null}
      {flow?.type === 'plugin' ? (
        <PluginDialog
          onClose={closeFlow}
          onDone={(m) => {
            closeFlow()
            say(m)
          }}
        />
      ) : null}
      {flow?.type === 'copy' ? (
        <CopyDialog entity={flow.entity} onClose={closeFlow} onSubmit={(intent) => setFlow({ type: 'plan', entity: flow.entity, intent })} />
      ) : null}
    </div>
  )
}
