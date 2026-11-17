import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { count, fmtTime, t } from '../shared/i18n'
import type { Lang } from '../shared/i18n'
import { CLIENTS } from '../shared/model'
import type { ClientId, Entity, Intent, Level, ScanResult, WriteLevel } from '../shared/model'
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
import { SkillDialog } from './views/SkillDialog'
import { Profiles } from './views/Profiles'
import { Ctxkit } from './views/Ctxkit'
import { Matrix, keyOf, withModifier } from './views/Matrix'
import type { Filters, Sel } from './views/Matrix'
import { Palette } from './views/Palette'
import type { PaletteItem } from './views/Palette'
import { Radar } from './views/Radar'
import { Updates } from './views/Updates'
import { DEFAULT_FILTERS, restoreUi } from './keep'
import type { Ui, View } from './keep'
import { Help, fxLabel } from './views/Help'
import type { Fx, Topic } from './views/Help'
import { kindLabel, levelLabel, setOpenHelp, Term, Toast } from './ui'
import type { Tone } from './ui'
/** A form before the write preview; `draft` is what was typed, when the preview sends the person back to it. */
type Form =
  | { type: 'edit'; entity: Entity; draft?: Extract<Intent, { op: 'edit' }> }
  | { type: 'copy'; entity: Entity; draft?: Extract<Intent, { op: 'copy' }> }
  | { type: 'add'; draft?: Extract<Intent, { op: 'add' }> }
/** What is currently open over the window: a form, then the write preview. */
type Flow =
  | { type: 'plan'; entity: Entity | null; intent: Intent; back?: Form }
  | Form
  | { type: 'plugin' }
  | { type: 'skill' }

/** The form an intent came from, filled with it (env values stay in this state only, never saved). */
function formOf(entity: Entity | null, intent: Intent): Form | undefined {
  if (intent.op === 'add') return { type: 'add', draft: intent }
  if (intent.op === 'edit' && entity) return { type: 'edit', entity, draft: intent }
  if (intent.op === 'copy' && entity) return { type: 'copy', entity, draft: intent }
  return undefined
}
type ScanState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: ScanResult; ms: number }

/** The sidebar's line under each section name: what it is for, in a few words. */
const navSub = (v: View): string =>
  ({
    matrix: t('что где установлено', 'what is installed where'),
    radar: t('обзор по клиентам', 'overview by client'),
    hooks: t('команды на события', 'commands on events'),
    doctor: t('найденные проблемы', 'problems found'),
    journal: t('история и откат', 'history and undo'),
    profiles: t('наборы включённого', 'sets of what is on'),
    ctxkit: t('для опытных', 'for advanced users'),
  })[v]

/** Functions, not constants: labels depend on the language, which is chosen after the module is imported. */
const views = (): readonly { id: View; label: string }[] => [
  { id: 'matrix', label: t('Матрица', 'Matrix') },
  { id: 'radar', label: t('Радар', 'Radar') },
  { id: 'hooks', label: t('Хуки', 'Hooks') },
  { id: 'doctor', label: t('Доктор', 'Doctor') },
  { id: 'journal', label: t('Журнал', 'Journal') },
  { id: 'profiles', label: t('Профили', 'Profiles') },
  { id: 'ctxkit', label: t('Инструменты контекста', 'Context Toolkit') },
]

function initialFx(): Fx {
  try {
    const saved = localStorage.getItem('loadout.fx')
    if (saved === 'off' || saved === 'low' || saved === 'full') return saved
  } catch {
    /* localStorage is unavailable: use the default value */
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

export function App({ lang, onLang, kept }: { lang: Lang; onLang: (l: Lang, ui: Ui) => void; kept?: Ui }) {
  const [scan, setScan] = useState<ScanState>({ status: 'loading' })
  const [view, setView] = useState<View>(() => restoreUi(kept).view)
  const [filters, setFilters] = useState<Filters>(() => restoreUi(kept).filters)
  const [sel, setSel] = useState<Sel | null>(() => restoreUi(kept).sel)
  const [palette, setPalette] = useState(false)
  /** The help dialog and the topic it opened on; `null` when closed. */
  const [help, setHelpState] = useState<Topic | null>(null)
  /** Where focus was when the help opened: it goes back there on close. */
  const helpFrom = useRef<HTMLElement | null>(null)
  const setHelp = useCallback((v: Topic | null) => {
    if (v && !helpFrom.current && document.activeElement instanceof HTMLElement) helpFrom.current = document.activeElement
    setHelpState(v)
  }, [])
  const closeHelp = useCallback(() => {
    setHelpState(null)
    const back = helpFrom.current
    helpFrom.current = null
    requestAnimationFrame(() => (back?.isConnected ? back : document.querySelector<HTMLElement>('main'))?.focus())
  }, [])
  useEffect(() => setOpenHelp((topic) => setHelp((topic as Topic | undefined) ?? 'start')), [setHelp])
  const [addOpen, setAddOpen] = useState(false)
  // the "Add" list closes on a click anywhere outside it
  useEffect(() => {
    if (!addOpen) return
    const off = (e: MouseEvent) => !(e.target instanceof Element && e.target.closest('.addmenu')) && setAddOpen(false)
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [addOpen])
  const [fx, setFx] = useState<Fx>(initialFx)
  const searchRef = useRef<HTMLInputElement>(null)

  /** The write level is kept by the main process; this is only its mirror. */
  const [level, setLevel] = useState<WriteLevel>('R0')
  const [flow, setFlow] = useState<Flow | null>(null)
  // the key handler below is re-subscribed in an effect, after paint: a key pressed between a dialog closing and that effect reached
  // the old handler, which still saw the dialog open and dropped the key (a "5" right after a write was lost once in e2e). The ref is
  // current from the render on.
  const flowRef = useRef(flow)
  flowRef.current = flow
  const helpRef = useRef(help)
  helpRef.current = help
  const [notice, setNotice] = useState<{ text: string; tone: Tone } | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const say = useCallback((text: string, tone: Tone = 'ok') => {
    setNotice({ text, tone })
    clearTimeout(noticeTimer.current)
    // an error stays longer: it usually needs reading, not a glance
    noticeTimer.current = setTimeout(() => setNotice(null), tone === 'error' ? 15000 : 8000)
  }, [])
  /** The first-run card: main says whether it was closed before (settings.json, `welcomed`). */
  const [welcome, setWelcome] = useState(false)
  useEffect(() => {
    void window.loadout.getWriteLevel().then(setLevel, () => undefined)
    void window.loadout.welcome().then(setWelcome, () => undefined)
    return () => clearTimeout(noticeTimer.current)
  }, [])
  const changeLevel = useCallback(
    async (next: WriteLevel) => {
      try {
        setLevel(await window.loadout.setWriteLevel(next))
      } catch {
        say(t('Не удалось сменить уровень записи', 'Could not change the write level'), 'error')
      }
    },
    [say],
  )
  /** Closes the dialog and returns focus to the table, like the palette. */
  const closeFlow = useCallback(() => {
    setFlow(null)
    // no scroll: focusing the table jumped the page to its top after every preview (seen in the live window)
    requestAnimationFrame(() => document.getElementById('grid')?.focus({ preventScroll: true }))
  }, [])
  /** Data refresh counter: the "Journal" and "Profiles" sections re-read on it (`canRollback` depends on the file). */
  const [rev, setRev] = useState(0)

  /**
   * An action that needs a higher write level asks for it on the spot instead of sending the person to the header:
   * main shows the confirmation window (the page cannot click it). The answer of main decides, not this render's `level`.
   */
  const asking = useRef(false)
  const ensureLevel = useCallback(
    async (need: Level): Promise<boolean> => {
      if (levelOk(level, need)) return true
      if (asking.current) return false // a double click must not stack a second confirmation window
      asking.current = true
      try {
        // the mirror may be stale (just opened, a failed read): never ask main to set a level lower than the one it keeps
        const now = await window.loadout.getWriteLevel()
        if (levelOk(now, need)) {
          setLevel(now)
          return true
        }
        const got = await window.loadout.setWriteLevel(need)
        setLevel(got)
        if (levelOk(got, need)) {
          setNotice(null) // an earlier "writing was not allowed" must not stay under the preview that now opens
          return true
        }
        say(t(`Запись не разрешена, ничего не изменилось. Уровень записи: «${levelLabel(got)}»`, `Writing was not allowed, nothing changed. Write level: “${levelLabel(got)}”`), 'info')
      } catch {
        say(t('Не удалось сменить уровень записи', 'Could not change the write level'), 'error')
      } finally {
        asking.current = false
      }
      return false
    },
    [level, say],
  )
  const requestToggle = useCallback(
    (e: Entity, enable: boolean) => {
      if (!e.canToggle) return say(t(`Переключить нельзя: ${e.toggleWhy ?? 'не поддержано'}`, `Cannot toggle: ${e.toggleWhy ?? 'not supported'}`), 'info')
      void ensureLevel(e.toggleLevel ?? 'R1').then((ok) => ok && setFlow({ type: 'plan', entity: e, intent: { op: 'toggle', entity: e.id, enable } }))
    },
    [ensureLevel, say],
  )
  const requestForm = useCallback(
    (type: 'edit' | 'copy', e: Entity) => {
      if (!e.canEdit) return say(t('Эту запись править и копировать нельзя: она не в файле клиента', 'This entry cannot be edited or copied: it is not in a client file'), 'info')
      void ensureLevel('R2').then((ok) => ok && setFlow({ type, entity: e }))
    },
    [ensureLevel, say],
  )

  /** Opens a form that writes at R2, asking for the level first when it is lower. */
  const requestR2 = useCallback(
    (type: 'add' | 'plugin' | 'skill') => void ensureLevel('R2').then((ok) => ok && setFlow({ type })),
    [ensureLevel],
  )
  const requestAdd = useCallback(() => requestR2('add'), [requestR2])
  const requestPlugin = useCallback(() => requestR2('plugin'), [requestR2])
  const requestSkill = useCallback(() => requestR2('skill'), [requestR2])

  /** Entries that changed in the last refresh from disk (highlighted for a few seconds). */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const freshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /** `silent`: data is swapped in place without a "loading" screen: that would unmount the table and reset focus and selection. */
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

  // File watcher: the core noticed a meaningful change, the data arrives already validated.
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
  /** The selected entry: by id, or the first one if the cell's main entry is selected. */
  const selEntity = useMemo<Entity | undefined>(() => {
    const inst = sel ? selRow?.cells[sel.client]?.instances : undefined
    return inst?.find((x) => x.id === sel?.id) ?? inst?.[0]
  }, [sel, selRow])

  useEffect(() => {
    document.documentElement.dataset['fx'] = fx
    try {
      localStorage.setItem('loadout.fx', fx)
    } catch {
      /* not critical */
    }
  }, [fx])

  // Pause animations when the window is hidden or unfocused (CONCEPT.md §8).
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
      // the arrows go on from the shown cell; the matrix itself scrolls the cell into view
      requestAnimationFrame(() => document.getElementById('grid')?.focus({ preventScroll: true }))
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
      // While a dialog is open (form, write or batch preview), other keys are disabled; Esc closes the dialog.
      if (flowRef.current || document.querySelector('.modal')) {
        if (e.key === 'Escape' && flowRef.current) closeFlow()
        // a click on the help's text leaves focus on <body>, where the dialog's own Esc handler does not hear the key
        else if (e.key === 'Escape' && helpRef.current && !(document.activeElement instanceof Element && document.activeElement.closest('.modal'))) closeHelp()
        return
      }
      const k = keyOf(e)
      if ((e.ctrlKey || e.metaKey) && k === 'k') {
        e.preventDefault()
        setAddOpen(false) // the "Add" list sits above the palette layer
        setPalette(true)
        return
      }
      if (e.key === 'Escape') {
        setAddOpen(false)
        return
      }
      if (e.key === 'F1') {
        e.preventDefault()
        if (!palette) setHelp(view) // never a second modal over the palette
        return
      }
      if (withModifier(e)) return
      const tg = e.target
      if (tg instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(tg.tagName)) return
      if (palette) return
      // Space toggles the selected entry only from the table (or with nothing focused); on a button, a summary or a term it does
      // what that control does; other keys do not depend on focus
      // the grid itself, not a control inside it ("Clear the filters" sits in the table and must not toggle a hidden entry)
      const onTable = !(tg instanceof HTMLElement) || tg === document.body || tg.tagName === 'MAIN' || tg.id === 'grid'
      if (e.key === ' ' && view === 'matrix' && selEntity && onTable) {
        e.preventDefault() // otherwise Space would scroll the page
        requestToggle(selEntity, selEntity.state === 'off' || selEntity.state === 'unknown')
      } else if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) {
        setHelp(view)
      } else if ((e.code === 'Slash' || e.key === '/') && view === 'matrix') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (/^[1-7]$/.test(e.key)) {
        setView(views()[Number(e.key) - 1]?.id ?? 'matrix')
      } else if (k === 'r') {
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
  }, [palette, view, load, flow, selEntity, requestToggle, closeFlow, help, closeHelp, setHelp])

  const paletteItems = useMemo<PaletteItem[]>(
    () => [
      ...views().map((v) => ({ label: t(`Раздел: ${v.label}`, `Section: ${v.label}`), hint: t('раздел', 'section'), run: () => setView(v.id) })),
      { label: t('Справка и частые вопросы', 'Help and questions'), hint: 'F1', run: () => setHelp(view) },
      { label: t('Обновить: перечитать конфиги', 'Refresh: re-read the configs'), hint: t('действие', 'action'), run: () => void load(true) },
      { label: t('Добавить MCP-сервер', 'Add MCP server'), hint: t('действие', 'action'), run: requestAdd },
      { label: t('Установить плагин Claude Code', 'Install Claude Code plugin'), hint: t('действие', 'action'), run: requestPlugin },
      { label: t('Установить скил из GitHub или папки', 'Install a skill from GitHub or a folder'), hint: t('действие', 'action'), run: requestSkill },
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
      ...(['off', 'low', 'full'] as const).map((m) => ({ label: t(`Анимация: ${fxLabel(m)}`, `Animation: ${fxLabel(m)}`), hint: t('действие', 'action'), run: () => setFx(m) })),
      ...rows.map((r) => ({ label: r.name, hint: r.kinds.map(kindLabel).join(' + '), run: () => showRow(r) })),
    ],
    [rows, load, showRow, level, changeLevel, selEntity, requestToggle, requestAdd, requestPlugin, requestSkill, view],
  )

  const planBack = flow?.type === 'plan' ? flow.back : undefined
  const problems = findings.filter((f) => f.severity === 'error').length
  const cautions = findings.filter((f) => f.severity === 'warn').length
  const scanText =
    scan.status === 'ready' ? t(`прочитано за ${scan.ms} мс`, `read in ${scan.ms} ms`) : scan.status === 'loading' ? t('читаю конфиги…', 'reading configs…') : t('конфиги не прочитаны', 'configs not read')

  return (
    <div id="app" className={view === 'matrix' ? undefined : 'noaside'}>
      <header>
        <span className="brand">
          <Logo />
          <span className="logo">
            LOAD<i>/</i>OUT
          </span>
        </span>
        <span className="mute" id="scanInfo" title={scanText} data-ready={scan.status === 'ready' || undefined}>{scanText}</span>
        <span className="sp" />
        {/* not a <label>: the focusable term must not sit inside the select's label; the select names itself */}
        <span className="mute levelbox">
          <Term
            tip={t(
              'Что Loadout может менять. «Только чтение» — ничего; «Вкл/выкл» — включать и выключать по флагу; «Все правки» — ещё корзина, правка, добавление, профили и установка. Выбирать заранее не нужно: кнопка действия сама попросит нужный уровень в окне подтверждения.',
              'What Loadout may change. Read-only: nothing; On/off: turn entries on and off by a flag; All edits: also the trash, edits, additions, profiles and installs. No need to pick it first: an action button asks for the level it needs in a confirmation window.',
            )}
          >
            {t('Запись', 'Write')}
          </Term>{' '}
          <select
            className={`level ${level === 'R0' ? 's-on' : 's-stale'}`}
            aria-label={t('Уровень записи', 'Write level')}
            title={t(
              'Только чтение (R0): окно ничего не пишет. Вкл/выкл (R1): включает и выключает записи флагом в конфиге клиента. Все правки (R2): ещё корзина, правка и копирование команд, новые MCP, плагины, скилы, профили и Инструменты контекста. Любая запись идёт через предпросмотр; повышение уровня подтверждается в отдельном окне',
              'Read-only (R0): the window writes nothing. On/off (R1): turns entries on and off by a flag in the client config. All edits (R2): also the trash, editing and copying commands, new MCP servers, plugins, skills, profiles and Context Toolkit. Every write goes through a preview; raising the level is confirmed in a separate window',
            )}
            value={level}
            onChange={(e) => void changeLevel(e.target.value as WriteLevel)}
          >
            {(['R0', 'R1', 'R2'] as const).map((l) => (
              <option key={l} value={l}>{levelLabel(l)}</option>
            ))}
          </select>
        </span>
        {/* one "Add" instead of three buttons: the three things to add, each with what it is; it closes when focus leaves it, Esc returns to the button */}
        <span
          className="addmenu"
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setAddOpen(false)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || !addOpen) return
            setAddOpen(false)
            e.currentTarget.querySelector('button')?.focus()
          }}
        >
          <button aria-expanded={addOpen} aria-controls={addOpen ? 'addpop' : undefined} onClick={() => setAddOpen((o) => !o)}>
            {t('Добавить', 'Add')} <span aria-hidden="true">▾</span>
          </button>
          {addOpen ? (
            <span id="addpop" className="hud addpop">
              {[
                { name: t('MCP-сервер', 'MCP server'), sub: t('программа с инструментами для ИИ-клиента', 'a program with tools for an AI client'), run: requestAdd },
                { name: t('Плагин Claude Code', 'Claude Code plugin'), sub: t('из маркетплейса на GitHub или из папки', 'from a marketplace on GitHub or a folder'), run: requestPlugin },
                { name: t('Скил', 'Skill'), sub: t('инструкция для модели из GitHub или папки', 'instructions for the model from GitHub or a folder'), run: requestSkill },
              ].map((x, i) => (
                <button
                  key={x.name}
                  autoFocus={i === 0}
                  onClick={(ev) => {
                    // focus back on "Add" before the list unmounts: after a refusal in the confirmation window it is not lost on <body>
                    ev.currentTarget.closest('.addmenu')?.querySelector('button')?.focus()
                    setAddOpen(false)
                    x.run()
                  }}
                >
                  <b>{x.name}…</b>
                  <span className="mute small">{x.sub}</span>
                </button>
              ))}
            </span>
          ) : null}
        </span>
        <button onClick={() => void load(scan.status === 'ready')} title={t('Перечитать конфиги клиентов (клавиша R). Обычно не нужно: Loadout замечает изменения сам', 'Re-read the client configs (key R). Usually not needed: Loadout notices changes by itself')}>{t('Обновить', 'Refresh')}</button>
        <button onClick={() => setPalette(true)} aria-label={t('Команды, Ctrl+K', 'Commands, Ctrl+K')} title={t('Команды и поиск по всему окну', 'Commands and search across the window')}>
          {t('Команды', 'Commands')} <kbd>Ctrl+K</kbd>
        </button>
        <button onClick={() => setHelp(view)} aria-label={t('Справка, F1', 'Help, F1')}>
          {t('Справка', 'Help')} <kbd>F1</kbd>
        </button>
        <select aria-label={t('Язык', 'Language')} title={t('Язык', 'Language')} value={lang} onChange={(e) => onLang(e.target.value as Lang, { view, sel, filters })}>
          <option value="ru">RU</option>
          <option value="en">EN</option>
        </select>
      </header>

      <nav aria-label={t('Разделы', 'Sections')}>
        {/* each section says what it is for; the number is its key (a kbd, not a counter); the Doctor shows how many things are broken */}
        {views().map((v, i) => (
          <button key={v.id} aria-current={view === v.id ? 'page' : undefined} onClick={() => setView(v.id)}>
            <span className="navtext">
              <span>
                {v.label}
                {v.id === 'doctor' && problems > 0 ? (
                  <span className="navcount" title={t(`сломано: ${problems}`, `broken: ${problems}`)}> · <span aria-hidden="true">✕ </span>{problems}<span className="vh"> {t('сломано', 'broken')}</span></span>
                ) : null}
              </span>
              <span className="navsub">{navSub(v.id)}</span>
            </span>
            <kbd aria-hidden="true">{i + 1}</kbd>
          </button>
        ))}
      </nav>

      <main tabIndex={-1}>
        {welcome ? (
          <section className="hud card welcome" aria-labelledby="welcome-title">
            <h2 id="welcome-title">{t('Loadout: что это и чего ждать', 'Loadout: what it is and what to expect')}</h2>
            <p>
              {t(
                'Loadout показывает в одной таблице плагины, MCP-серверы, скилы и хуки шести ИИ-клиентов: Claude Code, Claude Desktop, ChatGPT / Codex, Antigravity, DeepSeek и OpenCode. Данные он берёт из их конфигов на этом компьютере.',
                'Loadout shows the plugins, MCP servers, skills and hooks of six AI clients in one table: Claude Code, Claude Desktop, ChatGPT / Codex, Antigravity, DeepSeek and OpenCode. It reads their configs on this computer.',
              )}
            </p>
            {/* the first task in three steps, in the words of the window: what to click, what happens */}
            <ol className="steps">
              <li>{t('Найдите запись: поиском или кнопками типов над таблицей.', 'Find an entry: with the search or the type buttons above the table.')}</li>
              <li>{t('Нажмите на значок в столбце нужного клиента: справа откроются подробности.', 'Click the mark in the column of the client: the details open on the right.')}</li>
              <li>{t('Нажмите «Включить» или «Выключить»: окно покажет, что изменится, и подождёт подтверждения.', 'Press Enable or Disable: the window shows what will change and waits for you to confirm.')}</li>
            </ol>
            <p className="mute">
              {t(
                `Без вашей команды Loadout ничего не меняет: сейчас уровень записи «${levelLabel(level)}», разрешение на запись он спросит сам, когда вы нажмёте кнопку. Правки конфигов можно откатить в журнале. Сам Loadout выходит в сеть только для проверки обновлений на GitHub; её можно выключить кнопкой с номером версии в правом нижнем углу.`,
                `Loadout changes nothing unless you tell it to: the write level is “${levelLabel(level)}” now, and it asks for permission to write itself when you press a button. Config edits can be rolled back in the journal. On its own, Loadout goes online only to check GitHub for updates; turn that off with the version button in the bottom-right corner.`,
              )}
            </p>
            <div className="actions">
              <button
                className="primary"
                onClick={() => {
                  setWelcome(false)
                  void window.loadout.welcomeDone().catch(() => undefined)
                }}
              >
                {t('Понятно, начать', 'Got it, start')}
              </button>
              <button onClick={() => setHelp('start')}>{t('Открыть справку', 'Open Help')}</button>
            </div>
          </section>
        ) : null}
        {scan.status === 'loading' ? (
          <div className="state" role="status">
            <span className="pulse">◌</span> {t('Сканирование конфигов клиентов…', 'Scanning client configs…')}
          </div>
        ) : scan.status === 'error' ? (
          <div className="hud state error" role="alert">
            <h2>{t('Не удалось получить данные', 'Could not get the data')}</h2>
            <p>{t('Loadout не смог прочитать конфиги клиентов. Нажмите «Повторить». Если ошибка вернётся, перезапустите Loadout, а если и это не поможет, переустановите его.', 'Loadout could not read the client configs. Press Retry. If the error comes back, restart Loadout, and if that does not help either, reinstall it.')}</p>
            <details>
              <summary>{t('Подробности для отчёта об ошибке', 'Details for a bug report')}</summary>
              <p className="mono small wrap">{scan.error}</p>
            </details>
            <button className="primary" onClick={() => void load()}>{t('Повторить', 'Retry')}</button>
          </div>
        ) : view === 'matrix' ? (
          <Matrix rows={visible} total={rows.length} filters={filters} setFilters={setFilters} sel={sel} onSelect={setSel} searchRef={searchRef} fresh={fresh} onRescan={() => void load(true)} onAdd={requestAdd} />
        ) : (
          <div className="page">
            {view === 'radar' ? (
              <Radar rows={rows} findings={findings} activeClient={filters.client} onClient={filterClient} onDoctor={() => setView('doctor')} />
            ) : view === 'hooks' ? (
              <Hooks hooks={hooks} onShow={showEntity} />
            ) : view === 'doctor' ? (
              <Doctor findings={findings} onShow={showEntity} />
            ) : view === 'journal' ? (
              <Journal level={level} refreshKey={rev} onNotice={say} ensureLevel={ensureLevel} />
            ) : view === 'profiles' ? (
              <Profiles level={level} refreshKey={rev} onNotice={say} entities={entities} ensureLevel={ensureLevel} />
            ) : (
              <Ctxkit level={level} onNotice={say} ensureLevel={ensureLevel} />
            )}
          </div>
        )}
      </main>

      {/* the inspector shows a matrix entry: in other sections it does not belong to the screen and is hidden */}
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
          {[
            count(entities.length, ['запись', 'записи', 'записей'], ['entry', 'entries']),
            count(rows.length, ['строка', 'строки', 'строк'], ['row', 'rows']),
            // clients found on this computer, not the five Loadout knows: "5 clients" under "no client found" read as a contradiction
            t(`клиентов найдено: ${new Set(entities.map((e) => e.client)).size} из ${CLIENTS.length}`, `clients found: ${new Set(entities.map((e) => e.client)).size} of ${CLIENTS.length}`),
          ].join(' · ')}
        </span>
        {updatedAt ? (
          <span title={t('Ядро следит за конфигами клиентов и присылает изменения само; если слежение не поднялось, обновляйте вручную', 'The core watches client configs and pushes changes by itself; if watching did not start, refresh manually')}>
            {t('обновлено', 'updated')} {fmtTime(updatedAt)}
          </span>
        ) : null}
        {/* the same counts as the Doctor's "Broken" and "Warnings" groups; the visible text starts the button name */}
        {problems > 0 ? (
          <button className="foot-link s-broken" onClick={() => setView('doctor')} aria-label={t(`сломано: ${problems}, открыть Доктора`, `broken: ${problems}, open Doctor`)}>
            <span aria-hidden="true">✕ </span>{t('сломано', 'broken')}: {problems}
          </button>
        ) : null}
        {cautions > 0 ? (
          <button className="foot-link s-stale" onClick={() => setView('doctor')} aria-label={t(`предупреждений: ${cautions}, открыть Доктора`, `warnings: ${cautions}, open Doctor`)}>
            <span aria-hidden="true">◐ </span>{t('предупреждений', 'warnings')}: {cautions}
          </button>
        ) : null}
        <span className="sp" />
        <Updates />
      </footer>

      {/* always in the DOM: a screen reader announces text that appears inside an existing live region */}
      <div className="toasts" role="status" aria-live="polite">
        {notice && notice.tone !== 'error' ? <Toast id="notice" tone={notice.tone} text={notice.text} onClose={() => setNotice(null)} /> : null}
      </div>
      <div className="toasts" role="alert">
        {notice?.tone === 'error' ? <Toast id="notice" tone="error" text={notice.text} onClose={() => setNotice(null)} /> : null}
      </div>

      {help ? (
        <Help
          topic={help}
          fx={fx}
          onFx={setFx}
          onWelcome={() => {
            setHelpState(null)
            helpFrom.current = null
            setWelcome(true)
            setView('matrix')
            requestAnimationFrame(() => document.querySelector<HTMLElement>('.welcome button.primary')?.focus())
          }}
          onClose={closeHelp}
        />
      ) : null}
      {palette ? <Palette items={paletteItems} onClose={() => setPalette(false)} /> : null}
      {flow?.type === 'plan' ? (
        <PlanDialog
          entity={flow.entity}
          intent={flow.intent}
          onBack={planBack ? () => setFlow(planBack) : undefined}
          onClose={closeFlow}
          onDone={(m) => {
            closeFlow()
            say(m)
          }}
        />
      ) : null}
      {flow?.type === 'edit' ? (
        <EditDialog entity={flow.entity} draft={flow.draft} onClose={closeFlow} onSubmit={(intent) => setFlow({ type: 'plan', entity: flow.entity, intent, back: formOf(flow.entity, intent) })} />
      ) : null}
      {flow?.type === 'add' ? (
        <AddDialog entities={entities} draft={flow.draft} onClose={closeFlow} onSubmit={(intent) => setFlow({ type: 'plan', entity: null, intent, back: formOf(null, intent) })} />
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
      {flow?.type === 'skill' ? (
        <SkillDialog onClose={closeFlow} onSubmit={(intent) => setFlow({ type: 'plan', entity: null, intent })} />
      ) : null}
      {flow?.type === 'copy' ? (
        <CopyDialog entity={flow.entity} draft={flow.draft} onClose={closeFlow} onSubmit={(intent) => setFlow({ type: 'plan', entity: flow.entity, intent, back: formOf(flow.entity, intent) })} />
      ) : null}
    </div>
  )
}
