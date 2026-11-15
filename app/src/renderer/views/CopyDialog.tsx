import { useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { ClientId, Entity, Intent } from '../../shared/model'
import { Modal } from './Modal'

interface Props {
  entity: Entity
  onSubmit: (intent: Intent) => void
  onClose: () => void
}

/** DeepSeek хранит записи в YAML с тегами: копировать в него нельзя (CONCEPT.md §11). */
const TARGETS = CLIENTS.filter((c) => c.id !== 'deepseek')

export function CopyDialog({ entity, onSubmit, onClose }: Props) {
  const options = TARGETS.filter((c) => c.id !== entity.client)
  const [to, setTo] = useState<ClientId | null>(null)
  return (
    <Modal label={`Копировать в другой клиент: ${entity.name}`} onEscape={onClose}>
      <h2>Копировать в клиент</h2>
      <p>
        <b>{entity.name}</b>
      </p>
      <fieldset className="choices">
        <legend className="mute small">Куда</legend>
        {options.map((c) => (
          <label key={c.id}>
            <input type="radio" name="to" autoFocus={c === options[0]} checked={to === c.id} onChange={() => setTo(c.id)} /> {c.name}
          </label>
        ))}
      </fieldset>
      <p className="mute small">
        Значения env и заголовков копируются как есть внутри ядра и в окне не показываются. Формат (JSON ⇄ TOML) переводится сам; что не переносится, покажет предпросмотр.
      </p>
      <div className="actions">
        <button disabled={to === null} onClick={() => to && onSubmit({ op: 'copy', entity: entity.id, to })}>Предпросмотр</button>
        <button onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  )
}
