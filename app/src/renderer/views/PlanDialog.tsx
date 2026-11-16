import { useCallback, useEffect, useRef, useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { Entity, Intent, JournalEntry, Plan } from '../../shared/model'
import { t } from '../../shared/i18n'
import { Path } from '../ui'
import { Modal } from './Modal'

type PlanState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; plan: Plan & { running: string[] } }

interface Props {
  /** `null` when adding a new server: there is no entry yet. */
  entity: Entity | null
  intent: Intent
  /** Back to the form the intent came from, with what was typed (forms only). */
  onBack?: () => void
  onClose: () => void
  /** The write is done: the window gets fresh data from the watcher, so only a message is needed here. */
  onDone: (message: string) => void
}

const clientName = (id: string): string => CLIENTS.find((c) => c.id === id)?.name ?? id

/** File, key and the value before and after: the same block for a write and for a rollback. */
function Change({ file, pointer, from, to }: { file: string; pointer: string; from: string; to: string }) {
  return (
    <dl className="kv">
      <dt>{t('файл', 'file')}</dt><dd className="wrap"><Path p={file} /></dd>
      {pointer ? (
        <>
          <dt>{t('ключ', 'key')}</dt><dd className="wrap">{pointer}</dd>
        </>
      ) : null}
      <dt>{t('было', 'before')}</dt><dd className="wrap mono">{from}</dd>
      <dt>{t('станет', 'after')}</dt><dd className="wrap mono"><b>{to}</b></dd>
    </dl>
  )
}

interface RollbackProps {
  /** Journal lines to undo, newest first: one operation, or every line of a profile batch still in effect. */
  rows: JournalEntry[]
  batch: string | null
  onClose: () => void
  onDone: (message: string) => void
}

/**
 * Rollback preview from the journal: the journal line turned around (what it became goes back to what it was).
 * Nothing is written before confirmation, and the core checks the file again right before the write.
 */
export function RollbackDialog({ rows, batch, onClose, onDone }: RollbackProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const applyRef = useRef<HTMLButtonElement>(null)
  useEffect(() => applyRef.current?.focus(), [])
  const names = rows.map((r) => r.name).join(', ')
  const head = batch !== null ? t('Откатить пакет профиля', 'Roll back the profile batch') : t('Откатить', 'Roll back')
  const run = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (batch !== null) {
        const r = await window.loadout.rollbackBatch(batch)
        if (r.ok) onDone(t(`Пакет откатан: ${names}`, `Batch rolled back: ${names}`))
        else setError(r.error)
      } else if (rows[0]) {
        const r = await window.loadout.rollback(rows[0].id)
        if (r.ok) onDone(t(`Откачено: ${rows[0].name} · ${clientName(rows[0].client)}`, `Rolled back: ${rows[0].name} · ${clientName(rows[0].client)}`))
        else setError(r.error)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('откат не удался', 'rollback failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal label={`${head}: ${names}`} onEscape={onClose}>
      <h2>
        {head} <span className="lvl">{rows.some((r) => r.level === 'R2') ? 'R2' : 'R1'}</span>
      </h2>
      {rows.map((r) => (
        <div key={r.id}>
          <p>
            <b>{r.name}</b> <span className="mute">· {clientName(r.client)}</span>
          </p>
          <Change file={r.file} pointer={r.pointer} from={r.to} to={r.rollbackTo ?? r.from} />
          {/* a batch stops at the first line that cannot be rolled back: say so before, not after */}
          {!r.canRollback && r.why ? (
            <p className="s-broken">
              {batch !== null
                ? t(`Эта запись не откатится (${r.why}): пакет остановится на ней.`, `This entry will not roll back (${r.why}): the batch stops at it.`)
                : t(`Эта запись не откатится: ${r.why}.`, `This entry will not roll back: ${r.why}.`)}
            </p>
          ) : null}
        </div>
      ))}
      <p className="mute small">
        {t(
          'Перед записью копия файла сохранится в бэкап, остальное содержимое не меняется. Ядро ещё раз сверит файл и запись: если после операции их изменили так, что откат затёр бы чужие правки, он не пройдёт.',
          'Before writing, a copy of the file is saved as a backup; nothing else in it changes. The core checks the file and the entry again: if they changed after the operation so that the rollback would overwrite someone else’s edits, it will not go through.',
        )}
      </p>
      {error ? <p className="s-broken" role="alert">{error}</p> : null}
      <div className="actions">
        <button ref={applyRef} disabled={busy || rows.length === 0} onClick={() => void run()}>
          {busy ? t('Откатываю…', 'Rolling back…') : t('Откатить', 'Roll back')}
        </button>
        <button onClick={onClose}>{t('Отмена', 'Cancel')}</button>
      </div>
    </Modal>
  )
}

function title(p: Plan | undefined, intent: Intent): string {
  const op = p?.op ?? intent.op
  if (op === 'add') return t('Добавить MCP-сервер', 'Add MCP server')
  if (op === 'edit') return t('Правка команды', 'Edit command')
  if (op === 'copy') return t('Копирование в другой клиент', 'Copy to another client')
  if (op === 'installSkill') return t('Установить скил', 'Install skill')
  return intent.op === 'toggle' && intent.enable ? t('Включить', 'Enable') : t('Выключить', 'Disable')
}

/** Primary button label per operation instead of a generic "Apply": shows what exactly will happen. */
function applyLabel(p: Plan | undefined, intent: Intent): string {
  if (intent.op === 'add') return t('Добавить', 'Add')
  if (intent.op === 'edit') return t('Записать команду', 'Write command')
  if (intent.op === 'copy') return t('Скопировать', 'Copy')
  if (intent.op === 'installSkill') return t('Установить', 'Install')
  if (p?.trash === 'in') return t('Вернуть из корзины', 'Restore from trash')
  if (!intent.enable && p?.trash === 'out') return t('Вынести в корзину', 'Move to trash')
  return intent.enable ? t('Включить', 'Enable') : t('Выключить', 'Disable')
}

/** Preview of any write (CONCEPT.md §5, steps 1-2): what exactly will change, and the write happens only after confirmation. */
export function PlanDialog({ entity, intent, onBack, onClose, onDone }: Props) {
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
  // focus is in the dialog from the start (on "Cancel"); once the plan is ready and the write is possible, it moves to "Apply"
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
          <Change file={state.plan.file} pointer={state.plan.pointer} from={state.plan.from} to={state.plan.to} />
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
        {onBack ? <button disabled={busy} onClick={onBack}>{t('Назад к форме', 'Back to the form')}</button> : null}
        <button ref={cancelRef} onClick={onClose}>{t('Отмена', 'Cancel')}</button>
      </div>
    </Modal>
  )
}
