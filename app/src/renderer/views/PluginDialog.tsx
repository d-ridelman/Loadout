import { useState } from 'react'
import { Modal } from './Modal'

interface Props {
  onClose: () => void
  /** Установка закончилась успешно: окно получит новые данные от сторожа, здесь — только сообщение. */
  onDone: (message: string) => void
}

const SPEC_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Установка плагина Claude Code его собственным CLI (R2). Это сеть и чужой код, поэтому сначала показывается точная
 * команда, потом отдельное подтверждение; плагины, которые ставятся запуском команды маркетплейса, CLI без `-y` отклонит.
 * В журнал Loadout установка не пишется (файлы правит сам Claude Code): снять плагин можно выключением или `claude plugin uninstall`.
 */
export function PluginDialog({ onClose, onDone }: Props) {
  const [spec, setSpec] = useState('')
  const [command, setCommand] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState<string | null>(null)
  const ok = SPEC_OK.test(spec.trim())

  const call = async (dryRun: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.loadout.pluginInstall(spec.trim(), dryRun)
      if (!r.ok) return setError(r.error)
      if (dryRun) return setCommand(r.data.output)
      if (r.data.code === 0) onDone(`Плагин установлен: ${spec.trim()}. Выключить — в матрице, удалить — claude plugin uninstall`)
      else {
        setOutput(r.data.output)
        setError(`Установка не удалась (код ${r.data.code})`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'не удалось выполнить')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal label="Установить плагин Claude Code" onEscape={onClose}>
      <h2>
        Установить плагин Claude Code <span className="lvl">R2</span>
      </h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (ok && !busy) void call(true)
        }}
      >
        <label>
          Плагин (имя@маркетплейс)
          <input
            autoFocus
            value={spec}
            onChange={(e) => {
              setSpec(e.target.value)
              setCommand(null)
            }}
            placeholder="name@marketplace"
            maxLength={129}
            spellCheck={false}
          />
        </label>
        <p className="mute small">
          Маркетплейс должен быть уже добавлен в Claude Code. Установка идёт через `claude`, скачивает код из маркетплейса и выполняется без перезапуска приложений.
        </p>
        {command ? (
          <p className="s-stale">◐ Будет выполнено: <span className="mono">{command}</span></p>
        ) : null}
        {error ? <p className="s-broken" role="alert">{error}</p> : null}
        {output ? <pre className="wrap mono small">{output}</pre> : null}
        <div className="actions">
          {command ? (
            <button type="button" disabled={busy} onClick={() => void call(false)}>{busy ? 'Устанавливаю…' : 'Установить'}</button>
          ) : (
            <button type="submit" disabled={!ok || busy}>Предпросмотр</button>
          )}
          <button type="button" onClick={onClose}>Отмена</button>
        </div>
      </form>
    </Modal>
  )
}
