import { plural, t } from '../../shared/i18n'
import type { Entity } from '../../shared/model'
import type { Finding, Severity } from '../doctor'

/** The label is a getter: `t()` is evaluated on access, not when the module is imported. */
const SEV: Record<Severity, { ch: string; cls: string; label: string }> = {
  error: { ch: '✕', cls: 's-broken', get label() { return t('ошибка', 'error') } },
  warn: { ch: '◐', cls: 's-stale', get label() { return t('предупреждение', 'warning') } },
  info: { ch: 'i', cls: 's-cloud', get label() { return t('к сведению', 'info') } },
}

export function Doctor({ findings, onShow }: { findings: Finding[]; onShow: (e: Entity) => void }) {
  return (
    <>
      <h2>
        {t(`Доктор · ${findings.length} находок`, `Doctor · ${findings.length} ${plural(findings.length, ['находка', 'находки', 'находок'], ['finding', 'findings'])}`)}
      </h2>
      {findings.length === 0 ? (
        <p className="mute">{t('Всё чисто: сломанных записей, расхождений и перекрытий нет.', 'All clear: no broken entries, mismatches or overlaps.')}</p>
      ) : null}
      {findings.map((f) => (
        <div key={f.id} className="hud find">
          <span className={`sev ${SEV[f.severity].cls}`} role="img" aria-label={SEV[f.severity].label}>
            {SEV[f.severity].ch}
          </span>
          <div>
            <b>{f.title}</b>
            <p>{f.detail}</p>
          </div>
          {f.entity ? <button onClick={() => onShow(f.entity!)}>{t('Показать', 'Show')}</button> : null}
        </div>
      ))}
    </>
  )
}
