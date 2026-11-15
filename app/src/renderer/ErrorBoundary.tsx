import { Component } from 'react'
import type { ReactNode } from 'react'

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
        <h1>Окно сломалось</h1>
        <p>Данные на диске не затронуты. Перезагрузите окно.</p>
        <button onClick={() => location.reload()}>Перезагрузить окно</button>
      </div>
    )
  }
}
