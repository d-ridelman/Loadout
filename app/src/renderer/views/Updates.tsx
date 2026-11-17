import { useEffect, useRef, useState } from 'react'
import { fmtTime, t } from '../../shared/i18n'
import type { UpdateErrorReason, UpdatesInfo, UpdateState } from '../../shared/model'

const api = () => window.loadout

/** A calm fixed line per reason; main never sends raw error text. */
const errorText = (r: UpdateErrorReason): string =>
  r === 'offline'
    ? t('Нет связи с GitHub. Проверим позже, работе это не мешает.', 'No connection to GitHub. We will check later; this does not affect your work.')
    : r === 'missing'
      ? t('На GitHub нет сведений об обновлении: возможно, релиз ещё готовится. Проверим позже.', 'GitHub has no update information yet: the release may still be in preparation. We will check later.')
      : r === 'corrupt'
        ? t('Скачанный файл не прошёл проверку целостности, обновление не установлено. Попробуйте позже.', 'The downloaded file failed the integrity check, the update was not installed. Try again later.')
        : r === 'download'
          ? t('Не удалось скачать обновление. Попробуйте позже.', 'Could not download the update. Try again later.')
          : r === 'install'
            ? t('Не удалось запустить установку. Проверьте ещё раз и повторите.', 'Could not start the installation. Check again and retry.')
            : t('Не удалось проверить обновления. Проверим позже.', 'Could not check for updates. We will check later.')

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
      const at = fmtTime(s.checkedAt)
      return <p className="mute">{t(`У вас последняя версия (проверено в ${at})`, `You have the latest version (checked at ${at})`)}</p>
    }
    case 'available':
      return (
        <>
          <p>{t(`Доступна версия ${s.version}`, `Version ${s.version} is available`)}</p>
          <div className="upd-actions">
            <button className="primary" onClick={() => void api().downloadUpdate()}>{t('Скачать', 'Download')}</button>
            <button className="upd-link" onClick={() => void api().openReleaseNotes()}>{t('Что нового (GitHub)', 'What’s new (GitHub)')}</button>
          </div>
        </>
      )
    case 'downloading':
      return (
        <>
          {/* the percent is not announced by a screen reader on every step: it reads the progress bar on demand */}
          <p>
            {t(`Скачивается версия ${s.version}`, `Downloading version ${s.version}`)}
            <span aria-hidden="true">: {s.percent}%</span>
          </p>
          <progress max={100} value={s.percent} aria-label={t('Скачивание обновления', 'Update download')} />
        </>
      )
    case 'ready':
      return (
        <>
          <p>{t(`Версия ${s.version} скачана и проверена`, `Version ${s.version} is downloaded and verified`)}</p>
          <div className="upd-actions">
            <button className="primary" onClick={() => void install()}>{t('Перезапустить и обновить', 'Restart and update')}</button>
          </div>
          <p className="mute small">{t('Если не сейчас, обновление установится при выходе из Loadout.', 'If not now, the update is installed when you quit Loadout.')}</p>
        </>
      )
    case 'error':
      return (
        <>
          <p>{errorText(s.reason)}</p>
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
      ? `error:${s.reason}`
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
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    void api().updates().then(setInfo, () => undefined)
    return api().onUpdates(setInfo)
  }, [])
  useEffect(() => {
    if (!open) return
    // a dialog or the palette above the window takes Escape for itself (App.tsx)
    // capture phase: React closes the dialog in its own listener, after which `.modal` would already be gone
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.modal, .palette')) return
      setOpen(false)
      btnRef.current?.focus() // focus goes back where the panel was opened from
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const online = info ? info.supported && info.auto : false
  const privacy = online
    ? t('F1 — справка · сам Loadout ходит в сеть только за обновлениями (GitHub)', 'F1 — help · on its own, Loadout goes online only to check for updates (GitHub)')
    : t('F1 — справка · сам Loadout в сеть ничего не отправляет', 'F1 — help · on its own, Loadout sends nothing online')
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
        ref={btnRef}
        className={`upd-btn${fresh ? ' s-on' : ''}`}
        aria-expanded={open}
        aria-controls="updates"
        // the visible "vX.Y.Z" starts the name (WCAG 2.5.3); a new version is said in words, not only by the dot and colour
        aria-label={t(`v${info.version} — обновления${fresh ? ', есть новая версия' : ''}`, `v${info.version} — updates${fresh ? ', a new version is available' : ''}`)}
        onClick={() => setOpen((o) => !o)}
      >
        {fresh ? <span aria-hidden="true">● </span> : null}v{info.version}
      </button>
      {open ? (
        <section id="updates" className="hud upd-pop" role="dialog" aria-label={t('Обновления', 'Updates')}>
          <h3>{t('Обновления', 'Updates')}</h3>
          <p>{t(`Установлена версия ${info.version}`, `Installed version ${info.version}`)}</p>
          <label className="upd-auto">
            {/* focus moves into the panel when it opens */}
            <input type="checkbox" autoFocus checked={info.auto} onChange={(e) => toggle(e.target.checked)} />
            {t('Проверять обновления автоматически', 'Check for updates automatically')}
          </label>
          <p className="mute small">
            {t(
              'При запуске и раз в сутки, пока окно открыто (после сбоя — раз в час). Скачивание — только по кнопке, установка — по «Перезапустить и обновить» или при выходе после скачивания.',
              'At startup and once a day while the window is open (hourly after a failure). Download only on your click; install on “Restart and update” or when you quit after the download.',
            )}
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
