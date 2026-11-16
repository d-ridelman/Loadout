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

/**
 * Edit an MCP command (R2). The window does not receive the current values (they are masked in the list), so the new command
 * is entered in full: the core replaces `command` and `args` and leaves the rest (env, headers) alone.
 */
export function EditDialog({ entity, draft, onSubmit, onClose }: Props) {
  const [command, setCommand] = useState(draft?.command ?? '')
  const [args, setArgs] = useState(draft?.args.join('\n') ?? '')
  const lines = args.split('\n').filter((l) => l !== '')
  const ok = command.trim() !== '' && command.length <= 500 && lines.length <= 64 && lines.every((l) => l.length <= 500)
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
        <p className="mute small">
          {t(
            'Старые значения не показываются: в списке они скрыты, чтобы секреты не попадали в окно. Заменяются только команда и аргументы, ключи env и заголовки остаются.',
            'Old values are not shown: they are hidden in the list so secrets never reach the window. Only the command and arguments are replaced; env keys and headers stay.',
          )}
        </p>
        <div className="actions">
          <button type="submit" disabled={!ok}>{t('Предпросмотр', 'Preview')}</button>
          <button type="button" onClick={onClose}>{t('Отмена', 'Cancel')}</button>
        </div>
      </form>
    </Modal>
  )
}
