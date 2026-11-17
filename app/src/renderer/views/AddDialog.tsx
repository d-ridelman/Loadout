import { useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { ClientId, Entity, Intent } from '../../shared/model'
import { t } from '../../shared/i18n'
import { Rich } from '../ui'
import { Modal } from './Modal'

type AddIntent = Extract<Intent, { op: 'add' }>

interface Props {
  /** Entries already loaded: a taken name is reported in the form, before any plan. */
  entities: Entity[]
  /** What was typed before the preview ("Back to the form"): env values stay in memory only, never stored. */
  draft?: AddIntent
  onSubmit: (intent: Intent) => void
  onClose: () => void
}

/** DeepSeek stores entries in tagged YAML: adding to it is not allowed (CONCEPT.md §11). */
const TARGETS = CLIENTS.filter((c) => c.id !== 'deepseek')
const NAME_OK = /^[A-Za-z0-9._-]{1,64}$/
const KEY_OK = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** The client already has an MCP with this name (the same check the core makes, Loadout trash included). */
export function nameTaken(entities: readonly Entity[], to: ClientId, name: string): boolean {
  return entities.some((e) => e.client === to && e.kind === 'mcp' && e.scope === 'user' && e.name === name)
}

/**
 * Add an MCP server to a client (R2). env values go only to the core and are not shown in the preview.
 * Packages are not installed here: the window writes a launch line, and `npx`/`uvx` downloads the package on the client's first launch.
 */
export function AddDialog({ entities, draft, onSubmit, onClose }: Props) {
  const [to, setTo] = useState<ClientId>(draft?.to ?? TARGETS[0]?.id ?? 'claude-code')
  const [name, setName] = useState(draft?.name ?? '')
  const [wantRemote, setRemote] = useState(!!draft?.url)
  const [command, setCommand] = useState(draft?.command ?? '')
  const [args, setArgs] = useState(draft?.args.join('\n') ?? '')
  const [url, setUrl] = useState(draft?.url ?? '')
  const [env, setEnv] = useState(draft?.env.map((p) => `${p.key}=${p.value}`).join('\n') ?? '')
  const taken = nameTaken(entities, to, name)
  // the remote-server form has been checked only for Claude Code, Codex and OpenCode (the same list as the core's `prep_add`)
  const remoteOk = to === 'claude-code' || to === 'codex' || to === 'opencode' || to === 'antigravity'
  const remote = wantRemote && remoteOk
  const lines = args.split('\n').filter((l) => l !== '')
  const envLines = env.split('\n').filter((l) => l.trim() !== '')
  const pairs = envLines.map((l) => {
    const i = l.indexOf('=')
    return { key: i < 0 ? l.trim() : l.slice(0, i).trim(), value: i < 0 ? '' : l.slice(i + 1) }
  })
  const envOk = pairs.every((p) => KEY_OK.test(p.key)) && pairs.length <= 30
  const ok =
    NAME_OK.test(name) && !taken && envOk && (remote ? remoteOk && /^https?:\/\/[^\s/?#@:]\S*$/.test(url.trim()) : command.trim() !== '' && lines.length <= 64)
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
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" maxLength={64} spellCheck={false} aria-invalid={taken || undefined} aria-describedby={taken ? 'add-taken' : undefined} />
        </label>
        {taken ? (
          <p id="add-taken" className="s-broken small" role="alert">
            {t(
              `У ${CLIENTS.find((c) => c.id === to)?.name ?? to} уже есть MCP-сервер «${name}»: выберите другое имя или другого клиента.`,
              `${CLIENTS.find((c) => c.id === to)?.name ?? to} already has an MCP server named “${name}”: pick another name or client.`,
            )}
          </p>
        ) : null}
        <fieldset className="choices">
          <legend className="mute small">{t('Тип', 'Type')}</legend>
          <label><input type="radio" name="kind" checked={!remote} onChange={() => setRemote(false)} /> {t('локальный (команда)', 'local (command)')}</label>
          <label title={remoteOk ? undefined : t('Не для Claude Desktop и DeepSeek: в Desktop удалённый сервер добавляется в приложении как коннектор, DeepSeek хранит записи в YAML с тегами', 'Not for Claude Desktop and DeepSeek: Desktop adds a remote server in the app as a connector, DeepSeek keeps entries in tagged YAML')}>
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
          <Rich
            text={t(
              'Пакет не скачивается: в конфиг клиента записывается строка запуска, а `npx`/`uvx` загрузит пакет при первом запуске клиента. Значения env в предпросмотре и журнале не показываются.',
              'The package is not downloaded: the client config gets a launch command, and `npx`/`uvx` fetches the package on the client’s first launch. Env values are not shown in the preview or journal.',
            )}
          />
        </p>
        <div className="actions">
          <button type="submit" className="primary" disabled={!ok}>{t('Предпросмотр', 'Preview')}</button>
          <button type="button" onClick={onClose}>{t('Отмена', 'Cancel')}</button>
        </div>
      </form>
    </Modal>
  )
}
