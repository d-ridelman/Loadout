import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getLang, isLang, langFromLocale, setLang, t } from '../shared/i18n'
import type { Lang } from '../shared/i18n'
import { CLIENTS, LEVEL_RANK } from '../shared/model'
import type { ChangedEvent, ClientId, Intent, Result, ScanResponse, WriteLevel } from '../shared/model'
import * as ctxkit from './ctxkit'
import { cloneArgs, findSkills, localMarketplaceOk, parseMarketplaceSource, parseSkillSource, readCatalog, skillNameOk } from './install'
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
    return tidy(t(`ядро не найдено: ${bin}. Соберите его командой «cargo build --release» в корне проекта.`, `core not found: ${bin}. Build it with "cargo build --release" in the project root.`))
  }
  // Каталог бэкапов передаём всегда, а право писать проверяет main (уровень R1) перед каждым `apply` и `rollback`.
  const args = ['serve', '--backups', join(app.getPath('userData'), 'backups'), '--lang', getLang()]
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
    return { ok: false, error: tidy(e instanceof Error ? e.message : t('не удалось разобрать ответ ядра', 'failed to parse the core response')) }
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

function readSettings(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Ключи настроек пишутся по одному: запись одного не стирает остальные. */
function saveSetting(key: 'writeLevel' | 'lang', value: string): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), [key]: value }))
}

function readWriteLevel(): WriteLevel {
  const v = readSettings()['writeLevel']
  return v === 'R1' || v === 'R2' ? v : 'R0'
}

function saveWriteLevel(level: WriteLevel): void {
  saveSetting('writeLevel', level)
}

/** Язык: сохранённый выбор, иначе по локали системы (русская — русский, остальные — английский). `LOADOUT_LANG` — только для разработки и проверок. */
function initialLang(): Lang {
  const forced = envOf('LOADOUT_LANG')
  if (isLang(forced)) return forced
  const saved = readSettings()['lang']
  return isLang(saved) ? saved : langFromLocale(app.getLocale())
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
    return { ok: false, error: tidy(e instanceof Error ? e.message : t('не удалось выполнить операцию', 'the operation failed')) }
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
/** Запросы к ядру, которые идут сейчас: пока они не закончились, язык не меняется (смена останавливает ядро). */
let coreInFlight = 0

async function core(method: string, params?: Record<string, unknown>): Promise<unknown> {
  coreInFlight++
  try {
    const s = writeCore()
    if (verifiedGeneration !== s.generation) {
      const g = s.generation
      const st = await s.request('status', undefined, g)
      const ok = typeof st === 'object' && st !== null && (st as Record<string, unknown>)['protocol'] === CORE_PROTOCOL
      if (!ok) throw new Error(t('ядро другой версии: запись отключена. Пересоберите ядро (cargo build --release)', 'the core is a different version: writing is disabled. Rebuild the core (cargo build --release)'))
      verifiedGeneration = g
    }
    return await s.request(method, params, verifiedGeneration)
  } finally {
    coreInFlight--
  }
}

/**
 * Уровень, который main разрешает для этой операции. Передаётся ядру в том же запросе, что и сама запись
 * (`maxLevel`), и ядро отказывает, если операции нужен выше: схема «спросили план, проверили, потом применили»
 * поддавалась гонке (между вызовами можно вклинить `profileSave`).
 */
function grantedLevel(): 'R1' | 'R2' {
  const have = readWriteLevel()
  if (have === 'R0') throw new Error(t('запись выключена (R0): включите уровень записи в шапке окна', 'writing is off (R0): enable a write level in the window header'))
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
    throw new Error(t('неверные параметры', 'invalid parameters'))
  }
  if (!Array.isArray(args) || args.length > 64 || !args.every(isShort)) throw new Error(t('неверные аргументы', 'invalid arguments'))
  if (!Array.isArray(env) || env.length > 30) throw new Error(t('неверные переменные окружения', 'invalid environment variables'))
  const pairs = env.map((p: unknown) => {
    const k = (p as Record<string, unknown> | null)?.['key']
    const v = (p as Record<string, unknown> | null)?.['value']
    if (!isShort(k) || !isShort(v) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new Error(t('неверные переменные окружения', 'invalid environment variables'))
    return { key: k, value: v }
  })
  return { op: 'add', to: to as ClientId, name, command, args: args as string[], url, env: pairs }
}

/** Разбор намерения от страницы: только id записи и то, что с ней сделать. Всё остальное отбрасывается. */
function validateIntent(raw: unknown): Intent {
  if (typeof raw !== 'object' || raw === null) throw new Error(t('неверные параметры', 'invalid parameters'))
  const r = raw as Record<string, unknown>
  if (r['op'] === 'add') return validateAdd(r)
  if (r['op'] === 'installSkill') {
    // каталог подготовки ядро находит само по номеру; путь внутри и имя оно проверяет ещё раз
    const { stage, sub, name } = r
    if (typeof stage !== 'string' || !/^[0-9a-f]{32}$/.test(stage) || typeof sub !== 'string' || !/^([A-Za-z0-9._-]{1,100}(\/[A-Za-z0-9._-]{1,100})*)?$/.test(sub) || typeof name !== 'string' || !skillNameOk(name)) {
      throw new Error(t('неверные параметры', 'invalid parameters'))
    }
    return { op: 'installSkill', stage, sub, name }
  }
  const entity = r['entity']
  if (typeof entity !== 'string' || !ENTITY_RE.test(entity)) throw new Error(t('неверные параметры', 'invalid parameters'))
  if (r['op'] === 'toggle' && typeof r['enable'] === 'boolean') return { op: 'toggle', entity, enable: r['enable'] }
  if (r['op'] === 'edit' && isShort(r['command']) && r['command'].trim() !== '') {
    const args = r['args']
    if (!Array.isArray(args) || args.length > 64 || !args.every(isShort)) throw new Error(t('неверные аргументы', 'invalid arguments'))
    return { op: 'edit', entity, command: r['command'], args: args as string[] }
  }
  if (r['op'] === 'copy' && typeof r['to'] === 'string' && CLIENT_IDS.includes(r['to'])) {
    return { op: 'copy', entity, to: r['to'] as ClientId }
  }
  throw new Error(t('неверные параметры', 'invalid parameters'))
}

function validateName(v: unknown): string {
  if (typeof v !== 'string' || !NAME_RE.test(v) || v.trim() !== v) throw new Error(t('имя профиля: 1–40 знаков (буквы, цифры, пробел, _ - .)', 'profile name: 1-40 characters (letters, digits, space, _ - .)'))
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
  setLang(initialLang())
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
  ipcMain.handle('lang:get', (e) => (guard(e), getLang()))
  ipcMain.handle('lang:set', (e, lang: unknown) => {
    guard(e)
    if (!isLang(lang)) throw new Error('invalid language')
    if (lang !== getLang()) {
      // остановка ядра посреди записи (пакет профиля) оставила бы пакет применённым наполовину
      if (coreInFlight > 0 || setupBusy || claudeBusy || fetchBusy) {
        throw new Error(t('идёт запись или установка: дождитесь окончания и повторите', 'a write or an install is in progress: wait for it to finish and try again'))
      }
      setLang(lang)
      saveSetting('lang', lang)
      // сообщения ядра на языке процесса: ядро перезапускается с новым `--lang`, следующий запрос поднимет его заново;
      // версия протокола нового процесса сверяется заново (у него счёт поколений начинается с нуля)
      sidecar?.stop()
      sidecar = undefined
      verifiedGeneration = undefined
    }
    return lang
  })
  ipcMain.handle('writeLevel:get', (e) => (guard(e), readWriteLevel()))
  ipcMain.handle('writeLevel:set', async (e, level: unknown) => {
    guard(e)
    if (level !== 'R0' && level !== 'R1' && level !== 'R2') throw new Error(t('неизвестный уровень', 'unknown level'))
    // Повышение уровня подтверждает человек в окне самой ОС, которое страница не может нажать за него:
    // иначе скомпрометированная страница включила бы запись и тут же вызвала `apply`. Понижение подтверждения не требует.
    // Проверки окна подменяют `dialog.showMessageBox` в main-процессе, и согласие, и отказ.
    if (LEVEL_RANK[level] > LEVEL_RANK[readWriteLevel()]) {
      const r2 = level === 'R2'
      const opts = {
        type: 'warning' as const,
        title: t(`Loadout: включить уровень ${level}?`, `Loadout: enable level ${level}?`),
        message: r2
          ? t('Разрешить Loadout выносить записи в корзину, править команды MCP, копировать записи между клиентами и применять профили?', 'Allow Loadout to move entries to the trash, edit MCP commands, copy entries between clients and apply profiles?')
          : t('Разрешить Loadout включать и выключать записи в конфигах клиентов?', 'Allow Loadout to turn entries on and off in client configs?'),
        detail: t('Перед каждым изменением показывается предпросмотр и делается бэкап, каждое изменение можно откатить из журнала. Закройте Claude Code и Codex, если они запущены: они могут перезаписать файл.', 'A preview is shown and a backup is made before every change, and every change can be rolled back from the journal. Close Claude Code and Codex if they are running: they may overwrite the file.'),
        buttons: [t('Отмена', 'Cancel'), r2 ? t('Включить R2', 'Enable R2') : t('Включить запись', 'Enable writing')],
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
      // новый каталог скила клиент своим состоянием не перезапишет: предупреждение о запущенном клиенте ни к чему
      return { ...plan, running: plan.op === 'installSkill' ? [] : await runningOf(plan.client) }
    })
  })
  ipcMain.handle('apply', (e, raw: unknown, baseSha: unknown) => {
    guard(e)
    return guarded(async () => {
      const intent = validateIntent(raw)
      if (typeof baseSha !== 'string' || !SHA_RE.test(baseSha)) throw new Error(t('неверные параметры', 'invalid parameters'))
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
      if (typeof op !== 'string' || !OP_RE.test(op)) throw new Error(t('неверный номер операции', 'invalid operation number'))
      return validateApplied(await core('rollback', { op, maxLevel: grantedLevel() }))
    })
  })
  ipcMain.handle('rollbackBatch', (e, batch: unknown) => {
    guard(e)
    return guarded(async () => {
      if (typeof batch !== 'string' || !BATCH_RE.test(batch)) throw new Error(t('неверный номер пакета', 'invalid batch number'))
      const done: unknown = await core('rollbackBatch', { batch, maxLevel: grantedLevel() })
      if (!Array.isArray(done)) throw new Error(t('ядро вернуло ответ неожиданной формы', 'the core returned a response of an unexpected shape'))
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
      if (typeof batchSha !== 'string' || !SHA_RE.test(batchSha)) throw new Error(t('неверные параметры', 'invalid parameters'))
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
      const r = await ctxkit.run(ctxBin(), ['doctor', '--json', '--lang', getLang(), ...ctxkit.profileArgs(ctxHome())], 20_000)
      const d = ctxkit.parseDoctor(r.stdout)
      // в находках бывают полные пути (ошибка разбора settings.json, команда хука): путь домашнего каталога заменяем на `~`
      const tidyOpt = (s: string | null): string | null => (s === null ? null : tidy(s))
      return { ...d, findings: d.findings.map((f) => ({ ...f, message: tidy(f.message), detail: tidyOpt(f.detail), fix: tidyOpt(f.fix) })) }
    })
  })
  ipcMain.handle('ctxkit:report', (e, days: unknown) => {
    guard(e)
    return guarded(async () => {
      if (days !== 7 && days !== 14 && days !== 30) throw new Error(t('неверный период', 'invalid period'))
      const r = await ctxkit.run(ctxBin(), ['report', '--json', '--days', String(days), ...ctxkit.profileArgs(ctxHome())], 90_000)
      return ctxkit.parseReport(r.stdout)
    })
  })
  ipcMain.handle('ctxkit:setup', (e, raw: unknown, dryRun: unknown) => {
    guard(e)
    return guarded(async () => {
      if (typeof dryRun !== 'boolean') throw new Error(t('неверные параметры', 'invalid parameters'))
      const options = ctxkit.parseSetupOptions(raw)
      const key = JSON.stringify(options)
      if (setupBusy) throw new Error(t('ctxkit уже работает: дождитесь окончания', 'ctxkit is already running: wait for it to finish'))
      if (!dryRun) {
        // применение пишет в конфиги клиентов: нужен R2 и предпросмотр с точно такими же настройками
        if (readWriteLevel() !== 'R2') throw new Error(t('для применения ctxkit нужен уровень R2: включите его в шапке окна', 'applying ctxkit requires level R2: enable it in the window header'))
        if (lastSetupPreview !== key) throw new Error(t('сначала выполните предпросмотр с теми же настройками', 'run a preview with the same settings first'))
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
  // Один предпросмотр — один запуск: ключ — точная команда, расходуется до запуска. Общий для установки и маркетплейсов.
  let lastClaudePreview: string | undefined
  let claudeBusy = false
  const quoteArg = (a: string): string => (/[\s"]/.test(a) ? `"${a}"` : a)
  /** `claude <args>` по шагам «предпросмотр → R2 → запуск». `args` уже собраны из проверенного ввода, оболочки нет. */
  const claudeStep = async (args: string[], dryRun: boolean, what: string) => {
    const shown = `claude ${args.map(quoteArg).join(' ')}`
    if (dryRun) {
      lastClaudePreview = shown
      return { dryRun, code: 0, output: shown }
    }
    if (readWriteLevel() !== 'R2') throw new Error(t(`для этого действия (${what}) нужен уровень R2: включите его в шапке окна`, `this action (${what}) requires level R2: enable it in the window header`))
    if (lastClaudePreview !== shown) throw new Error(t('сначала выполните предпросмотр с тем же вводом', 'run a preview with the same input first'))
    if (claudeBusy) throw new Error(t('команда Claude Code уже выполняется', 'a Claude Code command is already running'))
    lastClaudePreview = undefined
    claudeBusy = true
    try {
      // стандартный запуск CLI из PATH; в разработке и проверках `LOADOUT_CLAUDE` (+ `LOADOUT_CLAUDE_ARGS`, JSON) подменяет его
      const extra = envOf('LOADOUT_CLAUDE_ARGS')
      const prefix: string[] = extra ? (JSON.parse(extra) as string[]) : []
      const home = ctxHome()
      const r = await ctxkit.run(envOf('LOADOUT_CLAUDE') ?? 'claude', [...prefix, ...args], 180_000, home ? { USERPROFILE: home, HOME: home } : undefined)
      return { dryRun, code: r.code, output: tidy(`${r.stdout}${r.stderr}`).slice(0, 20_000) }
    } finally {
      claudeBusy = false
    }
  }
  ipcMain.handle('plugin:install', (e, spec: unknown, dryRun: unknown) => {
    guard(e)
    return guarded(async () => {
      if (typeof spec !== 'string' || !SPEC_RE.test(spec) || typeof dryRun !== 'boolean') {
        throw new Error(t('имя плагина: имя@маркетплейс, буквы, цифры, `.`, `_`, `-`', 'plugin name: name@marketplace, letters, digits, `.`, `_`, `-`'))
      }
      return claudeStep(['plugin', 'install', spec, '--scope', 'user'], dryRun, t('установка плагина', 'plugin installation'))
    })
  })
  // ---- маркетплейсы Claude Code: добавление его CLI (сеть, R2) и чтение каталогов (только чтение) ----
  ipcMain.handle('marketplace:add', (e, raw: unknown, dryRun: unknown) => {
    guard(e)
    return guarded(async () => {
      if (typeof dryRun !== 'boolean') throw new Error(t('неверные параметры', 'invalid parameters'))
      const src = parseMarketplaceSource(raw)
      if (src.kind === 'path' && !localMarketplaceOk(src.value)) {
        throw new Error(t('в папке нет .claude-plugin/marketplace.json', 'the folder has no .claude-plugin/marketplace.json'))
      }
      return claudeStep(['plugin', 'marketplace', 'add', '--scope', 'user', src.value], dryRun, t('добавление маркетплейса', 'adding a marketplace'))
    })
  })
  ipcMain.handle('marketplace:catalog', (e) => {
    guard(e)
    return guarded(async () => readCatalog(userHome(), tidy))
  })
  // ---- скил из GitHub или папки: источник кладётся в каталог подготовки ядра, ставит его ядро (план, журнал, откат) ----
  const stagingRoot = (): string => join(app.getPath('userData'), 'backups', 'staging')
  let lastFetchPreview: string | undefined
  let fetchBusy = false
  // прошлые подготовки после перезапуска не нужны: начинаем с пустого каталога
  rmSync(stagingRoot(), { recursive: true, force: true })
  ipcMain.handle('skill:fetch', (e, raw: unknown, dryRun: unknown) => {
    guard(e)
    return guarded(async () => {
      if (typeof dryRun !== 'boolean') throw new Error(t('неверные параметры', 'invalid parameters'))
      const src = parseSkillSource(raw)
      const ghBase = envOf('LOADOUT_GITHUB_BASE') ?? 'https://github.com/'
      const shownDest = tidy(join(stagingRoot(), '…'))
      const command =
        src.kind === 'github'
          ? `git ${cloneArgs(src, ghBase, shownDest).map(quoteArg).join(' ')}`
          : t(`копия ${tidy(src.path)} → ${shownDest}`, `copy ${tidy(src.path)} → ${shownDest}`)
      const key = JSON.stringify(src)
      if (dryRun) {
        lastFetchPreview = key
        return { dryRun, command, stage: '', skills: [] }
      }
      if (lastFetchPreview !== key) throw new Error(t('сначала посмотрите, что будет скачано', 'first review what will be downloaded'))
      if (fetchBusy) throw new Error(t('загрузка уже идёт', 'a download is already in progress'))
      lastFetchPreview = undefined
      fetchBusy = true
      // одна подготовка за раз: прежняя убирается
      rmSync(stagingRoot(), { recursive: true, force: true })
      const stage = randomBytes(16).toString('hex')
      const dest = join(stagingRoot(), stage)
      mkdirSync(stagingRoot(), { recursive: true })
      try {
        if (src.kind === 'github') {
          // без окна входа и вопросов в консоли: на закрытом или несуществующем репозитории git сразу выходит с ошибкой
          const r = await ctxkit.run('git', cloneArgs(src, ghBase, dest), 120_000, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' })
          if (r.code !== 0) throw new Error(t(`git clone не удался: ${tidy(r.stderr).slice(-400)}`, `git clone failed: ${tidy(r.stderr).slice(-400)}`))
        } else {
          if (!statSync(src.path, { throwIfNoEntry: false })?.isDirectory()) throw new Error(t('папка не найдена', 'folder not found'))
          // ссылки не разыменовываются: ядро откажет на дереве со ссылками
          cpSync(src.path, dest, { recursive: true, dereference: false, verbatimSymlinks: true, filter: (s) => !/[\\/](\.git|node_modules)$/.test(s) })
        }
        const skills = findSkills(dest, src.kind === 'github' ? src.sub : '')
        if (skills.length === 0) throw new Error(t('в источнике нет каталога со SKILL.md', 'the source has no directory with SKILL.md'))
        return { dryRun, command: '', stage, skills }
      } catch (err) {
        rmSync(dest, { recursive: true, force: true })
        throw err
      } finally {
        fetchBusy = false
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
