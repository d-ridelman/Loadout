import type { ReactNode } from 'react'
import type { EntityState, Kind } from '../shared/model'
import { GLYPH } from './aggregate'

/** State as a glyph plus color: color alone carries no meaning (accessibility, CONCEPT.md §8). */
export function Glyph({ state, pulse }: { state: EntityState | 'none'; pulse?: boolean }) {
  const g = GLYPH[state]
  return (
    <span className={`g s-${state}${pulse && state === 'broken' ? ' pulse' : ''}`} aria-hidden="true">
      {g.ch}
    </span>
  )
}

export function KindBadge({ kinds }: { kinds: readonly Kind[] }) {
  return <span className={`badge k-${kinds[0] ?? 'plugin'}`}>{kinds.join('+')}</span>
}

export function Panel({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`hud card ${className}`}>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
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
}
