import type { Entity } from '../../shared/model'
import type { Finding, Severity } from '../doctor'

const SEV: Record<Severity, { ch: string; cls: string; label: string }> = {
  error: { ch: '✕', cls: 's-broken', label: 'ошибка' },
  warn: { ch: '◐', cls: 's-stale', label: 'предупреждение' },
  info: { ch: 'i', cls: 's-cloud', label: 'к сведению' },
}

export function Doctor({ findings, onShow }: { findings: Finding[]; onShow: (e: Entity) => void }) {
  return (
    <>
      <h2>Доктор · {findings.length} находок</h2>
      {findings.length === 0 ? <p className="mute">Всё чисто: сломанных записей, расхождений и перекрытий нет.</p> : null}
      {findings.map((f) => (
        <div key={f.id} className="hud find">
          <span className={`sev ${SEV[f.severity].cls}`} role="img" aria-label={SEV[f.severity].label}>
            {SEV[f.severity].ch}
          </span>
          <div>
            <b>{f.title}</b>
            <p>{f.detail}</p>
          </div>
          {f.entity ? <button onClick={() => onShow(f.entity!)}>Показать</button> : null}
        </div>
      ))}
    </>
  )
}
