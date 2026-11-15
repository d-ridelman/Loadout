import '@fontsource/inter/400.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { setLang } from '../shared/i18n'
import type { Lang } from '../shared/i18n'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root container not found')
const root = createRoot(container)

/** Язык меняется целиком: `key` пересоздаёт дерево, и все строки берутся заново на новом языке. */
function Root({ initial }: { initial: Lang }) {
  const [lang, setCurrent] = useState<Lang>(initial)
  const change = async (next: Lang): Promise<void> => {
    try {
      const applied = await window.loadout.setLang(next)
      setLang(applied)
      document.documentElement.lang = applied
      setCurrent(applied)
    } catch (e) {
      // отказ main (идёт запись): язык остаётся прежним, причина — в сообщении
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <ErrorBoundary key={lang}>
      <App lang={lang} onLang={(l) => void change(l)} />
    </ErrorBoundary>
  )
}

// язык задаёт main (сохранённый выбор или локаль системы): сначала он, потом первая отрисовка
const start = (lang: Lang): void => {
  setLang(lang)
  document.documentElement.lang = lang
  root.render(
    <StrictMode>
      <Root initial={lang} />
    </StrictMode>,
  )
}
// при сбое IPC окно всё равно открывается, на русском
void window.loadout.getLang().then(start, () => start('ru'))
