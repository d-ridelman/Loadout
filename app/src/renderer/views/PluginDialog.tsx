import { useCallback, useEffect, useState } from 'react'
import { t } from '../../shared/i18n'
import type { Marketplace } from '../../shared/model'
import { Cmd, Rich } from '../ui'
import { Modal } from './Modal'

interface Props {
  onClose: () => void
  /** The installation finished successfully: the window gets fresh data from the watcher, so only a message is needed here. */
  onDone: (message: string) => void
}

/**
 * Installing a Claude Code plugin with its own CLI (R2): marketplace -> catalog -> plugin. Adding a marketplace and
 * installing both involve the network and third-party code, so the exact command is shown first, then a separate confirmation;
 * plugins that are installed by running a marketplace command are not installed from here. This is not written to the Loadout
 * journal (Claude Code edits the files itself): a plugin can be removed by disabling it or with `claude plugin uninstall`,
 * a marketplace with `claude plugin marketplace remove`.
 */
export function PluginDialog({ onClose, onDone }: Props) {
  const [markets, setMarkets] = useState<Marketplace[] | null>(null)
  const [market, setMarket] = useState('')
  const [adding, setAdding] = useState(false)
  const [source, setSource] = useState('')
  const [filter, setFilter] = useState('')
  const [spec, setSpec] = useState('')
  // the command from the preview and what it does: installing a plugin or adding a marketplace
  const [command, setCommand] = useState<{ text: string; kind: 'install' | 'add' } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState<string | null>(null)
  const [refreshed, setRefreshed] = useState(false)

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
      if (kind === 'install') return onDone(t(`Плагин установлен: ${value}. Выключить можно в матрице, удалить — командой \`claude plugin uninstall\``, `Plugin installed: ${value}. Disable it in the matrix, remove it with \`claude plugin uninstall\``))
      // the new marketplace is the one that was not in the list before adding
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
              <>
                <button
                  type="button"
                  disabled={busy}
                  title={t('Перечитать каталоги маркетплейсов с диска (в сеть не ходит)', 'Read the marketplace catalogs from disk again (no network)')}
                  onClick={() => {
                    reset()
                    void load().then(() => setRefreshed(true))
                  }}
                >
                  {t('Обновить каталог', 'Refresh catalog')}
                </button>
                <button type="button" onClick={() => (setAdding(true), reset())}>
                  {t('Добавить маркетплейс…', 'Add marketplace…')}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {markets === null && !error ? <p className="mute">{t('Читаю маркетплейсы…', 'Reading marketplaces…')}</p> : null}
        {refreshed && !adding ? (
          <p className="mute small" role="status">
            <Rich
              text={t(
                'Каталог перечитан с диска. Чтобы скачать свежий список плагинов из источника маркетплейса, выполните `claude plugin marketplace update` и нажмите «Обновить каталог» ещё раз.',
                'The catalog was read from disk again. To download a fresh plugin list from the marketplace source, run `claude plugin marketplace update` and press “Refresh catalog” again.',
              )}
            />
          </p>
        ) : null}

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
                placeholder={t('owner/repo[#ветка], https://…, git@хост:путь или D:\\путь\\к\\папке', 'owner/repo[#branch], https://…, git@host:path or D:\\path\\to\\folder')}
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
            {command?.kind === 'add' ? <p className="s-stale">◐ {t('Будет выполнено:', 'Will run:')} <span className="mono"><Cmd text={command.text} /></span></p> : null}
            <div className="actions">
              {command?.kind === 'add' ? (
                <button type="button" className="primary" disabled={busy} onClick={() => void run('add', false, source.trim())}>
                  {busy ? t('Добавляю…', 'Adding…') : t('Добавить маркетплейс', 'Add marketplace')}
                </button>
              ) : (
                <button type="submit" className="primary" disabled={!source.trim() || busy}>{t('Предпросмотр', 'Preview')}</button>
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
                <Rich
                  text={t(
                    'Установка идёт через `claude`, скачивает код плагина и выполняется без перезапуска приложений.',
                    'Installation runs through `claude`, downloads the plugin code and happens without restarting apps.',
                  )}
                />
              </p>
              {command?.kind === 'install' ? <p className="s-stale">◐ {t('Будет выполнено:', 'Will run:')} <span className="mono"><Cmd text={command.text} /></span></p> : null}
            </>
          )
        ) : null}
        {error ? <p className="s-broken" role="alert">{error}</p> : null}
        {output ? <pre className="out" aria-label={t('Вывод claude', 'claude output')} tabIndex={0}>{output}</pre> : null}
        <div className="actions">
          {command?.kind === 'install' ? (
            <button type="button" className="primary" disabled={busy} onClick={() => void run('install', false, spec)}>{busy ? t('Устанавливаю…', 'Installing…') : t('Установить', 'Install')}</button>
          ) : null}
          <button type="button" onClick={onClose}>{t('Закрыть', 'Close')}</button>
        </div>
      </div>
    </Modal>
  )
}
