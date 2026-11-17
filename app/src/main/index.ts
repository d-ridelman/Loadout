import { app, BrowserWindow, clipboard, ipcMain, Menu, net, session, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { autoUpdater } from 'electron-updater'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { backupNotice } from '../shared/backups'
import { getLang, isLang, langFromLocale, setLang, t } from '../shared/i18n'
import type { Lang } from '../shared/i18n'
import { LEVEL_RANK } from '../shared/model'
import type { ChangedEvent, ClientId, Result, ScanResponse, SimilarInfo, SimilarItem, SimilarState, UpdatesInfo, WriteLevel } from '../shared/model'
import { comparable, downloadModel, embed, megabytes, MODEL_BASE, MODEL_FILES, modelDirName, modelPresent, modelValid, nearest, textOf } from './similar'
import type { ModelFile } from './similar'
import { askConfirm } from './confirm'
import type { Confirm } from './confirm'
import * as ctxkit from './ctxkit'
import { assertTrusted, grantedOf, parseBatch, parseLevel, parseOp, parseSha, trustedSender, validateIntent, validateName } from './gate'
import { checkoutArgs, checkTreeSize, cloneArgs, findSkills, isCommitRef, localMarketplaceOk, parseMarketplaceSource, parseRefs, parseSkillSource, pickTreeRef, readCatalog, remoteUrl, rmTree } from './install'
import { Sidecar } from './sidecar'
import { tidyHome } from './tidy'
import { autoCheckOn, notesUrl, Updates } from './updates'
import type { UpdaterLike } from './updates'
import { welcomeDue } from './welcome'
import {
  validateApplied,
  validateBatchApplied,
  validateBatchPlan,
  validateDiff,
  validateJournal,
  validatePlan,
  validateProfiles,
  validateProjects,
  validatePruned,
  validateScan,
  PROJECT_RE,
} from './validate'

/**
 * Environment variables (`LOADOUT_BIN`, `LOADOUT_HOME`, `LOADOUT_USER_DATA`, `ELECTRON_RENDERER_URL`) are for development
 * and window checks. They are ignored in an installed build, otherwise a foreign environment could swap the core or the page.
 */
const envAllowed = !app.isPackaged
const envOf = (name: string): string | undefined => (envAllowed ? process.env[name] : undefined)

/** A path containing the home directory is shown as `~` in error text. */
function tidy(text: string): string {
  return tidyHome(text, app.getPath('home'))
}

/**
 * QA mode (`APP_QA=1`): window data lives only in the profile from `LOADOUT_USER_DATA`.
 * The owner's profile is never touched, so without an explicit directory the app does not start in this mode.
 */
const qa = !app.isPackaged && process.env.APP_QA === '1'
if (qa && !process.env.LOADOUT_USER_DATA) {
  console.error('FAILED: APP_QA=1 requires LOADOUT_USER_DATA (the QA profile directory)')
  app.exit(1)
}
const userData = envOf('LOADOUT_USER_DATA')
if (userData) app.setPath('userData', resolve(userData))

/**
 * One instance per data directory: two windows sharing a profile would write to the same backups and configs. The Electron
 * lock is tied to `userData` (verified on this project's Electron: two processes with different `userData`, via `setPath` and via
 * `--user-data-dir`, both get the lock; with the same one the second gets `false`). So QA runs (`LOADOUT_USER_DATA`,
 * `--user-data-dir` in pack-check) with their own profile do not interfere with each other or with an installed copy. Call after `setPath`.
 */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

// The window is simple (tables, text, light effects): the accelerated GPU process eats ~120 MB for a few gradients.
// Software rendering keeps private memory lower (CONCEPT.md §7, 150 MB target).
app.disableHardwareAcceleration()

const DEV_URL = envOf('ELECTRON_RENDERER_URL')
/** The only file allowed to call IPC in the built app. */
const INDEX_URL = pathToFileURL(join(__dirname, '../renderer/index.html')).href

/** The core path is fixed, not taken from PATH. `LOADOUT_BIN` is for tests and development. */
function sidecarPath(): string {
  // installed build: the core sits next to the app (extraResources), the path is hardcoded and env is not read
  if (app.isPackaged) return join(process.resourcesPath, 'loadout.exe')
  return envOf('LOADOUT_BIN') ?? resolve(app.getAppPath(), '..', 'target', 'release', 'loadout.exe')
}

/** Window icon on the taskbar (an unsigned exe has none of its own): from resources in a build, from `build/` in development. */
function iconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : resolve(app.getAppPath(), 'build', 'icon.png')
}

/** Loadout's directory for operation backups and the trash: inside the app profile. */
const backupsDir = (): string => join(app.getPath('userData'), 'backups')

let sidecar: Sidecar | undefined
let lastWindow: BrowserWindow | undefined
/** The scan failed: the window shows an error, and the first `ready` from the restarted core must replace it with data. */
let needCatchUp = false

/** The persistent core: `loadout serve` over JSON-RPC. If it crashes, it is started again (see sidecar.ts). */
function ensureSidecar(): Sidecar | string {
  if (sidecar) return sidecar
  const bin = sidecarPath()
  if (!existsSync(bin) || !basename(bin).toLowerCase().startsWith('loadout')) {
    // what to do, in user words; a development build gets here only without `cargo build --release`, which a developer knows
    return tidy(t(`ядро не найдено: нет файла ${bin}. Переустановите Loadout.`, `core not found: there is no file ${bin}. Reinstall Loadout.`))
  }
  // The backups directory is always passed; the right to write is checked by main (level R1) before every `apply` and `rollback`.
  const args = ['serve', '--backups', backupsDir(), '--lang', getLang()]
  const homeOverride = envOf('LOADOUT_HOME')
  if (homeOverride) args.push('--home', homeOverride)
  // checks point the OpenCode system config (%ProgramData%\opencode) at a fixture; ignored in the packaged build like every LOADOUT_*
  const systemOverride = envOf('LOADOUT_OPENCODE_SYSTEM_DIR')
  if (systemOverride) args.push('--opencode-system', systemOverride)
  let readySeen = false
  sidecar = new Sidecar({
    bin,
    args,
    onNotification: (method, params) => {
      if (method === 'changed') void pushChanged(params)
      else if (method === 'ready') {
        // A repeated `ready` means the core restarted: files may have changed during the pause, so the window catches up.
        // Same if the first request failed (the core crashed before the first `ready`): the window then shows an error.
        if (readySeen || needCatchUp) void pushChanged(undefined)
        readySeen = true
        needCatchUp = false
      }
    },
  })
  sidecar.start()
  return sidecar
}

/** Only for window checks: a response delay, to capture the "loading" state. */
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

/** The core reported a change: fetch the snapshot, validate it like a request response, and hand it to the window. */
async function pushChanged(params: unknown): Promise<void> {
  const win = lastWindow
  if (!win || win.isDestroyed() || !sidecar) return
  try {
    // `undefined` means a core restart: the differences are unknown, so the window gets fresh data without highlighting
    const diff = params === undefined
      ? { added: [], removed: [], changed: [], warningsChanged: false, factsChanged: false }
      : validateDiff(params)
    const data = validateScan(await sidecar.request('snapshot'))
    const event: ChangedEvent = { data, diff }
    win.webContents.send('changed', event)
  } catch {
    /* a broken event must not crash the window: the next scan or a manual refresh will catch up */
  }
}

/** The write level (CONCEPT.md §5) is stored in the app profile; the default is R0, read-only. */
const settingsFile = (): string => join(app.getPath('userData'), 'settings.json')

function readSettings(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Settings keys are written one at a time: writing one does not erase the others. */
function saveSetting(key: 'writeLevel' | 'lang' | 'autoUpdate' | 'welcomed', value: string | boolean): void {
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

/**
 * Updates from GitHub releases (electron-updater, `publish` in package.json). They work in an installed build; a QA run gets
 * a stand-in that e2e drives through `app.evaluate` (`globalThis.__loadoutUpdater`), so checks never touch the network.
 */
const updatesSupported = app.isPackaged || qa
let updates: Updates | undefined

function updatesInfo(): UpdatesInfo {
  return { version: app.getVersion(), auto: autoCheckOn(readSettings()), supported: updatesSupported, state: updates?.state ?? { status: 'idle' } }
}

function sendUpdates(): void {
  const win = lastWindow
  if (win && !win.isDestroyed()) win.webContents.send('updates', updatesInfo())
}

function qaUpdater(): UpdaterLike & { calls: string[]; opened: string[] } {
  const calls: string[] = []
  const fake = Object.assign(new EventEmitter(), {
    autoDownload: true,
    calls,
    opened: [] as string[],
    checkForUpdates: async () => (calls.push('check'), null),
    downloadUpdate: async () => (calls.push('download'), []),
    quitAndInstall: (silent?: boolean, run?: boolean) => void calls.push(`install:${silent}:${run}`),
  })
  ;(globalThis as Record<string, unknown>)['__loadoutUpdater'] = fake
  return fake
}

/** Language: the saved choice, otherwise by system locale (Russian locale gives Russian, any other gives English). `LOADOUT_LANG` is for development and checks only. */
function initialLang(): Lang {
  const forced = envOf('LOADOUT_LANG')
  if (isLang(forced)) return forced
  const saved = readSettings()['lang']
  return isLang(saved) ? saved : langFromLocale(app.getLocale())
}

/** Client processes by image name; Claude Desktop and Claude Code are both called `claude.exe`, so this is a warning, not a ban. */
const CLIENT_PROCESSES: Partial<Record<ClientId, string[]>> = {
  'claude-code': ['claude.exe'],
  'claude-desktop': ['claude.exe'],
  codex: ['codex.exe'],
  // names taken from a real machine: the DeepSeek window is called "DeepSeek Harness", Antigravity has a shell and the CLI `agy`
  antigravity: ['antigravity.exe', 'agy.exe'],
  deepseek: ['deepseek harness.exe'],
  // the desktop app and its CLI as installed on a real machine (OpenCode 2.3.0)
  opencode: ['opencode.exe', 'opencode-cli.exe'],
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

/** A core or validation error becomes a response to the window: the page never receives exceptions with paths. */
async function guarded<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: tidy(e instanceof Error ? e.message : t('не удалось выполнить операцию', 'the operation failed')) }
  }
}

function writeCore(): Sidecar {
  const s = ensureSidecar()
  if (typeof s === 'string') throw new Error(s)
  return s
}

/** The core protocol version this window works with (crates/loadoutd: `PROTOCOL`). */
const CORE_PROTOCOL = 1
/** The generation of the core process whose protocol has already been verified. */
let verifiedGeneration: number | undefined

/**
 * A request to the core for writing. The protocol version is checked for every core process: an old core (a stale
 * `target/release`, or a planted `LOADOUT_BIN`) does not know `maxLevel` and would let an R2 write through at level R1. The write
 * itself is bound to the generation of the verified process: if the core restarted (including while the request sat in the queue),
 * it is not sent to the new process.
 */
/** Core requests in flight: until they finish the language does not change (a change stops the core). */
let coreInFlight = 0

async function core(method: string, params?: Record<string, unknown>): Promise<unknown> {
  coreInFlight++
  try {
    const s = writeCore()
    if (verifiedGeneration !== s.generation) {
      const g = s.generation
      const st = await s.request('status', undefined, g)
      const ok = typeof st === 'object' && st !== null && (st as Record<string, unknown>)['protocol'] === CORE_PROTOCOL
      if (!ok) throw new Error(t('ядро другой версии, поэтому запись отключена. Переустановите Loadout.', 'the core is a different version, so writing is disabled. Reinstall Loadout.'))
      verifiedGeneration = g
    }
    return await s.request(method, params, verifiedGeneration)
  } finally {
    coreInFlight--
  }
}

/**
 * The level main allows for this operation. It is passed to the core in the same request as the write itself
 * (`maxLevel`), and the core refuses if the operation needs a higher one: the "ask for the plan, check, then apply" scheme
 * was open to a race (`profileSave` could be slipped in between the calls).
 */
const grantedLevel = (): 'R1' | 'R2' => grantedOf(readWriteLevel())

/** The write level in the words of the window's header list. */
const levelLabel = (l: WriteLevel): string => (l === 'R2' ? t('Все правки · R2', 'All edits · R2') : l === 'R1' ? t('Вкл/выкл · R1', 'On/off · R1') : t('Только чтение · R0', 'Read-only · R0'))

/**
 * A person's yes or no in main's own confirmation window (confirm.ts). Window checks put an answer function in
 * `globalThis.__loadoutConfirm` instead; that hook exists only in the QA mode, never in the packaged build.
 */
const confirm = (parent: BrowserWindow | null, o: Confirm): Promise<boolean> => {
  const hook = qa ? (globalThis as { __loadoutConfirm?: (o: Confirm) => Promise<boolean> }).__loadoutConfirm : undefined
  return hook ? hook(o) : askConfirm(parent, o, getLang(), qaHidden)
}

/** Accept calls only from our own page (see gate.ts). */
const trusted = (e: IpcMainInvokeEvent): boolean => trustedSender(e, INDEX_URL, DEV_URL)

/** The QA window stays out of the owner's way: off screen, no taskbar button (`LOADOUT_QA_VISIBLE=1` brings it back on screen). */
const qaHidden = qa && process.env.LOADOUT_QA_VISIBLE !== '1'
// Without this Chromium does not paint an occluded or off-screen window, and screenshots hang.
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
    // No system frame or title: the window's top bar is ours (logo, controls), while the minimize, maximize and
    // close buttons stay system ones (with Snap layouts), but in the window colors and in our 48 px high bar.
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

// A second launch with the same profile: the first window comes to the front, the second process is already exiting (see `gotLock`).
app.on('second-instance', () => {
  const win = lastWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

void app.whenReady().then(() => {
  // the second instance touches nothing: not the staging directory, not the core, not the window
  if (!gotLock) return
  setLang(initialLang())
  Menu.setApplicationMenu(null)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ipcMain.handle('scan', (e) => (trusted(e) ? runScan() : Promise.reject(new Error('untrusted sender'))))
  ipcMain.handle('copyText', (e, text: unknown) => {
    if (!trusted(e) || typeof text !== 'string') return
    clipboard.writeText(text.slice(0, 10_000))
  })
  // Write channels: the page passes only the entry id, the desired state, the hash from the preview and the operation number.
  const guard = (e: IpcMainInvokeEvent): void => assertTrusted(e, INDEX_URL, DEV_URL)
  ipcMain.handle('lang:get', (e) => (guard(e), getLang()))
  ipcMain.handle('lang:set', (e, lang: unknown) => {
    guard(e)
    if (!isLang(lang)) throw new Error('invalid language')
    if (lang !== getLang()) {
      // stopping the core in the middle of a write (a profile batch) would leave the batch half applied
      if (coreInFlight > 0 || setupBusy || claudeBusy || fetchBusy) {
        throw new Error(t('идёт запись или установка: дождитесь окончания и повторите', 'a write or an install is in progress: wait for it to finish and try again'))
      }
      setLang(lang)
      saveSetting('lang', lang)
      // core messages are in the process language: the core restarts with a new `--lang`, the next request starts it again;
      // the new process's protocol version is verified again (its generation count starts from zero)
      sidecar?.stop()
      sidecar = undefined
      verifiedGeneration = undefined
    }
    return lang
  })
  ipcMain.handle('welcome:get', (e) => (guard(e), welcomeDue(readSettings())))
  ipcMain.handle('welcome:done', (e) => (guard(e), saveSetting('welcomed', true)))
  ipcMain.handle('writeLevel:get', (e) => (guard(e), readWriteLevel()))
  ipcMain.handle('writeLevel:set', async (e, raw: unknown) => {
    guard(e)
    const level = parseLevel(raw)
    // Raising the level is confirmed by a person in a window of main's own that the page cannot click for them:
    // otherwise a compromised page would enable writing and call `apply` right away. Lowering needs no confirmation.
    // Window checks replace `globalThis.__loadoutConfirm` in the main process (QA only), for both consent and refusal.
    if (LEVEL_RANK[level] > LEVEL_RANK[readWriteLevel()]) {
      const r2 = level === 'R2'
      const opts = {
        title: t(`разрешить запись: ${levelLabel(level)}`, `allow writing: ${levelLabel(level)}`),
        message: r2
          ? t('Разрешить Loadout выносить записи в корзину (так выключаются MCP без флага), править команды MCP, копировать и добавлять MCP, применять профили, ставить скилы, плагины и Инструменты контекста?', 'Allow Loadout to move entries to the trash (that is how an MCP server without a flag is disabled), edit MCP commands, copy and add MCP servers, apply profiles, and install skills, plugins and Context Toolkit?')
          : t('Разрешить Loadout включать и выключать записи по флагу в конфигах клиентов (плагины, коннекторы, записи Codex, MCP-серверы OpenCode)?', 'Allow Loadout to turn entries on and off by their flag in client configs (plugins, connectors, Codex entries, OpenCode MCP servers)?'),
        detail:
          (r2
            ? t(
                'Перед каждым изменением показывается предпросмотр. Переключения, корзина, правка, копирование и добавление MCP, профили и скилы пишутся в журнал с бэкапом и откатываются оттуда. Плагины и маркетплейсы ставит сам claude, в журнал они не попадают: плагин выключается в матрице, удаляется командой claude plugin uninstall. У Инструментов контекста свой откат в их разделе.',
                'A preview is shown before every change. Toggles, the trash, MCP edits, copies and additions, profiles and skills go into the journal with a backup and roll back from there. Plugins and marketplaces are installed by claude itself and are not in the journal: disable a plugin in the matrix, remove it with claude plugin uninstall. Context Toolkit has its own rollback in its section.',
              )
            : t('Перед каждым изменением показывается предпросмотр и делается бэкап; переключение откатывается из журнала.', 'A preview is shown and a backup is made before every change; a toggle rolls back from the journal.')) +
          ' ' +
          t('Закройте Claude Code и Codex, если они запущены: они могут перезаписать файл.', 'Close Claude Code and Codex if they are running: they may overwrite the file.') +
          '\n\n' +
          backupNotice(tidy(backupsDir())),
        cancel: t('Отмена', 'Cancel'),
        ok: r2 ? t('Разрешить все правки', 'Allow all edits') : t('Разрешить вкл/выкл', 'Allow on/off'),
      }
      if (!(await confirm(BrowserWindow.fromWebContents(e.sender), opts))) return readWriteLevel()
    }
    saveWriteLevel(level)
    return level
  })
  ipcMain.handle('plan', (e, raw: unknown) => {
    guard(e)
    return guarded(async () => {
      const plan = validatePlan(await core('plan', validateIntent(raw)))
      // a client will not overwrite a new skill directory with its own state: a warning about a running client is pointless
      return { ...plan, running: plan.op === 'installSkill' ? [] : await runningOf(plan.client) }
    })
  })
  ipcMain.handle('apply', (e, raw: unknown, baseSha: unknown) => {
    guard(e)
    return guarded(async () => {
      const intent = validateIntent(raw)
      const sha = parseSha(baseSha)
      // the level an operation needs (a flag is R1; trash, edit and copy are R2) is known and checked by the core
      return validateApplied(await core('apply', { ...intent, baseSha: sha, maxLevel: grantedLevel() }))
    })
  })
  ipcMain.handle('journal', (e) => {
    guard(e)
    return guarded(async () => validateJournal(await core('journal')))
  })
  // Cleaning up old backups is irreversible, so a person confirms it in main's own window (the page cannot click it), like raising the level.
  ipcMain.handle('backups:prune', async (e) => {
    guard(e)
    const opts = {
      title: t('очистить старые копии', 'clean up old copies'),
      message: t('Удалить копии старых операций? Откатить их после этого будет нельзя.', 'Delete the copies of old operations? They cannot be rolled back afterwards.'),
      detail: backupNotice(tidy(backupsDir())),
      cancel: t('Отмена', 'Cancel'),
      ok: t('Очистить', 'Clean up'),
      danger: true,
    }
    if (!(await confirm(BrowserWindow.fromWebContents(e.sender), opts))) return { ok: false, error: t('очистка отменена', 'cleanup cancelled') }
    return guarded(async () => validatePruned(await core('pruneBackups')))
  })
  ipcMain.handle('rollback', (e, op: unknown) => {
    guard(e)
    return guarded(async () => {
      return validateApplied(await core('rollback', { op: parseOp(op), maxLevel: grantedLevel() }))
    })
  })
  ipcMain.handle('rollbackBatch', (e, batch: unknown) => {
    guard(e)
    return guarded(async () => {
      const done: unknown = await core('rollbackBatch', { batch: parseBatch(batch), maxLevel: grantedLevel() })
      if (!Array.isArray(done)) throw new Error(t('ядро вернуло ответ неожиданной формы', 'the core returned a response of an unexpected shape'))
      return done.map(validateApplied)
    })
  })
  // Profiles live in Loadout's own store and do not write to client configs: they can be read and changed at any level.
  ipcMain.handle('profiles', (e) => {
    guard(e)
    return guarded(async () => validateProfiles(await core('profiles')))
  })
  ipcMain.handle('profileSave', (e, name: unknown, items: unknown) => {
    guard(e)
    return guarded(async () => {
      const params: Record<string, unknown> = { name: validateName(name) }
      if (items !== undefined && items !== null) {
        // validate the shape of the profile entries and rebuild them: extra fields never reach the core
        params['items'] = validateProfiles([{ name: 'x', items }])[0]?.items
      }
      return validateProfiles(await core('profileSave', params))
    })
  })
  ipcMain.handle('profileDelete', (e, name: unknown) => {
    guard(e)
    return guarded(async () => validateProfiles(await core('profileDelete', { name: validateName(name) })))
  })
  ipcMain.handle('profilesQuarantine', (e) => {
    guard(e)
    return guarded(async () => {
      const name: unknown = await core('profilesQuarantine')
      if (typeof name !== 'string' || !/^profiles\.json\.broken-\d{1,20}$/.test(name)) throw new Error(t('ядро вернуло ответ неожиданной формы', 'the core returned a response of an unexpected shape'))
      return name
    })
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
      const sha = parseSha(batchSha)
      const n = validateName(name)
      return validateBatchApplied(await core('applyProfile', { name: n, batchSha: sha, maxLevel: grantedLevel() }))
    })
  })
  // ---- copying entries to another client, globally or inside one known project (docs/TRANSFER.en.md) ----
  ipcMain.handle('projects', (e) => {
    guard(e)
    return guarded(async () => validateProjects(await core('projects')))
  })
  ipcMain.handle('projectScan', (e, id: unknown) => {
    guard(e)
    return guarded(async () => {
      if (typeof id !== 'string' || !PROJECT_RE.test(id)) throw new Error(t('неверный номер проекта', 'invalid project id'))
      return validateScan(await core('projectScan', { id }))
    })
  })
  /** A copy batch holds copies only, each validated like a single intent. */
  const copiesOf = (raw: unknown) => {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) throw new Error(t('неверный пакет копий', 'invalid batch of copies'))
    return raw.map((r) => {
      const i = validateIntent(r)
      if (i.op !== 'copy') throw new Error(t('неверный пакет копий', 'invalid batch of copies'))
      return i
    })
  }
  ipcMain.handle('planCopies', (e, items: unknown) => {
    guard(e)
    return guarded(async () => {
      const bp = validateBatchPlan(await core('planCopies', { items: copiesOf(items) }))
      const clients = [...new Set(bp.plans.map((p) => p.client))]
      const running = [...new Set((await Promise.all(clients.map(runningOf))).flat())]
      return { ...bp, running }
    })
  })
  ipcMain.handle('applyCopies', (e, items: unknown, batchSha: unknown) => {
    guard(e)
    return guarded(async () => {
      const sha = parseSha(batchSha)
      return validateBatchApplied(await core('applyCopies', { items: copiesOf(items), batchSha: sha, maxLevel: grantedLevel() }))
    })
  })
  // ---- built-in Context Toolkit (CONCEPT.md §13): the binary ships with the app, the path is hardcoded ----
  const ctxBin = (): string =>
    app.isPackaged
      ? join(process.resourcesPath, 'context-toolkit.exe')
      : (envOf('LOADOUT_CONTEXT_TOOLKIT') ?? envOf('LOADOUT_CTXKIT') ?? resolve(app.getAppPath(), 'build', 'context-toolkit.exe'))
  /** In development and checks (`LOADOUT_HOME`) Context Toolkit works in this directory, not in the real profile. */
  const ctxHome = (): string | undefined => envOf('LOADOUT_HOME')
  const userHome = (): string => ctxHome() ?? app.getPath('home')
  let lastSetupPreview: string | undefined
  let setupBusy = false

  ipcMain.handle('ctxkit:status', (e) => {
    guard(e)
    return guarded(() =>
      ctxkit.status(ctxBin(), join(userHome(), '.claude', 'hooks'), join(userHome(), '.local', 'bin')),
    )
  })
  ipcMain.handle('ctxkit:doctor', (e) => {
    guard(e)
    return guarded(async () => {
      // `doctor` exits with code 1 when there is an error-level finding: that is a normal response, so parse stdout
      const r = await ctxkit.run(ctxBin(), ['doctor', '--json', '--lang', getLang(), ...ctxkit.profileArgs(ctxHome())], 20_000)
      const d = ctxkit.parseDoctor(r.stdout)
      // findings may contain full paths (a settings.json parse error, a hook command): the home directory path is replaced with `~`
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
  /** Preview → R2 → run for `setup` and `setup --uninstall`: one preview key (with the kind of action in the key) and one lock. */
  const ctxkitStep = (dryRun: unknown, what: string, plan: () => { key: string; args: string[] }) =>
    guarded(async () => {
      if (typeof dryRun !== 'boolean') throw new Error(t('неверные параметры', 'invalid parameters'))
      const { key, args } = plan()
      if (setupBusy) throw new Error(t('Инструменты контекста уже работают: дождитесь окончания', 'Context Toolkit is already running: wait for it to finish'))
      if (!dryRun) {
        // writing to client configs needs R2 and a preview with exactly the same settings
        if (readWriteLevel() !== 'R2') throw new Error(t(`для этого действия (${what}) нужен уровень R2: включите его в шапке окна`, `this action (${what}) requires level R2: enable it in the window header`))
        if (lastSetupPreview !== key) throw new Error(t('сначала выполните предпросмотр с теми же настройками', 'run a preview with the same settings first'))
        // the preview is consumed before the run: one preview, one action, even if the run ends in an error
        lastSetupPreview = undefined
      }
      setupBusy = true
      try {
        const r = await ctxkit.run(ctxBin(), args, 120_000)
        if (dryRun && r.code === 0) lastSetupPreview = key
        return { dryRun, code: r.code, output: tidy(`${r.stdout}${r.stderr}`).slice(0, 20_000) }
      } finally {
        setupBusy = false
      }
    })
  ipcMain.handle('ctxkit:setup', (e, raw: unknown, dryRun: unknown) => {
    guard(e)
    return ctxkitStep(dryRun, t('применение Инструментов контекста', 'applying Context Toolkit'), () => {
      const options = ctxkit.parseSetupOptions(raw)
      return { key: `setup:${JSON.stringify(options)}`, args: ctxkit.setupArgs(options, dryRun as boolean, ctxHome()) }
    })
  })
  ipcMain.handle('ctxkit:uninstall', (e, raw: unknown, dryRun: unknown) => {
    guard(e)
    return ctxkitStep(dryRun, t('откат Инструментов контекста', 'rolling back Context Toolkit'), () => {
      const options = ctxkit.parseUninstallOptions(raw)
      return { key: `uninstall:${JSON.stringify(options)}`, args: ctxkit.uninstallArgs(options, dryRun as boolean, getLang(), ctxHome()) }
    })
  })
  // ---- installing a Claude Code plugin with its own CLI: this is network access and foreign code, hence R2, a preview and no `-y` ----
  const SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
  // One preview, one run: the key is the exact command, consumed before the run. Shared by installs and marketplaces.
  let lastClaudePreview: string | undefined
  let claudeBusy = false
  const quoteArg = (a: string): string => (/[\s"]/.test(a) ? `"${a}"` : a)
  /** `claude <args>` in the steps "preview → R2 → run". `args` are already built from validated input, there is no shell. */
  const claudeStep = async (args: string[], dryRun: boolean, what: string) => {
    const shown = `claude ${args.map(quoteArg).join(' ')}`
    if (dryRun) {
      lastClaudePreview = shown
      return { dryRun, code: 0, output: tidy(shown) }
    }
    if (readWriteLevel() !== 'R2') throw new Error(t(`для этого действия (${what}) нужен уровень R2: включите его в шапке окна`, `this action (${what}) requires level R2: enable it in the window header`))
    if (lastClaudePreview !== shown) throw new Error(t('сначала выполните предпросмотр с тем же вводом', 'run a preview with the same input first'))
    if (claudeBusy) throw new Error(t('команда Claude Code уже выполняется', 'a Claude Code command is already running'))
    lastClaudePreview = undefined
    claudeBusy = true
    try {
      // the standard CLI launch from PATH; in development and checks `LOADOUT_CLAUDE` (+ `LOADOUT_CLAUDE_ARGS`, JSON) replaces it
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
  // ---- Claude Code marketplaces: adding via its CLI (network, R2) and reading catalogs (read-only) ----
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
  // ---- a skill from GitHub or a folder: the source goes into the core's staging directory, the core installs it (plan, journal, rollback) ----
  const stagingRoot = (): string => join(app.getPath('userData'), 'backups', 'staging')
  let lastFetchPreview: string | undefined
  let fetchBusy = false
  // earlier staging is not needed after a restart: start from an empty directory
  try {
    rmTree(stagingRoot())
  } catch {
    // the leftover will be removed by the skill download; app startup does not fail because of it
  }
  ipcMain.handle('skill:fetch', (e, raw: unknown, dryRun: unknown) => {
    guard(e)
    return guarded(async () => {
      if (typeof dryRun !== 'boolean') throw new Error(t('неверные параметры', 'invalid parameters'))
      const src = parseSkillSource(raw)
      const ghBase = envOf('LOADOUT_GITHUB_BASE') ?? 'https://github.com/'
      const shownDest = tidy(join(stagingRoot(), '…'))
      const gitLine = (args: string[]): string => `git ${args.map(quoteArg).join(' ')}`
      const command =
        src.kind === 'github'
          ? [
              gitLine(cloneArgs(src, ghBase, shownDest)),
              // a commit hash: `--branch` does not accept it, hence a second step
              ...(isCommitRef(src.ref) ? [gitLine(checkoutArgs(src.ref!, shownDest))] : []),
              // a branch from a tree/… address may contain `/`: it is found from the branch list, this step is not in the preview yet
              ...(src.treePath ? [t(`(перед этим: git ls-remote, чтобы отделить ветку ${src.treePath.join('/')} от пути внутри репозитория)`, `(first: git ls-remote, to tell the branch in ${src.treePath.join('/')} from the path inside the repository)`)] : isCommitRef(src.ref) ? [t('(перед этим: git ls-remote, чтобы убедиться, что это не ветка или тег с таким именем)', '(first: git ls-remote, to make sure this is not a branch or a tag with that name)')] : []),
            ].join('\n')
          : t(`копия ${tidy(src.path)} → ${shownDest}`, `copy ${tidy(src.path)} → ${shownDest}`)
      const key = JSON.stringify(src)
      if (dryRun) {
        lastFetchPreview = key
        return { dryRun, command, stage: '', skills: [] }
      }
      // network access and foreign code on disk require R2, as with plugin installation
      if (readWriteLevel() !== 'R2') throw new Error(t('для загрузки скила нужен уровень R2: включите его в шапке окна', 'downloading a skill requires level R2: enable it in the window header'))
      if (lastFetchPreview !== key) throw new Error(t('сначала посмотрите, что будет скачано', 'first review what will be downloaded'))
      if (fetchBusy) throw new Error(t('загрузка уже идёт', 'a download is already in progress'))
      lastFetchPreview = undefined
      fetchBusy = true
      // one staging at a time: the previous one is removed
      rmTree(stagingRoot())
      const stage = randomBytes(16).toString('hex')
      const dest = join(stagingRoot(), stage)
      mkdirSync(stagingRoot(), { recursive: true })
      try {
        let subDir = ''
        if (src.kind === 'github') {
          let found = src
          // no login window and no console prompts: on a private or nonexistent repository git exits with an error immediately
          // no LFS smudge: it would contact the host from the repository's `.lfsconfig`
          const gitEnv = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1' }
          if (src.treePath || isCommitRef(src.ref)) {
            // a branch with `/` in a tree/… address and a branch that looks like a hash: check against the real list of branches and tags;
            // if that fails, "the first segment is the branch" stays, and something hash-like is treated as a hash
            const ls = await ctxkit.run('git', ['-c', 'protocol.ext.allow=never', 'ls-remote', '--heads', '--tags', '--', remoteUrl(src, ghBase)], 60_000, gitEnv)
            const pick = ls.code === 0 ? pickTreeRef(src.treePath ?? [src.ref!], parseRefs(ls.stdout)) : undefined
            if (pick) found = { ...src, ref: pick.ref, sub: src.treePath ? pick.sub : src.sub, commit: pick.commit }
          }
          subDir = found.sub
          const r = await ctxkit.run('git', cloneArgs(found, ghBase, dest), 120_000, gitEnv)
          if (r.code !== 0) {
            const hint = src.treePath && found === src ? t(' Если ветка в адресе содержит «/», а репозиторий не отвечает на список веток, укажите адрес без tree/… (owner/repo/путь).', ' If the branch in the address contains “/” and the repository does not answer the branch list, use an address without tree/… (owner/repo/path).') : ''
            throw new Error(t(`git clone не удался: ${tidy(r.stderr).slice(-400)}${hint}`, `git clone failed: ${tidy(r.stderr).slice(-400)}${hint}`))
          }
          if (found.commit ?? isCommitRef(found.ref)) {
            const co = await ctxkit.run('git', checkoutArgs(found.ref!, dest), 120_000, gitEnv)
            if (co.code !== 0) throw new Error(t(`коммит ${found.ref} не найден или не выгружен: ${tidy(co.stderr).slice(-400)}`, `commit ${found.ref} was not found or not checked out: ${tidy(co.stderr).slice(-400)}`))
          }
        } else {
          if (!statSync(src.path, { throwIfNoEntry: false })?.isDirectory()) throw new Error(t('папка не найдена', 'folder not found'))
          checkTreeSize(src.path)
          // links are not dereferenced: the core will refuse a tree containing links
          cpSync(src.path, dest, { recursive: true, dereference: false, verbatimSymlinks: true, filter: (s) => !/[\\/](\.git|node_modules)$/.test(s) })
        }
        const skills = src.kind === 'github' ? findSkills(dest, subDir, src.repo) : findSkills(dest, '', basename(src.path))
        if (skills.length === 0) throw new Error(t('в источнике нет каталога со SKILL.md', 'the source has no directory with SKILL.md'))
        return { dryRun, command: '', stage, skills }
      } catch (err) {
        // cleanup must not mask the real error (the directory may still be held by a git child process that has not exited)
        try {
          rmTree(dest)
        } catch {
          // the leftover will be removed by the next staging or by startup
        }
        throw err
      } finally {
        fetchBusy = false
      }
    })
  })

  // ---- app updates: the page asks, main checks the state; the page never gets the updater itself ----
  const qaFake = qa ? qaUpdater() : undefined
  if (updatesSupported) {
    if (!qaFake) {
      autoUpdater.disableWebInstaller = true // only the full installer whose sha512 is in latest.yml
      // electron-updater sends a random id kept in `<profile>/.updaterId` with every request (for staged rollouts, unused here);
      // a constant in its place keeps the checks from being linked to one installation
      autoUpdater.requestHeaders = { 'x-user-staging-id': '00000000-0000-0000-0000-000000000000' }
    }
    const updater: UpdaterLike = qaFake ?? autoUpdater
    updates = new Updates({ updater, currentVersion: app.getVersion(), isAuto: () => autoCheckOn(readSettings()), send: sendUpdates })
    // QA runs have no schedule: e2e sets the states itself
    if (!qaFake) updates.start()
  }
  ipcMain.handle('updates:get', (e) => (guard(e), updatesInfo()))
  ipcMain.handle('updates:setAuto', (e, on: unknown) => {
    guard(e)
    if (typeof on !== 'boolean') throw new Error('invalid parameters')
    saveSetting('autoUpdate', on)
    if (on) updates?.tick()
    return updatesInfo()
  })
  ipcMain.handle('updates:check', (e) => {
    guard(e)
    void updates?.check(true)
  })
  ipcMain.handle('updates:download', (e) => {
    guard(e)
    void updates?.download()
  })
  ipcMain.handle('updates:install', (e) => {
    guard(e)
    return guarded(async () => {
      // quitting in the middle of a write (a profile batch) would leave it half applied
      if (coreInFlight > 0 || setupBusy || claudeBusy || fetchBusy) {
        throw new Error(t('идёт запись или установка: дождитесь окончания и повторите', 'a write or an install is in progress: wait for it to finish and try again'))
      }
      return updates?.install() ?? false
    })
  })
  ipcMain.handle('updates:notes', (e) => {
    guard(e)
    const s = updates?.state
    if (!s || !('version' in s)) return
    const url = notesUrl(s.version)
    if (qaFake) qaFake.opened.push(url)
    else void shell.openExternal(url)
  })

  // "Similar to this": the model comes only on a click, from Hugging Face, checked by sha256; the vectors come from loadout-ml
  // (started only here, one run per set of new texts) and stay in memory for this run. QA swaps the files, the address and the
  // program for small fakes; a packaged build reads none of it.
  const mlFiles: ModelFile[] = qa && process.env.LOADOUT_ML_FILES ? (JSON.parse(process.env.LOADOUT_ML_FILES) as ModelFile[]) : MODEL_FILES
  const mlBase = (qa && process.env.LOADOUT_ML_BASE) || MODEL_BASE
  const mlPrefix: string[] = qa && process.env.LOADOUT_ML_ARGS ? (JSON.parse(process.env.LOADOUT_ML_ARGS) as string[]) : []
  const mlBin = (): string =>
    app.isPackaged ? join(process.resourcesPath, 'loadout-ml.exe') : (envOf('LOADOUT_ML_BIN') ?? resolve(app.getAppPath(), '..', 'target', 'release', 'loadout-ml.exe'))
  const mlDir = join(app.getPath('userData'), 'models', modelDirName)
  let mlState: SimilarState = modelPresent(mlDir, mlFiles) ? { status: 'ready' } : { status: 'absent' }
  /** The sha256 of the files was checked in this run (after a download or before the first use). */
  let mlChecked = false
  const vectors = new Map<string, number[]>()
  let mlQueue: Promise<unknown> = Promise.resolve()
  let mlWanted = 0
  const similarInfo = (): SimilarInfo => ({ state: mlState, mb: megabytes(mlFiles) })
  const sendSimilar = (): void => {
    const win = lastWindow
    if (win && !win.isDestroyed()) win.webContents.send('similar', similarInfo())
  }
  async function findSimilar(id: string): Promise<SimilarItem[]> {
    if (mlState.status !== 'ready') throw new Error(t('модель для поиска похожих не скачана', 'the model for similar entries is not downloaded'))
    if (!mlChecked) {
      if (!(await modelValid(mlDir, mlFiles))) {
        mlState = { status: 'error', reason: 'corrupt' }
        sendSimilar()
        throw new Error(t('файлы модели повреждены: скачайте её заново', 'the model files are damaged: download it again'))
      }
      mlChecked = true
    }
    const scan = await runScan()
    if (!scan.ok) throw new Error(scan.error)
    const items = comparable(scan.data.entities)
    const target = items.find((x) => x.id === id)
    if (!target) throw new Error(t('этого скила больше нет в конфигах: обновите список', 'this skill is no longer in the configs: refresh the list'))
    const missing = [...new Set(items.map(textOf))].filter((x) => !vectors.has(x))
    if (missing.length > 0) {
      const vs = await embed(mlBin(), mlDir, missing, mlPrefix)
      missing.forEach((x, i) => vectors.set(x, vs[i]!))
    }
    return nearest(target, items, (x) => vectors.get(textOf(x)))
  }
  ipcMain.handle('similar:get', (e) => (guard(e), similarInfo()))
  ipcMain.handle('similar:download', (e) => {
    guard(e)
    if (mlState.status === 'downloading' || mlState.status === 'ready') return
    mlState = { status: 'downloading', percent: 0 }
    sendSimilar()
    let last = 0
    void downloadModel(
      mlDir,
      mlBase,
      (done, total) => {
        const percent = Math.floor((done * 100) / total)
        if (percent === last) return
        last = percent
        mlState = { status: 'downloading', percent }
        sendSimilar()
      },
      (url, init) => net.fetch(String(url), init),
      mlFiles,
    )
      .then(() => {
        mlState = { status: 'ready' }
        mlChecked = true
      })
      .catch(() => {
        mlState = { status: 'error', reason: 'download' }
      })
      .finally(sendSimilar)
  })
  ipcMain.handle('similar:find', (e, id: unknown) => {
    guard(e)
    if (typeof id !== 'string' || id.length === 0 || id.length > 4096) throw new Error('invalid parameters')
    // one run of loadout-ml at a time: a second request waits and finds the vectors of the first in memory; a request overtaken
    // by a newer one (the arrows went on to the next skill) is skipped, the window shows only the newest answer anyway
    const mine = ++mlWanted
    const run = mlQueue.then(() => (mine === mlWanted ? findSimilar(id) : []))
    mlQueue = run.catch(() => undefined)
    return guarded(() => run)
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// The core is a child process of the window: close stdin (it exits on EOF by itself) and kill it if it hangs.
app.on('before-quit', () => sidecar?.stop())
app.on('window-all-closed', () => app.quit())
