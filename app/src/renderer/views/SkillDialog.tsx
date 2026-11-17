import { useState } from 'react'
import { t } from '../../shared/i18n'
import type { Intent, SkillFetch } from '../../shared/model'
import { Modal } from './Modal'

interface Props {
  onClose: () => void
  /** The source is prepared and a skill is chosen: the shared write preview follows (core plan, R2, journal, rollback). */
  onSubmit: (intent: Intent) => void
}

/**
 * Install a Claude Code skill into `~/.claude/skills/<name>`. Step 1: show what will be downloaded and where (no network yet);
 * step 2: on a separate button, download (git clone) or copy into the Loadout staging directory; step 3: pick a skill,
 * then the core plan with files and a confirmation. Nothing is written to `~/.claude` before confirmation.
 */
export function SkillDialog({ onClose, onSubmit }: Props) {
  const [source, setSource] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [fetched, setFetched] = useState<SkillFetch | null>(null)
  const [pick, setPick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const local = /^[A-Za-z]:[\\/]/.test(source.trim())

  const call = async (dryRun: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.loadout.skillFetch(source.trim(), dryRun)
      if (!r.ok) return setError(r.error)
      if (dryRun) return setPreview(r.data.command)
      setFetched(r.data)
      setPick(0)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('не удалось выполнить', 'could not run'))
    } finally {
      setBusy(false)
    }
  }
  const chosen = fetched?.skills[pick]

  return (
    <Modal label={t('Установить скил', 'Install skill')} onEscape={onClose}>
      <h2>
        {t('Установить скил Claude Code', 'Install Claude Code skill')} <span className="lvl">R2</span>
      </h2>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (source.trim() && !busy && !fetched) void call(true)
        }}
      >
        <label>
          {t('Источник скила', 'Skill source')}
          <input
            autoFocus
            value={source}
            disabled={!!fetched}
            onChange={(e) => {
              setSource(e.target.value)
              setPreview(null)
              setError(null)
            }}
            placeholder={t('owner/repo[/путь], https://github.com/…/tree/ветка-или-хеш/… или D:\\папка', 'owner/repo[/path], https://github.com/…/tree/branch-or-hash/… or D:\\folder')}
            maxLength={400}
            spellCheck={false}
          />
        </label>
        {!fetched ? (
          <p className="mute small">
            {t(
              'Скил — каталог со SKILL.md. С GitHub репозиторий скачивается (git clone, только последняя версия) во временную папку Loadout; из папки — копируется туда же. В ~/.claude ничего не пишется, пока вы не подтвердите установку.',
              'A skill is a directory with SKILL.md. From GitHub the repository is downloaded (git clone, latest version only) into a Loadout temporary folder; from a folder it is copied there. Nothing is written to ~/.claude until you confirm the installation.',
            )}
          </p>
        ) : null}
        {preview && !fetched ? (
          <p className="s-stale">
            ◐ {local ? t('Будет скопировано:', 'Will copy:') : t('Будет скачано:', 'Will download:')} <span className="mono">{preview}</span>
          </p>
        ) : null}
        {fetched ? (
          <fieldset className="choices">
            <legend>{t('Скилы в источнике', 'Skills in the source')}</legend>
            <ul className="plist">
              {fetched.skills.map((s, i) => (
                <li key={s.sub || '.'}>
                  <label>
                    <input type="radio" name="skill" checked={pick === i} disabled={!s.name} onChange={() => setPick(i)} />
                    <span>
                      <span className="mono">{s.name || s.sub}</span>
                      {s.sub ? <span className="mute small"> {s.sub}/</span> : null}
                      {s.description ? <span className="mute small desc">{s.description}</span> : null}
                      {!s.name ? <span className="mute small desc">{t('имя каталога не подходит для скила', 'the directory name is not valid for a skill')}</span> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        ) : null}
        {error ? <p className="s-broken" role="alert">{error}</p> : null}
        <div className="actions">
          {fetched ? (
            <button type="button" className="primary" disabled={!chosen?.name} onClick={() => chosen && onSubmit({ op: 'installSkill', stage: fetched.stage, sub: chosen.sub, name: chosen.name })}>
              {t('Предпросмотр установки', 'Preview installation')}
            </button>
          ) : preview ? (
            <button type="button" className="primary" disabled={busy} onClick={() => void call(false)}>
              {busy ? (local ? t('Копирую…', 'Copying…') : t('Скачиваю…', 'Downloading…')) : local ? t('Скопировать и показать', 'Copy and show') : t('Скачать и показать', 'Download and show')}
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!source.trim() || busy}>{local ? t('Что будет скопировано', 'What will be copied') : t('Что будет скачано', 'What will be downloaded')}</button>
          )}
          <button type="button" onClick={onClose}>{t('Отмена', 'Cancel')}</button>
        </div>
      </form>
    </Modal>
  )
}
