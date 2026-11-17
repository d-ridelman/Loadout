import { useEffect, useMemo, useRef, useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { BatchPlan, ClientId, Entity, Intent, ProjectInfo } from '../../shared/model'
import { count, t } from '../../shared/i18n'
import { Cmd, kindLabel, Path } from '../ui'
import { copyIntent } from './CopyDialog'
import { Modal } from './Modal'
import { Warn } from './PlanDialog'

const clientName = (id: string) => CLIENTS.find((c) => c.id === id)?.name ?? id
const entries = (n: number): string => count(n, ['запись', 'записи', 'записей'], ['entry', 'entries'])

/** One row of the list: an entry the source client has here, and why the target cannot take it (if so). */
export interface Candidate {
  entity: Entity
  why?: string
}

/** The source client's copyable entries in the chosen place, in a stable order; refused ones carry their reason. */
export function candidates(list: readonly Entity[], from: ClientId, to: ClientId | null, project: boolean): Candidate[] {
  return list
    .filter((e) => e.client === from && e.canCopy && (project ? e.scope.startsWith('project:') : e.scope === 'user'))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    .map((entity) => {
      const why = to ? entity.copyWhy?.[to] : undefined
      return why ? { entity, why } : { entity }
    })
}

/** Clients that have something to copy in this place: the choices for "From". */
export function sources(list: readonly Entity[], project: boolean): ClientId[] {
  return CLIENTS.map((c) => c.id).filter((id) => candidates(list, id, null, project).length > 0)
}

interface Props {
  /** The full scan: user-scope entries come from it, project ones from the project's own scan. */
  entities: readonly Entity[]
  onClose: () => void
  onDone: (message: string) => void
}

type Step =
  | { status: 'form' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; plan: BatchPlan & { running: string[] } }

/**
 * Copy several entries of one client to another in one batch: globally, or inside one project the core knows. The page
 * sends only entry ids and the project id; the preview shows every file and key, the journal rolls the batch back as a whole.
 */
export function TransferDialog({ entities, onClose, onDone }: Props) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null)
  const [place, setPlace] = useState('')
  const [projectEntities, setProjectEntities] = useState<Entity[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [from, setFrom] = useState<ClientId | null>(null)
  const [to, setTo] = useState<ClientId | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [step, setStep] = useState<Step>({ status: 'form' })
  const [busy, setBusy] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const applyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    void window.loadout.projects().then((r) => (r.ok ? setProjects(r.data) : setLoadError(r.error)))
  }, [])
  useEffect(() => {
    setProjectEntities(null)
    setLoadError(null)
    if (place === '') return
    void window.loadout.projectScan(place).then((r) => (r.ok ? setProjectEntities(r.data.entities) : setLoadError(r.error)))
  }, [place])

  const inProject = place !== ''
  const list = inProject ? (projectEntities ?? []) : entities
  const fromChoices = useMemo(() => sources(list, inProject), [list, inProject])
  const rows = useMemo(() => (from ? candidates(list, from, to, inProject) : []), [list, from, to, inProject])
  // A new place, source or target starts with every entry the target can take. Not on every rescan: a running client
  // rewrites its files often, and the boxes the person unticked must stay unticked.
  const resetKey = `${place}|${from ?? ''}|${to ?? ''}|${inProject && projectEntities === null ? 'loading' : 'ready'}`
  useEffect(() => setPicked(new Set(rows.filter((r) => !r.why).map((r) => r.entity.id))), [resetKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const items: Intent[] = rows.filter((r) => !r.why && picked.has(r.entity.id)).map((r) => copyIntent(r.entity, to as ClientId))
  const build = async () => {
    setStep({ status: 'loading' })
    setApplyError(null)
    const r = await window.loadout.planCopies(items).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : t('не удалось построить план', 'could not build the plan') }))
    setStep(r.ok ? { status: 'ready', plan: r.data } : { status: 'error', error: r.error })
  }
  useEffect(() => {
    if (step.status === 'ready') applyRef.current?.focus()
  }, [step.status])

  const apply = async () => {
    if (step.status !== 'ready' || busy) return
    setBusy(true)
    setApplyError(null)
    const r = await window.loadout.applyCopies(items, step.plan.batchSha).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : t('запись не удалась', 'write failed') }))
    setBusy(false)
    if (r.ok) onDone(t(`Скопировано в ${clientName(to ?? '')}: ${entries(r.data.applied.length)}. Откатить пакет можно в журнале`, `Copied to ${clientName(to ?? '')}: ${entries(r.data.applied.length)}. You can roll the batch back in the journal`))
    else setApplyError(r.error)
  }

  const head = t('Копировать из другого клиента', 'Copy from another client')
  if (step.status !== 'form') {
    return (
      <Modal label={head} onEscape={onClose}>
        <h2>
          {head} {step.status === 'ready' ? <span className="lvl">{step.plan.level}</span> : null}
        </h2>
        <p>
          <b>{clientName(from ?? '')} → {clientName(to ?? '')}</b>
          <span className="mute"> · {inProject ? projects?.find((p) => p.id === place)?.path : t('глобально', 'globally')}</span>
        </p>
        {step.status === 'loading' ? (
          <p className="mute" role="status">{t('Строю план…', 'Building the plan…')}</p>
        ) : step.status === 'error' ? (
          <p className="s-broken" role="alert">{step.error}</p>
        ) : (
          <>
            {step.plan.plans.length === 0 ? (
              <p className="mute">{t('Копировать нечего: ни одна запись не прошла проверку.', 'Nothing to copy: no entry passed the checks.')}</p>
            ) : (
              <ul className="plist tlist" aria-label={t('Что будет скопировано', 'What will be copied')}>
                {step.plan.plans.map((p) => (
                  <li key={p.entity} className="pitem">
                    <span>
                      <b>{p.name}</b> <span className="mute">· {kindLabel(p.kind)}</span>
                    </span>
                    <span className="wrap small"><Path p={p.file} />{p.pointer ? <span className="mute"> {p.pointer}</span> : null}</span>
                    <span className="mono mute small"><Cmd text={p.to} /></span>
                    <Warn lines={p.warn} />
                    {p.notes.map((n) => (
                      <span key={n} className="s-stale small">◐ {n}</span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            {step.plan.skipped.length > 0 ? (
              <div className="s-stale" role="note">
                <p>◐ {t('Не будут скопированы:', 'Will not be copied:')}</p>
                <ul>
                  {step.plan.skipped.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {step.plan.running.length > 0 ? (
              <p className="s-stale">◐ {t(`Сейчас запущен ${step.plan.running.join(', ')}: он может перезаписать файл своим состоянием. Лучше закрыть клиент и повторить.`, `${step.plan.running.join(', ')} is running now: it may overwrite the file with its own state. Better close the client and retry.`)}</p>
            ) : null}
            <p className="mute small">{t('Каждая запись получит свой бэкап и строку журнала, весь пакет откатывается одной кнопкой. Источник не меняется. Если что-то изменится до записи, она не пройдёт.', 'Each entry gets its own backup and journal row, and the whole batch rolls back with one button. The source does not change. If anything changes before the write, it will not go through.')}</p>
          </>
        )}
        {applyError ? <p className="s-broken" role="alert">{applyError}</p> : null}
        <div className="actions">
          <button ref={applyRef} className="primary" disabled={step.status !== 'ready' || step.plan.plans.length === 0 || busy} onClick={() => void apply()}>
            {busy ? t('Записываю…', 'Writing…') : t('Скопировать', 'Copy')}
          </button>
          {applyError ? <button onClick={() => void build()}>{t('Обновить предпросмотр', 'Refresh preview')}</button> : null}
          <button disabled={busy} onClick={() => setStep({ status: 'form' })}>{t('Назад к форме', 'Back to the form')}</button>
          <button onClick={onClose}>{t('Отмена', 'Cancel')}</button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal label={head} onEscape={onClose}>
      <h2>
        {head} <span className="lvl">R2</span>
      </h2>
      <p className="mute small">
        {t(
          'Копируются скилы, хуки и MCP-серверы; источник не меняется. Запись проекта копируется в тот же проект. Плагины как пакеты не копируются: что с ними делать, сказано в инспекторе плагина.',
          'Skills, hooks and MCP servers are copied; the source does not change. A project entry is copied into the same project. Plugins are not copied as packages: the plugin’s inspector says what to do instead.',
        )}
      </p>
      <label className="tfield">
        <span className="mute small">{t('Где', 'Where')}</span>
        <select autoFocus value={place} onChange={(e) => { setPlace(e.target.value); setFrom(null); setTo(null) }}>
          <option value="">{t('Глобально (для всех проектов)', 'Globally (for all projects)')}</option>
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>{t(`Проект ${p.path}`, `Project ${p.path}`)}</option>
          ))}
        </select>
      </label>
      {loadError ? <p className="s-broken" role="alert">{loadError}</p> : null}
      {inProject && projectEntities === null && !loadError ? <p className="mute" role="status">{t('Читаю проект…', 'Reading the project…')}</p> : null}
      {(!inProject || projectEntities !== null) && fromChoices.length === 0 ? (
        <p className="mute">{t('Здесь нет записей, которые можно скопировать.', 'There are no entries to copy here.')}</p>
      ) : null}
      {fromChoices.length > 0 ? (
        <div className="cols2">
          <fieldset className="choices">
            <legend className="mute small">{t('Откуда', 'From')}</legend>
            {fromChoices.map((id) => (
              <label key={id}>
                <input type="radio" name="from" checked={from === id} onChange={() => { setFrom(id); if (to === id) setTo(null) }} /> {clientName(id)}
              </label>
            ))}
          </fieldset>
          <fieldset className="choices">
            <legend className="mute small">{t('Куда', 'To')}</legend>
            {CLIENTS.filter((c) => c.id !== from).map((c) => (
              <label key={c.id}>
                <input type="radio" name="to" disabled={from === null} checked={to === c.id} onChange={() => setTo(c.id)} /> {c.name}
              </label>
            ))}
          </fieldset>
        </div>
      ) : null}
      {from && to ? (
        rows.length === 0 ? (
          <p className="mute">{t('У этого клиента здесь нечего копировать.', 'This client has nothing to copy here.')}</p>
        ) : (
          <fieldset className="choices checks">
            <legend className="mute small">
              {t(`Записи (${picked.size} из ${rows.length})`, `Entries (${picked.size} of ${rows.length})`)}
            </legend>
            {rows.map(({ entity: e, why }) => (
              <label key={e.id} className={why ? 'off' : undefined}>
                <input
                  type="checkbox"
                  disabled={why !== undefined}
                  checked={!why && picked.has(e.id)}
                  onChange={(ev) => {
                    const next = new Set(picked)
                    if (ev.target.checked) next.add(e.id)
                    else next.delete(e.id)
                    setPicked(next)
                  }}
                />
                <span>
                  {e.name} <span className="mute small">· {kindLabel(e.kind)}</span>
                  {why ? <span className="mute small"> — {why}</span> : null}
                </span>
              </label>
            ))}
          </fieldset>
        )
      ) : null}
      <div className="actions">
        <button className="primary" disabled={!from || !to || items.length === 0} onClick={() => void build()}>{t('Предпросмотр', 'Preview')}</button>
        <button onClick={onClose}>{t('Отмена', 'Cancel')}</button>
      </div>
    </Modal>
  )
}
