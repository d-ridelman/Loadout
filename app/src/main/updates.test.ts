import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../shared/i18n'
import type { UpdateState } from '../shared/model'
import { CHECK_EVERY_MS, FIRST_CHECK_MS, TICK_MS, autoCheckOn, checkDue, isNewer, notesUrl, parseVersion, Updates, updateErrorText } from './updates'

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
  it('first check a short while after start, then once a day', () => {
    const start = 1_000_000
    expect(checkDue(start + FIRST_CHECK_MS - 1, start, undefined)).toBe(false)
    expect(checkDue(start + FIRST_CHECK_MS, start, undefined)).toBe(true)
    expect(checkDue(start + CHECK_EVERY_MS - 1, start, start)).toBe(false)
    expect(checkDue(start + CHECK_EVERY_MS, start, start)).toBe(true)
  })
})

describe('error text', () => {
  beforeEach(() => setLang('en'))
  afterEach(() => setLang('ru'))
  it('a network failure gives a calm line without the stack or the address', () => {
    const e = new Error('net::ERR_INTERNET_DISCONNECTED\n    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:2:1)')
    const text = updateErrorText(e, 'check')
    expect(text).toMatch(/GitHub/)
    expect(text).not.toMatch(/net::|at |\n/)
  })
  it('a missing release and a broken file have their own lines', () => {
    expect(updateErrorText(Object.assign(new Error('x'), { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' }), 'check')).toMatch(/no update information/)
    expect(updateErrorText(Object.assign(new Error('sha512 checksum mismatch'), { code: 'ERR_CHECKSUM_MISMATCH' }), 'download')).toMatch(/integrity/)
    expect(updateErrorText('weird', 'download')).toMatch(/download/)
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
    expect(u.state).toMatchObject({ status: 'error', quiet: false })
    expect(JSON.stringify(u.state)).not.toMatch(/boom|ENOTFOUND/)
  })

  it('a rejected promise also ends in an error state, not an unhandled rejection', async () => {
    const { updater, u } = setup()
    updater.checkForUpdates = () => Promise.reject(new Error('ETIMEDOUT'))
    await u.check(true)
    expect(u.state).toMatchObject({ status: 'error', quiet: false })
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
