// App updates from GitHub releases: the decisions and the schedule. No electron here, so vitest covers it (updates.test.ts);
// index.ts passes in electron-updater's `autoUpdater` (or a stand-in in QA mode) and the setting.
import { t } from '../shared/i18n'
import type { UpdateState } from '../shared/model'

/** First automatic check: a short while after start, so it does not compete with the first scan. */
export const FIRST_CHECK_MS = 10_000
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
/** How often the wall clock is looked at: a timer of a whole day would drift across sleep and hibernation. */
export const TICK_MS = 60 * 60 * 1000

const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

/** Only a plain `X.Y.Z`: pre-releases are not offered, and nothing else from the feed reaches the window. */
export function parseVersion(v: unknown): string | null {
  return typeof v === 'string' && VERSION_RE.test(v) ? v : null
}

export function isNewer(current: string, latest: unknown): boolean {
  const l = parseVersion(latest)
  const c = parseVersion(current)
  if (!l || !c) return false
  const a = c.split('.').map(Number)
  const b = l.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (b[i] !== a[i]) return (b[i] ?? 0) > (a[i] ?? 0)
  return false
}

/** Built from a version that passed `parseVersion`, never taken from the feed. */
export const notesUrl = (version: string): string => `https://github.com/d-ridelman/Loadout/releases/tag/v${version}`

/** On unless the person turned it off. */
export const autoCheckOn = (settings: Record<string, unknown>): boolean => settings['autoUpdate'] !== false

export function checkDue(now: number, startedAt: number, lastCheckAt: number | undefined): boolean {
  return lastCheckAt === undefined ? now - startedAt >= FIRST_CHECK_MS : now - lastCheckAt >= CHECK_EVERY_MS
}

const NET_RE =
  /net::|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket hang up|ERR_INTERNET|ERR_NETWORK|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_PROXY|ERR_TIMED_OUT/i

/** A fixed, calm line for the window: the raw message (stack, addresses, paths) stays in main. */
export function updateErrorText(err: unknown, phase: 'check' | 'download'): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : ''
  const s = `${code} ${err instanceof Error ? err.message : String(err)}`
  if (/ERR_CHECKSUM_MISMATCH|sha512 checksum mismatch|ERR_UPDATER_INVALID_SIGNATURE/.test(s)) {
    return t('Скачанный файл не прошёл проверку целостности, обновление не установлено. Попробуйте позже.', 'The downloaded file failed the integrity check, the update was not installed. Try again later.')
  }
  if (/ERR_UPDATER_LATEST_VERSION_NOT_FOUND|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|No published versions|\b404\b/.test(s)) {
    return t('На GitHub нет сведений об обновлении: возможно, релиз ещё готовится. Проверим позже.', 'GitHub has no update information yet: the release may still be in preparation. We will check later.')
  }
  if (NET_RE.test(s)) return t('Нет связи с GitHub. Проверим позже, работе это не мешает.', 'No connection to GitHub. We will check later; this does not affect your work.')
  return phase === 'download'
    ? t('Не удалось скачать обновление. Попробуйте позже.', 'Could not download the update. Try again later.')
    : t('Не удалось проверить обновления. Проверим позже.', 'Could not check for updates. We will check later.')
}

/** The part of electron-updater's `AppUpdater` that is used. */
export interface UpdaterLike {
  autoDownload: boolean
  // `any`: the payloads come from the network and are checked field by field in the listeners below
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

interface Options {
  updater: UpdaterLike
  currentVersion: string
  isAuto: () => boolean
  send: (state: UpdateState) => void
  now?: () => number
}

/** Turns updater events into `UpdateState` and allows each action only in its state. */
export class Updates {
  state: UpdateState = { status: 'idle' }
  private phase: 'check' | 'download' = 'check'
  private manual = false
  private lastCheckAt: number | undefined
  private startedAt: number
  private readonly o: Options
  private readonly now: () => number

  constructor(o: Options) {
    this.o = o
    this.now = o.now ?? Date.now
    this.startedAt = this.now()
    const u = o.updater
    // the person decides: a found version is only offered, the download starts on the button
    u.autoDownload = false
    u.on('update-available', (info: { version?: unknown }) => {
      if (this.busy()) return
      const v = parseVersion(info?.version)
      this.set(v && isNewer(o.currentVersion, v) ? { status: 'available', version: v } : { status: 'latest', checkedAt: this.now() })
    })
    u.on('update-not-available', () => {
      if (!this.busy()) this.set({ status: 'latest', checkedAt: this.now() })
    })
    u.on('download-progress', (p: { percent?: unknown }) => {
      if (this.state.status !== 'downloading') return
      const n = typeof p?.percent === 'number' && Number.isFinite(p.percent) ? Math.round(p.percent) : 0
      this.set({ ...this.state, percent: Math.min(100, Math.max(0, n)) })
    })
    u.on('update-downloaded', () => {
      if (this.state.status === 'downloading') this.set({ status: 'ready', version: this.state.version })
    })
    u.on('error', (e: unknown) => this.fail(e))
  }

  private busy(): boolean {
    return this.state.status === 'downloading' || this.state.status === 'ready'
  }

  private set(s: UpdateState): void {
    this.state = s
    this.o.send(s)
  }

  private fail(e: unknown): void {
    if (this.state.status === 'ready') return // an update is already downloaded and checked: keep offering it
    this.set({ status: 'error', message: updateErrorText(e, this.phase), quiet: this.phase === 'check' && !this.manual })
  }

  async check(manual: boolean): Promise<void> {
    if (this.busy()) return
    this.phase = 'check'
    this.manual = manual
    this.lastCheckAt = this.now()
    this.set({ status: 'checking', manual })
    try {
      await this.o.updater.checkForUpdates()
    } catch (e) {
      this.fail(e)
    }
  }

  async download(): Promise<void> {
    if (this.state.status !== 'available') return
    this.phase = 'download'
    this.set({ status: 'downloading', version: this.state.version, percent: 0 })
    try {
      await this.o.updater.downloadUpdate()
    } catch (e) {
      this.fail(e)
    }
  }

  /** Silent install, then the new version starts by itself. */
  install(): boolean {
    if (this.state.status !== 'ready') return false
    this.o.updater.quitAndInstall(true, true)
    return true
  }

  /** An automatic check, if the setting is on and it is due. Also called right after the setting is turned on. */
  tick(): void {
    if (this.o.isAuto() && checkDue(this.now(), this.startedAt, this.lastCheckAt)) void this.check(false)
  }

  start(): () => void {
    this.startedAt = this.now()
    const first = setTimeout(() => this.tick(), FIRST_CHECK_MS)
    const every = setInterval(() => this.tick(), TICK_MS)
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }
}
