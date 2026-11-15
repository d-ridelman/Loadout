import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CLIENTS, LEVEL_RANK } from '../shared/model'
import type { ChangedEvent, ClientId, Intent, Result, ScanResponse, WriteLevel } from '../shared/model'
import * as ctxkit from './ctxkit'
import { Sidecar } from './sidecar'
import {
  validateApplied,
  validateBatchApplied,
  validateBatchPlan,
  validateDiff,
  validateJournal,
  validatePlan,
  validateProfiles,
  validateScan,
} from './validate'

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

// Окно простое (таблицы, текст, лёгкие эффекты): GPU-процесс с ускорением съедает ~120 МБ ради нескольких градиентов.
// Программная отрисовка держит приватную память ниже (CONCEPT.md §7, цель 150 МБ).
app.disableHardwareAcceleration()

const DEV_URL = envOf('ELECTRON_RENDERER_URL')
/** Единственный файл, которому разрешено вызывать IPC в собранном приложении. */
const INDEX_URL = pathToFileURL(join(__dirname, '../renderer/index.html')).href

/** Путь к ядру фиксированный, не из PATH. `LOADOUT_BIN` нужен тестам и разработке. */
function sidecarPath(): string {
  // установленная сборка: ядро лежит рядом с приложением (extraResources), путь зашит и env не читается
  if (app.isPackaged) return join(process.resourcesPath, 'loadout.exe')
  return envOf('LOADOUT_BIN') ?? resolve(app.getAppPath(), '..', 'target', 'release', 'loadout.exe')
}

/** Значок окна на панели задач (у exe без подписи своего нет): из resources в сборке, из `build/` в разработке. */
function iconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : resolve(app.getAppPath(), 'build', 'icon.png')
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
    const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['writeLevel'] : undefined
    return v === 'R1' || v === 'R2' ? v : 'R0'
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
  // имена сняты с этой машины: окно DeepSeek зовётся «DeepSeek Harness», у Antigravity есть оболочка и CLI `agy`
  antigravity: ['antigravity.exe', 'agy.exe'],
  deepseek: ['deepseek harness.exe'],
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

/** Версия протокола ядра, с которой работает это окно (crates/loadoutd: `PROTOCOL`). */
const CORE_PROTOCOL = 1
/** Поколение процесса ядра, чей протокол уже сверен. */
let verifiedGeneration: number | undefined

/**
 * Запрос к ядру для записи. Версия протокола сверяется для каждого процесса ядра: старое ядро (несобранный
 * `target/release`, подсунутый `LOADOUT_BIN`) не знает `maxLevel` и пропустило бы запись R2 при уровне R1. Сама запись
 * привязана к поколению сверенного процесса: если ядро перезапустилось (в том числе пока запрос стоял в очереди),
 * новому процессу она не уходит.
 */
async function core(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const s = writeCore()
  if (verifiedGeneration !== s.generation) {
    const g = s.generation
    const st = await s.request('status', undefined, g)
    const ok = typeof st === 'object' && st !== null && (st as Record<string, unknown>)['protocol'] === CORE_PROTOCOL
    if (!ok) throw new Error('ядро другой версии: запись отключена. Пересоберите ядро (cargo build --release)')
    verifiedGeneration = g
  }
  return s.request(method, params, verifiedGeneration)
}

/**
 * Уровень, который main разрешает для этой операции. Передаётся ядру в том же запросе, что и сама запись
 * (`maxLevel`), и ядро отказывает, если операции нужен выше: схема «спросили план, проверили, потом применили»
 * поддавалась гонке (между вызовами можно вклинить `profileSave`).
 */
function grantedLevel(): 'R1' | 'R2' {
  const have = readWriteLevel()
  if (have === 'R0') throw new Error('запись выключена (R0): включите уровень записи в шапке окна')
  return have
}

const CLIENT_IDS: readonly string[] = CLIENTS.map((c) => c.id)
const BATCH_RE = /^[0-9]{13}$/
const NAME_RE = /^[\p{L}\p{N} _.-]{1,40}$/u
const isShort = (v: unknown): v is string => typeof v === 'string' && v.length <= 500 && !/\p{Cc}/u.test(v)

/** Новый MCP: поля пересобираются, окончательные правила имени, адреса и env проверяет ядро. */
function validateAdd(r: Record<string, unknown>): Intent {
  const { to, name, command, args, url, env } = r
  if (typeof to !== 'string' || !CLIENT_IDS.includes(to) || !isShort(name) || !isShort(command) || !isShort(url)) {
    throw new Error('неверные параметры')
  }
  if (!Array.isArray(args) || args.length > 64 || !args.every(isShort)) throw new Error('неверные аргументы')
  if (!Array.isArray(env) || env.length > 30) throw new Error('неверные переменные окружения')
  const pairs = env.map((p: unknown) => {
    const k = (p as Record<string, unknown> | null)?.['key']
    const v = (p as Record<string, unknown> | null)?.['value']
    if (!isShort(k) || !isShort(v) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new Error('неверные переменные окружения')
    return { key: k, value: v }
  })
  return { op: 'add', to: to as ClientId, name, command, args: args as string[], url, env: pairs }
}

/** Разбор намерения от страницы: только id записи и то, что с ней сделать. Всё остальное отбрасывается. */
function validateIntent(raw: unknown): Intent {
  if (typeof raw !== 'object' || raw === null) throw new Error('неверные параметры')
  const r = raw as Record<string, unknown>
  if (r['op'] === 'add') return validateAdd(r)
  const entity = r['entity']
  if (typeof entity !== 'string' || !ENTITY_RE.test(entity)) throw new Error('неверные параметры')
  if (r['op'] === 'toggle' && typeof r['enable'] === 'boolean') return { op: 'toggle', entity, enable: r['enable'] }
  if (r['op'] === 'edit' && isShort(r['command']) && r['command'].trim() !== '') {
    const args = r['args']
    if (!Array.isArray(args) || args.length > 64 || !args.every(isShort)) throw new Error('неверные аргументы')
    return { op: 'edit', entity, command: r['command'], args: args as string[] }
  }
  if (r['op'] === 'copy' && typeof r['to'] === 'string' && CLIENT_IDS.includes(r['to'])) {
    return { op: 'copy', entity, to: r['to'] as ClientId }
  }
  throw new Error('неверные параметры')
}

function validateName(v: unknown): string {
  if (typeof v !== 'string' || !NAME_RE.test(v) || v.trim() !== v) throw new Error('имя профиля: 1–40 знаков (буквы, цифры, пробел, _ - .)')
  return v
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
    // Без системной рамки и заголовка: верхняя строка окна — наша (логотип, управление), а кнопки свернуть, развернуть и
    // закрыть остаются системными (с раскладками Snap), но в цветах окна и в нашей строке высотой 48 px.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#21222c', symbolColor: '#f8f8f2', height: 48 },
    icon: iconPath(),
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
    if (level !== 'R0' && level !== 'R1' && level !== 'R2') throw new Error('неизвестный уровень')
    // Повышение уровня подтверждает человек в окне самой ОС, которое страница не может нажать за него:
    // иначе скомпрометированная страница включила бы запись и тут же вызвала `apply`. Понижение подтверждения не требует.
    // Проверки окна подменяют `dialog.showMessageBox` в main-процессе, и согласие, и отказ.
    if (LEVEL_RANK[level] > LEVEL_RANK[readWriteLevel()]) {
      const r2 = level === 'R2'
      const opts = {
        type: 'warning' as const,
        title: `Loadout: включить уровень ${level}?`,
        message: r2
          ? 'Разрешить Loadout выносить записи в корзину, править команды MCP, копировать записи между клиентами и применять профили?'
          : 'Разрешить Loadout включать и выключать записи в конфигах клиентов?',
        detail: 'Перед каждым изменением показывается предпросмотр и делается бэкап, каждое изменение можно откатить из журнала. Закройте Claude Code и Codex, если они запущены: они могут перезаписать файл.',
        buttons: ['Отмена', r2 ? 'Включить R2' : 'Включить запись'],
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
  ipcMain.handle('plan', (e, raw: unknown) => {
    guard(e)
    return guarded(async () => {
      const plan = validatePlan(await core('plan', validateIntent(raw)))
      return { ...plan, running: await runningOf(plan.client) }
    })
  })
  ipcMain.handle('apply', (e, raw: unknown, baseSha: unknown) => {
    guard(e)
    return guarded(async () => {
      const intent = validateIntent(raw)
      if (typeof baseSha !== 'string' || !SHA_RE.test(baseSha)) throw new Error('неверные параметры')
      // нужный операции уровень (флаг — R1, корзина, правка, копирование — R2) знает и проверяет ядро
      return validateApplied(await core('apply', { ...intent, baseSha, maxLevel: grantedLevel() }))
    })
  })
  ipcMain.handle('journal', (e) => {
    guard(e)
    return guarded(async () => validateJournal(await core('journal')))
  })
  ipcMain.handle('rollback', (e, op: unknown) => {
    guard(e)
    return guarded(async () => {
      if (typeof op !== 'string' || !OP_RE.test(op)) throw new Error('неверный номер операции')
      return validateApplied(await core('rollback', { op, maxLevel: grantedLevel() }))
    })
  })
  ipcMain.handle('rollbackBatch', (e, batch: unknown) => {
    guard(e)
    return guarded(async () => {
      if (typeof batch !== 'string' || !BATCH_RE.test(batch)) throw new Error('неверный номер пакета')
      const done: unknown = await core('rollbackBatch', { batch, maxLevel: grantedLevel() })
      if (!Array.isArray(done)) throw new Error('ядро вернуло ответ неожиданной формы')
      return done.map(validateApplied)
    })
  })
  // Профили лежат в хранилище Loadout и в конфиги клиентов не пишут: читать и менять их можно на любом уровне.
  ipcMain.handle('profiles', (e) => {
    guard(e)
    return guarded(async () => validateProfiles(await core('profiles')))
  })
  ipcMain.handle('profileSave', (e, name: unknown, items: unknown) => {
    guard(e)
    return guarded(async () => {
      const params: Record<string, unknown> = { name: validateName(name) }
      if (items !== undefined && items !== null) {
        // проверка формы записей профиля и повторная сборка: лишние поля до ядра не доходят
        params['items'] = validateProfiles([{ name: 'x', items }])[0]?.items
      }
      return validateProfiles(await core('profileSave', params))
    })
  })
  ipcMain.handle('profileDelete', (e, name: unknown) => {
    guard(e)
    return guarded(async () => validateProfiles(await core('profileDelete', { name: validateName(name) })))
  })
  ipcMain.handle('planProfile', (e, name: unknown) => {
    guard(e)
    return guarded(async () => {
      const bp = validateBatchPlan(await core('planProfile', { name: validateName(name) }))
      const clients = [...new Set(bp.plans.filter((p) => !p.noop).map((p) => p.client))]
      const running = [...new Set((await Promise.all(clients.map(runningOf))).flat())]
      return { ...bp, running }
    })
  })
  ipcMain.handle('applyProfile', (e, name: unknown, batchSha: unknown) => {
    guard(e)
    return guarded(async () => {
      if (typeof batchSha !== 'string' || !SHA_RE.test(batchSha)) throw new Error('неверные параметры')
      const n = validateName(name)
      return validateBatchApplied(await core('applyProfile', { name: n, batchSha, maxLevel: grantedLevel() }))
    })
  })
  // ---- встроенный ctxkit (CONCEPT.md §13): бинарь лежит в составе приложения, путь зашит ----
  const ctxBin = (): string =>
    app.isPackaged ? join(process.resourcesPath, 'ctxkit.exe') : (envOf('LOADOUT_CTXKIT') ?? resolve(app.getAppPath(), 'build', 'ctxkit.exe'))
  /** В разработке и проверках (`LOADOUT_HOME`) ctxkit работает в этом каталоге, а не в настоящем профиле. */
  const ctxHome = (): string | undefined => envOf('LOADOUT_HOME')
  const userHome = (): string => ctxHome() ?? app.getPath('home')
  let lastSetupPreview: string | undefined
  let setupBusy = false

  ipcMain.handle('ctxkit:status', (e) => {
    guard(e)
    return guarded(() =>
      ctxkit.status(ctxBin(), join(userHome(), '.claude', 'hooks', 'ctxkit.exe'), join(userHome(), '.local', 'bin', 'ctxkit.exe')),
    )
  })
  ipcMain.handle('ctxkit:doctor', (e) => {
    guard(e)
    return guarded(async () => {
      // `doctor` выходит с кодом 1, когда есть находка уровня error: это нормальный ответ, разбираем stdout
      const r = await ctxkit.run(ctxBin(), ['doctor', '--json', ...ctxkit.profileArgs(ctxHome())], 20_000)
      const d = ctxkit.parseDoctor(r.stdout)
      // в находках бывают полные пути (ошибка разбора settings.json, команда хука): путь домашнего каталога заменяем на `~`
      const t = (s: string | null): string | null => (s === null ? null : tidy(s))
      return { ...d, findings: d.findings.map((f) => ({ ...f, message: tidy(f.message), detail: t(f.detail), fix: t(f.fix) })) }
    })
  })
  ipcMain.handle('ctxkit:report', (e, days: unknown) => {
    guard(e)
    return guarded(async () => {
      if (days !== 7 && days !== 14 && days !== 30) throw new Error('неверный период')
      const r = await ctxkit.run(ctxBin(), ['report', '--json', '--days', String(days), ...ctxkit.profileArgs(ctxHome())], 90_000)
      return ctxkit.parseReport(r.stdout)
    })
  })
  ipcMain.handle('ctxkit:setup', (e, raw: unknown, dryRun: unknown) => {
    guard(e)
    return guarded(async () => {
      if (typeof dryRun !== 'boolean') throw new Error('неверные параметры')
      const options = ctxkit.parseSetupOptions(raw)
      const key = JSON.stringify(options)
      if (setupBusy) throw new Error('ctxkit уже работает: дождитесь окончания')
      if (!dryRun) {
        // применение пишет в конфиги клиентов: нужен R2 и предпросмотр с точно такими же настройками
        if (readWriteLevel() !== 'R2') throw new Error('для применения ctxkit нужен уровень R2: включите его в шапке окна')
        if (lastSetupPreview !== key) throw new Error('сначала выполните предпросмотр с теми же настройками')
        // предпросмотр расходуется до запуска: один предпросмотр — одно применение, даже если запуск закончится ошибкой
        lastSetupPreview = undefined
      }
      setupBusy = true
      try {
        const r = await ctxkit.run(ctxBin(), ctxkit.setupArgs(options, dryRun, ctxHome()), 120_000)
        if (dryRun && r.code === 0) lastSetupPreview = key
        return { dryRun, code: r.code, output: tidy(`${r.stdout}${r.stderr}`).slice(0, 20_000) }
      } finally {
        setupBusy = false
      }
    })
  })
  // ---- установка плагина Claude Code его собственным CLI: это сеть и чужой код, поэтому R2, предпросмотр и без `-y` ----
  const SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
  let lastPluginPreview: string | undefined
  let pluginBusy = false
  ipcMain.handle('plugin:install', (e, spec: unknown, dryRun: unknown) => {
    guard(e)
    return guarded(async () => {
      if (typeof spec !== 'string' || !SPEC_RE.test(spec) || typeof dryRun !== 'boolean') {
        throw new Error('имя плагина: имя@маркетплейс, буквы, цифры, `.`, `_`, `-`')
      }
      const args = ['plugin', 'install', spec, '--scope', 'user']
      if (dryRun) {
        lastPluginPreview = spec
        return { dryRun, code: 0, output: `claude ${args.join(' ')}` }
      }
      if (readWriteLevel() !== 'R2') throw new Error('для установки плагина нужен уровень R2: включите его в шапке окна')
      if (lastPluginPreview !== spec) throw new Error('сначала выполните предпросмотр с тем же именем')
      if (pluginBusy) throw new Error('установка уже идёт')
      lastPluginPreview = undefined
      pluginBusy = true
      try {
        // стандартный запуск CLI из PATH; в разработке и проверках `LOADOUT_CLAUDE` (+ `LOADOUT_CLAUDE_ARGS`, JSON) подменяет его
        const extra = envOf('LOADOUT_CLAUDE_ARGS')
        const prefix: string[] = extra ? (JSON.parse(extra) as string[]) : []
        const home = ctxHome()
        const r = await ctxkit.run(envOf('LOADOUT_CLAUDE') ?? 'claude', [...prefix, ...args], 180_000, home ? { USERPROFILE: home, HOME: home } : undefined)
        return { dryRun, code: r.code, output: tidy(`${r.stdout}${r.stderr}`).slice(0, 20_000) }
      } finally {
        pluginBusy = false
      }
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
