import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Sidecar } from './sidecar'
import { validateDiff, validateScan } from './validate'

/** Подставное «ядро»: JSON-RPC по stdio, с командами для падения, шума и записи следов в файл. */
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
    if (Date.now() > end) throw new Error('условие не наступило')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('Sidecar', () => {
  it('отвечает на запросы и доставляет уведомления; мусор в stdout игнорируется', async () => {
    const { s, notes } = setup()
    s.start()
    expect(await s.request('snapshot')).toEqual({ echo: 'snapshot' })
    await s.request('push')
    await until(() => notes.some((n) => n.method === 'changed'))
    expect(notes.some((n) => n.method === 'ready')).toBe(true)
  })

  it('после падения процесса ждущий запрос получает «ядро не ответило», а следующий работает на новом процессе', async () => {
    const { s, starts } = setup()
    s.start()
    await s.request('snapshot')
    await expect(s.request('crash')).rejects.toThrow('ядро не ответило')
    expect(await s.request('snapshot')).toEqual({ echo: 'snapshot' })
    expect(starts()).toBe(2)
  })

  it('пределы перезапусков: после исчерпания запрос падает сразу, повторный запрос начинает заново', async () => {
    const { s, starts } = setup({ maxRestarts: 2 }, `require('node:fs').appendFileSync(process.env.FAKE_LOG, 'start\\n'); process.exit(1)`)
    s.start()
    await expect(s.request('scan')).rejects.toThrow('ядро не ответило')
    await until(() => starts() >= 3) // первый запуск и две попытки
    await new Promise((r) => setTimeout(r, 200))
    expect(starts()).toBe(3)
    await expect(s.request('scan')).rejects.toThrow('ядро не ответило')
    await until(() => starts() > 3) // «Повторить» начинает заново
  })

  it('stop закрывает stdin: ядро выходит по EOF, перезапуска нет', async () => {
    const { s, lines, starts } = setup()
    s.start()
    await s.request('snapshot')
    s.stop()
    await until(() => lines().includes('eof'))
    await new Promise((r) => setTimeout(r, 200))
    expect(starts()).toBe(1)
  })

  it('после stop запрос не поднимает ядро заново', async () => {
    const { s, starts } = setup()
    s.start()
    await s.request('snapshot')
    s.stop()
    await expect(s.request('snapshot')).rejects.toThrow('ядро остановлено')
    await new Promise((r) => setTimeout(r, 200))
    expect(starts()).toBe(1)
  })

  it('запрос без ответа падает по таймауту', async () => {
    const { s } = setup({ requestTimeoutMs: 200 })
    s.start()
    await s.request('snapshot')
    await expect(s.request('silent')).rejects.toThrow('нет ответа')
  })

  it('запросы, отправленные до запуска процесса, не теряются', async () => {
    const { s } = setup()
    s.start()
    const first = s.request('snapshot') // процесс ещё поднимается
    expect(await first).toEqual({ echo: 'snapshot' })
  })
})

describe('validate', () => {
  const ok = {
    entities: [
      {
        id: 'a', logicalKey: 'k', kind: 'mcp', client: 'codex', scope: 'user', name: 'n', state: 'on',
        origin: { file: '~/f', pointer: '/p' }, detail: {},
      },
    ],
    warnings: [],
    facts: { backups: [], brokenLinks: [] },
  }

  it('принимает корректный скан и отвергает неожиданные формы', () => {
    expect(validateScan(ok).entities).toHaveLength(1)
    expect(() => validateScan({ ...ok, entities: [{ ...ok.entities[0], client: 'evil' }] })).toThrow('неожиданной формы')
    expect(() => validateScan({ ...ok, entities: [{ ...ok.entities[0], state: 7 }] })).toThrow()
    expect(() => validateScan({ ...ok, facts: undefined })).toThrow()
    expect(() => validateScan({ ...ok, facts: { backups: [{ client: 'codex', dir: 1, count: 1 }], brokenLinks: [] } })).toThrow('факты')
    expect(() => validateScan(null)).toThrow()
    expect(() => validateScan({ ...ok, facts: { backups: [{ client: 'evil', dir: 'd', count: 1 }], brokenLinks: [] } })).toThrow('факты')
  })

  it('в окно уходят пересобранные объекты без лишних полей', () => {
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

  it('событие `changed` — только id и признаки', () => {
    expect(validateDiff({ added: ['a'], removed: [], changed: [], warningsChanged: true, factsChanged: false })).toEqual({
      added: ['a'], removed: [], changed: [], warningsChanged: true, factsChanged: false,
    })
    expect(() => validateDiff({ added: [1], removed: [], changed: [] })).toThrow()
    expect(() => validateDiff('x')).toThrow()
  })
})
