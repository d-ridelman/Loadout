import { useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { ClientId, Entity, Intent } from '../../shared/model'
import { t } from '../../shared/i18n'
import { Modal } from './Modal'

interface Props {
  entity: Entity
  /** The choice made before the preview ("Back to the form"). */
  draft?: Extract<Intent, { op: 'copy' }>
  onSubmit: (intent: Intent) => void
  onClose: () => void
}

/** The copy intent for an entry: a project entry stays in its project, so the core gets the project id back. */
export function copyIntent(e: Entity, to: ClientId): Extract<Intent, { op: 'copy' }> {
  return e.project && e.scope.startsWith('project:') ? { op: 'copy', entity: e.id, to, project: e.project } : { op: 'copy', entity: e.id, to }
}

/** What happens with the entry's content, by kind (docs/TRANSFER.en.md §2). */
function about(e: Entity): string {
  switch (e.kind) {
    case 'skill':
      return t(
        'Папка скила копируется целиком в папку скилов получателя. Ключи, которые понимает только Claude Code, получатель пропустит; предпросмотр их назовёт.',
        'The skill folder is copied whole into the target’s skills folder. Keys only Claude Code understands are skipped by the target; the preview names them.',
      )
    case 'hook':
      return t(
        'Хук добавляется в файл хуков получателя тем же событием. Имена инструментов в matcher переводятся; то, чему у получателя нет пары, предпросмотр назовёт.',
        'The hook is added to the target’s hooks file on the same event. Tool names in the matcher are translated; whatever has no counterpart, the preview names.',
      )
    case 'plugin':
      return t(
        'Плагин — пакет, который ставит и обновляет сам клиент: правкой файла Loadout его не переносит. Ниже для каждого клиента сказано, что сделать вместо этого.',
        'A plugin is a package its client installs and updates: Loadout does not move it by a file edit. Below, each client says what to do instead.',
      )
    default:
      return t(
        'Значения env и заголовков копируются как есть внутри ядра и в окне не показываются. Формат (JSON ⇄ TOML) переводится сам; что не переносится, покажет предпросмотр.',
        'Env and header values are copied as-is inside the core and are not shown in the window. The format (JSON ⇄ TOML) is converted automatically; the preview shows anything that cannot be carried over.',
      )
  }
}

export function CopyDialog({ entity, draft, onSubmit, onClose }: Props) {
  const options = CLIENTS.filter((c) => c.id !== entity.client)
  const why = (id: ClientId): string | undefined => entity.copyWhy?.[id]
  const [to, setTo] = useState<ClientId | null>(draft?.to ?? null)
  const first = options.find((c) => !why(c.id))
  const project = entity.scope.startsWith('project:') ? entity.scope.slice('project:'.length) : null
  return (
    <Modal label={t(`Копировать в другой клиент: ${entity.name}`, `Copy to another client: ${entity.name}`)} onEscape={onClose}>
      <h2>
        {t('Копировать в клиент', 'Copy to client')} <span className="lvl">R2</span>
      </h2>
      <p>
        <b>{entity.name}</b>
        {project ? <span className="mute"> · {t(`в тот же проект ${project}`, `into the same project ${project}`)}</span> : null}
      </p>
      <fieldset className="choices">
        <legend className="mute small">{t('Куда', 'Destination')}</legend>
        {options.map((c) => {
          const no = why(c.id)
          return (
            <label key={c.id} className={no ? 'off' : undefined}>
              <input type="radio" name="to" autoFocus={c === first} disabled={no !== undefined} checked={to === c.id} onChange={() => setTo(c.id)} />
              <span>
                {c.name}
                {no ? <span className="mute small"> — {no}</span> : null}
              </span>
            </label>
          )
        })}
      </fieldset>
      <p className="mute small">{about(entity)}</p>
      <div className="actions">
        {entity.kind === 'plugin' ? null : (
          <button className="primary" disabled={to === null} onClick={() => to && onSubmit(copyIntent(entity, to))}>{t('Предпросмотр', 'Preview')}</button>
        )}
        <button onClick={onClose}>{entity.kind === 'plugin' ? t('Закрыть', 'Close') : t('Отмена', 'Cancel')}</button>
      </div>
    </Modal>
  )
}
