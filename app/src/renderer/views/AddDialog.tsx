import { useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { ClientId, Intent } from '../../shared/model'
import { t } from '../../shared/i18n'
import { Modal } from './Modal'

interface Props {
  onSubmit: (intent: Intent) => void
  onClose: () => void
}

/** DeepSeek stores entries in tagged YAML: adding to it is not allowed (CONCEPT.md §11). */
const TARGETS = CLIENTS.filter((c) => c.id !== 'deepseek')
const NAME_OK = /^[A-Za-z0-9._-]{1,64}$/
const KEY_OK = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/**
 * Add an MCP server to a client (R2). env values go only to the core and are not shown in the preview.
 * Packages are not installed here: the window writes a launch line, and `npx`/`uvx` downloads the package on the client's first launch.
 */
export function AddDialog({ onSubmit, onClose }: Props) {
  const [to, setTo] = useState<ClientId>(TARGETS[0]?.id ?? 'claude-code')
  const [name, setName] = useState('')
  const [wantRemote, setRemote] = useState(false)
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [env, setEnv] = useState('')
  // the remote-server form has been checked only for Claude Code and Codex
  const remoteOk = to === 'claude-code' || to === 'codex'
  const remote = wantRemote && remoteOk
  const lines = args.split('\n').filter((l) => l !== '')
  const envLines = env.split('\n').filter((l) => l.trim() !== '')
  const pairs = envLines.map((l) => {
    const i = l.indexOf('=')
    return { key: i < 0 ? l.trim() : l.slice(0, i).trim(), value: i < 0 ? '' : l.slice(i + 1) }
  })
  const envOk = pairs.every((p) => KEY_OK.test(p.key)) && pairs.length <= 30
  const ok =
    NAME_OK.test(name) && envOk && (remote ? remoteOk && /^https?:\/\/[^\s/?#@:]\S*$/.test(url.trim()) : command.trim() !== '' && lines.length <= 64)
  return (
    <Modal label={t('Добавить MCP-сервер', 'Add MCP server')} onEscape={onClose}>
      <h2>
        {t('Добавить MCP-сервер', 'Add MCP server')} <span className="lvl">R2</span>
      </h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!ok) return
          onSubmit({
            op: 'add',
            to,
            name,
            command: remote ? '' : command.trim(),
            args: remote ? [] : lines,
            url: remote ? url.trim() : '',
            env: remote ? [] : pairs,
          })
        }}
      >
        <label>
          {t('Клиент', 'Client')}
          <select value={to} onChange={(e) => setTo(e.target.value as ClientId)}>
            {TARGETS.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label>
          {t('Имя', 'Name')}
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" maxLength={64} spellCheck={false} />
        </label>
        <fieldset className="choices">
          <legend className="mute small">{t('Тип', 'Type')}</legend>
          <label><input type="radio" name="kind" checked={!remote} onChange={() => setRemote(false)} /> {t('локальный (команда)', 'local (command)')}</label>
          <label title={remoteOk ? undefined : t('Только для Claude Code и Codex: у остальных клиентов форма записи не проверена', 'Only for Claude Code and Codex: the entry format is not verified for other clients')}>
            <input type="radio" name="kind" checked={remote} disabled={!remoteOk} onChange={() => setRemote(true)} /> {t('удалённый (адрес)', 'remote (URL)')}
          </label>
        </fieldset>
        {remote ? (
          <label>
            {t('Адрес', 'URL')}
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" maxLength={500} spellCheck={false} />
          </label>
        ) : (
          <>
            <label>
              {t('Команда', 'Command')}
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" maxLength={500} spellCheck={false} />
            </label>
            <label>
              {t('Аргументы, по одному в строке', 'Arguments, one per line')}
              <textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={3} placeholder={t('-y\nпакет@1.2.3', '-y\npackage@1.2.3')} spellCheck={false} />
            </label>
            <label>
              {t('Переменные окружения, КЛЮЧ=значение, по одной в строке', 'Environment variables, KEY=value, one per line')}
              <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={2} placeholder="API_TOKEN=…" spellCheck={false} />
            </label>
          </>
        )}
        <p className="mute small">
          {t(
            'Пакет не скачивается: в конфиг клиента записывается строка запуска, а `npx`/`uvx` загрузит пакет при первом запуске клиента. Значения env в предпросмотре и журнале не показываются.',
            'The package is not downloaded: the client config gets a launch command, and `npx`/`uvx` fetches the package on the client’s first launch. Env values are not shown in the preview or journal.',
          )}
        </p>
        <div className="actions">
          <button type="submit" disabled={!ok}>{t('Предпросмотр', 'Preview')}</button>
          <button type="button" onClick={onClose}>{t('Отмена', 'Cancel')}</button>
        </div>
      </form>
    </Modal>
  )
}
