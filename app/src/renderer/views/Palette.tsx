import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../../shared/i18n'

export interface PaletteItem {
  label: string
  hint: string
  run: () => void
}

/** Command palette (Ctrl+K). Focus returns to where it was opened from. */
export function Palette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [n, setN] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const opener = useRef<Element | null>(document.activeElement)
  const listRef = useRef<HTMLUListElement>(null)

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items.filter((i) => i.label.toLowerCase().includes(needle)).slice(0, 40)
  }, [items, q])

  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [n, shown])

  const close = () => {
    onClose()
    const o = opener.current
    if (o instanceof HTMLElement && document.contains(o)) o.focus()
    else document.getElementById('grid')?.focus()
  }
  const run = (i: PaletteItem | undefined) => {
    close()
    if (!i) return
    i.run()
    // whatever was picked in the palette is immediately usable from the keyboard: focus the table if the new screen has one
    // the frame may arrive late (window not in the foreground): if a dialog or the palette opened again meanwhile, do not take focus from them
    requestAnimationFrame(() => {
      if (!document.querySelector('[role=dialog]')) document.getElementById('grid')?.focus()
    })
  }

  return (
    <div className="palette" role="dialog" aria-modal="true" aria-label={t('Палитра команд', 'Command palette')} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="hud box">
        <input
          ref={input}
          value={q}
          placeholder={t('Сущность, раздел или действие…', 'Entity, section or action…')}
          aria-label={t('Команда', 'Command')}
          role="combobox"
          aria-expanded="true"
          aria-controls="pal-list"
          aria-activedescendant={shown[n] ? `pal-${n}` : undefined}
          onChange={(e) => {
            setQ(e.target.value)
            setN(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setN(Math.min(shown.length - 1, n + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setN(Math.max(0, n - 1))
            } else if (e.key === 'Enter') run(shown[n])
            else if (e.key === 'Escape') close()
            else if (e.key === 'Tab') {
              e.preventDefault() // focus trap: the dialog has only the input field
            }
          }}
        />
        <ul id="pal-list" ref={listRef} role="listbox">
          {shown.map((i, k) => (
            <li key={`${i.label}-${k}`} id={`pal-${k}`} role="option" aria-selected={k === n} onClick={() => run(i)}>
              <span>{i.label}</span>
              <span className="mute mono">{i.hint}</span>
            </li>
          ))}
          {shown.length === 0 ? <li className="mute" aria-disabled="true">{t('Ничего не найдено', 'Nothing found')}</li> : null}
        </ul>
      </div>
    </div>
  )
}
