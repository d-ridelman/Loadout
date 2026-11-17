import { useEffect, useState } from 'react'
import { getLang, t } from '../../shared/i18n'
import type { UpdatesInfo, UpdateState } from '../../shared/model'

const api = () => window.loadout

/** The state line and its buttons: the same in the notification card and in the panel. */
function Status({ s, onNote, panel = false }: { s: UpdateState; onNote: (m: string | null) => void; panel?: boolean }) {
  const install = async (): Promise<void> => {
    const r = await api().installUpdate().catch(() => null)
    onNote(r && !r.ok ? r.error : null)
  }
  switch (s.status) {
    case 'idle':
      return <p className="mute">{t('Ещё не проверялось', 'Not checked yet')}</p>
    case 'checking':
      return <p className="mute">{t('Проверяем…', 'Checking…')}</p>
    case 'latest': {
      const at = new Date(s.checkedAt).toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'ru-RU', { hour: '2-digit', minute: '2-digit' })
      return <p className="mute">{t(`У вас последняя версия (проверено в ${at})`, `You have the latest version (checked at ${at})`)}</p>
    }
    case 'available':
      return (
        <>
          <p>{t(`Доступна версия ${s.version}`, `Version ${s.version} is available`)}</p>
          <div className="upd-actions">
            <button onClick={() => void api().downloadUpdate()}>{t('Скачать', 'Download')}</button>
            <button className="upd-link" onClick={() => void api().openReleaseNotes()}>{t('Что нового (GitHub)', 'What’s new (GitHub)')}</button>
          </div>
        </>
      )
    case 'downloading':
      return (
        <>
          <p>{t(`Скачивается версия ${s.version}: ${s.percent}%`, `Downloading version ${s.version}: ${s.percent}%`)}</p>
          <progress max={100} value={s.percent} aria-label={t('Скачивание обновления', 'Update download')} />
        </>
      )
    case 'ready':
      return (
        <>
          <p>{t(`Версия ${s.version} скачана и проверена`, `Version ${s.version} is downloaded and verified`)}</p>
          <div className="upd-actions">
            <button className="upd-go" onClick={() => void install()}>{t('Перезапустить и обновить', 'Restart and update')}</button>
          </div>
          <p className="mute small">{t('Если не сейчас, обновление установится при выходе из Loadout.', 'If not now, the update is installed when you quit Loadout.')}</p>
        </>
      )
    case 'error':
      return (
        <>
          <p>{s.message}</p>
          {/* the panel has its own "Check now" */}
          {panel ? null : (
            <div className="upd-actions">
              <button onClick={() => void api().checkUpdates()}>{t('Повторить', 'Retry')}</button>
            </div>
          )}
        </>
      )
  }
}

const cardKey = (s: UpdateState): string | null =>
  s.status === 'available' || s.status === 'downloading' || s.status === 'ready'
    ? `${s.status}:${s.version}`
    : s.status === 'error' && !s.quiet
      ? `error:${s.message}`
      : null

/**
 * Footer: the privacy line and the version button that opens the update panel; above the footer, a small card when a new
 * version is found, downloading or ready (and after a failed manual check). Nothing here blocks the window.
 */
export function Updates() {
  const [info, setInfo] = useState<UpdatesInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    void api().updates().then(setInfo, () => undefined)
    return api().onUpdates(setInfo)
  }, [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const online = info ? info.supported && info.auto : false
  const privacy = online
    ? t('? — клавиши · данные читаются с диска; в сеть ходит только проверка обновлений (GitHub)', '? — shortcuts · data is read from disk; only the update check goes online (GitHub)')
    : t('? — клавиши · данные читаются с диска, ничего не отправляется', '? — shortcuts · data is read from disk, nothing is sent')
  if (!info) return <span id="privacy">{privacy}</span>

  const s = info.state
  const key = cardKey(s)
  const fresh = s.status === 'available' || s.status === 'ready'
  const busy = s.status === 'checking' || s.status === 'downloading' || s.status === 'ready'
  const toggle = (on: boolean): void => {
    setInfo({ ...info, auto: on }) // the checkbox follows the click at once; main's answer (or the old value on failure) follows
    void api().setAutoUpdate(on).then(setInfo, () => setInfo(info))
  }

  return (
    <>
      <span id="privacy">{privacy}</span>
      <button
        className={`upd-btn${fresh ? ' s-on' : ''}`}
        aria-expanded={open}
        aria-controls="updates"
        aria-label={t(`Обновления, установлена версия ${info.version}`, `Updates, installed version ${info.version}`)}
        onClick={() => setOpen((o) => !o)}
      >
        {fresh ? '● ' : ''}v{info.version}
      </button>
      {open ? (
        <section id="updates" className="hud upd-pop" role="dialog" aria-label={t('Обновления', 'Updates')}>
          <h2>{t('Обновления', 'Updates')}</h2>
          <p>{t(`Установлена версия ${info.version}`, `Installed version ${info.version}`)}</p>
          <label className="upd-auto">
            <input type="checkbox" checked={info.auto} onChange={(e) => toggle(e.target.checked)} />
            {t('Проверять обновления автоматически', 'Check for updates automatically')}
          </label>
          <p className="mute small">
            {t('При запуске и раз в сутки, пока окно открыто. Скачивание и установка — только по вашей кнопке.', 'At startup and once a day while the window is open. Download and install happen only on your click.')}
          </p>
          {info.supported ? (
            <div className="upd-state" aria-live="polite">
              <Status s={s} onNote={setNote} panel />
            </div>
          ) : (
            <p className="mute">{t('Обновления работают в установленной сборке.', 'Updates work in the installed build.')}</p>
          )}
          {note ? <p className="s-stale" role="alert">{note}</p> : null}
          <div className="upd-actions">
            <button disabled={!info.supported || busy} onClick={() => void api().checkUpdates()}>{t('Проверить сейчас', 'Check now')}</button>
          </div>
          <p className="mute small">
            {t(
              'Проверка обращается только к GitHub (github.com и его сервер загрузки файлов) и ничего не сообщает о вас, ваших клиентах и настройках. GitHub видит то же, что в любом запросе: IP-адрес, время и язык системы; User-Agent общий — «electron-builder».',
              'The check contacts only GitHub (github.com and its file download server) and says nothing about you, your clients or your settings. GitHub sees what any request shows: the IP address, the time and the system language; the User-Agent is the generic “electron-builder”.',
            )}
          </p>
        </section>
      ) : key && key !== dismissed ? (
        <section className="hud upd-pop upd-card" role="status" aria-label={t('Обновление Loadout', 'Loadout update')}>
          <button className="upd-close" aria-label={t('Скрыть', 'Hide')} title={t('Скрыть', 'Hide')} onClick={() => setDismissed(key)}>×</button>
          <Status s={s} onNote={setNote} />
          {note ? <p className="s-stale" role="alert">{note}</p> : null}
        </section>
      ) : null}
    </>
  )
}
