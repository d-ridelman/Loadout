import type { ReactNode } from 'react'
import type { EntityState, Kind } from '../shared/model'
import { GLYPH } from './aggregate'

/** Состояние глифом и цветом: цвет один не несёт смысла (доступность, CONCEPT.md §8). */
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

/** Путь с местами переноса после `/` и `\`: длинный путь делится по сегментам, а не посреди имени файла. */
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
