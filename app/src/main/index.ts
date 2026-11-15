import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ChangedEvent, ClientId, Result, ScanResponse, WriteLevel } from '../shared/model'
import { Sidecar } from './sidecar'
import { validateApplied, validateDiff, validateJournal, validatePlan, validateScan } from './validate'

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
  // Каталог бэкапов передаём всегда, а право писать проверяет main (уровень R1) перед каждым `apply` и `rollback`.
  const args = ['serve', '--backups', join(app.getPath('userData'), 'backups')]
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

/** Уровень записи (CONCEPT.md §5) хранится в профиле приложения; по умолчанию R0 — только чтение. */
const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

function readWriteLevel(): WriteLevel {
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    return typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>)['writeLevel'] === 'R1' ? 'R1' : 'R0'
  } catch {
    return 'R0'
  }
}

function saveWriteLevel(level: WriteLevel): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsFile(), JSON.stringify({ writeLevel: level }))
}

/** Процессы клиентов по имени образа; Claude Desktop и Claude Code оба зовутся `claude.exe`, поэтому это предупреждение, а не запрет. */
const CLIENT_PROCESSES: Partial<Record<ClientId, string[]>> = {
  'claude-code': ['claude.exe'],
  'claude-desktop': ['claude.exe'],
  codex: ['codex.exe'],
}

function runningOf(client: ClientId): Promise<string[]> {
  const want = CLIENT_PROCESSES[client] ?? []
  if (want.length === 0 || process.platform !== 'win32') return Promise.resolve([])
  return new Promise((done) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000, maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return done([])
      const names = new Set(out.split(/\r?\n/).map((l) => /^"([^"]+)"/.exec(l)?.[1]?.toLowerCase()))
      done(want.filter((n) => names.has(n)))
    })
  })
}

/** Ошибка ядра или проверки превращается в ответ окну: страница не получает исключений с путями. */
async function guarded<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: tidy(e instanceof Error ? e.message : 'не удалось выполнить операцию') }
  }
}

const ENTITY_RE = /^[0-9a-f]{16}(-\d{1,4})?$/
const SHA_RE = /^[0-9a-f]{64}$/
const OP_RE = /^[0-9]{13}-[0-9]{2}$/

function writeCore(): Sidecar {
  const s = ensureSidecar()
  if (typeof s === 'string') throw new Error(s)
  return s
}

function needWrite(): void {
  if (readWriteLevel() !== 'R1') throw new Error('запись выключена: включите уровень R1 в шапке окна')
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
  // Каналы записи: страница передаёт только id записи, желаемое состояние, хеш из предпросмотра и номер операции.
  const guard = (e: IpcMainInvokeEvent): void => {
    if (!trusted(e)) throw new Error('untrusted sender')
  }
  ipcMain.handle('writeLevel:get', (e) => (guard(e), readWriteLevel()))
  ipcMain.handle('writeLevel:set', async (e, level: unknown) => {
    guard(e)
    if (level !== 'R0' && level !== 'R1') throw new Error('неизвестный уровень')
    // Повышение до R1 подтверждает человек в окне самой ОС, которое страница не может нажать за него:
    // иначе скомпрометированная страница включила бы запись и тут же вызвала `apply`. Понижение подтверждения не требует.
    // В проверочном режиме (только разработка, `APP_QA=1`) окна нет: сценарий не может его нажать.
    if (level === 'R1' && readWriteLevel() !== 'R1' && !qa) {
      const opts = {
        type: 'warning' as const,
        title: 'Loadout: включить запись?',
        message: 'Разрешить Loadout включать и выключать записи в конфигах клиентов?',
        detail: 'Перед каждым изменением показывается предпросмотр и делается бэкап, каждое изменение можно откатить из журнала. Закройте Claude Code и Codex, если они запущены: они могут перезаписать файл.',
        buttons: ['Отмена', 'Включить запись'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }
      const win = BrowserWindow.fromWebContents(e.sender)
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (r.response !== 1) return readWriteLevel()
    }
    saveWriteLevel(level)
    return level
  })
  ipcMain.handle('plan', (e, entity: unknown, enable: unknown) => {
    guard(e)
    return guarded(async () => {
      if (typeof entity !== 'string' || !ENTITY_RE.test(entity) || typeof enable !== 'boolean') throw new Error('неверные параметры')
      const plan = validatePlan(await writeCore().request('plan', { entity, enable }))
      return { ...plan, running: await runningOf(plan.client) }
    })
  })
  ipcMain.handle('apply', (e, entity: unknown, enable: unknown, baseSha: unknown) => {
    guard(e)
    return guarded(async () => {
      needWrite()
      if (typeof entity !== 'string' || !ENTITY_RE.test(entity) || typeof enable !== 'boolean' || typeof baseSha !== 'string' || !SHA_RE.test(baseSha)) {
        throw new Error('неверные параметры')
      }
      return validateApplied(await writeCore().request('apply', { entity, enable, baseSha }))
    })
  })
  ipcMain.handle('journal', (e) => {
    guard(e)
    return guarded(async () => validateJournal(await writeCore().request('journal')))
  })
  ipcMain.handle('rollback', (e, op: unknown) => {
    guard(e)
    return guarded(async () => {
      needWrite()
      if (typeof op !== 'string' || !OP_RE.test(op)) throw new Error('неверный номер операции')
      return validateApplied(await writeCore().request('rollback', { op }))
    })
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Ядро — дочерний процесс окна: закрываем stdin (по EOF оно выходит само) и добиваем, если завис.
app.on('before-quit', () => sidecar?.stop())
app.on('window-all-closed', () => app.quit())
