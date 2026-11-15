import { useCallback, useEffect, useRef, useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { Entity, Intent, Plan } from '../../shared/model'
import { t } from '../../shared/i18n'
import { Path } from '../ui'
import { Modal } from './Modal'

type PlanState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; plan: Plan & { running: string[] } }

interface Props {
  /** `null` у добавления нового сервера: записи ещё нет. */
  entity: Entity | null
  intent: Intent
  onClose: () => void
  /** Запись выполнена: окно получит новые данные от сторожа, здесь — только сообщение. */
  onDone: (message: string) => void
}

function title(p: Plan | undefined, intent: Intent): string {
  const op = p?.op ?? intent.op
  if (op === 'add') return t('Добавить MCP-сервер', 'Add MCP server')
  if (op === 'edit') return t('Правка команды', 'Edit command')
  if (op === 'copy') return t('Копирование в другой клиент', 'Copy to another client')
  if (op === 'installSkill') return t('Установить скил', 'Install skill')
  return intent.op === 'toggle' && intent.enable ? t('Включить', 'Enable') : t('Выключить', 'Disable')
}

/** Название главной кнопки по операции, а не общее «Применить»: видно, что именно произойдёт. */
function applyLabel(p: Plan | undefined, intent: Intent): string {
  if (intent.op === 'add') return t('Добавить', 'Add')
  if (intent.op === 'edit') return t('Записать команду', 'Write command')
  if (intent.op === 'copy') return t('Скопировать', 'Copy')
  if (intent.op === 'installSkill') return t('Установить', 'Install')
  if (p?.trash === 'in') return t('Вернуть из корзины', 'Restore from trash')
  if (!intent.enable && p?.trash === 'out') return t('Вынести в корзину', 'Move to trash')
  return intent.enable ? t('Включить', 'Enable') : t('Выключить', 'Disable')
}

/** Предпросмотр любой записи (CONCEPT.md §5, шаги 1–2): что именно поменяется, и только после подтверждения запись. */
export function PlanDialog({ entity, intent, onClose, onDone }: Props) {
  const [state, setState] = useState<PlanState>({ status: 'loading' })
  const shown = entity?.name ?? (intent.op === 'add' || intent.op === 'installSkill' ? intent.name : '')
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
      setState({ status: 'error', error: e instanceof Error ? e.message : t('не удалось построить план', 'could not build the plan') })
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
      if (r.ok) onDone(t(`${title(state.plan, intent)}: ${shown}. Откат — в журнале`, `${title(state.plan, intent)}: ${shown}. Rollback is in the journal`))
      else setApplyError(r.error)
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : t('запись не удалась', 'write failed'))
    } finally {
      setBusy(false)
    }
  }

  const plan = state.status === 'ready' ? state.plan : undefined
  const clientId = plan?.client ?? entity?.client ?? (intent.op === 'add' ? intent.to : undefined)
  const client = CLIENTS.find((c) => c.id === clientId)?.name ?? clientId ?? ''
  return (
    <Modal label={`${title(plan, intent)}: ${shown}`} onEscape={onClose}>
      <h2>
        {title(plan, intent)} {plan ? <span className="lvl">{plan.level}</span> : null}
      </h2>
      <p>
        <b>{shown}</b>{' '}
        <span className="mute">
          · {plan?.op === 'copy' && entity ? `${CLIENTS.find((c) => c.id === entity.client)?.name ?? entity.client} → ${client}` : client}
        </span>
      </p>
      {state.status === 'loading' ? (
        <p className="mute" role="status">{t('Строю план…', 'Building the plan…')}</p>
      ) : state.status === 'error' ? (
        <p className="s-broken" role="alert">{state.error}</p>
      ) : (
        <>
          <dl className="kv">
            <dt>{t('файл', 'file')}</dt><dd className="wrap"><Path p={state.plan.file} /></dd>
            {state.plan.pointer ? (
              <>
                <dt>{t('ключ', 'key')}</dt><dd className="wrap">{state.plan.pointer}</dd>
              </>
            ) : null}
            <dt>{t('было', 'before')}</dt><dd className="wrap mono">{state.plan.from}</dd>
            <dt>{t('станет', 'after')}</dt><dd className="wrap mono"><b>{state.plan.to}</b></dd>
          </dl>
          {state.plan.noop ? <p className="mute">{t('Запись уже в нужном состоянии, писать нечего.', 'The entry is already in the right state, nothing to write.')}</p> : null}
          {state.plan.affects.length > 0 ? (
            <p className="s-stale">
              ◐ {t(
                `Этот же ключ меняет ещё ${state.plan.affects.length} ${state.plan.affects.length === 1 ? 'запись' : 'записей'}: так устроено в самом клиенте.`,
                `This same key also changes ${state.plan.affects.length} more ${state.plan.affects.length === 1 ? 'entry' : 'entries'}: that is how the client works.`,
              )}
            </p>
          ) : null}
          {state.plan.notes.map((n) => (
            <p key={n} className="s-stale">◐ {n}</p>
          ))}
          {state.plan.running.length > 0 ? (
            <p className="s-stale">
              ◐ {t(
                `Сейчас запущен ${state.plan.running.join(', ')}: он может перезаписать файл своим состоянием. Лучше закрыть клиент и повторить.`,
                `${state.plan.running.join(', ')} is running now: it may overwrite the file with its own state. Better close the client and retry.`,
              )}
            </p>
          ) : null}
          <p className="mute small">
            {state.plan.op === 'installSkill'
              ? t(
                  'Копия скила сохранится в бэкап операции, другие файлы не меняются. Откат — в журнале, пока скил не правили. Если источник изменится до записи, она не пройдёт.',
                  'A copy of the skill is saved in the operation backup; no other files change. Roll back from the journal while the skill is unedited. If the source changes before the write, it will not go through.',
                )
              : t(
                  'Перед записью копия файла сохранится в бэкап, остальное содержимое файла не меняется. Если файл изменится до записи, она не пройдёт.',
                  'Before writing, a copy of the file is saved as a backup; the rest of the file is left untouched. If the file changes before the write, it will not go through.',
                )}
          </p>
        </>
      )}
      {applyError ? <p className="s-broken" role="alert">{applyError}</p> : null}
      <div className="actions">
        <button ref={applyRef} disabled={state.status !== 'ready' || state.plan.noop || busy} onClick={() => void apply()}>
          {busy ? t('Записываю…', 'Writing…') : applyLabel(plan, intent)}
        </button>
        {applyError ? <button onClick={() => void build()}>{t('Обновить предпросмотр', 'Refresh preview')}</button> : null}
        <button ref={cancelRef} onClick={onClose}>{t('Отмена', 'Cancel')}</button>
      </div>
    </Modal>
  )
}
