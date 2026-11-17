import { BrowserWindow } from 'electron'

/** A yes/no question main asks a person: raising the write level, cleaning up old copies. */
export interface Confirm {
  title: string
  message: string
  /** Paragraphs split by an empty line. */
  detail: string
  cancel: string
  ok: string
  /** The OK action destroys something: a red button instead of the cyan one. */
  danger?: boolean
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/**
 * The page of the confirmation window, in the window's own style. Every text is escaped (the detail names a folder);
 * the answer is a console line (`loadout-confirm:ok` / `loadout-confirm:cancel`) that main hears from this window only.
 */
export function confirmHtml(o: Confirm, lang: string): string {
  const paras = o.detail.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim())}</p>`).join('')
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${esc(o.title)}</title><style>
*{box-sizing:border-box}html,body{margin:0;background:#21222c;color:#f8f8f2;font:14px/1.5 'Segoe UI',system-ui,sans-serif}
#dlg{border:1px solid #44475a;display:flex;flex-direction:column;min-height:100vh}
header{-webkit-app-region:drag;user-select:none;display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid #44475a;color:#9aa5ce;font-size:13px}
header .logo{color:#8be9fd;font:700 13px 'JetBrains Mono',Consolas,monospace;letter-spacing:.2em}
.text{padding:16px 20px 4px}
h1{margin:0 0 10px;font:600 17px/1.4 'Segoe UI',system-ui,sans-serif;color:#f8f8f2;text-wrap:pretty}
h1::before{content:'◐ ';color:#ffb86c}
p{margin:0 0 8px;color:#9aa5ce;font-size:13px;text-wrap:pretty}
footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px 16px;margin-top:auto}
button{font:inherit;color:inherit;background:#21222c;border:1px solid #44475a;border-radius:4px;padding:6px 16px;cursor:pointer}
button:hover{border-color:#8be9fd}
button:focus-visible{outline:2px solid #8be9fd;outline-offset:1px}
#ok{background:#8be9fd;border-color:#8be9fd;color:#21222c;font-weight:600}
#ok:focus-visible{outline-color:#f8f8f2}
#ok.danger{background:#21222c;border-color:#ff5555;color:#ff6e6e}
</style></head><body><div id="dlg" role="alertdialog" aria-modal="true" aria-labelledby="q" aria-describedby="d">
<header><b class="logo">LOAD/OUT</b><span>${esc(o.title)}</span></header>
<div class="text"><h1 id="q">${esc(o.message)}</h1><div id="d">${paras}</div></div>
<footer><button id="cancel" autofocus>${esc(o.cancel)}</button><button id="ok"${o.danger ? ' class="danger"' : ''}>${esc(o.ok)}</button></footer></div>
<script>
const go = (a) => console.log('loadout-confirm:' + a)
document.getElementById('cancel').onclick = () => go('cancel')
document.getElementById('ok').onclick = () => go('ok')
addEventListener('keydown', (e) => { if (e.key === 'Escape') go('cancel') })
</script></body></html>`
}

/** The answer a console line of the confirmation page carries: only an exact `loadout-confirm:ok` is consent. */
export const answerOf = (line: string): boolean | null => (line === 'loadout-confirm:ok' ? true : line === 'loadout-confirm:cancel' ? false : null)

const WIDTH = 560

/**
 * Asks in a window of its own, owned by main: the page of the main window has no handle to it, so it cannot press OK for the
 * person (the property the OS message box gave). Closing the window, Esc or Cancel is a refusal.
 */
export function askConfirm(parent: BrowserWindow | null, o: Confirm, lang: string, hidden: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      // modal over the window that asked; the hidden QA window gets a plain one off screen: a modal child shown inactive off screen is
      // never painted, and a check waiting for its frame hangs
      ...(parent && !hidden ? { parent, modal: true } : {}),
      ...(hidden ? { x: -6000, y: 0 } : {}),
      width: WIDTH,
      height: 320,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      show: false,
      skipTaskbar: true,
      title: o.title,
      backgroundColor: '#21222c',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    let done = false
    const finish = (yes: boolean): void => {
      if (done) return
      done = true
      resolve(yes)
      if (!w.isDestroyed()) w.close()
    }
    // the page answers with a console line: a fragment change was the first try, but Chromium refuses any navigation of a data: page
    w.webContents.on('console-message', (e) => {
      const a = answerOf(String((e as { message?: unknown }).message ?? ''))
      if (a !== null) finish(a)
    })
    w.webContents.on('will-navigate', (e) => e.preventDefault())
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    w.on('closed', () => finish(false))
    // a page that never comes up is a refusal, not a question waiting forever (the renderer would wait for the level with it)
    w.webContents.on('did-fail-load', () => finish(false))
    w.webContents.on('render-process-gone', () => finish(false))
    w.webContents.once('did-finish-load', () => {
      void w.webContents
        .executeJavaScript('document.documentElement.scrollHeight')
        .catch(() => 320)
        .then((h: number) => {
          if (w.isDestroyed()) return
          const height = Math.min(Math.ceil(h), 680)
          w.setContentSize(WIDTH, height)
          // over the window that asked, a little above its middle, like a system dialog
          if (parent && !parent.isDestroyed() && !hidden) {
            const b = parent.getBounds()
            w.setPosition(Math.round(b.x + (b.width - WIDTH) / 2), Math.round(b.y + Math.max(48, (b.height - height) / 3)))
          }
          if (hidden) w.showInactive()
          else w.show()
        })
    })
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(confirmHtml(o, lang))).catch(() => finish(false))
  })
}
