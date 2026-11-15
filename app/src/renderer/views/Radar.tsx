import { CLIENTS } from '../../shared/model'
import type { ClientId, Entity } from '../../shared/model'
import type { Finding } from '../doctor'
import { Panel } from '../ui'

const POS: readonly [number, number][] = [
  [50, 6], [91, 40], [76, 90], [24, 90], [9, 40],
]
const KINDS = ['plugin', 'mcp', 'skill', 'hook', 'agent', 'command', 'marketplace', 'connector'] as const

interface Props {
  entities: Entity[]
  findings: Finding[]
  activeClient: ClientId | null
  onClient: (c: ClientId) => void
  onDoctor: () => void
}

export function Radar({ entities, findings, activeClient, onClient, onDoctor }: Props) {
  const stat = (id: ClientId) => {
    const own = entities.filter((e) => e.client === id)
    return {
      n: own.length,
      bad: own.filter((e) => e.state === 'broken').length,
      warn: own.filter((e) => e.state === 'stale').length,
    }
  }
  return (
    <div className="radar">
      <Panel title="Радар клиентов">
        <div className="rwrap">
          <div className="rcirc" />
          <div className="beam fx" />
          <div className="rcenter">
            <div className="mono big">{entities.length}</div>
            <div className="mute mono small">записей</div>
          </div>
          {CLIENTS.map((c, i) => {
            const s = stat(c.id)
            const colour = s.bad ? 'var(--red)' : s.warn ? 'var(--orange)' : 'var(--green)'
            return (
              <button
                key={c.id}
                className="node"
                style={{ left: `${POS[i]?.[0] ?? 50}%`, top: `${POS[i]?.[1] ?? 50}%` }}
                aria-pressed={activeClient === c.id}
                aria-label={`${c.name}: записей ${s.n}, проблем ${s.bad + s.warn}`}
                onClick={() => onClient(c.id)}
              >
                <b>{c.name}</b>
                <span className="mute mono small">
                  <span className="dot pulse" style={{ background: colour }} />
                  {s.n} · ⚠ {s.bad + s.warn}
                </span>
              </button>
            )
          })}
        </div>
      </Panel>
      <div>
        <Panel title="По типам">
          <dl className="kv">
            {KINDS.map((k) => (
              <div key={k} className="kvrow">
                <dt><span className={`badge k-${k}`}>{k}</span></dt>
                <dd>{entities.filter((e) => e.kind === k).length}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel title={`Проблемы (${findings.filter((f) => f.severity !== 'info').length})`}>
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
          {findings.every((f) => f.severity === 'info') ? <p className="mute">Проблем не найдено.</p> : null}
          <button onClick={onDoctor}>Открыть Доктора</button>
        </Panel>
      </div>
    </div>
  )
}
