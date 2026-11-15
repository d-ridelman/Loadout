import { useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { ClientId, Entity, Intent } from '../../shared/model'
import { t } from '../../shared/i18n'
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
    <Modal label={t(`Копировать в другой клиент: ${entity.name}`, `Copy to another client: ${entity.name}`)} onEscape={onClose}>
      <h2>
        {t('Копировать в клиент', 'Copy to client')} <span className="lvl">R2</span>
      </h2>
      <p>
        <b>{entity.name}</b>
      </p>
      <fieldset className="choices">
        <legend className="mute small">{t('Куда', 'Destination')}</legend>
        {options.map((c) => (
          <label key={c.id}>
            <input type="radio" name="to" autoFocus={c === options[0]} checked={to === c.id} onChange={() => setTo(c.id)} /> {c.name}
          </label>
        ))}
      </fieldset>
      <p className="mute small">
        {t(
          'Значения env и заголовков копируются как есть внутри ядра и в окне не показываются. Формат (JSON ⇄ TOML) переводится сам; что не переносится, покажет предпросмотр.',
          'Env and header values are copied as-is inside the core and are not shown in the window. The format (JSON ⇄ TOML) is converted automatically; the preview shows anything that cannot be carried over.',
        )}
      </p>
      <div className="actions">
        <button disabled={to === null} onClick={() => to && onSubmit({ op: 'copy', entity: entity.id, to })}>{t('Предпросмотр', 'Preview')}</button>
        <button onClick={onClose}>{t('Отмена', 'Cancel')}</button>
      </div>
    </Modal>
  )
}
