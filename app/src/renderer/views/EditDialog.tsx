import { useState } from 'react'
import type { Entity, Intent } from '../../shared/model'
import { Modal } from './Modal'

interface Props {
  entity: Entity
  onSubmit: (intent: Intent) => void
  onClose: () => void
}

/**
 * Правка команды MCP (R2). Текущие значения окно не получает (в списке они замаскированы), поэтому новая команда
 * вводится целиком: ядро заменит `command` и `args`, остальное (env, заголовки) не тронет.
 */
export function EditDialog({ entity, onSubmit, onClose }: Props) {
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const lines = args.split('\n').filter((l) => l !== '')
  const ok = command.trim() !== '' && command.length <= 500 && lines.length <= 64 && lines.every((l) => l.length <= 500)
  return (
    <Modal label={`Править команду: ${entity.name}`} onEscape={onClose}>
      <h2>Править команду</h2>
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
          Команда
          <input autoFocus value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" maxLength={500} spellCheck={false} />
        </label>
        <label>
          Аргументы, по одному в строке
          <textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={5} placeholder={'-y\nпакет@1.2.3'} spellCheck={false} />
        </label>
        <p className="mute small">
          Старые значения не показываются: в списке они скрыты, чтобы секреты не попадали в окно. Заменяются только команда и аргументы, ключи env и заголовки остаются.
        </p>
        <div className="actions">
          <button type="submit" disabled={!ok}>Предпросмотр</button>
          <button type="button" onClick={onClose}>Отмена</button>
        </div>
      </form>
    </Modal>
  )
}
