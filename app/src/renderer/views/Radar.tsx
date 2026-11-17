import { t } from '../../shared/i18n'
import { CLIENTS } from '../../shared/model'
import type { ClientId } from '../../shared/model'
import { clientStat, GROUPS } from '../aggregate'
import type { Row } from '../aggregate'
import type { Finding } from '../doctor'
import { PageHead, Panel } from '../ui'

const POS: readonly [number, number][] = [
  [50, 6], [91, 40], [76, 90], [24, 90], [9, 40],
]

interface Props {
  /** The matrix rows: the Radar counts what the matrix shows. */
  rows: Row[]
  findings: Finding[]
  activeClient: ClientId | null
  onClient: (c: ClientId) => void
  onDoctor: () => void
}

export function Radar({ rows, findings, activeClient, onClient, onDoctor }: Props) {
  return (
    <>
    <PageHead
      title={t('Радар', 'Radar')}
      sub={t(
        'Сколько строк матрицы у каждого клиента и сколько проблем у него нашёл Доктор. Нажмите на клиента, чтобы отфильтровать матрицу.',
        'How many matrix rows each client has and how many problems the Doctor found in it. Click a client to filter the matrix.',
      )}
    />
    <div className="radar">
      <Panel title={t('Радар клиентов', 'Client radar')}>
        <div className="rwrap">
          <div className="rcirc" />
          <div className="beam fx" />
          <div className="rcenter">
            <div className="mono big">{rows.length}</div>
            <div className="mute mono small">{t('строк матрицы', 'matrix rows')}</div>
          </div>
          {CLIENTS.map((c, i) => {
            const s = clientStat(rows, findings, c.id)
            const colour = s.worst === 'error' ? 'var(--red)' : s.worst === 'warn' ? 'var(--orange)' : 'var(--green)'
            return (
              <button
                key={c.id}
                className="node"
                style={{ left: `${POS[i]?.[0] ?? 50}%`, top: `${POS[i]?.[1] ?? 50}%` }}
                aria-pressed={activeClient === c.id}
                aria-label={t(`${c.name}: строк в матрице ${s.cells}, проблем ${s.issues}`, `${c.name}: ${s.cells} matrix rows, ${s.issues} issues`)}
                onClick={() => onClient(c.id)}
              >
                <b>{c.name}</b>
                <span className="mute mono small">
                  <span className="dot pulse" style={{ background: colour }} />
                  {s.cells}
                  {s.issues > 0 ? ` · ⚠ ${s.issues}` : null}
                </span>
              </button>
            )
          })}
        </div>
      </Panel>
      <div>
        <Panel title={t('По типам', 'By type')}>
          <dl className="kv">
            {GROUPS.map((g) => (
              <div key={g.id} className="kvrow">
                <dt><span className={`badge k-${g.id}`}>{g.id}</span></dt>
                <dd>{rows.filter((r) => r.group === g.id).length}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel title={t(`Проблемы (${findings.filter((f) => f.severity !== 'info').length})`, `Issues (${findings.filter((f) => f.severity !== 'info').length})`)}>
          {findings
            .filter((f) => f.severity !== 'info')
            .slice(0, 5)
            .map((f) => (
              <div key={f.id} className="finding-line">
                <span className={`g ${f.severity === 'error' ? 's-broken' : 's-stale'}`} aria-hidden="true">
                  {f.severity === 'error' ? '✕' : '◐'}
                </span>{' '}
                {f.title}
              </div>
            ))}
          {findings.every((f) => f.severity === 'info') ? <p className="mute">{t('Проблем не найдено.', 'No issues found.')}</p> : null}
          <button onClick={onDoctor}>{t('Открыть Доктора', 'Open Doctor')}</button>
        </Panel>
      </div>
    </div>
    </>
  )
}
