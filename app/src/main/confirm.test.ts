import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))
const { answerOf, confirmHtml } = await import('./confirm')

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
})
