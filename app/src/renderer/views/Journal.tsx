import { useCallback, useEffect, useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { JournalEntry, WriteLevel } from '../../shared/model'
import { levelOk } from './Inspector'

const OP_LABEL: Record<JournalEntry['op'], string> = { toggle: 'запись', edit: 'правка', copy: 'копия', add: 'добавление', rollback: 'откат' }

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
      setState({ status: 'error', error: e instanceof Error ? e.message : 'журнал не прочитан' })
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const rollback = async (id: string) => {
    setBusy(id)
    try {
      const r = await window.loadout.rollback(id)
      onNotice(r.ok ? 'Откат выполнен' : r.error)
    } catch (e) {
      onNotice(e instanceof Error ? e.message : 'откат не удался')
    } finally {
      setBusy(null)
      void load()
    }
  }

  const rollbackBatch = async (batch: string) => {
    setBusy(batch)
    try {
      const r = await window.loadout.rollbackBatch(batch)
      onNotice(r.ok ? `Пакет откатан: ${r.data.length} записей` : r.error)
    } catch (e) {
      onNotice(e instanceof Error ? e.message : 'откат пакета не удался')
    } finally {
      setBusy(null)
      void load()
    }
  }

  return (
    <>
      <h2>Журнал</h2>
      {state.status === 'loading' ? (
        <p className="mute" role="status">Читаю журнал…</p>
      ) : state.status === 'error' ? (
        <div className="hud card" role="alert">
          <p className="s-broken">{state.error}</p>
          <button onClick={() => void load()}>Повторить</button>
        </div>
      ) : state.rows.length === 0 ? (
        <div className="hud card">
          <p>Операций пока не было. Переключатель в инспекторе (или клавиша Space на выбранной ячейке) записывает сюда каждое изменение, и каждое можно откатить.</p>
        </div>
      ) : (
        <div className="hud tablewrap">
          <table className="left" aria-label="Журнал операций">
            <thead>
              <tr>
                <th scope="col">ВРЕМЯ</th>
                <th scope="col">ОПЕРАЦИЯ</th>
                <th scope="col">ЗАПИСЬ</th>
                <th scope="col">ЗНАЧЕНИЕ</th>
                <th scope="col">СТАТУС</th>
                <th scope="col">ДЕЙСТВИЯ</th>
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
                    <td className="mono nw">{new Date(j.time).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td className="nw">
                      {OP_LABEL[j.op]}
                      {j.level === 'R2' ? <span className="lvl">R2</span> : null}
                    </td>
                    <td className="name">
                      <b>{j.name}</b>
                      <div className="mute small">{CLIENTS.find((c) => c.id === j.client)?.name} · {j.pointer}</div>
                    </td>
                    <td className="mono vcell wrap">{j.from} → {j.to}</td>
                    <td className="nw">{j.rolledBack ? '↺ откатано' : j.op === 'rollback' ? 'откат записан' : j.canRollback ? 'в силе' : 'уже менялось'}</td>
                    <td>
                      <div className="actions col">
                        <button
                          disabled={!j.canRollback || !ok || busy !== null}
                          title={!ok ? `Включите уровень ${j.level} в шапке` : !j.canRollback ? 'Откат невозможен: файл менялся после операции или операция уже откатана' : undefined}
                          onClick={() => void rollback(j.id)}
                        >
                          Откатить
                        </button>
                        {batchHead ? (
                          <button
                            disabled={!levelOk(level, 'R2') || busy !== null}
                            title={!levelOk(level, 'R2') ? 'Включите уровень R2 в шапке' : 'Откатить весь пакет профиля, начиная с последней записи'}
                            onClick={() => void rollbackBatch(j.batch ?? '')}
                          >
                            Откатить пакет
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
