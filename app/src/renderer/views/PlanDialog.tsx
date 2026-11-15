import { useCallback, useEffect, useRef, useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { Entity, Intent, Plan } from '../../shared/model'
import { Modal } from './Modal'

type PlanState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; plan: Plan & { running: string[] } }

interface Props {
  entity: Entity
  intent: Intent
  onClose: () => void
  /** Запись выполнена: окно получит новые данные от сторожа, здесь — только сообщение. */
  onDone: (message: string) => void
}

function title(p: Plan | undefined, intent: Intent): string {
  const op = p?.op ?? intent.op
  if (op === 'edit') return 'Правка команды'
  if (op === 'copy') return 'Копирование в другой клиент'
  return intent.op === 'toggle' && intent.enable ? 'Включить' : 'Выключить'
}

/** Название главной кнопки по операции, а не общее «Применить»: видно, что именно произойдёт. */
function applyLabel(p: Plan | undefined, intent: Intent): string {
  if (intent.op === 'edit') return 'Записать команду'
  if (intent.op === 'copy') return 'Скопировать'
  if (p?.from.includes('корзин')) return 'Вернуть из корзины'
  if (!intent.enable && p?.to.includes('корзин')) return 'Вынести в корзину'
  return intent.enable ? 'Включить' : 'Выключить'
}

/** Предпросмотр любой записи (CONCEPT.md §5, шаги 1–2): что именно поменяется, и только после подтверждения запись. */
export function PlanDialog({ entity, intent, onClose, onDone }: Props) {
  const [state, setState] = useState<PlanState>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const applyRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const build = useCallback(async () => {
    setState({ status: 'loading' })
    setApplyError(null)
    try {
      const r = await window.loadout.plan(intent)
      setState(r.ok ? { status: 'ready', plan: r.data } : { status: 'error', error: r.error })
    } catch (e) {
      setState({ status: 'error', error: e instanceof Error ? e.message : 'не удалось построить план' })
    }
  }, [intent])

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

  const apply = async () => {
    if (state.status !== 'ready' || busy) return
    setBusy(true)
    setApplyError(null)
    try {
      const r = await window.loadout.apply(intent, state.plan.baseSha)
      if (r.ok) onDone(`${title(state.plan, intent)}: ${entity.name}. Откат — в журнале`)
      else setApplyError(r.error)
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : 'запись не удалась')
    } finally {
      setBusy(false)
    }
  }

  const plan = state.status === 'ready' ? state.plan : undefined
  const client = CLIENTS.find((c) => c.id === (plan?.client ?? entity.client))?.name ?? entity.client
  return (
    <Modal label={`${title(plan, intent)}: ${entity.name}`} onEscape={onClose}>
      <h2>
        {title(plan, intent)} {plan ? <span className="lvl">{plan.level}</span> : null}
      </h2>
      <p>
        <b>{entity.name}</b>{' '}
        <span className="mute">
          · {plan?.op === 'copy' ? `${CLIENTS.find((c) => c.id === entity.client)?.name ?? entity.client} → ${client}` : client}
        </span>
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
            <dt>было</dt><dd className="wrap mono">{state.plan.from}</dd>
            <dt>станет</dt><dd className="wrap mono"><b>{state.plan.to}</b></dd>
          </dl>
          {state.plan.noop ? <p className="mute">Запись уже в нужном состоянии, писать нечего.</p> : null}
          {state.plan.affects.length > 0 ? (
            <p className="s-stale">
              ◐ Этот же ключ меняет ещё {state.plan.affects.length} {state.plan.affects.length === 1 ? 'запись' : 'записей'}: так устроено в самом клиенте.
            </p>
          ) : null}
          {state.plan.notes.map((n) => (
            <p key={n} className="s-stale">◐ {n}</p>
          ))}
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
          {busy ? 'Записываю…' : applyLabel(plan, intent)}
        </button>
        {applyError ? <button onClick={() => void build()}>Обновить предпросмотр</button> : null}
        <button ref={cancelRef} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  )
}
