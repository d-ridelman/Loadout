import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

/** A dialog over the window: focus does not leave for the page below (Tab cycles through the dialog's buttons and fields). Esc is handled by App. */
export function Modal({ label, children, onEscape, wide }: { label: string; children: ReactNode; onEscape: () => void; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const trap = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onEscape()
      return
    }
    if (e.key !== 'Tab') return
    const all = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select, summary, [tabindex="0"]') ?? [])]
    const first = all[0]
    const last = all[all.length - 1]
    if (!first || !last) return
    const cur = document.activeElement
    // focus on something outside the cycle (a block focused by script, tabindex -1): the next Tab stays inside
    if (!all.includes(cur as HTMLElement)) {
      e.preventDefault()
      ;(e.shiftKey ? last : first).focus()
    } else if (e.shiftKey && cur === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && cur === last) {
      e.preventDefault()
      first.focus()
    }
  }
  return (
    <div className="modal" onKeyDown={trap}>
      <div ref={box} className={`hud box${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  )
}
