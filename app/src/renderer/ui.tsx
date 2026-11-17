import { useId } from 'react'
import type { ReactNode } from 'react'
import { t } from '../shared/i18n'
import type { EntityState, Kind, WriteLevel } from '../shared/model'
import { GLYPH } from './aggregate'

/** A toast's tone: colour, glyph and the ARIA role (an error interrupts the screen reader, the rest wait their turn). */
export type Tone = 'ok' | 'error' | 'info'
export type Notify = (message: string, tone?: Tone) => void

/** The write level in words first (what the window may do), the code after it for those who know it. */
export const levelLabel = (l: WriteLevel): string =>
  l === 'R0' ? t('Только чтение · R0', 'Read-only · R0') : l === 'R1' ? t('Вкл/выкл · R1', 'On/off · R1') : t('Все правки · R2', 'All edits · R2')


/** State as a glyph plus color: color alone carries no meaning (accessibility, CONCEPT.md §8). */
export function Glyph({ state, pulse }: { state: EntityState | 'none'; pulse?: boolean }) {
  const g = GLYPH[state]
  return (
    <span className={`g s-${state}${pulse && state === 'broken' ? ' pulse' : ''}`} aria-hidden="true">
      {g.ch}
    </span>
  )
}

/** A kind in the person's words (one entry), not the config key. */
export const kindLabel = (k: Kind): string =>
  ({
    plugin: t('плагин', 'plugin'),
    mcp: 'MCP',
    skill: t('скил', 'skill'),
    hook: t('хук', 'hook'),
    agent: t('агент', 'agent'),
    command: t('команда', 'command'),
    connector: t('коннектор', 'connector'),
    marketplace: t('маркетплейс', 'marketplace'),
  })[k] ?? k

export function KindBadge({ kinds }: { kinds: readonly Kind[] }) {
  return <span className={`badge k-${kinds[0] ?? 'plugin'}`}>{kinds.map(kindLabel).join(' + ')}</span>
}

export function Panel({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`hud card ${className}`}>
      {title ? <h3>{title}</h3> : null}
      {children}
    </section>
  )
}

/**
 * A term with its explanation: dotted underline, the explanation shows on hover and on keyboard focus (not a `title`,
 * which the keyboard never reaches) and is the term's accessible description.
 */
export function Term({ tip, children }: { tip: string; children: ReactNode }) {
  const id = useId()
  return (
    <span className="term" tabIndex={0} aria-describedby={id} onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}>
      {children}
      <span role="tooltip" id={id} className="tip">{tip}</span>
    </span>
  )
}

/** Opens the in-window help at a topic; set once by App (the help lives there). */
export let openHelp: (topic?: string) => void = () => undefined
export const setOpenHelp = (f: (topic?: string) => void): void => {
  openHelp = f
}

/** Section title with a one-line explanation under it and a link to the section's help: the same size and spacing on every page. */
export function PageHead({ title, sub, topic, children }: { title: ReactNode; sub: ReactNode; topic?: string; children?: ReactNode }) {
  return (
    <div className="pagehead">
      <h2>{title}</h2>
      <p className="mute">
        {sub}
        {topic ? (
          <>
            {' '}
            <button className="linkish" onClick={() => openHelp(topic)}>{t('Подробнее в справке', 'More in Help')}</button>
          </>
        ) : null}
      </p>
      {children}
    </div>
  )
}

/** Text split on backtick pairs: `x` parts become code. An odd number of backticks leaves the text as it is. */
export function codeSpans(s: string): (string | { code: string })[] {
  const parts = s.split('`')
  if (parts.length < 3 || parts.length % 2 === 0) return [s]
  return parts.flatMap((p, i): (string | { code: string })[] => (i % 2 ? [{ code: p }] : p ? [p] : []))
}

/** Plain text where `code` in backticks shows as code instead of raw backtick characters. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {codeSpans(text).map((p, i) => (typeof p === 'string' ? p : <code key={i}>{p.code}</code>))}
    </>
  )
}

const TOAST_GLYPH: Record<Tone, string> = { ok: '●', error: '✕', info: 'i' }

/** A pop-up message above the footer: full text, colour plus a glyph, and a close button. */
export function Toast({ id, tone, text, onClose }: { id: string; tone: Tone; text: string; onClose: () => void }) {
  return (
    <div id={id} className={`hud toast toast-${tone}`}>
      <span className="g" aria-hidden="true">{TOAST_GLYPH[tone]}</span>
      <span className="toast-text"><Rich text={text} /></span>
      <button className="toast-close" aria-label={t('Закрыть уведомление', 'Close the notification')} onClick={onClose}>×</button>
    </div>
  )
}

/** A command or a value that wraps only between its words: "e2e-market" or "--scope" never break at a hyphen (a word longer than the line still breaks). */
export function Cmd({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\s+)/).map((w, i) => (i % 2 ? w : w ? <span key={i} className="tok">{w}</span> : null))}
    </>
  )
}

/** Path with wrap points after `/` and `\`: a long path breaks between segments, not in the middle of a file name. */
export function Path({ p }: { p: string }) {
  return (
    <>
      {p.split(/(?<=[/\\])/).map((s, i) => (
        <span key={i}>
          {i > 0 ? <wbr /> : null}
          {s}
        </span>
      ))}
    </>
  )
}

export const clientShort: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'ChatGPT / Codex',
  antigravity: 'Antigravity',
  deepseek: 'DeepSeek',
  opencode: 'OpenCode',
}
