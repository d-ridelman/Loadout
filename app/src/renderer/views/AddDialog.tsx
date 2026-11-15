import { useState } from 'react'
import { CLIENTS } from '../../shared/model'
import type { ClientId, Intent } from '../../shared/model'
import { Modal } from './Modal'

interface Props {
  onSubmit: (intent: Intent) => void
  onClose: () => void
}

/** DeepSeek хранит записи в YAML с тегами: добавлять в него нельзя (CONCEPT.md §11). */
const TARGETS = CLIENTS.filter((c) => c.id !== 'deepseek')
const NAME_OK = /^[A-Za-z0-9._-]{1,64}$/
const KEY_OK = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/**
 * Добавление MCP-сервера клиенту (R2). Значения env уходят только в ядро и в предпросмотре не показываются.
 * Установки самих пакетов здесь нет: окно записывает строку запуска, а `npx`/`uvx` скачает пакет при первом запуске клиента.
 */
export function AddDialog({ onSubmit, onClose }: Props) {
  const [to, setTo] = useState<ClientId>(TARGETS[0]?.id ?? 'claude-code')
  const [name, setName] = useState('')
  const [wantRemote, setRemote] = useState(false)
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [env, setEnv] = useState('')
  // форма удалённого сервера сверена только для Claude Code и Codex
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
    <Modal label="Добавить MCP-сервер" onEscape={onClose}>
      <h2>
        Добавить MCP-сервер <span className="lvl">R2</span>
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
          Клиент
          <select value={to} onChange={(e) => setTo(e.target.value as ClientId)}>
            {TARGETS.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label>
          Имя
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" maxLength={64} spellCheck={false} />
        </label>
        <fieldset className="choices">
          <legend className="mute small">Тип</legend>
          <label><input type="radio" name="kind" checked={!remote} onChange={() => setRemote(false)} /> локальный (команда)</label>
          <label title={remoteOk ? undefined : 'Только для Claude Code и Codex: у остальных клиентов форма записи не проверена'}>
            <input type="radio" name="kind" checked={remote} disabled={!remoteOk} onChange={() => setRemote(true)} /> удалённый (адрес)
          </label>
        </fieldset>
        {remote ? (
          <label>
            Адрес
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" maxLength={500} spellCheck={false} />
          </label>
        ) : (
          <>
            <label>
              Команда
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" maxLength={500} spellCheck={false} />
            </label>
            <label>
              Аргументы, по одному в строке
              <textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={3} placeholder={'-y\nпакет@1.2.3'} spellCheck={false} />
            </label>
            <label>
              Переменные окружения, КЛЮЧ=значение, по одной в строке
              <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={2} placeholder="API_TOKEN=…" spellCheck={false} />
            </label>
          </>
        )}
        <p className="mute small">
          Пакет не скачивается: в конфиг клиента записывается строка запуска, а `npx`/`uvx` загрузит пакет при первом запуске клиента. Значения env в предпросмотре и журнале не показываются.
        </p>
        <div className="actions">
          <button type="submit" disabled={!ok}>Предпросмотр</button>
          <button type="button" onClick={onClose}>Отмена</button>
        </div>
      </form>
    </Modal>
  )
}
