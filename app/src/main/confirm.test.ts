import { describe, expect, it, vi } from 'vitest'

type Handler = (e: { message?: string }) => void
const windows: FakeWindow[] = []
class FakeWindow {
  handlers: Record<string, Handler> = {}
  closedHandler: (() => void) | null = null
  destroyed = false
  webContents = {
    on: (ev: string, h: Handler) => void (this.handlers[ev] = h),
    once: (ev: string, h: Handler) => void (this.handlers[ev] = h),
    setWindowOpenHandler: () => {},
    executeJavaScript: () => Promise.resolve(320),
  }
  constructor() {
    windows.push(this)
  }
  on(ev: string, h: () => void): void {
    if (ev === 'closed') this.closedHandler = h
  }
  loadURL(): Promise<void> {
    return new Promise(() => {})
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  close(): void {
    this.destroyed = true
    this.closedHandler?.()
  }
}
vi.mock('electron', () => ({ BrowserWindow: FakeWindow }))
const { answerOf, askConfirm, confirmHtml } = await import('./confirm')

describe('confirm window page', () => {
  const o = { title: 'Loadout: <R2>?', message: 'Allow "this" & that?', detail: 'One <b>x</b>\n\nTwo in C:\\Users\\a&b', cancel: 'Cancel', ok: 'Enable' }

  it('escapes every text: a folder name or a message cannot add markup', () => {
    const html = confirmHtml(o, 'en')
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('One &lt;b&gt;x&lt;/b&gt;')
    expect(html).toContain('Allow &quot;this&quot; &amp; that?')
    expect(html).toContain('<title>Loadout: &lt;R2&gt;?</title>')
    expect(html).toContain('C:\\Users\\a&amp;b')
  })

  it('splits the detail into paragraphs and focuses Cancel first', () => {
    const html = confirmHtml(o, 'en')
    expect(html.match(/<p>/g)).toHaveLength(2)
    expect(html).toMatch(/<button id="cancel" autofocus>Cancel<\/button>/)
    expect(confirmHtml({ ...o, danger: true }, 'en')).toContain('<button id="ok" class="danger">')
  })

  it('only an exact "loadout-confirm:ok" line is consent', () => {
    expect(answerOf('loadout-confirm:ok')).toBe(true)
    expect(answerOf('loadout-confirm:cancel')).toBe(false)
    expect(answerOf('loadout-confirm:okay')).toBeNull()
    expect(answerOf('say loadout-confirm:ok')).toBeNull()
    expect(answerOf('')).toBeNull()
  })

  it('asks one question at a time: a second one while the first is open is refused without a window', async () => {
    windows.length = 0
    const first = askConfirm(null, o, 'en', false)
    expect(await askConfirm(null, o, 'en', false)).toBe(false)
    expect(windows).toHaveLength(1)
    windows[0]!.handlers['console-message']!({ message: 'loadout-confirm:ok' })
    expect(await first).toBe(true)
    // the first answered: the next question gets its own window again
    const third = askConfirm(null, o, 'en', false)
    expect(windows).toHaveLength(2)
    windows[1]!.close()
    expect(await third).toBe(false)
  })
})
