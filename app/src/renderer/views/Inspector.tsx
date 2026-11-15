import { CLIENTS, LEVEL_RANK } from '../../shared/model'
import type { Entity, Level, WriteLevel } from '../../shared/model'
import { GLYPH } from '../aggregate'
import type { Row } from '../aggregate'
import { Glyph, KindBadge, Panel } from '../ui'
import type { Sel } from './Matrix'

/** Хватает ли текущего уровня записи для операции. */
export const levelOk = (have: WriteLevel, need: Level): boolean => LEVEL_RANK[have] >= LEVEL_RANK[need]

/** Поле `detail` как строка. Только текст: значения секретов в ядре замаскированы, а здесь нет HTML-вставок. */
function show(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (Array.isArray(v)) return v.length === 0 ? null : v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const DETAIL_LABELS: Record<string, string> = {
  transport: 'транспорт',
  command: 'команда',
  args: 'аргументы',
  url: 'адрес',
  envKeys: 'ключи env',
  headerKeys: 'ключи заголовков',
  event: 'событие',
  matcher: 'matcher',
  type: 'тип',
  timeout: 'таймаут',
  description: 'описание',
  displayName: 'название',
  sha: 'коммит',
  sourceType: 'источник',
  model: 'модель',
  id: 'id записи',
}

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
        <h2>Инспектор</h2>
        <p className="mute">Выберите ячейку матрицы.</p>
      </>
    )
  }
  const client = CLIENTS.find((c) => c.id === sel.client)
  const cell = row.cells[sel.client]
  const strip = (
    <div className="strip" aria-label="Состояние по клиентам">
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
        <h2>Инспектор</h2>
        <Panel>
          <KindBadge kinds={row.kinds} /> <b>{row.name}</b>
          {strip}
          <p className="mute">В {client?.name} этой сущности нет. Копирование между клиентами — этап M4.</p>
        </Panel>
      </>
    )
  }
  // запись по id: при обновлении данных с диска номера в списке сдвигаются, а выбор должен остаться на той же записи
  const e: Entity = cell.instances.find((x) => x.id === sel.id) ?? cell.instances[0]!
  const details = Object.entries(e.detail)
    .map(([k, v]) => [k, show(v)] as const)
    .filter((kv): kv is readonly [string, string] => kv[1] !== null)

  return (
    <>
      <h2>Инспектор</h2>
      <Panel>
        <div>
          <KindBadge kinds={[e.kind]} /> <b>{row.name}</b>
        </div>
        {strip}
        <dl className="kv">
          <dt>клиент</dt><dd>{client?.name}</dd>
          <dt>состояние</dt><dd className={`s-${e.state}`}>{GLYPH[e.state].ch} {GLYPH[e.state].label}</dd>
          <dt>область</dt><dd>{e.scope}</dd>
          {e.version ? (<><dt>версия</dt><dd>{e.version}</dd></>) : null}
          <dt>файл</dt><dd className="wrap">{e.origin.file}</dd>
          <dt>указатель</dt><dd className="wrap">{e.origin.pointer}</dd>
        </dl>
      </Panel>

      {cell.instances.length > 1 ? (
        <>
          <h2>Записи ({cell.instances.length})</h2>
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
          <b className="s-stale">Замечание</b>
          <p>{e.note}</p>
        </Panel>
      ) : null}

      {details.length > 0 ? (
        <>
          <h2>Содержимое</h2>
          <dl className="kv detail">
            {details.map(([k, v]) => (
              <div key={k} className="kvrow">
                <dt>{DETAIL_LABELS[k] ?? k}</dt>
                <dd className="wrap">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mute small">Значения env и заголовков не показываются: только имена ключей. Команды показаны без секретов.</p>
        </>
      ) : null}

      <div className="actions col">
        <button onClick={() => void window.loadout.copyText(e.origin.file)}>Копировать путь</button>
        <button
          disabled={!e.canToggle || !levelOk(level, e.toggleLevel ?? 'R1')}
          title={!e.canToggle ? e.toggleWhy : !levelOk(level, e.toggleLevel ?? 'R1') ? `Включите уровень ${e.toggleLevel ?? 'R1'} в шапке окна` : 'Предпросмотр, затем запись (Space)'}
          onClick={() => onToggle(e, e.state === 'off' || e.state === 'unknown')}
        >
          {e.state === 'off' || e.state === 'unknown' ? 'Включить' : e.toggleLevel === 'R2' ? 'Выключить (в корзину)' : 'Выключить'}
        </button>
        {e.canEdit ? (
          <>
            <button disabled={!levelOk(level, 'R2')} title={levelOk(level, 'R2') ? 'Заменить команду и аргументы' : 'Включите уровень R2 в шапке окна'} onClick={() => onEdit(e)}>
              Править команду…
            </button>
            <button disabled={!levelOk(level, 'R2')} title={levelOk(level, 'R2') ? 'Скопировать запись в другой клиент' : 'Включите уровень R2 в шапке окна'} onClick={() => onCopy(e)}>
              Копировать в клиент…
            </button>
          </>
        ) : null}
      </div>
      <p className="mute small">
        {!e.canToggle
          ? `Переключить нельзя: ${e.toggleWhy ?? 'не поддержано'}.`
          : level === 'R0'
            ? 'Запись выключена (R0). Уровень включается в шапке окна.'
            : !levelOk(level, e.toggleLevel ?? 'R1')
              ? `Для этой записи нужен уровень ${e.toggleLevel}: у неё нет флага, выключение выносит её в корзину Loadout.`
              : 'Запись пойдёт через предпросмотр, бэкап и проверку; откат — в журнале.'}
      </p>
    </>
  )
}
