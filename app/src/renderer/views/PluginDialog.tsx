import { useCallback, useEffect, useState } from 'react'
import { t } from '../../shared/i18n'
import type { Marketplace } from '../../shared/model'
import { Modal } from './Modal'

interface Props {
  onClose: () => void
  /** Установка закончилась успешно: окно получит новые данные от сторожа, здесь — только сообщение. */
  onDone: (message: string) => void
}

/**
 * Установка плагина Claude Code его собственным CLI (R2): маркетплейс → каталог → плагин. Добавление маркетплейса и
 * установка — сеть и чужой код, поэтому сначала показывается точная команда, потом отдельное подтверждение; плагины,
 * которые ставятся запуском команды маркетплейса, отсюда не ставятся. В журнал Loadout это не пишется (файлы правит
 * сам Claude Code): снять плагин можно выключением или `claude plugin uninstall`, маркетплейс — `claude plugin marketplace remove`.
 */
export function PluginDialog({ onClose, onDone }: Props) {
  const [markets, setMarkets] = useState<Marketplace[] | null>(null)
  const [market, setMarket] = useState('')
  const [adding, setAdding] = useState(false)
  const [source, setSource] = useState('')
  const [filter, setFilter] = useState('')
  const [spec, setSpec] = useState('')
  // команда из предпросмотра и что она делает: установка плагина или добавление маркетплейса
  const [command, setCommand] = useState<{ text: string; kind: 'install' | 'add' } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState<string | null>(null)

  const load = useCallback(async (prefer?: (list: Marketplace[]) => string | undefined) => {
    const r = await window.loadout.marketplaces()
    if (!r.ok) return setError(r.error)
    setMarkets(r.data)
    setMarket((m) => prefer?.(r.data) ?? (r.data.some((x) => x.name === m) ? m : (r.data[0]?.name ?? '')))
    if (r.data.length === 0) setAdding(true)
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const reset = () => {
    setCommand(null)
    setError(null)
    setOutput(null)
  }

  const run = async (kind: 'install' | 'add', dryRun: boolean, value: string) => {
    setBusy(true)
    setError(null)
    setOutput(null)
    try {
      const r = kind === 'install' ? await window.loadout.pluginInstall(value, dryRun) : await window.loadout.marketplaceAdd(value, dryRun)
      if (!r.ok) return setError(r.error)
      if (dryRun) return setCommand({ text: r.data.output, kind })
      if (r.data.code !== 0) {
        setOutput(r.data.output)
        return setError(t(`Команда не удалась (код ${r.data.code})`, `The command failed (code ${r.data.code})`))
      }
      setCommand(null)
      if (kind === 'install') return onDone(t(`Плагин установлен: ${value}. Выключить — в матрице, удалить — claude plugin uninstall`, `Plugin installed: ${value}. Disable it in the matrix, remove it with claude plugin uninstall`))
      // новый маркетплейс — тот, которого не было в списке до добавления
      const before = new Set(markets?.map((m) => m.name))
      setAdding(false)
      setSource('')
      await load((list) => list.find((m) => !before.has(m.name))?.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('не удалось выполнить', 'could not run'))
    } finally {
      setBusy(false)
    }
  }

  const current = markets?.find((m) => m.name === market)
  const q = filter.trim().toLowerCase()
  const shown = current?.plugins.filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)) ?? []

  return (
    <Modal label={t('Установить плагин Claude Code', 'Install Claude Code plugin')} onEscape={onClose}>
      <h2>
        {t('Установить плагин Claude Code', 'Install Claude Code plugin')} <span className="lvl">R2</span>
      </h2>
      <div className="form">
        {markets && markets.length > 0 ? (
          <div className="row-inline">
            <label>
              {t('Маркетплейс', 'Marketplace')}
              <select
                value={market}
                onChange={(e) => {
                  setMarket(e.target.value)
                  setSpec('')
                  reset()
                }}
              >
                {markets.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.source ? `${m.name} — ${m.source}` : m.name}
                  </option>
                ))}
              </select>
            </label>
            {!adding ? (
              <button type="button" onClick={() => (setAdding(true), reset())}>
                {t('Добавить маркетплейс…', 'Add marketplace…')}
              </button>
            ) : null}
          </div>
        ) : null}
        {markets === null && !error ? <p className="mute">{t('Читаю маркетплейсы…', 'Reading marketplaces…')}</p> : null}

        {adding ? (
          <form
            className="form sub"
            aria-label={t('Добавить маркетплейс', 'Add marketplace')}
            onSubmit={(e) => {
              e.preventDefault()
              if (source.trim() && !busy) void run('add', true, source.trim())
            }}
          >
            <label>
              {t('Источник маркетплейса', 'Marketplace source')}
              <input
                autoFocus
                value={source}
                onChange={(e) => {
                  setSource(e.target.value)
                  reset()
                }}
                placeholder={t('owner/repo, https://… или D:\\путь\\к\\папке', 'owner/repo, https://… or D:\\path\\to\\folder')}
                maxLength={400}
                spellCheck={false}
              />
            </label>
            <p className="mute small">
              {t(
                'Claude Code скачает маркетплейс (с GitHub или по адресу) или прочитает его из папки и запишет в ~/.claude/settings.json и ~/.claude/plugins/known_marketplaces.json. Плагины не ставятся. В журнал Loadout это не попадает: убрать — claude plugin marketplace remove <имя>.',
                'Claude Code downloads the marketplace (from GitHub or the address) or reads it from the folder, and records it in ~/.claude/settings.json and ~/.claude/plugins/known_marketplaces.json. No plugins are installed. This is not in the Loadout journal: remove it with claude plugin marketplace remove <name>.',
              )}
            </p>
            {command?.kind === 'add' ? <p className="s-stale">◐ {t('Будет выполнено:', 'Will run:')} <span className="mono">{command.text}</span></p> : null}
            <div className="actions">
              {command?.kind === 'add' ? (
                <button type="button" disabled={busy} onClick={() => void run('add', false, source.trim())}>
                  {busy ? t('Добавляю…', 'Adding…') : t('Добавить маркетплейс', 'Add marketplace')}
                </button>
              ) : (
                <button type="submit" disabled={!source.trim() || busy}>{t('Предпросмотр', 'Preview')}</button>
              )}
              {markets && markets.length > 0 ? (
                <button type="button" onClick={() => (setAdding(false), reset())}>{t('Отмена', 'Cancel')}</button>
              ) : null}
            </div>
          </form>
        ) : null}

        {!adding && current ? (
          current.error ? (
            <p className="s-stale">◐ {current.error}</p>
          ) : (
            <>
              {current.plugins.length > 8 ? (
                <label>
                  {t('Поиск в каталоге', 'Search the catalog')}
                  <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
                </label>
              ) : null}
              <ul className="plist catalog" aria-label={t(`Каталог ${current.name}`, `Catalog ${current.name}`)}>
                {shown.map((p) => {
                  const id = `${p.name}@${current.name}`
                  return (
                    <li key={p.name}>
                      <button
                        type="button"
                        className="pick"
                        aria-pressed={spec === id}
                        disabled={busy || !!p.why}
                        title={p.why}
                        onClick={() => {
                          setSpec(id)
                          reset()
                          void run('install', true, id)
                        }}
                      >
                        <span className="mono">{p.name}</span>
                        {p.version ? <span className="mute small"> {p.version}</span> : null}
                        {p.installed ? <span className="badge">{t('установлен', 'installed')}</span> : null}
                        {p.description ? <span className="mute small desc">{p.description}</span> : null}
                        {p.why ? <span className="mute small desc">{p.why}</span> : null}
                      </button>
                    </li>
                  )
                })}
                {shown.length === 0 ? <li className="mute">{t('Плагинов нет', 'No plugins')}</li> : null}
              </ul>
              <p className="mute small">
                {t(
                  'Установка идёт через `claude`, скачивает код плагина и выполняется без перезапуска приложений.',
                  'Installation runs through `claude`, downloads the plugin code and happens without restarting apps.',
                )}
              </p>
              {command?.kind === 'install' ? <p className="s-stale">◐ {t('Будет выполнено:', 'Will run:')} <span className="mono">{command.text}</span></p> : null}
            </>
          )
        ) : null}
        {error ? <p className="s-broken" role="alert">{error}</p> : null}
        {output ? <pre className="wrap mono small">{output}</pre> : null}
        <div className="actions">
          {command?.kind === 'install' ? (
            <button type="button" disabled={busy} onClick={() => void run('install', false, spec)}>{busy ? t('Устанавливаю…', 'Installing…') : t('Установить', 'Install')}</button>
          ) : null}
          <button type="button" onClick={onClose}>{t('Закрыть', 'Close')}</button>
        </div>
      </div>
    </Modal>
  )
}
