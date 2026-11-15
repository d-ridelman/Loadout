import { useCallback, useEffect, useRef, useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { Entity, Plan } from '../../shared/model'

type PlanState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; plan: Plan & { running: string[] } }

interface Props {
  entity: Entity
  enable: boolean
  onClose: () => void
  /** Запись выполнена: окно получит новые данные от сторожа, здесь — только сообщение. */
  onDone: (message: string) => void
}

/** Предпросмотр переключения (CONCEPT.md §5, шаги 1–2): что именно поменяется, и только после подтверждения запись. */
export function ToggleDialog({ entity, enable, onClose, onDone }: Props) {
  const [state, setState] = useState<PlanState>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const applyRef = useRef<HTMLButtonElement>(null)

  const build = useCallback(async () => {
    setState({ status: 'loading' })
    setApplyError(null)
    try {
      const r = await window.loadout.plan(entity.id, enable)
      setState(r.ok ? { status: 'ready', plan: r.data } : { status: 'error', error: r.error })
    } catch (e) {
      setState({ status: 'error', error: e instanceof Error ? e.message : 'не удалось построить план' })
    }
  }, [entity.id, enable])

  useEffect(() => {
    void build()
  }, [build])
  useEffect(() => {
    if (state.status === 'ready') applyRef.current?.focus()
  }, [state.status])

  const apply = async () => {
    if (state.status !== 'ready' || busy) return
    setBusy(true)
    setApplyError(null)
    try {
      const r = await window.loadout.apply(entity.id, enable, state.plan.baseSha)
      if (r.ok) onDone(`${enable ? 'Включено' : 'Выключено'}: ${entity.name}. Откат — в журнале`)
      else setApplyError(r.error)
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : 'запись не удалась')
    } finally {
      setBusy(false)
    }
  }

  const client = CLIENTS.find((c) => c.id === entity.client)?.name ?? entity.client
  const verb = enable ? 'Включить' : 'Выключить'
  return (
    <div className="modal" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="hud box" role="dialog" aria-modal="true" aria-label={`${verb}: ${entity.name}`}>
        <h2>{verb}</h2>
        <p>
          <b>{entity.name}</b> <span className="mute">· {client}</span>
        </p>
        {state.status === 'loading' ? (
          <p className="mute" role="status">Строю план…</p>
        ) : state.status === 'error' ? (
          <p className="s-broken" role="alert">{state.error}</p>
        ) : (
          <>
            <dl className="kv">
              <dt>файл</dt><dd className="wrap">{state.plan.file}</dd>
              <dt>ключ</dt><dd className="wrap">{state.plan.pointer}</dd>
              <dt>значение</dt>
              <dd>
                <span className="mono">{state.plan.from}</span> → <b className="mono">{state.plan.to}</b>
              </dd>
            </dl>
            {state.plan.noop ? <p className="mute">Запись уже в нужном состоянии, писать нечего.</p> : null}
            {state.plan.affects.length > 0 ? (
              <p className="s-stale">
                ◐ Этот же ключ меняет ещё {state.plan.affects.length} {state.plan.affects.length === 1 ? 'запись' : 'записей'}: так устроено в самом клиенте.
              </p>
            ) : null}
            {state.plan.running.length > 0 ? (
              <p className="s-stale">
                ◐ Сейчас запущен {state.plan.running.join(', ')}: он может перезаписать файл своим состоянием. Лучше закрыть клиент и повторить.
              </p>
            ) : null}
            <p className="mute small">
              Перед записью копия файла сохранится в бэкап, остальное содержимое файла не меняется. Если файл изменится до записи, она не пройдёт.
            </p>
          </>
        )}
        {applyError ? <p className="s-broken" role="alert">{applyError}</p> : null}
        <div className="actions">
          <button ref={applyRef} disabled={state.status !== 'ready' || state.plan.noop || busy} onClick={() => void apply()}>
            {busy ? 'Записываю…' : 'Применить'}
          </button>
          {applyError ? <button onClick={() => void build()}>Обновить предпросмотр</button> : null}
          <button onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  )
}
