import { useCallback, useEffect, useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { JournalEntry, Level, WriteLevel } from '../../shared/model'
import { BACKUP_DIR_HINT, backupNotice } from '../../shared/backups'
import { fmtDateTime, t } from '../../shared/i18n'
import { Cmd, levelLabel, PageHead } from '../ui'
import type { Notify } from '../ui'
import { levelOk } from './Inspector'
import { RollbackDialog } from './PlanDialog'

// t() only during render, not when the module is imported
const opLabel = (op: JournalEntry['op']): string =>
  ({ toggle: t('вкл/выкл', 'on/off'), edit: t('правка', 'edit'), copy: t('копия', 'copy'), add: t('добавление', 'add'), installSkill: t('установка скила', 'skill install'), rollback: t('откат', 'rollback') })[op]

type State = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; rows: JournalEntry[] }

interface Props {
  level: WriteLevel
  /** Changes on every data refresh: the journal is re-read because `canRollback` depends on the current file. */
  refreshKey: number
  onNotice: Notify
  /** Asks for a write level a rollback needs (the OS dialog); true when it is granted. */
  ensureLevel: (need: Level) => Promise<boolean>
}

/** Journal of our operations (CONCEPT.md §5, step 8). Changes made to clients from outside do not appear here. */
export function Journal({ level, refreshKey, onNotice, ensureLevel }: Props) {
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

  /** The rollback waiting for confirmation: one line, or the lines of a batch still in effect. */
  const [confirm, setConfirm] = useState<{ rows: JournalEntry[]; batch: string | null } | null>(null)
  const closeConfirm = () => {
    setConfirm(null)
    void load()
  }

  const prune = async () => {
    setBusy('prune')
    try {
      const r = await window.loadout.pruneBackups()
      if (r.ok) onNotice(t(`Старые копии удалены: операций ${r.data.removed}, осталось ${r.data.kept}`, `Old copies removed: ${r.data.removed} operations, ${r.data.kept} kept`))
      else onNotice(r.error, 'error')
    } catch (e) {
      onNotice(e instanceof Error ? e.message : t('очистка не удалась', 'cleanup failed'), 'error')
    } finally {
      setBusy(null)
      void load()
    }
  }

  return (
    <>
      <PageHead
        title={t('Журнал', 'Journal')}
        topic="journal"
        sub={t(
          'Записи, которые сделал Loadout. Запись можно откатить после предпросмотра, если файл с тех пор не меняли.',
          'Writes made by Loadout. You can roll one back after a preview if the file has not changed since.',
        )}
      />
      <details className="small">
        <summary>{t('Где хранятся копии и что в них', 'Where the copies are kept and what is in them')}</summary>
        <p className="mute small">{backupNotice(BACKUP_DIR_HINT)}</p>
        <div className="actions">
          <button disabled={busy !== null} onClick={() => void prune()}>{t('Очистить старые копии…', 'Clean up old copies…')}</button>
        </div>
      </details>
      {state.status === 'loading' ? (
        <p className="mute" role="status">{t('Читаю журнал…', 'Reading the journal…')}</p>
      ) : state.status === 'error' ? (
        <div className="hud card" role="alert">
          <p className="s-broken">{state.error}</p>
          <button onClick={() => void load()}>{t('Повторить', 'Retry')}</button>
        </div>
      ) : state.rows.length === 0 ? (
        <div className="hud card">
          <p>{t('Операций пока не было. Сюда попадают переключения (кнопка в инспекторе или Space на ячейке), корзина, правка, копирование и добавление MCP, профили и скилы; каждую можно откатить после предпросмотра, если файл с тех пор не меняли. Плагины ставит сам claude, их здесь нет; у Инструментов контекста свой откат.', 'No operations yet. Toggles (the Inspector button or Space on a cell), the trash, MCP edits, copies and additions, profiles and skills land here; each can be rolled back after a preview if the file has not changed since. Plugins are installed by claude itself and are not here; Context Toolkit has its own rollback.')}</p>
        </div>
      ) : (
        <div className="hud tablewrap">
          <table className="left" aria-label={t('Журнал операций', 'Operations journal')}>
            <thead>
              <tr>
                <th scope="col">{t('Время', 'Time')}</th>
                <th scope="col">{t('Операция', 'Operation')}</th>
                <th scope="col">{t('Запись', 'Entry')}</th>
                <th scope="col">{t('Значение', 'Value')}</th>
                <th scope="col">{t('Статус', 'Status')}</th>
                <th scope="col">{t('Действия', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((j, i) => {
                const ok = levelOk(level, j.level)
                // the batch button sits on the newest entry of the batch while it still has something to roll back
                const batchHead =
                  j.batch !== null && state.rows.findIndex((x) => x.batch === j.batch) === i && state.rows.some((x) => x.batch === j.batch && x.canRollback)
                return (
                  <tr key={j.id}>
                    <td className="mono nw">{fmtDateTime(j.time)}</td>
                    <td className="nw">
                      {opLabel(j.op)}
                      {j.level === 'R2' ? <span className="lvl">R2</span> : null}
                    </td>
                    <td className="name">
                      <b>{j.name}</b>
                      <div className="mute small">{CLIENTS.find((c) => c.id === j.client)?.name}{j.pointer ? ` · ${j.pointer}` : ''}</div>
                    </td>
                    <td className="mono vcell wrap"><Cmd text={`${j.from} → ${j.to}`} /></td>
                    <td className="nw">{j.rolledBack ? t('↺ откатано', '↺ rolled back') : j.op === 'rollback' ? t('откат записан', 'rollback recorded') : j.canRollback ? t('в силе', 'in effect') : t('уже менялось', 'changed since')}</td>
                    <td>
                      <div className="actions col">
                        {j.op === 'rollback' ? null : (
                          <button disabled={!j.canRollback || busy !== null} onClick={() => void ensureLevel(j.level).then((y) => y && setConfirm({ rows: [j], batch: null }))}>
                            {t('Откатить', 'Roll back')}
                          </button>
                        )}
                        {batchHead ? (
                          <button
                            disabled={busy !== null}
                            title={t('Откатить весь пакет профиля, начиная с последней записи', 'Roll back the whole profile batch, starting from the latest entry')}
                            onClick={() => void ensureLevel('R2').then((y) => y && setConfirm({ rows: state.rows.filter((x) => x.batch === j.batch && x.op !== 'rollback' && !x.rolledBack), batch: j.batch }))}
                          >
                            {t('Откатить пакет', 'Roll back batch')}
                          </button>
                        ) : null}
                        {/* the reason is text in the row, not a tooltip on a disabled button */}
                        {j.op !== 'rollback' && !j.canRollback && !j.rolledBack && j.why ? <span className="mute small">{t(`Нельзя: ${j.why}`, `Not possible: ${j.why}`)}</span> : null}
                        {(j.canRollback && !ok) || (batchHead && !levelOk(level, 'R2')) ? (
                          <span className="mute small">{t(`Сейчас «${levelLabel(level)}»: сначала Loadout спросит разрешение на запись`, `The level is “${levelLabel(level)}” now: Loadout asks for permission to write first`)}</span>
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
      {confirm ? (
        <RollbackDialog
          rows={confirm.rows}
          batch={confirm.batch}
          onClose={closeConfirm}
          onDone={(m) => {
            closeConfirm()
            onNotice(m)
          }}
        />
      ) : null}
    </>
  )
}
