import { useCallback, useEffect, useRef, useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { BatchPlan, Profile, ProfileItem, WriteLevel } from '../../shared/model'
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

/** Предпросмотр пакета: одним окном все записи профиля, которые отличаются от текущего состояния. */
function BatchDialog({ name, onClose, onDone }: BatchProps) {
  const [state, setState] = useState<BatchState>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const applyRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const build = useCallback(async () => {
    setState({ status: 'loading' })
    setApplyError(null)
    const r = await window.loadout.planProfile(name).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'не удалось построить план' }))
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
    const r = await window.loadout.applyProfile(name, state.plan.batchSha).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'запись не удалась' }))
    setBusy(false)
    if (r.ok) onDone(`Профиль «${name}» применён: ${r.data.applied.length} записей. Откатить пакет можно в журнале`)
    else setApplyError(r.error)
  }

  return (
    <Modal label={`Применить профиль: ${name}`} onEscape={onClose}>
      <h2>
        Применить профиль {state.status === 'ready' ? <span className="lvl">{state.plan.level}</span> : null}
      </h2>
      <p>
        <b>{name}</b>
      </p>
      {state.status === 'loading' ? (
        <p className="mute" role="status">Строю план…</p>
      ) : state.status === 'error' ? (
        <p className="s-broken" role="alert">{state.error}</p>
      ) : (
        <>
          {changes.length === 0 ? (
            <p className="mute">Всё уже в нужном состоянии, писать нечего.</p>
          ) : (
            <>
              <p>Изменится записей: {changes.length}</p>
              <ul className="plist" aria-label="Изменения профиля">
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
            <p className="s-stale">◐ Пропущено, записи уже нет или она не определилась: {state.plan.skipped.slice(0, 8).join(', ')}{state.plan.skipped.length > 8 ? ` и ещё ${state.plan.skipped.length - 8}` : ''}.</p>
          ) : null}
          {state.plan.running.length > 0 ? (
            <p className="s-stale">◐ Сейчас запущен {state.plan.running.join(', ')}: он может перезаписать файл своим состоянием. Лучше закрыть клиент и повторить.</p>
          ) : null}
          <p className="mute small">Каждая запись получит свой бэкап и строку журнала, весь пакет откатывается одной кнопкой. Если что-то изменится до записи, она не пройдёт.</p>
        </>
      )}
      {applyError ? <p className="s-broken" role="alert">{applyError}</p> : null}
      <div className="actions">
        <button ref={applyRef} disabled={state.status !== 'ready' || changes.length === 0 || busy} onClick={() => void apply()}>
          {busy ? 'Записываю…' : 'Применить'}
        </button>
        {applyError ? <button onClick={() => void build()}>Обновить предпросмотр</button> : null}
        <button ref={cancelRef} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  )
}

interface Props {
  level: WriteLevel
  onNotice: (message: string) => void
  /** Меняется, когда данные обновились: профиль, записи которого исчезли, перепроверяется при применении. */
  refreshKey: number
}

/** Профили: именованные наборы «что включено». Применение — пакет через тот же конвейер записи (R2). */
export function Profiles({ level, onNotice, refreshKey }: Props) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [draft, setDraft] = useState<Record<string, ProfileItem[]>>({})
  const [applying, setApplying] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await window.loadout.profiles().catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'профили не прочитаны' }))
    if (r.ok) {
      setProfiles(r.data)
      setError(null)
    } else setError(r.error)
  }, [])
  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const run = async (p: Promise<{ ok: true; data: Profile[] } | { ok: false; error: string }>, done?: string) => {
    const r = await p.catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : 'операция не удалась' }))
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
      <h2>Профили</h2>
      <div className="hud card">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault()
            if (nameOk) void run(window.loadout.saveProfile(name), `Профиль «${name}» сохранён`).then((ok) => ok && setName(''))
          }}
        >
          <label>
            Новый профиль из текущего состояния плагинов и MCP
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: рабочий" maxLength={40} aria-label="Имя профиля" />
          </label>
          <div className="actions">
            <button type="submit" disabled={!nameOk}>Снять с текущего состояния</button>
          </div>
        </form>
        <p className="mute small">Профиль хранит, что должно быть включено. Применение пишет в конфиги клиентов, поэтому нужен уровень R2; сами профили можно создавать и менять на любом уровне.</p>
      </div>
      {error ? <p className="s-broken" role="alert">{error}</p> : null}
      {profiles === null ? (
        <p className="mute" role="status">Читаю профили…</p>
      ) : profiles.length === 0 ? (
        <div className="hud card"><p>Профилей пока нет.</p></div>
      ) : (
        <div className="cards">
          {profiles.map((p) => {
            const items = draft[p.name] ?? p.items
            const dirty = draft[p.name] !== undefined
            return (
              <section key={p.name} className="hud card" aria-label={`Профиль ${p.name}`}>
                <h3>{p.name}</h3>
                <p className="mute small">{items.length} записей, из них включено {items.filter((i) => i.enable).length}</p>
                <details>
                  <summary>Записи профиля</summary>
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
                          включено
                        </label>
                      </li>
                    ))}
                  </ul>
                </details>
                <div className="actions col">
                  <button
                    disabled={!canApply}
                    title={canApply ? 'Предпросмотр и запись пакета' : 'Включите уровень R2 в шапке окна'}
                    onClick={() => setApplying(p.name)}
                  >
                    Применить…
                  </button>
                  <button
                    disabled={!dirty}
                    onClick={() => void run(window.loadout.saveProfile(p.name, items), `Профиль «${p.name}» сохранён`).then((ok) => ok && setDraft(({ [p.name]: _gone, ...rest }) => rest))}
                  >
                    Сохранить изменения
                  </button>
                  <button onClick={() => void run(window.loadout.deleteProfile(p.name), `Профиль «${p.name}» удалён`)}>Удалить профиль</button>
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
