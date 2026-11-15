import { app, BrowserWindow, clipboard, ipcMain, Menu, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ChangedEvent, ScanResponse } from '../shared/model'
import { Sidecar } from './sidecar'
import { validateDiff, validateScan } from './validate'

/**
 * Переменные окружения (`LOADOUT_BIN`, `LOADOUT_HOME`, `LOADOUT_USER_DATA`, `ELECTRON_RENDERER_URL`) нужны разработке
 * и проверкам окна. В установленной сборке они игнорируются, иначе чужое окружение подменило бы ядро или страницу.
 */
const envAllowed = !app.isPackaged
const envOf = (name: string): string | undefined => (envAllowed ? process.env[name] : undefined)

/** Путь с домашним каталогом в тексте ошибки показываем как `~`. */
function tidy(text: string): string {
  const home = app.getPath('home')
  return text.split(home).join('~').split(home.replaceAll('\\', '/')).join('~')
}

/**
 * Проверочный режим (`APP_QA=1`): данные окна живут только в профиле из `LOADOUT_USER_DATA`.
 * Профиль владельца не трогаем никогда, поэтому без явного каталога в этом режиме приложение не стартует.
 */
const qa = !app.isPackaged && process.env.APP_QA === '1'
if (qa && !process.env.LOADOUT_USER_DATA) {
  console.error('FAILED: APP_QA=1 требует LOADOUT_USER_DATA (каталог проверочного профиля)')
  app.exit(1)
}
const userData = envOf('LOADOUT_USER_DATA')
if (userData) app.setPath('userData', resolve(userData))

const DEV_URL = envOf('ELECTRON_RENDERER_URL')
/** Единственный файл, которому разрешено вызывать IPC в собранном приложении. */
const INDEX_URL = pathToFileURL(join(__dirname, '../renderer/index.html')).href

/** Путь к ядру фиксированный, не из PATH. `LOADOUT_BIN` нужен тестам и разработке. */
function sidecarPath(): string {
  return envOf('LOADOUT_BIN') ?? resolve(app.getAppPath(), '..', 'target', 'release', 'loadout.exe')
}

let sidecar: Sidecar | undefined
let lastWindow: BrowserWindow | undefined
/** Скан не удался: окно показывает ошибку, и первый же `ready` перезапущенного ядра должен её сменить данными. */
let needCatchUp = false

/** Постоянное ядро: `loadout serve` по JSON-RPC. Падает — поднимается заново (см. sidecar.ts). */
function ensureSidecar(): Sidecar | string {
  if (sidecar) return sidecar
  const bin = sidecarPath()
  if (!existsSync(bin) || !basename(bin).toLowerCase().startsWith('loadout')) {
    return tidy(`ядро не найдено: ${bin}. Соберите его командой «cargo build --release» в корне проекта.`)
  }
  const args = ['serve']
  const homeOverride = envOf('LOADOUT_HOME')
  if (homeOverride) args.push('--home', homeOverride)
  let readySeen = false
  sidecar = new Sidecar({
    bin,
    args,
    onNotification: (method, params) => {
      if (method === 'changed') void pushChanged(params)
      else if (method === 'ready') {
        // Повторный `ready` значит, что ядро перезапустилось: за время паузы файлы могли измениться, окно догоняем.
        // То же, если первый запрос не удался (ядро упало до первого `ready`): окно тогда показывает ошибку.
        if (readySeen || needCatchUp) void pushChanged(undefined)
        readySeen = true
        needCatchUp = false
      }
    },
  })
  sidecar.start()
  return sidecar
}

/** Только для проверок окна: задержка ответа, чтобы снять состояние «загрузка». */
async function runScan(): Promise<ScanResponse> {
  const delay = qa ? Number(process.env.LOADOUT_QA_DELAY_MS ?? 0) : 0
  if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay))
  const s = ensureSidecar()
  if (typeof s === 'string') return { ok: false, error: s }
  const started = Date.now()
  try {
    return { ok: true, data: validateScan(await s.request('scan')), ms: Date.now() - started }
  } catch (e) {
    needCatchUp = true
    return { ok: false, error: tidy(e instanceof Error ? e.message : 'не удалось разобрать ответ ядра') }
  }
}

/** Ядро сообщило об изменении: забираем снимок, проверяем так же, как ответ на запрос, и отдаём окну. */
async function pushChanged(params: unknown): Promise<void> {
  const win = lastWindow
  if (!win || win.isDestroyed() || !sidecar) return
  try {
    // `undefined` — перезапуск ядра: различий не знаем, окну уходят свежие данные без подсветки
    const diff = params === undefined
      ? { added: [], removed: [], changed: [], warningsChanged: false, factsChanged: false }
      : validateDiff(params)
    const data = validateScan(await sidecar.request('snapshot'))
    const event: ChangedEvent = { data, diff }
    win.webContents.send('changed', event)
  } catch {
    /* битое событие не должно ронять окно: следующий скан или ручное обновление догонит */
  }
}

/** Принимаем вызовы только от нашей страницы: файл из сборки или адрес dev-сервера. */
function trusted(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  if (url.split('#')[0] === INDEX_URL) return true
  // dev-сервер: тот же источник целиком, а не префикс строки (`http://localhost:5173.evil.test` не подходит)
  try {
    return DEV_URL !== undefined && new URL(url).origin === new URL(DEV_URL).origin
  } catch {
    return false
  }
}

/** Окно проверок не мешает владельцу: за экраном, без кнопки на панели задач (`LOADOUT_QA_VISIBLE=1` возвращает на экран). */
const qaHidden = qa && process.env.LOADOUT_QA_VISIBLE !== '1'
// Без этого Chromium не рисует перекрытое или внеэкранное окно, и снимки зависают.
if (qa) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 880,
    minWidth: 1100,
    minHeight: 640,
    show: false,
    skipTaskbar: qaHidden,
    ...(qaHidden ? { x: -6000, y: 0 } : {}),
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
  lastWindow = win
  win.once('ready-to-show', () => (qaHidden ? win.showInactive() : win.show()))
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

// Ядро — дочерний процесс окна: закрываем stdin (по EOF оно выходит само) и добиваем, если завис.
app.on('before-quit', () => sidecar?.stop())
app.on('window-all-closed', () => app.quit())
