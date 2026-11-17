import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../shared/model'
import { CHECK_EVERY_MS, FIRST_CHECK_MS, TICK_MS, autoCheckOn, checkDue, errorReason, isNewer, notesUrl, parseVersion, Updates } from './updates'

describe('version decision', () => {
  it('accepts only a plain X.Y.Z version', () => {
    expect(parseVersion('1.0.0')).toBe('1.0.0')
    expect(parseVersion('v1.2.3')).toBeNull()
    expect(parseVersion('1.0.0-beta.1')).toBeNull()
    expect(parseVersion('1.0')).toBeNull()
    expect(parseVersion('1.0.0\n<script>')).toBeNull()
    expect(parseVersion(100)).toBeNull()
    expect(parseVersion('01.0.0')).toBeNull()
  })
  it('a newer version is offered, an equal or older one is not', () => {
    expect(isNewer('0.0.7', '1.0.0')).toBe(true)
    expect(isNewer('0.9.0', '0.10.0')).toBe(true) // numbers, not strings
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('1.0.1', '1.0.0')).toBe(false)
    expect(isNewer('1.0.0', 'garbage')).toBe(false)
    expect(isNewer('1.0.0', '2.0.0-rc.1')).toBe(false)
  })
  it('release notes link is built from the checked version only', () => {
    expect(notesUrl('1.0.0')).toBe('https://github.com/d-ridelman/Loadout/releases/tag/v1.0.0')
  })
})

describe('setting', () => {
  it('automatic check is on by default and off only on an explicit false', () => {
    expect(autoCheckOn({})).toBe(true)
    expect(autoCheckOn({ autoUpdate: true })).toBe(true)
    expect(autoCheckOn({ autoUpdate: 'false' })).toBe(true)
    expect(autoCheckOn({ autoUpdate: false })).toBe(false)
  })
})

describe('schedule', () => {
  it('never checked, or a day since the last check', () => {
    const at = 1_000_000
    expect(checkDue(at, undefined)).toBe(true)
    expect(checkDue(at + CHECK_EVERY_MS - 1, at)).toBe(false)
    expect(checkDue(at + CHECK_EVERY_MS, at)).toBe(true)
  })
})

describe('error reason', () => {
  it('a network failure is "offline", whatever the stack and address around it', () => {
    const e = new Error('net::ERR_INTERNET_DISCONNECTED\n    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:2:1)')
    expect(errorReason(e, 'check')).toBe('offline')
    expect(errorReason(new Error('getaddrinfo ENOTFOUND github.com'), 'download')).toBe('offline')
  })
  it('a missing release, a broken file and the rest have their own reasons', () => {
    expect(errorReason(Object.assign(new Error('x'), { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' }), 'check')).toBe('missing')
    expect(errorReason(Object.assign(new Error('x'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }), 'check')).toBe('missing')
    expect(errorReason(Object.assign(new Error('sha512 checksum mismatch'), { code: 'ERR_CHECKSUM_MISMATCH' }), 'download')).toBe('corrupt')
    expect(errorReason('weird', 'download')).toBe('download')
    expect(errorReason('weird', 'check')).toBe('check')
    expect(errorReason(new Error('spawn EACCES'), 'install')).toBe('install')
  })
})

/** A stand-in for electron-updater: the same events, calls are recorded. */
class FakeUpdater extends EventEmitter {
  autoDownload = true
  calls: string[] = []
  checkForUpdates(): Promise<unknown> {
    this.calls.push('check')
    return Promise.resolve(null)
  }
  downloadUpdate(): Promise<unknown> {
    this.calls.push('download')
    return Promise.resolve([])
  }
  quitAndInstall(silent: boolean, run: boolean): void {
    this.calls.push(`install:${silent}:${run}`)
  }
}

function setup(auto = true) {
  const updater = new FakeUpdater()
  const sent: UpdateState[] = []
  let on = auto
  const u = new Updates({ updater, currentVersion: '1.0.0', isAuto: () => on, send: (s) => sent.push(s) })
  return { updater, sent, u, setAuto: (v: boolean) => (on = v) }
}

describe('Updates', () => {
  afterEach(() => vi.useRealTimers())

  it('does not download by itself', () => {
    const { updater } = setup()
    expect(updater.autoDownload).toBe(false)
  })

  it('available, progress, downloaded, install', async () => {
    const { updater, u } = setup()
    await u.check(true)
    expect(u.state).toEqual({ status: 'checking', manual: true })
    updater.emit('update-available', { version: '1.1.0', releaseNotes: '<img src=x onerror=alert(1)>' })
    expect(u.state).toEqual({ status: 'available', version: '1.1.0' })
    await u.download()
    expect(updater.calls).toContain('download')
    updater.emit('download-progress', { percent: 42.6 })
    expect(u.state).toEqual({ status: 'downloading', version: '1.1.0', percent: 43 })
    updater.emit('download-progress', { percent: 1e9 })
    expect(u.state).toMatchObject({ percent: 100 })
    updater.emit('update-downloaded', { version: '1.1.0' })
    expect(u.state).toEqual({ status: 'ready', version: '1.1.0' })
    expect(u.install()).toBe(true)
    expect(updater.calls).toContain('install:true:true')
  })

  it('an equal, older or malformed version from the feed is not offered', () => {
    const { updater, u } = setup()
    for (const version of ['1.0.0', '0.9.0', '1.1.0-beta', 'x']) {
      updater.emit('update-available', { version })
      expect(u.state.status).toBe('latest')
    }
    updater.emit('update-not-available', { version: '1.0.0' })
    expect(u.state.status).toBe('latest')
  })

  it('download and install are refused in the wrong state', async () => {
    const { updater, u } = setup()
    await u.download()
    expect(u.install()).toBe(false)
    expect(updater.calls).toEqual([])
  })

  it('a background check error is quiet, a manual one and a download error are not', async () => {
    const { updater, u } = setup()
    await u.check(false)
    updater.emit('error', new Error('getaddrinfo ENOTFOUND github.com'))
    expect(u.state).toMatchObject({ status: 'error', quiet: true })
    await u.check(true)
    updater.emit('error', new Error('getaddrinfo ENOTFOUND github.com'))
    expect(u.state).toMatchObject({ status: 'error', quiet: false })
    updater.emit('update-available', { version: '2.0.0' })
    await u.download()
    updater.emit('error', new Error('boom'))
    expect(u.state).toEqual({ status: 'error', reason: 'download', quiet: false })
  })

  it('events out of turn change nothing: a new feed version during a download, a second check while checking', async () => {
    const { updater, u } = setup()
    updater.emit('update-available', { version: '2.0.0' })
    await u.download()
    updater.emit('update-available', { version: '3.0.0' })
    updater.emit('update-not-available', {})
    expect(u.state).toMatchObject({ status: 'downloading', version: '2.0.0' })
    const fresh = setup()
    await fresh.u.check(false)
    await fresh.u.check(true)
    expect(fresh.u.state).toEqual({ status: 'checking', manual: true })
    fresh.updater.emit('update-available', { version: '1.0.1' })
    expect(fresh.u.state).toEqual({ status: 'available', version: '1.0.1' })
  })

  it('a late download error after the update is ready (cache bookkeeping) keeps the ready update', () => {
    const { updater, u } = setup()
    updater.emit('update-available', { version: '2.0.0' })
    void u.download()
    updater.emit('update-downloaded', {})
    updater.emit('error', new Error('EBUSY: resource busy or locked, copyfile current.blockmap'))
    expect(u.state).toEqual({ status: 'ready', version: '2.0.0' })
  })

  it('a failed install start (the updater reports an error once ready) is shown, not swallowed', () => {
    const { updater, u } = setup()
    updater.emit('update-available', { version: '2.0.0' })
    void u.download()
    updater.emit('update-downloaded', {})
    expect(u.install()).toBe(true)
    updater.emit('error', new Error("No update filepath provided, can't quit and install"))
    expect(u.state).toEqual({ status: 'error', reason: 'install', quiet: false })
  })

  it('a rejected promise also ends in an error state, not an unhandled rejection', async () => {
    const { updater, u } = setup()
    updater.checkForUpdates = () => Promise.reject(new Error('ETIMEDOUT'))
    await u.check(true)
    expect(u.state).toEqual({ status: 'error', reason: 'offline', quiet: false })
  })

  it('a check does not interrupt a download or a ready update', async () => {
    const { updater, u } = setup()
    updater.emit('update-available', { version: '2.0.0' })
    await u.download()
    updater.emit('download-progress', { percent: 10 })
    await u.check(true)
    updater.emit('update-downloaded', { version: '2.0.0' })
    await u.check(false)
    expect(updater.calls.filter((c) => c === 'check')).toEqual([])
    expect(u.state.status).toBe('ready')
  })

  it('the schedule checks after start and daily, only while the setting is on', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { updater, u, setAuto } = setup()
    const stop = u.start()
    vi.advanceTimersByTime(FIRST_CHECK_MS - 1)
    expect(updater.calls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(updater.calls).toEqual(['check'])
    updater.emit('update-not-available', {})
    vi.advanceTimersByTime(CHECK_EVERY_MS - 1)
    expect(updater.calls).toEqual(['check'])
    // the clock is looked at once an hour (it survives sleep): the daily check is at most an hour late
    vi.advanceTimersByTime(TICK_MS)
    expect(updater.calls).toEqual(['check', 'check'])
    setAuto(false)
    vi.advanceTimersByTime(3 * CHECK_EVERY_MS)
    expect(updater.calls).toHaveLength(2)
    stop()
    setAuto(true)
    vi.advanceTimersByTime(3 * CHECK_EVERY_MS)
    expect(updater.calls).toHaveLength(2)
  })

  it('a failed check is retried on the next hourly tick, not a day later', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { updater, u } = setup()
    u.start()
    vi.advanceTimersByTime(FIRST_CHECK_MS)
    updater.emit('error', new Error('getaddrinfo ENOTFOUND github.com'))
    expect(u.state).toMatchObject({ status: 'error', reason: 'offline', quiet: true })
    vi.advanceTimersByTime(TICK_MS)
    expect(updater.calls).toEqual(['check', 'check'])
  })

  it('a found version stays offered: the background schedule does not check it away', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { updater, u } = setup()
    u.start()
    vi.advanceTimersByTime(FIRST_CHECK_MS)
    updater.emit('update-available', { version: '2.0.0' })
    vi.advanceTimersByTime(3 * CHECK_EVERY_MS)
    expect(updater.calls).toEqual(['check'])
    expect(u.state).toEqual({ status: 'available', version: '2.0.0' })
  })

  it('turning the setting on checks at once (tick), turned off nothing runs', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { updater, u, setAuto } = setup(false)
    u.start()
    vi.advanceTimersByTime(2 * CHECK_EVERY_MS)
    expect(updater.calls).toEqual([])
    setAuto(true)
    u.tick()
    expect(updater.calls).toEqual(['check'])
  })

  it('a manual check counts: the daily check waits a day after it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { updater, u } = setup()
    u.start()
    await u.check(true)
    updater.emit('update-not-available', {})
    vi.advanceTimersByTime(CHECK_EVERY_MS - 1)
    expect(updater.calls).toEqual(['check'])
  })
})
