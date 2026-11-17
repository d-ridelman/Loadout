import { t } from '../../shared/i18n'
import { CLIENTS } from '../../shared/model'
import type { Entity } from '../../shared/model'
import { PageHead, Rich } from '../ui'

/** Lifecycle event order: known events go in this order, the rest follow alphabetically. */
const ORDER = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
]

export function Hooks({ hooks, onShow }: { hooks: Entity[]; onShow: (e: Entity) => void }) {
  const eventOf = (e: Entity) => (typeof e.detail['event'] === 'string' ? e.detail['event'] : '?')
  const events = [...new Set(hooks.map(eventOf))].sort((a, b) => {
    const [ia, ib] = [ORDER.indexOf(a), ORDER.indexOf(b)]
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b)
  })
  const head = (
    <PageHead
      title={t('Хуки', 'Hooks')}
      sub={t(
        'Хуки всех клиентов по событиям, слева направо в том порядке, в каком события происходят. Нажмите на хук, чтобы открыть его в матрице.',
        'Hooks of every client by event, left to right in the order the events happen. Click a hook to open it in the matrix.',
      )}
    />
  )
  if (hooks.length === 0)
    return (
      <>
        {head}
        <div className="hud card">
          <p>{t('Хуков не найдено ни в одном клиенте.', 'No hooks found in any client.')}</p>
          <p className="mute">{t('Хук — команда, которую клиент запускает на событие (старт сессии, вызов инструмента). Их добавляют в настройки клиента или ставят вместе с плагином; Инструменты контекста (раздел 7) тоже ставят свои хуки.', 'A hook is a command the client runs on an event (a session start, a tool call). They are added in the client settings or come with a plugin; Context Toolkit (section 7) installs hooks too.')}</p>
        </div>
      </>
    )
  return (
    <>
      {head}
      {/* columns share the window width; only with very many events (below 88px a column) does the grid scroll instead of being cut off */}
      <div className="hud tablewrap scrollx" tabIndex={0} role="region" aria-label={t('Хуки по событиям и клиентам: прокрутка', 'Hooks by event and client: scrollable')}>
        <div className="pipe" role="group" aria-label={t('Хуки по событиям и клиентам', 'Hooks by event and client')} style={{ gridTemplateColumns: `minmax(96px, 130px) repeat(${events.length}, minmax(88px, 1fr))` }}>
          <div />
          {events.map((ev) => (
            // a line may break between the words of `UserPromptSubmit`, not inside them
            <div key={ev} className="h">{ev.replace(/([a-z])([A-Z])/g, '$1​$2')}</div>
          ))}
          {CLIENTS.map((c) => (
            <PipeRow key={c.id} name={c.name} events={events} hooks={hooks.filter((h) => h.client === c.id)} eventOf={eventOf} onShow={onShow} />
          ))}
        </div>
      </div>
      <p className="mute small">
        <Rich
          text={t(
            'Показаны только события, которые есть в найденных файлах. Пустая ячейка значит «хука нет», а не «клиент не поддерживает событие»: набор событий каждого клиента ядро не проверяет. Хуки-обёртки одной программы (например, `orca-agent-hooks`) собраны под общим ключом.',
            'Only events present in the files found are shown. An empty cell means "no hook", not "the client does not support the event": the core does not check which events each client supports. Wrapper hooks of one program (for example, `orca-agent-hooks`) are grouped under a shared key.',
          )}
        />
      </p>
    </>
  )
}

function PipeRow({ name, events, hooks, eventOf, onShow }: { name: string; events: string[]; hooks: Entity[]; eventOf: (e: Entity) => string; onShow: (e: Entity) => void }) {
  return (
    <>
      <div className="mono mute rowname">{name}</div>
      {events.map((ev) => {
        const list = hooks.filter((h) => eventOf(h) === ev)
        return (
          <div key={ev}>
            {list.length === 0 ? <span className="mute">·</span> : null}
            {list.map((h) => (
              <button key={h.id} className="hk" onClick={() => onShow(h)}>
                {h.logicalKey}
                <br />
                <small>{typeof h.detail['matcher'] === 'string' ? h.detail['matcher'] : '*'} · {h.scope}</small>
              </button>
            ))}
          </div>
        )
      })}
    </>
  )
}
