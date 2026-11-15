import { CLIENTS } from '../../shared/model'
import type { Entity } from '../../shared/model'
import { GLYPH } from '../aggregate'
import type { Row } from '../aggregate'
import { Glyph, KindBadge, Panel } from '../ui'
import type { Sel } from './Matrix'

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

export function Inspector({ row, sel, onPick }: { row: Row | undefined; sel: Sel | null; onPick: (id: string) => void }) {
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

      <div className="actions">
        <button onClick={() => void window.loadout.copyText(e.origin.file)}>Копировать путь</button>
        <button disabled title="Запись включается с M3 (CONCEPT.md §5)">
          {e.state === 'off' ? 'Включить' : 'Выключить'}
        </button>
      </div>
      <p className="mute small">Loadout пока только читает. Запись пойдёт через план → diff → бэкап → откат (M3).</p>
    </>
  )
}
