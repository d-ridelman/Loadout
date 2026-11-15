import { useCallback, useEffect, useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { JournalEntry, WriteLevel } from '../../shared/model'
import { getLang, t } from '../../shared/i18n'
import { levelOk } from './Inspector'

// t() только во время рендера, не при импорте модуля
const opLabel = (op: JournalEntry['op']): string =>
  ({ toggle: t('запись', 'write'), edit: t('правка', 'edit'), copy: t('копия', 'copy'), add: t('добавление', 'add'), installSkill: t('установка скила', 'skill install'), rollback: t('откат', 'rollback') })[op]

type State = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; rows: JournalEntry[] }

interface Props {
  level: WriteLevel
  /** Меняется при каждом обновлении данных: журнал перечитывается, `canRollback` зависит от текущего файла. */
  refreshKey: number
  onNotice: (message: string) => void
}

/** Журнал наших операций (CONCEPT.md §5, шаг 8). Изменения клиентов извне сюда не попадают. */
export function Journal({ level, refreshKey, onNotice }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await window.loadout.journal()
      setState(r.ok ? { status: 'ready', rows: r.data } : { status: 'error', error: r.error })
    } catch (e) {
      setState({ status: 'error', error: e instanceof Error ? e.message : t('журнал не прочитан', 'could not read the journal') })
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const rollback = async (id: string) => {
    setBusy(id)
    try {
      const r = await window.loadout.rollback(id)
      onNotice(r.ok ? t('Откат выполнен', 'Rolled back') : r.error)
    } catch (e) {
      onNotice(e instanceof Error ? e.message : t('откат не удался', 'rollback failed'))
    } finally {
      setBusy(null)
      void load()
    }
  }

  const rollbackBatch = async (batch: string) => {
    setBusy(batch)
    try {
      const r = await window.loadout.rollbackBatch(batch)
      onNotice(r.ok ? t(`Пакет откатан: ${r.data.length} записей`, `Batch rolled back: ${r.data.length} entries`) : r.error)
    } catch (e) {
      onNotice(e instanceof Error ? e.message : t('откат пакета не удался', 'batch rollback failed'))
    } finally {
      setBusy(null)
      void load()
    }
  }

  return (
    <>
      <h2>{t('Журнал', 'Journal')}</h2>
      {state.status === 'loading' ? (
        <p className="mute" role="status">{t('Читаю журнал…', 'Reading the journal…')}</p>
      ) : state.status === 'error' ? (
        <div className="hud card" role="alert">
          <p className="s-broken">{state.error}</p>
          <button onClick={() => void load()}>{t('Повторить', 'Retry')}</button>
        </div>
      ) : state.rows.length === 0 ? (
        <div className="hud card">
          <p>{t('Операций пока не было. Переключатель в инспекторе (или клавиша Space на выбранной ячейке) записывает сюда каждое изменение, и каждое можно откатить.', 'No operations yet. The toggle in the Inspector (or the Space key on a selected cell) records every change here, and every change can be rolled back.')}</p>
        </div>
      ) : (
        <div className="hud tablewrap">
          <table className="left" aria-label={t('Журнал операций', 'Operations journal')}>
            <thead>
              <tr>
                <th scope="col">{t('ВРЕМЯ', 'TIME')}</th>
                <th scope="col">{t('ОПЕРАЦИЯ', 'OPERATION')}</th>
                <th scope="col">{t('ЗАПИСЬ', 'ENTRY')}</th>
                <th scope="col">{t('ЗНАЧЕНИЕ', 'VALUE')}</th>
                <th scope="col">{t('СТАТУС', 'STATUS')}</th>
                <th scope="col">{t('ДЕЙСТВИЯ', 'ACTIONS')}</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((j, i) => {
                const ok = levelOk(level, j.level)
                // кнопка пакета стоит у самой новой записи пакета, пока в нём есть что откатывать
                const batchHead =
                  j.batch !== null && state.rows.findIndex((x) => x.batch === j.batch) === i && state.rows.some((x) => x.batch === j.batch && x.canRollback)
                return (
                  <tr key={j.id}>
                    <td className="mono nw">{new Date(j.time).toLocaleString(getLang() === 'en' ? 'en-GB' : 'ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td className="nw">
                      {opLabel(j.op)}
                      {j.level === 'R2' ? <span className="lvl">R2</span> : null}
                    </td>
                    <td className="name">
                      <b>{j.name}</b>
                      <div className="mute small">{CLIENTS.find((c) => c.id === j.client)?.name} · {j.pointer}</div>
                    </td>
                    <td className="mono vcell wrap">{j.from} → {j.to}</td>
                    <td className="nw">{j.rolledBack ? t('↺ откатано', '↺ rolled back') : j.op === 'rollback' ? t('откат записан', 'rollback recorded') : j.canRollback ? t('в силе', 'in effect') : t('уже менялось', 'changed since')}</td>
                    <td>
                      <div className="actions col">
                        <button
                          disabled={!j.canRollback || !ok || busy !== null}
                          title={!ok ? t(`Включите уровень ${j.level} в шапке`, `Enable level ${j.level} in the header`) : !j.canRollback ? t('Откат невозможен: файл менялся после операции или операция уже откатана', 'Rollback is not possible: the file changed after the operation or it was already rolled back') : undefined}
                          onClick={() => void rollback(j.id)}
                        >
                          {t('Откатить', 'Roll back')}
                        </button>
                        {batchHead ? (
                          <button
                            disabled={!levelOk(level, 'R2') || busy !== null}
                            title={!levelOk(level, 'R2') ? t('Включите уровень R2 в шапке', 'Enable level R2 in the header') : t('Откатить весь пакет профиля, начиная с последней записи', 'Roll back the whole profile batch, starting from the latest entry')}
                            onClick={() => void rollbackBatch(j.batch ?? '')}
                          >
                            {t('Откатить пакет', 'Roll back batch')}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
