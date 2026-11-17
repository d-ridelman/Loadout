import { useState } from 'react'
import type { Entity, Intent } from '../../shared/model'
import { t } from '../../shared/i18n'
import { Modal } from './Modal'

interface Props {
  entity: Entity
  /** What was typed before the preview ("Back to the form"). */
  draft?: Extract<Intent, { op: 'edit' }>
  onSubmit: (intent: Intent) => void
  onClose: () => void
}

/** The mark the core puts in place of a value it hides from the window (crates/loadout-core/src/mask.rs, `MASK`). */
const MASK = '<masked>'

/** A mask typed back (or left from a prefill) would be written into the client config instead of the real value. */
export const hasMask = (command: string, args: readonly string[]): boolean => command.includes(MASK) || args.some((a) => a.includes(MASK))

/**
 * The form starts from the current command only when the core says it showed it exactly (`detail.exact`): masking is lossy
 * without always leaving a mark (a URL loses its query), and a prefilled lossy value saved back would erase the secret.
 * `partial` means there was a command the form could not start from.
 */
export function prefill(e: Entity): { command: string; args: string; partial: boolean } {
  const command = typeof e.detail['command'] === 'string' ? e.detail['command'] : ''
  const args = Array.isArray(e.detail['args']) ? e.detail['args'].filter((a): a is string => typeof a === 'string') : []
  if (command === '' && args.length === 0) return { command: '', args: '', partial: false }
  // one argument per line: an empty or multi-line argument would not survive the round trip
  const fits = args.every((a) => a !== '' && !a.includes('\n'))
  if (e.detail['exact'] !== true || !fits || hasMask(command, args)) return { command: '', args: '', partial: true }
  return { command, args: args.join('\n'), partial: false }
}

/**
 * Edit an MCP command (R2). The core replaces `command` and `args` and leaves the rest (env, headers) alone. The form starts
 * from the current value unless the core masked part of it (then the command is typed in full).
 */
export function EditDialog({ entity, draft, onSubmit, onClose }: Props) {
  const [start] = useState(() => prefill(entity))
  const [command, setCommand] = useState(draft?.command ?? start.command)
  const [args, setArgs] = useState(draft?.args.join('\n') ?? start.args)
  const lines = args.split('\n').filter((l) => l !== '')
  const masked = hasMask(command, lines)
  const ok = command.trim() !== '' && command.length <= 500 && lines.length <= 64 && lines.every((l) => l.length <= 500) && !masked
  return (
    <Modal label={t(`Править команду: ${entity.name}`, `Edit command: ${entity.name}`)} onEscape={onClose}>
      <h2>
        {t('Править команду', 'Edit command')} <span className="lvl">R2</span>
      </h2>
      <p>
        <b>{entity.name}</b>
      </p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) onSubmit({ op: 'edit', entity: entity.id, command: command.trim(), args: lines })
        }}
      >
        <label>
          {t('Команда', 'Command')}
          <input autoFocus value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" maxLength={500} spellCheck={false} />
        </label>
        <label>
          {t('Аргументы, по одному в строке', 'Arguments, one per line')}
          <textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={5} placeholder={t('-y\nпакет@1.2.3', '-y\npackage@1.2.3')} spellCheck={false} />
        </label>
        {start.partial && !draft ? (
          <p className="s-stale">
            ◐ {t(
              'Текущую команду окно не может показать в точности (часть похожа на секрет и скрыта), поэтому поля пустые: введите команду и аргументы целиком.',
              'The window cannot show the current command exactly (part of it looks like a secret and is hidden), so the fields are empty: type the command and arguments in full.',
            )}
          </p>
        ) : null}
        {masked ? (
          <p className="s-broken" role="alert">{t(`Уберите ${MASK}: вместо секрета в конфиг записалась бы эта метка.`, `Remove ${MASK}: this mark would be written to the config instead of the secret.`)}</p>
        ) : null}
        <p className="mute small">
          {t(
            'Заменяются только команда и аргументы, ключи env и заголовки остаются как есть.',
            'Only the command and arguments are replaced; env keys and headers stay as they are.',
          )}
        </p>
        <div className="actions">
          <button type="submit" className="primary" disabled={!ok}>{t('Предпросмотр', 'Preview')}</button>
          <button type="button" onClick={onClose}>{t('Отмена', 'Cancel')}</button>
        </div>
      </form>
    </Modal>
  )
}
