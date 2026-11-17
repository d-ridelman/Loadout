// UI text is Segoe UI (hinted for ClearType at 100–125 % scale; Inter rendered ~15 % softer there); the mono face is for code only
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import { StrictMode, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { setLang } from '../shared/i18n'
import type { Lang } from '../shared/i18n'
import { App } from './App'
import type { Ui } from './keep'
import { ErrorBoundary } from './ErrorBoundary'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root container not found')
const root = createRoot(container)

/** The language changes as a whole: `key` recreates the tree, so every string is taken again in the new language. */
function Root({ initial }: { initial: Lang }) {
  const [lang, setCurrent] = useState<Lang>(initial)
  // the section, selection and filters survive the rebuild: the new App starts from them
  const kept = useRef<Ui | undefined>(undefined)
  const change = async (next: Lang, ui: Ui): Promise<void> => {
    try {
      const applied = await window.loadout.setLang(next)
      setLang(applied)
      document.documentElement.lang = applied
      kept.current = ui
      setCurrent(applied)
    } catch (e) {
      // main refused (a write is in progress): the language stays the same, the reason is in the message
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <ErrorBoundary key={lang}>
      <App lang={lang} onLang={(l, ui) => void change(l, ui)} kept={kept.current} />
    </ErrorBoundary>
  )
}

// main sets the language (saved choice or system locale): it comes first, then the first render
const start = (lang: Lang): void => {
  setLang(lang)
  document.documentElement.lang = lang
  root.render(
    <StrictMode>
      <Root initial={lang} />
    </StrictMode>,
  )
}
// if IPC fails the window still opens, in Russian
void window.loadout.getLang().then(start, () => start('ru'))
