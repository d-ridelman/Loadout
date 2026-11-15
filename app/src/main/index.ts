import { app, BrowserWindow, clipboard, ipcMain, Menu, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { ScanResponse, ScanResult } from '../shared/model'

/**
 * Проверочный режим (`APP_QA=1`): данные окна живут только в профиле из `LOADOUT_USER_DATA`.
 * Профиль владельца не трогаем никогда, поэтому без явного каталога в этом режиме приложение не стартует.
 */
const qa = process.env.APP_QA === '1'
if (qa && !process.env.LOADOUT_USER_DATA) {
  console.error('FAILED: APP_QA=1 требует LOADOUT_USER_DATA (каталог проверочного профиля)')
  app.exit(1)
}
if (process.env.LOADOUT_USER_DATA) app.setPath('userData', resolve(process.env.LOADOUT_USER_DATA))

const DEV_URL = process.env['ELECTRON_RENDERER_URL']

/** Путь к ядру фиксированный, не из PATH. `LOADOUT_BIN` нужен тестам и разработке. */
function sidecarPath(): string {
  return process.env.LOADOUT_BIN ?? resolve(app.getAppPath(), '..', 'target', 'release', 'loadout.exe')
}

function validate(raw: unknown): ScanResult {
  const o = raw as Partial<ScanResult> | null
  if (!o || !Array.isArray(o.entities) || !Array.isArray(o.warnings)) {
    throw new Error('ядро вернуло данные неожиданной формы')
  }
  for (const e of o.entities.slice(0, 5_000)) {
    if (typeof e?.id !== 'string' || typeof e.kind !== 'string' || typeof e.client !== 'string') {
      throw new Error('в ответе ядра есть сущность без id, kind или client')
    }
  }
  return o as ScanResult
}

/** Только для проверок окна: задержка ответа, чтобы снять состояние «загрузка». */
async function runScan(): Promise<ScanResponse> {
  const delay = qa ? Number(process.env.LOADOUT_QA_DELAY_MS ?? 0) : 0
  if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay))
  return doScan()
}

function doScan(): Promise<ScanResponse> {
  const bin = sidecarPath()
  if (!existsSync(bin) || !basename(bin).toLowerCase().startsWith('loadout')) {
    return Promise.resolve({
      ok: false,
      error: `ядро не найдено: ${bin}. Соберите его командой «cargo build --release» в корне проекта.`,
    })
  }
  const args = ['scan', '--json']
  if (process.env.LOADOUT_HOME) args.push('--home', process.env.LOADOUT_HOME)
  const started = Date.now()
  return new Promise((done) => {
    execFile(bin, args, { timeout: 20_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) {
        done({ ok: false, error: `ядро не ответило: ${err.message.split('\n')[0] ?? 'ошибка запуска'}` })
        return
      }
      try {
        done({ ok: true, data: validate(JSON.parse(stdout)), ms: Date.now() - started })
      } catch (e) {
        done({ ok: false, error: e instanceof Error ? e.message : 'не удалось разобрать ответ ядра' })
      }
    })
  })
}

/** Принимаем вызовы только от нашей страницы: файл из сборки или адрес dev-сервера. */
function trusted(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  return url.startsWith('file:') || (DEV_URL !== undefined && url.startsWith(DEV_URL))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 880,
    minWidth: 1100,
    minHeight: 640,
    show: false,
    title: 'Loadout',
    backgroundColor: '#282a36',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (ev) => ev.preventDefault())
  if (DEV_URL) void win.loadURL(DEV_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ipcMain.handle('scan', (e) => (trusted(e) ? runScan() : Promise.reject(new Error('untrusted sender'))))
  ipcMain.handle('copyText', (e, text: unknown) => {
    if (!trusted(e) || typeof text !== 'string') return
    clipboard.writeText(text.slice(0, 10_000))
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
