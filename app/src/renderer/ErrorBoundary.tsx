import { Component } from 'react'
import type { ReactNode } from 'react'
import { t } from '../shared/i18n'

/** Ошибка отрисовки не должна оставлять пустое окно: показываем сообщение и кнопку перезагрузки страницы. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" style={{ padding: 32 }}>
        <h1>{t('Окно сломалось', 'The window crashed')}</h1>
        <p>{t('Данные на диске не затронуты. Перезагрузите окно.', 'Data on disk is untouched. Reload the window.')}</p>
        <button onClick={() => location.reload()}>{t('Перезагрузить окно', 'Reload window')}</button>
      </div>
    )
  }
}
