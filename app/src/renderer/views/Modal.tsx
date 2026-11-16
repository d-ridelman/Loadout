import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

/** A dialog over the window: focus does not leave for the page below (Tab cycles through the dialog's buttons and fields). Esc is handled by App. */
export function Modal({ label, children, onEscape }: { label: string; children: ReactNode; onEscape: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const trap = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onEscape()
      return
    }
    if (e.key !== 'Tab') return
    const all = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select') ?? [])]
    const first = all[0]
    const last = all[all.length - 1]
    if (!first || !last) return
    const cur = document.activeElement
    if (e.shiftKey && cur === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && cur === last) {
      e.preventDefault()
      first.focus()
    }
  }
  return (
    <div className="modal" onKeyDown={trap}>
      <div ref={box} className="hud box" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  )
}
