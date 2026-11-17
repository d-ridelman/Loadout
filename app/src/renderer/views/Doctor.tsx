import { count, t } from '../../shared/i18n'
import type { Entity } from '../../shared/model'
import { groupFindings } from '../doctor'
import type { Finding, Severity } from '../doctor'
import { PageHead, Rich } from '../ui'

/** The label is a getter: `t()` is evaluated on access, not when the module is imported. */
const SEV: Record<Severity, { ch: string; cls: string; label: string; group: string }> = {
  error: { ch: '✕', cls: 's-broken', get label() { return t('ошибка', 'error') }, get group() { return t('Сломано', 'Broken') } },
  warn: { ch: '◐', cls: 's-stale', get label() { return t('предупреждение', 'warning') }, get group() { return t('Предупреждения', 'Warnings') } },
  info: { ch: 'i', cls: 's-cloud', get label() { return t('к сведению', 'info') }, get group() { return t('К сведению', 'For your information') } },
}

export function Doctor({ findings, onShow }: { findings: Finding[]; onShow: (e: Entity) => void }) {
  return (
    <>
      <PageHead
        title={`${t('Доктор', 'Doctor')} · ${count(findings.length, ['находка', 'находки', 'находок'], ['finding', 'findings'])}`}
        sub={t(
          'Проверка конфигов: сломанные записи, расхождения версий и записи, которые лежат в нескольких местах. К каждой находке есть подсказка, как её исправить.',
          'A check of the configs: broken entries, version mismatches and entries found in several places. Each finding comes with a hint on how to fix it.',
        )}
      />
      {findings.length === 0 ? (
        <div className="hud card">
          <p>{t('Всё чисто: сломанных записей, расхождений и перекрытий нет.', 'All clear: no broken entries, mismatches or overlaps.')}</p>
        </div>
      ) : null}
      {groupFindings(findings).map((g) => (
        <section key={g.severity} aria-labelledby={`doc-${g.severity}`}>
          <h3 id={`doc-${g.severity}`} className={`group-head ${SEV[g.severity].cls}`}>
            <span aria-hidden="true">{SEV[g.severity].ch}</span> {SEV[g.severity].group} · {g.items.length}
          </h3>
          {g.items.map((f) => (
            <div key={f.id} className="hud find">
              <span className={`sev ${SEV[f.severity].cls}`} role="img" aria-label={SEV[f.severity].label}>
                {SEV[f.severity].ch}
              </span>
              <div>
                <b>{f.title}</b>
                <dl className="kv">
                  <dt>{t('что не так', 'what is wrong')}</dt>
                  <dd><Rich text={f.what} /></dd>
                  <dt>{t('почему', 'why')}</dt>
                  <dd><Rich text={f.why} /></dd>
                  <dt>{t('как исправить', 'how to fix')}</dt>
                  <dd className="fix"><Rich text={f.fix} /></dd>
                </dl>
              </div>
              {f.entity ? <button onClick={() => onShow(f.entity!)} aria-label={t(`Показать в матрице: ${f.title}`, `Show in the matrix: ${f.title}`)}>{t('Показать', 'Show')}</button> : null}
            </div>
          ))}
        </section>
      ))}
    </>
  )
}
