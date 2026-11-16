import { CLIENTS, LEVEL_RANK } from '../../shared/model'
import type { Entity, Level, WriteLevel } from '../../shared/model'
import { t } from '../../shared/i18n'
import { GLYPH } from '../aggregate'
import type { Row } from '../aggregate'
import { Glyph, KindBadge, Panel, Path } from '../ui'
import type { Sel } from './Matrix'

/** Whether the current write level is enough for the operation. */
export const levelOk = (have: WriteLevel, need: Level): boolean => LEVEL_RANK[have] >= LEVEL_RANK[need]

/** The `detail` field as a string. Text only: secret values are masked in the core, and there are no HTML insertions here. */
function show(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (Array.isArray(v)) return v.length === 0 ? null : v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// t() only during render, not when the module is imported
const detailLabel = (k: string): string =>
  (
    ({
      transport: t('транспорт', 'transport'),
      command: t('команда', 'command'),
      args: t('аргументы', 'arguments'),
      url: t('адрес', 'URL'),
      envKeys: t('ключи env', 'env keys'),
      headerKeys: t('ключи заголовков', 'header keys'),
      event: t('событие', 'event'),
      matcher: 'matcher',
      type: t('тип', 'type'),
      timeout: t('таймаут', 'timeout'),
      description: t('описание', 'description'),
      displayName: t('название', 'name'),
      sha: t('коммит', 'commit'),
      sourceType: t('источник', 'source'),
      model: t('модель', 'model'),
      id: t('id записи', 'entry id'),
    }) as Record<string, string>
  )[k] ?? k

interface Props {
  row: Row | undefined
  sel: Sel | null
  onPick: (id: string) => void
  level: WriteLevel
  onToggle: (e: Entity, enable: boolean) => void
  onEdit: (e: Entity) => void
  onCopy: (e: Entity) => void
}

export function Inspector({ row, sel, onPick, level, onToggle, onEdit, onCopy }: Props) {
  if (!row || !sel) {
    return (
      <>
        <h2>{t('Инспектор', 'Inspector')}</h2>
        <p className="mute">{t('Выберите ячейку матрицы.', 'Select a matrix cell.')}</p>
      </>
    )
  }
  const client = CLIENTS.find((c) => c.id === sel.client)
  const cell = row.cells[sel.client]
  const strip = (
    <div className="strip" aria-label={t('Состояние по клиентам', 'State by client')}>
      {CLIENTS.map((c) => (
        <span key={c.id} title={`${c.name}: ${GLYPH[row.cells[c.id]?.state ?? 'none'].label}`}>
          <Glyph state={row.cells[c.id]?.state ?? 'none'} />
        </span>
      ))}
    </div>
  )
  if (!cell) {
    return (
      <>
        <h2>{t('Инспектор', 'Inspector')}</h2>
        <Panel>
          <KindBadge kinds={row.kinds} /> <b>{row.name}</b>
          {strip}
          <p className="mute">
            {t(`В ${client?.name} этой сущности нет.`, `This entity is not in ${client?.name}.`)}
            {/* copying works for MCP servers in a client file, and not into DeepSeek (tagged YAML) */}
            {row.kinds.includes('mcp') && sel.client !== 'deepseek'
              ? ' ' + t('MCP-сервер можно скопировать сюда из ячейки другого клиента: «Копировать в клиент…».', 'An MCP server can be copied here from another client’s cell: “Copy to client…”.')
              : null}
          </p>
        </Panel>
      </>
    )
  }
  // entry by id: when data is refreshed from disk the list indexes shift, but the selection must stay on the same entry
  const e: Entity = cell.instances.find((x) => x.id === sel.id) ?? cell.instances[0]!
  const details = Object.entries(e.detail)
    .map(([k, v]) => [k, show(v)] as const)
    .filter((kv): kv is readonly [string, string] => kv[1] !== null)

  return (
    <>
      <h2>{t('Инспектор', 'Inspector')}</h2>
      <Panel>
        <div>
          <KindBadge kinds={[e.kind]} /> <b>{row.name}</b>
        </div>
        {strip}
        <dl className="kv">
          <dt>{t('клиент', 'client')}</dt><dd>{client?.name}</dd>
          <dt>{t('состояние', 'state')}</dt><dd className={`s-${e.state}`}>{GLYPH[e.state].ch} {GLYPH[e.state].label}</dd>
          <dt>{t('область', 'scope')}</dt><dd>{e.scope}</dd>
          {e.version ? (<><dt>{t('версия', 'version')}</dt><dd>{e.version}</dd></>) : null}
          <dt>{t('файл', 'file')}</dt><dd className="wrap"><Path p={e.origin.file} /></dd>
          <dt>{t('указатель', 'pointer')}</dt><dd className="wrap">{e.origin.pointer}</dd>
          {/* found in one file, switched in another (a Claude Code plugin: settings.json → enabledPlugins) */}
          {e.toggleAt ? (
            <>
              <dt>{t('переключатель', 'switch')}</dt>
              <dd className="wrap"><Path p={e.toggleAt.file} /> · {e.toggleAt.pointer}</dd>
            </>
          ) : null}
        </dl>
      </Panel>

      {cell.instances.length > 1 ? (
        <>
          <h2>{t('Записи', 'Entries')} ({cell.instances.length})</h2>
          <ul className="instances">
            {cell.instances.map((x) => (
              <li key={x.id}>
                <button aria-pressed={x.id === e.id} onClick={() => onPick(x.id)}>
                  <Glyph state={x.state} /> {x.scope}
                  {x.kind !== e.kind || cell.instances.some((y) => y !== x && y.kind !== x.kind) ? ` · ${x.kind}` : ''}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {e.note ? (
        <Panel className="note">
          <b className="s-stale">{t('Замечание', 'Note')}</b>
          <p>{e.note}</p>
        </Panel>
      ) : null}

      {details.length > 0 ? (
        <>
          <h2>{t('Содержимое', 'Contents')}</h2>
          <dl className="kv detail">
            {details.map(([k, v]) => (
              <div key={k} className="kvrow">
                <dt>{detailLabel(k)}</dt>
                <dd className="wrap">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mute small">{t('Значения env и заголовков не показываются: только имена ключей. Команды показаны без секретов.', 'Env and header values are not shown, only key names. Commands are shown without secrets.')}</p>
        </>
      ) : null}

      <div className="actions col">
        <button onClick={() => void window.loadout.copyText(e.origin.file)}>{t('Копировать путь', 'Copy path')}</button>
        <button
          disabled={!e.canToggle || !levelOk(level, e.toggleLevel ?? 'R1')}
          title={
            !e.canToggle
              ? e.toggleWhy
              : !levelOk(level, e.toggleLevel ?? 'R1')
                ? t(`Включите уровень ${e.toggleLevel ?? 'R1'} в шапке окна`, `Enable level ${e.toggleLevel ?? 'R1'} in the window header`)
                : t('Предпросмотр, затем запись (Space)', 'Preview, then write (Space)')
          }
          onClick={() => onToggle(e, e.state === 'off' || e.state === 'unknown')}
        >
          {e.state === 'off' || e.state === 'unknown' ? t('Включить', 'Enable') : e.toggleLevel === 'R2' ? t('Выключить (в корзину)', 'Disable (move to trash)') : t('Выключить', 'Disable')}
        </button>
        {e.canEdit ? (
          <>
            <button disabled={!levelOk(level, 'R2')} title={levelOk(level, 'R2') ? t('Заменить команду и аргументы', 'Replace the command and arguments') : t('Включите уровень R2 в шапке окна', 'Enable level R2 in the window header')} onClick={() => onEdit(e)}>
              {t('Править команду…', 'Edit command…')}
            </button>
            <button disabled={!levelOk(level, 'R2')} title={levelOk(level, 'R2') ? t('Скопировать запись в другой клиент', 'Copy the entry to another client') : t('Включите уровень R2 в шапке окна', 'Enable level R2 in the window header')} onClick={() => onCopy(e)}>
              {t('Копировать в клиент…', 'Copy to client…')}
            </button>
          </>
        ) : null}
      </div>
      <p className="mute small">
        {!e.canToggle
          ? t(`Переключить нельзя: ${e.toggleWhy ?? 'не поддержано'}.`, `Cannot toggle: ${e.toggleWhy ?? 'not supported'}.`)
          : level === 'R0'
            ? t('Запись выключена (R0). Уровень включается в шапке окна.', 'Writing is off (R0). Set the level in the window header.')
            : !levelOk(level, e.toggleLevel ?? 'R1')
              ? t(`Для этой записи нужен уровень ${e.toggleLevel}: у неё нет флага, выключение выносит её в корзину Loadout.`, `This entry needs level ${e.toggleLevel}: it has no flag, so disabling moves it to the Loadout trash.`)
              : t('Запись пойдёт через предпросмотр, бэкап и проверку; откат — в журнале.', 'The write goes through preview, backup and verification; rollback is in the journal.')}
      </p>
    </>
  )
}
