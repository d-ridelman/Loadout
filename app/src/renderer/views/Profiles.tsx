import { useCallback, useEffect, useRef, useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { BatchPlan, Entity, Profile, ProfileItem, WriteLevel } from '../../shared/model'
import { count, t } from '../../shared/i18n'
import { PageHead, pickLevel } from '../ui'
import type { Notify } from '../ui'
import { levelOk } from './Inspector'
import { Modal } from './Modal'

const clientName = (id: string) => CLIENTS.find((c) => c.id === id)?.name ?? id
const entries = (n: number): string => count(n, ['запись', 'записи', 'записей'], ['entry', 'entries'])

/**
 * The profile describes the current state exactly: every entry exists and is on or off as the profile says (the same match
 * and the same "on" as the core uses when it captures and applies a profile). An empty profile matches nothing.
 */
export function matchesNow(p: Profile, entities: readonly Entity[]): boolean {
  return (
    p.items.length > 0 &&
    p.items.every((it) => {
      const hits = entities.filter((e) => e.canToggle && e.client === it.client && e.kind === it.kind && e.scope === it.scope && e.name === it.name)
      return hits.length > 0 && hits.every((e) => (e.state === 'on' || e.state === 'stale' ? true : e.state === 'off' ? false : null) === it.enable)
    })
  )
}

interface BatchProps {
  name: string
  onClose: () => void
  onDone: (message: string) => void
}

type BatchState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; plan: BatchPlan & { running: string[] } }

/** Batch preview: all profile entries that differ from the current state in one window. */
function BatchDialog({ name, onClose, onDone }: BatchProps) {
  const [state, setState] = useState<BatchState>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const applyRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const build = useCallback(async () => {
    setState({ status: 'loading' })
    setApplyError(null)
    const r = await window.loadout.planProfile(name).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : t('не удалось построить план', 'could not build the plan') }))
    setState(r.ok ? { status: 'ready', plan: r.data } : { status: 'error', error: r.error })
  }, [name])
  useEffect(() => {
    void build()
  }, [build])
  useEffect(() => cancelRef.current?.focus(), [])
  useEffect(() => {
    if (state.status === 'ready') applyRef.current?.focus()
  }, [state.status])

  const changes = state.status === 'ready' ? state.plan.plans.filter((p) => !p.noop) : []
  const apply = async () => {
    if (state.status !== 'ready' || busy) return
    setBusy(true)
    setApplyError(null)
    const r = await window.loadout.applyProfile(name, state.plan.batchSha).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : t('запись не удалась', 'write failed') }))
    setBusy(false)
    if (r.ok) onDone(t(`Профиль «${name}» применён: ${entries(r.data.applied.length)}. Откатить пакет можно в журнале`, `Profile “${name}” applied: ${entries(r.data.applied.length)}. You can roll the batch back in the journal`))
    else setApplyError(r.error)
  }

  return (
    <Modal label={t(`Применить профиль: ${name}`, `Apply profile: ${name}`)} onEscape={onClose}>
      <h2>
        {t('Применить профиль', 'Apply profile')} {state.status === 'ready' ? <span className="lvl">{state.plan.level}</span> : null}
      </h2>
      <p>
        <b>{name}</b>
      </p>
      {state.status === 'loading' ? (
        <p className="mute" role="status">{t('Строю план…', 'Building the plan…')}</p>
      ) : state.status === 'error' ? (
        <p className="s-broken" role="alert">{state.error}</p>
      ) : (
        <>
          {changes.length === 0 ? (
            <p className="mute">{t('Всё уже в нужном состоянии, писать нечего.', 'Everything is already in the right state, nothing to write.')}</p>
          ) : (
            <>
              <p>{t(`Изменится записей: ${changes.length}`, `Entries to change: ${changes.length}`)}</p>
              <ul className="plist" aria-label={t('Изменения профиля', 'Profile changes')}>
                {changes.map((p) => (
                  <li key={p.entity} className="pitem">
                    <span>
                      <b>{p.name}</b> <span className="mute">· {clientName(p.client)}</span>
                    </span>
                    <span className="mono mute">{p.from} → {p.to}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {state.plan.skipped.length > 0 ? (
            <p className="s-stale">◐ {t('Пропущено, записи уже нет или она не определилась:', 'Skipped, the entry is gone or could not be resolved:')} {state.plan.skipped.slice(0, 8).join(', ')}{state.plan.skipped.length > 8 ? t(` и ещё ${state.plan.skipped.length - 8}`, ` and ${state.plan.skipped.length - 8} more`) : ''}.</p>
          ) : null}
          {state.plan.running.length > 0 ? (
            <p className="s-stale">◐ {t(`Сейчас запущен ${state.plan.running.join(', ')}: он может перезаписать файл своим состоянием. Лучше закрыть клиент и повторить.`, `${state.plan.running.join(', ')} is running now: it may overwrite the file with its own state. Better close the client and retry.`)}</p>
          ) : null}
          <p className="mute small">{t('Каждая запись получит свой бэкап и строку журнала, весь пакет откатывается одной кнопкой. Если что-то изменится до записи, она не пройдёт.', 'Each entry gets its own backup and journal row, and the whole batch rolls back with one button. If anything changes before the write, it will not go through.')}</p>
        </>
      )}
      {applyError ? <p className="s-broken" role="alert">{applyError}</p> : null}
      <div className="actions">
        <button ref={applyRef} className="primary" disabled={state.status !== 'ready' || changes.length === 0 || busy} onClick={() => void apply()}>
          {busy ? t('Записываю…', 'Writing…') : t('Применить', 'Apply')}
        </button>
        {applyError ? <button onClick={() => void build()}>{t('Обновить предпросмотр', 'Refresh preview')}</button> : null}
        <button ref={cancelRef} onClick={onClose}>{t('Отмена', 'Cancel')}</button>
      </div>
    </Modal>
  )
}

interface Props {
  level: WriteLevel
  onNotice: Notify
  /** Changes when the data is refreshed: a profile whose entries have disappeared is re-checked on apply. */
  refreshKey: number
  /** The current scan: the profile that matches it is marked. */
  entities: readonly Entity[]
}

/** Profiles: named sets of "what is enabled". Applying one is a batch through the same write pipeline (R2). */
export function Profiles({ level, onNotice, refreshKey, entities }: Props) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [draft, setDraft] = useState<Record<string, ProfileItem[]>>({})
  const [applying, setApplying] = useState<string | null>(null)
  /** The profile whose delete button was pressed once: the second press, on "Delete for good", deletes. */
  const [deleting, setDeleting] = useState<string | null>(null)
  const [kept, setKept] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await window.loadout.profiles().catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : t('профили не прочитаны', 'could not read profiles') }))
    if (r.ok) {
      setProfiles(r.data)
      setError(null)
    } else setError(r.error)
  }, [])
  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const run = async (p: Promise<{ ok: true; data: Profile[] } | { ok: false; error: string }>, done?: string) => {
    const r = await p.catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : t('операция не удалась', 'operation failed') }))
    if (r.ok) {
      setProfiles(r.data)
      setError(null)
      if (done) onNotice(done)
    } else setError(r.error)
    return r.ok
  }

  const canApply = levelOk(level, 'R2')
  const nameOk = /^[\p{L}\p{N} _.-]{1,40}$/u.test(name) && name.trim() === name
  return (
    <>
      <PageHead
        title={t('Профили', 'Profiles')}
        sub={t(
          'Профиль запоминает, что включено. Сохраните текущее состояние под именем, и потом к нему можно вернуться одной кнопкой.',
          'A profile remembers what is turned on. Save the current state under a name and return to it later with one button.',
        )}
      />
      <div className="hud card">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            if (nameOk) void run(window.loadout.saveProfile(name), t(`Профиль «${name}» сохранён`, `Profile “${name}” saved`)).then((ok) => ok && setName(''))
          }}
        >
          <label>
            {t('Новый профиль из текущего состояния плагинов и MCP', 'New profile from the current state of plugins and MCP')}
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Например: рабочий', 'For example: work')} maxLength={40} aria-label={t('Имя профиля', 'Profile name')} />
          </label>
          <div className="actions">
            <button type="submit" className="primary" disabled={!nameOk}>{t('Снять с текущего состояния', 'Capture current state')}</button>
          </div>
        </form>
        <p className="mute small">{t('Применение профиля пишет в конфиги клиентов, поэтому нужен уровень «Все правки · R2». Сами профили можно создавать и менять на любом уровне.', 'Applying a profile writes to client configs, so it needs the “All edits · R2” level. Profiles themselves can be created and edited at any level.')}</p>
      </div>
      {error ? <p className="s-broken" role="alert">{error}</p> : null}
      {error?.includes('profiles.json') ? (
        <div className="actions">
          <button
            onClick={() =>
              void window.loadout
                .quarantineProfiles()
                .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : t('операция не удалась', 'operation failed') }))
                .then((r) => {
                  // on refusal the reason stays on screen: a re-read would overwrite it with the previous error
                  if (!r.ok) return setError(r.error)
                  onNotice(t(`Повреждённый файл отложен: ${r.data}`, `The damaged file was set aside: ${r.data}`))
                  return load()
                })
            }
          >
            {t('Отложить повреждённый profiles.json', 'Set the damaged profiles.json aside')}
          </button>
        </div>
      ) : null}
      {profiles === null ? (
        error ? null : <p className="mute" role="status">{t('Читаю профили…', 'Reading profiles…')}</p>
      ) : profiles.length === 0 ? (
        <div className="hud card">
          <p>{t('Профилей пока нет.', 'No profiles yet.')}</p>
          <p className="mute">{t('Введите имя выше и нажмите «Снять с текущего состояния»: профиль запомнит, какие плагины и MCP-серверы сейчас включены.', 'Type a name above and press “Capture current state”: the profile remembers which plugins and MCP servers are on now.')}</p>
        </div>
      ) : (
        <div className="cards">
          {profiles.map((p) => {
            const items = draft[p.name] ?? p.items
            const dirty = draft[p.name] !== undefined
            const current = matchesNow(p, entities)
            return (
              <section key={p.name} className={`hud card${current ? ' current' : ''}`} aria-label={t(`Профиль ${p.name}`, `Profile ${p.name}`)}>
                <h3>
                  {p.name}
                  {current ? <span className="badge now">{t('● совпадает с текущим состоянием', '● matches the current state')}</span> : null}
                </h3>
                <p className="mute small">{t(`${entries(items.length)}, из них включено ${items.filter((i) => i.enable).length}`, `${entries(items.length)}, ${items.filter((i) => i.enable).length} enabled`)}</p>
                <details>
                  <summary>{t('Записи профиля', 'Profile entries')}</summary>
                  <ul className="plist">
                    {items.map((it, i) => (
                      <li key={`${it.client}|${it.kind}|${it.scope}|${it.name}`} className="pitem">
                        <span>
                          <b>{it.name}</b> <span className="mute">· {clientName(it.client)} · {it.kind}</span>
                        </span>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={it.enable}
                            onChange={(e) => setDraft({ ...draft, [p.name]: items.map((x, j) => (j === i ? { ...x, enable: e.target.checked } : x)) })}
                          />
                          {t('включено', 'enabled')}
                        </label>
                      </li>
                    ))}
                  </ul>
                </details>
                {/* apply and save on the left, delete on the far right: the destructive button is not next to the main one */}
                <div className="actions split">
                  <button
                    className="primary"
                    disabled={!canApply}
                    title={canApply ? t('Предпросмотр и запись пакета', 'Preview and write the batch') : pickLevel('R2')}
                    onClick={() => setApplying(p.name)}
                  >
                    {t('Применить…', 'Apply…')}
                  </button>
                  <button
                    disabled={!dirty}
                    onClick={() => void run(window.loadout.saveProfile(p.name, items), t(`Профиль «${p.name}» сохранён`, `Profile “${p.name}” saved`)).then((ok) => ok && setDraft(({ [p.name]: _gone, ...rest }) => rest))}
                  >
                    {t('Сохранить изменения', 'Save changes')}
                  </button>
                  <span className="sp" />
                  {deleting === p.name ? (
                    <>
                      <span className="s-broken small">{t('Профиль удалится без отката.', 'The profile is deleted with no rollback.')}</span>
                      <button
                        className="danger"
                        onClick={() => {
                          setDeleting(null)
                          void run(window.loadout.deleteProfile(p.name), t(`Профиль «${p.name}» удалён`, `Profile “${p.name}” deleted`))
                        }}
                      >
                        {t('Удалить навсегда', 'Delete for good')}
                      </button>
                      {/* focus on the safe choice: a double click or a held Enter does not delete */}
                      <button
                        autoFocus
                        onClick={() => {
                          setKept(p.name)
                          setDeleting(null)
                        }}
                      >
                        {t('Не удалять', 'Keep it')}
                      </button>
                    </>
                  ) : (
                    // after "Keep it" the focus comes back here instead of falling to the page body
                    <button className="danger" autoFocus={kept === p.name}
                      onClick={() => {
                        setKept(null)
                        setDeleting(p.name)
                      }}
                    >
                      {t('Удалить профиль…', 'Delete profile…')}
                    </button>
                  )}
                </div>
              </section>
            )
          })}
        </div>
      )}
      {applying ? (
        <BatchDialog
          name={applying}
          onClose={() => setApplying(null)}
          onDone={(m) => {
            setApplying(null)
            onNotice(m)
          }}
        />
      ) : null}
    </>
  )
}
