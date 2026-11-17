import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

/** A stand-in "core": JSON-RPC over stdio, with commands for crashing, noise and writing traces to a file. */
const FAKE = `
const fs = require('node:fs')
const log = process.env.FAKE_LOG
const note = (s) => log && fs.appendFileSync(log, s + '\\n')
note('start')
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
send({ method: 'ready', params: { watching: 1 } })
process.stdout.write('это не JSON\\n')
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.method === 'crash') process.exit(3)
  if (m.method === 'silent') return
  if (m.method === 'refuse') return send({ id: m.id, error: { code: -32000, message: 'у этого клиента уже есть запись с таким именем' } })
  if (m.method === 'push') { send({ method: 'changed', params: { added: [], removed: [], changed: ['x'] } }) }
  send({ id: m.id, result: { echo: m.method } })
}).on('close', () => { note('eof'); process.exit(0) })
`

const dirs: string[] = []
const sidecars: Sidecar[] = []
afterEach(() => {
  sidecars.splice(0).forEach((s) => s.stop())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function setup(extra: Partial<ConstructorParameters<typeof Sidecar>[0]> = {}, script = FAKE) {
  const dir = mkdtempSync(join(tmpdir(), 'loadout-sidecar-'))
  dirs.push(dir)
  const file = join(dir, 'fake.cjs')
  const log = join(dir, 'log.txt')
  writeFileSync(file, script)
  process.env['FAKE_LOG'] = log
  const notes: { method: string; params: unknown }[] = []
  const s = new Sidecar({
    bin: process.execPath,
    args: [file],
    onNotification: (method, params) => notes.push({ method, params }),
    baseDelayMs: 20,
    requestTimeoutMs: 3000,
    ...extra,
  })
  sidecars.push(s)
  const starts = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l === 'start').length : 0)
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
  return { s, notes, starts, lines, log }
}

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition was not met')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('Sidecar', () => {
  it('answers requests and delivers notifications; garbage on stdout is ignored', async () => {
    const { s, notes } = setup()
    s.start()
    expect(await s.request('snapshot')).toEqual({ echo: 'snapshot' })
    await s.request('push')
    await until(() => notes.some((n) => n.method === 'changed'))
    expect(notes.some((n) => n.method === 'ready')).toBe(true)
  })

  it('after the process crashes a pending request gets "the core did not respond", and the next one runs on a new process', async () => {
    const { s, starts } = setup()
    s.start()
    await s.request('snapshot')
    await expect(s.request('crash')).rejects.toThrow('ядро не ответило')
    expect(await s.request('snapshot')).toEqual({ echo: 'snapshot' })
    expect(starts()).toBe(2)
  })

  it('an error the core answered with is shown as is: "the core did not respond" is only for a dead or silent core', async () => {
    const { s } = setup()
    s.start()
    await expect(s.request('refuse')).rejects.toThrow(/^у этого клиента уже есть запись с таким именем$/)
  })

  it('restart limits: once exhausted a request fails immediately, a repeated request starts over', async () => {
    const { s, starts } = setup({ maxRestarts: 2 }, `require('node:fs').appendFileSync(process.env.FAKE_LOG, 'start\\n'); process.exit(1)`)
    s.start()
    await expect(s.request('scan')).rejects.toThrow('ядро не ответило')
    await until(() => starts() >= 3) // the first start and two retries
    await new Promise((r) => setTimeout(r, 200))
    expect(starts()).toBe(3)
    await expect(s.request('scan')).rejects.toThrow('ядро не ответило')
    await until(() => starts() > 3) // "Retry" starts over
  })

  it('stop closes stdin: the core exits on EOF, no restart', async () => {
    const { s, lines, starts } = setup()
    s.start()
    await s.request('snapshot')
    s.stop()
    await until(() => lines().includes('eof'))
    await new Promise((r) => setTimeout(r, 200))
    expect(starts()).toBe(1)
  })

  it('after stop a request does not start the core again', async () => {
    const { s, starts } = setup()
    s.start()
    await s.request('snapshot')
    s.stop()
    await expect(s.request('snapshot')).rejects.toThrow('ядро остановлено')
    await new Promise((r) => setTimeout(r, 200))
    expect(starts()).toBe(1)
  })

  it('a request without a reply fails on timeout', async () => {
    const { s, notes } = setup({ requestTimeoutMs: 200 })
    s.start()
    // wait for the core's own "ready", not for a first reply: under load the stand-in core starts slower than the 200 ms timeout,
    // and a warm-up request timed out instead of the silent one (a flake under a parallel vitest)
    await until(() => notes.some((n) => n.method === 'ready'))
    await expect(s.request('silent')).rejects.toThrow('нет ответа на silent')
  })

  it('a request bound to a generation is not sent to a restarted process (the core version check cannot be bypassed)', async () => {
    const { s } = setup({ baseDelayMs: 300 })
    s.start()
    await s.request('snapshot')
    const verified = s.generation
    await expect(s.request('crash')).rejects.toThrow('ядро не ответило')
    // the process crashed and a new one is not up yet: a write verified on the old generation is queued
    const queued = s.request('apply', { x: 1 }, verified)
    await expect(queued).rejects.toThrow('перезапустилось')
    expect(s.generation).toBeGreaterThan(verified)
    // an ordinary unbound request runs on the new process, while the old generation is rejected at once
    expect(await s.request('snapshot')).toEqual({ echo: 'snapshot' })
    await expect(s.request('apply', undefined, verified)).rejects.toThrow('перезапустилось')
    expect(await s.request('apply', undefined, s.generation)).toEqual({ echo: 'apply' })
  })

  it('requests sent before the process starts are not lost', async () => {
    const { s } = setup()
    s.start()
    const first = s.request('snapshot') // the process is still starting
    expect(await first).toEqual({ echo: 'snapshot' })
  })
})

describe('validate', () => {
  const ok = {
    entities: [
      {
        id: 'a', logicalKey: 'k', kind: 'mcp', client: 'codex', scope: 'user', name: 'n', state: 'on',
        origin: { file: '~/f', pointer: '/p' }, detail: {}, canToggle: true, canEdit: false,
      },
    ],
    warnings: [],
    facts: { backups: [], brokenLinks: [] },
  }

  it('accepts a valid scan and rejects unexpected shapes', () => {
    expect(validateScan(ok).entities).toHaveLength(1)
    expect(() => validateScan({ ...ok, entities: [{ ...ok.entities[0], client: 'evil' }] })).toThrow('неожиданной формы')
    expect(() => validateScan({ ...ok, entities: [{ ...ok.entities[0], state: 7 }] })).toThrow()
    expect(() => validateScan({ ...ok, facts: undefined })).toThrow()
    expect(() => validateScan({ ...ok, facts: { backups: [{ client: 'codex', dir: 1, count: 1 }], brokenLinks: [] } })).toThrow('факты')
    expect(() => validateScan(null)).toThrow()
    expect(() => validateScan({ ...ok, facts: { backups: [{ client: 'evil', dir: 'd', count: 1 }], brokenLinks: [] } })).toThrow('факты')
  })

  it('rebuilt objects without extra fields are sent to the window', () => {
    const dirty = {
      ...ok,
      extra: 'x',
      entities: [{ ...ok.entities[0], secret: 'S', version: '1.0', note: 'n', origin: { file: '~/f', pointer: '/p', leak: 'L' } }],
    }
    const out = validateScan(dirty)
    expect(Object.keys(out).sort()).toEqual(['entities', 'facts', 'warnings'])
    expect(out.entities[0]).not.toHaveProperty('secret')
    expect(out.entities[0]?.origin).toEqual({ file: '~/f', pointer: '/p' })
    expect(out.entities[0]).toMatchObject({ version: '1.0', note: 'n' })
  })

  it('the `changed` event carries only ids and flags', () => {
    expect(validateDiff({ added: ['a'], removed: [], changed: [], warningsChanged: true, factsChanged: false })).toEqual({
      added: ['a'], removed: [], changed: [], warningsChanged: true, factsChanged: false,
    })
    expect(() => validateDiff({ added: [1], removed: [], changed: [] })).toThrow()
    expect(() => validateDiff('x')).toThrow()
  })

  it('canToggle is required, toggleWhy is optional', () => {
    expect(() => validateScan({ ...ok, entities: [{ ...ok.entities[0], canToggle: undefined }] })).toThrow()
    const out = validateScan({ ...ok, entities: [{ ...ok.entities[0], canToggle: false, toggleWhy: 'нет флага' }] })
    expect(out.entities[0]).toMatchObject({ canToggle: false, toggleWhy: 'нет флага' })
  })

  const plan = {
    op: 'toggle', level: 'R1', notes: [] as string[], trash: '',
    entity: 'a1', client: 'codex', kind: 'plugin', name: 'n', file: '~/f', pointer: 'p', enable: false,
    from: 'true', to: 'false', noop: false, affects: [], baseSha: 'a'.repeat(64),
  }

  it('plan, write result and journal: extra fields are dropped, malformed shapes are rejected', () => {
    expect(validatePlan({ ...plan, content: 'FAKE-SECRET' })).toEqual(plan)
    expect(() => validatePlan({ ...plan, baseSha: 'zz' })).toThrow('план')
    expect(() => validatePlan({ ...plan, client: 'evil' })).toThrow()
    expect(() => validatePlan({ ...plan, affects: [1] })).toThrow()
    expect(validateApplied({ op: '1-00', entity: 'a', from: 'true', to: 'false', path: 'C:/x' })).toEqual({
      op: '1-00', entity: 'a', from: 'true', to: 'false',
    })
    expect(() => validateApplied({ op: 1 })).toThrow()
    const row = {
      id: '1-00', time: 5, op: 'toggle', of: null, batch: null, level: 'R1', client: 'codex', kind: 'plugin', name: 'n', pointer: 'p', file: '~/f',
      from: 'true', to: 'false', rolledBack: false, canRollback: true,
    }
    expect(validateJournal([{ ...row, path: 'C:/x' }])).toEqual([row])
    expect(() => validateJournal([{ ...row, op: 'delete' }])).toThrow()
    expect(() => validateJournal({})).toThrow()
    expect(validateJournal([{ ...row, op: 'copy', batch: '1700000000000', level: 'R2' }])[0]).toMatchObject({ op: 'copy', batch: '1700000000000', level: 'R2' })
    expect(() => validateJournal([{ ...row, level: 'R9' }])).toThrow()
    expect(validateJournal([{ ...row, why: 'уже откатано' }])[0]?.why).toBe('уже откатано')
    expect(validateJournal([{ ...row, rollbackTo: 'в корзине Loadout' }])[0]?.rollbackTo).toBe('в корзине Loadout')
  })

  it('toggleAt passes only as a file and pointer pair', () => {
    const at = { file: '~/.claude/settings.json', pointer: '/enabledPlugins/a@b' }
    const out = validateScan({ ...ok, entities: [{ ...ok.entities[0], toggleAt: { ...at, leak: 'L' } }] })
    expect(out.entities[0]?.toggleAt).toEqual(at)
    expect(validateScan({ ...ok, entities: [{ ...ok.entities[0], toggleAt: { file: 1 } }] }).entities[0]).not.toHaveProperty('toggleAt')
  })

  it('profiles and batch plan: extra fields are dropped, malformed shapes are rejected', () => {
    const prof = [{ name: 'рабочий', items: [{ client: 'codex', kind: 'plugin', scope: 'user', name: 'p1', enable: true, junk: 1 }], x: 1 }]
    expect(validateProfiles(prof)).toEqual([{ name: 'рабочий', items: [{ client: 'codex', kind: 'plugin', scope: 'user', name: 'p1', enable: true }] }])
    expect(() => validateProfiles([{ name: 'x', items: [{ client: 'evil', kind: 'plugin', scope: 'u', name: 'n', enable: true }] }])).toThrow()
    const bp = { plans: [plan], skipped: ['x'], level: 'R2', batchSha: 'b'.repeat(64), junk: 1 }
    expect(validateBatchPlan(bp)).toEqual({ plans: [plan], skipped: ['x'], level: 'R2', batchSha: 'b'.repeat(64) })
    expect(() => validateBatchPlan({ ...bp, batchSha: 'z' })).toThrow()
    expect(validateBatchApplied({ batch: '1', applied: [{ op: '1-00', entity: 'a', from: 'a', to: 'b', path: 'C:/x' }] })).toEqual({
      batch: '1', applied: [{ op: '1-00', entity: 'a', from: 'a', to: 'b' }],
    })
  })
})
