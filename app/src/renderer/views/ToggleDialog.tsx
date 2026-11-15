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
  const cancelRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

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
  // фокус в диалоге с самого начала (на «Отмена»), когда план готов и запись возможна — на «Применить»
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])
  useEffect(() => {
    if (state.status === 'ready') applyRef.current?.focus()
  }, [state.status])

  /** Ловушка фокуса: Tab ходит по кнопкам диалога и не выпускает фокус на страницу под ним. */
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const btns = [...(boxRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const first = btns[0]
    const last = btns[btns.length - 1]
    if (!first || !last) return
    const cur = document.activeElement
    if (e.shiftKey && cur === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && cur === last) {
      e.preventDefault()
      first.focus()
    }
  }

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
    <div className="modal" onKeyDown={trapTab}>
      <div ref={boxRef} className="hud box" role="dialog" aria-modal="true" aria-label={`${verb}: ${entity.name}`}>
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
          <button ref={cancelRef} onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  )
}
