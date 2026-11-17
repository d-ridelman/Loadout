import { CLIENTS, LEVEL_RANK } from '../../shared/model'
import type { Entity, Level, WriteLevel } from '../../shared/model'
import { t } from '../../shared/i18n'
import { GLYPH } from '../aggregate'
import type { Row } from '../aggregate'
import { Glyph, KindBadge, kindLabel, levelLabel, Panel, Path, Rich, Term } from '../ui'
import type { Sel } from './Matrix'
import { Similar } from './Similar'

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
  /** Every entry of the scan: the similar skills are named from it. */
  entities: Entity[]
  onShowEntity: (e: Entity) => void
}

export function Inspector({ row, sel, onPick, level, onToggle, onEdit, onCopy, entities, onShowEntity }: Props) {
  if (!row || !sel) {
    return (
      <>
        <h2>{t('Инспектор', 'Inspector')}</h2>
        {/* the first state teaches the next step: what to click and what appears here */}
        <p>{t('Нажмите на значок в таблице — здесь появятся подробности о записи и кнопки «Включить» и «Выключить».', 'Click a mark in the table: the details of the entry and the Enable and Disable buttons appear here.')}</p>
        <p className="mute small">{t('По таблице можно ходить стрелками, Space включает и выключает выбранное.', 'The arrow keys move through the table; Space enables or disables the selection.')}</p>
      </>
    )
  }
  const client = CLIENTS.find((c) => c.id === sel.client)
  const cell = row.cells[sel.client]
  const strip = (
    <div className="strip" role="img" aria-label={t('Состояние по клиентам: ', 'State by client: ') + CLIENTS.map((c) => `${c.name} — ${GLYPH[row.cells[c.id]?.state ?? 'none'].label}`).join(', ')}>
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
            {/* a copy from another client's cell is possible when that entry can be copied and this client is not refused for it */}
            {CLIENTS.some((c) => row.cells[c.id]?.instances.some((x) => x.canCopy && !x.copyWhy?.[sel.client]))
              ? ' ' + t('Запись можно скопировать сюда из ячейки другого клиента: «Копировать в клиент…».', 'The entry can be copied here from another client’s cell: “Copy to client…”.')
              : null}
          </p>
        </Panel>
      </>
    )
  }
  // entry by id: when data is refreshed from disk the list indexes shift, but the selection must stay on the same entry
  const e: Entity = cell.instances.find((x) => x.id === sel.id) ?? cell.instances[0]!
  const details = Object.entries(e.detail)
    .filter(([k]) => k !== 'exact') // a flag for the edit form, not content
    .map(([k, v]) => [k, show(v)] as const)
    .filter((kv): kv is readonly [string, string] => kv[1] !== null)

  const enable = e.state === 'off' || e.state === 'unknown'
  const short = !levelOk(level, e.toggleLevel ?? 'R1')
  return (
    <>
      <h2>{t('Инспектор', 'Inspector')}</h2>
      <Panel>
        <div>
          <KindBadge kinds={[e.kind]} /> <b>{row.name}</b>
        </div>
        {strip}
        {/* what a person needs first: where, in what state, and which file a change goes to; the rest is under "Technical details" */}
        <dl className="kv">
          <dt>{t('клиент', 'client')}</dt><dd>{client?.name}</dd>
          <dt>{t('состояние', 'state')}</dt><dd className={`s-${e.state}`}>{GLYPH[e.state].ch} {GLYPH[e.state].label}</dd>
          {e.version ? (<><dt>{t('версия', 'version')}</dt><dd>{e.version}</dd></>) : null}
          {/* found in one file, switched in another (a Claude Code plugin: settings.json → enabledPlugins): the file a toggle writes */}
          <dt>{t('файл', 'file')}</dt><dd className="wrap"><Path p={(e.toggleAt ?? e.origin).file} /></dd>
        </dl>
      </Panel>

      {cell.instances.length > 1 ? (
        <>
          <h3>{t('Записи', 'Entries')} ({cell.instances.length})</h3>
          <ul className="instances">
            {cell.instances.map((x) => (
              <li key={x.id}>
                <button aria-pressed={x.id === e.id} onClick={() => onPick(x.id)}>
                  <Glyph state={x.state} /><span className="vh">{GLYPH[x.state].label}, </span> {x.scope}
                  {x.kind !== e.kind || cell.instances.some((y) => y !== x && y.kind !== x.kind) ? ` · ${kindLabel(x.kind)}` : ''}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {e.note ? (
        <Panel className="note">
          <b className="s-stale">{t('Замечание', 'Note')}</b>
          <p><Rich text={e.note} /></p>
        </Panel>
      ) : null}

      {/* an action never waits behind a header setting: a button whose level is not granted yet asks for it (the confirmation window) and goes on */}
      <div className="actions col">
        <button
          className={e.canToggle ? 'primary' : undefined}
          disabled={!e.canToggle}
          title={!e.canToggle ? e.toggleWhy : t('Покажет, что изменится, и подождёт подтверждения (Space)', 'Shows what will change and waits for your confirmation (Space)')}
          onClick={() => onToggle(e, enable)}
        >
          {/* plain "Enable": an R2 entry may come back from the Loadout trash or from the client's own stash; the preview names which */}
          {enable ? t('Включить', 'Enable') : e.toggleLevel === 'R2' ? t('Выключить (в корзину)', 'Disable (move to trash)') : t('Выключить', 'Disable')}
        </button>
        {e.canEdit ? (
          <button title={t('Заменить команду и аргументы', 'Replace the command and arguments')} onClick={() => onEdit(e)}>
            {t('Править команду…', 'Edit command…')}
          </button>
        ) : null}
        {/* a plugin is never copied, but the dialog says for each client what to do instead */}
        {e.canCopy || (e.kind === 'plugin' && e.copyWhy) ? (
          <button title={t('Скопировать запись в другой клиент', 'Copy the entry to another client')} onClick={() => onCopy(e)}>
            {t('Копировать в клиент…', 'Copy to client…')}
          </button>
        ) : null}
        {/* the path shown in "file" above: the one a toggle writes */}
        <button onClick={() => void window.loadout.copyText((e.toggleAt ?? e.origin).file)}>{t('Копировать путь', 'Copy path')}</button>
      </div>
      <p className="mute small">
        {!e.canToggle
          ? t(`Переключить нельзя: ${e.toggleWhy ?? 'не поддержано'}.`, `Cannot toggle: ${e.toggleWhy ?? 'not supported'}.`)
          : short
            ? t(
                `Сейчас «${levelLabel(level)}». Loadout сначала спросит разрешение в окне подтверждения, потом покажет, что изменится.${e.toggleLevel === 'R2' ? ' У этой записи нет флага «выключено»: выключение убирает её из списка клиента и сохраняет, включение возвращает на место; куда именно, покажет предпросмотр.' : ''}`,
                `The level is “${levelLabel(level)}” now. Loadout asks for permission first in a confirmation window, then shows what will change.${e.toggleLevel === 'R2' ? ' This entry has no “disabled” flag: disabling takes it out of the client’s list and keeps it, enabling puts it back; the preview shows where.' : ''}`,
              )
            : t('Сначала предпросмотр, потом запись с бэкапом; откатить можно в журнале.', 'A preview first, then the write with a backup; you can roll it back in the journal.')}
      </p>

      {e.kind === 'skill' ? <Similar e={e} entities={entities} onShow={onShowEntity} /> : null}

      <details className="tech">
        <summary>{t('Технические подробности', 'Technical details')}</summary>
        <dl className="kv">
          <div className="kvrow"><dt><Term tip={t('Где лежит запись: user — для всех проектов; project и local — для одной папки; managed и enterprise — заданы организацией; builtin — встроено в клиент; plugin — пришло с плагином; profile — профиль DeepSeek; other — неизвестная Loadout область', 'Where the entry lives: user is for all projects; project and local for one folder; managed and enterprise are set by an organisation; builtin comes with the client; plugin came with a plugin; profile is a DeepSeek profile; other is a scope Loadout does not know')}>{t('область', 'scope')}</Term></dt><dd>{e.scope}</dd></div>
          <div className="kvrow"><dt>{t('найдено в', 'found in')}</dt><dd className="wrap"><Path p={e.origin.file} /></dd></div>
          <div className="kvrow"><dt><Term tip={t('Путь к записи внутри файла (JSON Pointer)', 'The path to the entry inside the file (JSON Pointer)')}>{t('указатель', 'pointer')}</Term></dt><dd className="wrap">{e.origin.pointer}</dd></div>
          {e.toggleAt ? <div className="kvrow"><dt>{t('переключатель', 'switch')}</dt><dd className="wrap">{e.toggleAt.pointer}</dd></div> : null}
          {details.map(([k, v]) => (
            <div key={k} className="kvrow">
              <dt>{detailLabel(k)}</dt>
              <dd className="wrap">{v}</dd>
            </div>
          ))}
        </dl>
        {details.length > 0 ? <p className="mute small">{t('Значения env и заголовков не показываются: только имена ключей. Команды показаны без секретов.', 'Env and header values are not shown, only key names. Commands are shown without secrets.')}</p> : null}
      </details>
    </>
  )
}
