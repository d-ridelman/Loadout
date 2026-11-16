import { useCallback, useEffect, useRef, useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { BatchPlan, Profile, ProfileItem, WriteLevel } from '../../shared/model'
import { t } from '../../shared/i18n'
import { levelOk } from './Inspector'
import { Modal } from './Modal'

const clientName = (id: string) => CLIENTS.find((c) => c.id === id)?.name ?? id

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
    if (r.ok) onDone(t(`Профиль «${name}» применён: ${r.data.applied.length} записей. Откатить пакет можно в журнале`, `Profile “${name}” applied: ${r.data.applied.length} entries. You can roll the batch back in the journal`))
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
        <button ref={applyRef} disabled={state.status !== 'ready' || changes.length === 0 || busy} onClick={() => void apply()}>
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
  onNotice: (message: string) => void
  /** Changes when the data is refreshed: a profile whose entries have disappeared is re-checked on apply. */
  refreshKey: number
}

/** Profiles: named sets of "what is enabled". Applying one is a batch through the same write pipeline (R2). */
export function Profiles({ level, onNotice, refreshKey }: Props) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [draft, setDraft] = useState<Record<string, ProfileItem[]>>({})
  const [applying, setApplying] = useState<string | null>(null)

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
    <div className="page">
      <h2>{t('Профили', 'Profiles')}</h2>
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
            <button type="submit" disabled={!nameOk}>{t('Снять с текущего состояния', 'Capture current state')}</button>
          </div>
        </form>
        <p className="mute small">{t('Профиль хранит, что должно быть включено. Применение пишет в конфиги клиентов, поэтому нужен уровень R2; сами профили можно создавать и менять на любом уровне.', 'A profile stores what should be enabled. Applying writes to client configs, so level R2 is required; profiles themselves can be created and edited at any level.')}</p>
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
        <div className="hud card"><p>{t('Профилей пока нет.', 'No profiles yet.')}</p></div>
      ) : (
        <div className="cards">
          {profiles.map((p) => {
            const items = draft[p.name] ?? p.items
            const dirty = draft[p.name] !== undefined
            return (
              <section key={p.name} className="hud card" aria-label={t(`Профиль ${p.name}`, `Profile ${p.name}`)}>
                <h3>{p.name}</h3>
                <p className="mute small">{t(`${items.length} записей, из них включено ${items.filter((i) => i.enable).length}`, `${items.length} entries, ${items.filter((i) => i.enable).length} enabled`)}</p>
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
                <div className="actions col">
                  <button
                    disabled={!canApply}
                    title={canApply ? t('Предпросмотр и запись пакета', 'Preview and write the batch') : t('Включите уровень R2 в шапке окна', 'Enable level R2 in the window header')}
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
                  <button className="danger" onClick={() => void run(window.loadout.deleteProfile(p.name), t(`Профиль «${p.name}» удалён`, `Profile “${p.name}” deleted`))}>{t('Удалить профиль', 'Delete profile')}</button>
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
    </div>
  )
}
