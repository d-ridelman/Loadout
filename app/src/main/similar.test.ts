import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Entity } from '../shared/model'
import { comparable, downloadModel, modelValid, nearest, textOf } from './similar'

const ent = (id: string, logicalKey: string, extra: Partial<Entity> = {}): Entity => ({
  id,
  logicalKey,
  kind: 'skill',
  client: 'claude-code',
  scope: 'user',
  name: logicalKey,
  state: 'on',
  origin: { file: '~/x', pointer: '' },
  detail: {},
  canToggle: false,
  canEdit: false,
  ...extra,
})

describe('similar to this: ranking', () => {
  const vecs: Record<string, number[]> = { a: [1, 0], b: [0.8, 0.6], b2: [0.6, 0.8], c: [0, 1], d: [-1, 0], a2: [1, 0] }
  const items = [ent('a', 'A'), ent('a2', 'A', { client: 'codex' }), ent('b', 'B'), ent('b2', 'B', { client: 'codex' }), ent('c', 'C'), ent('d', 'D')]
  const vec = (e: Entity) => vecs[e.id]

  it('leaves out the target and its own key, keeps one entry per key (the closest), best first', () => {
    expect(nearest(items[0]!, items, vec)).toEqual([
      { id: 'b', score: 0.8 },
      { id: 'c', score: 0 },
      { id: 'd', score: -1 },
    ])
    expect(nearest(items[0]!, items, vec, 1).map((n) => n.id)).toEqual(['b'])
  })

  it('a target without a vector or a vector of another length gives nothing for it', () => {
    expect(nearest(ent('x', 'X'), items, vec)).toEqual([])
    expect(nearest(items[0]!, [...items, ent('z', 'Z')], (e) => (e.id === 'z' ? [1, 0, 0] : vecs[e.id]))).toHaveLength(3)
  })

  it('compares skills by "name: description", the name alone without one', () => {
    expect(textOf(ent('s', 'k', { name: 'pdf', detail: { description: ' Read PDFs ' } }))).toBe('pdf: Read PDFs')
    expect(textOf(ent('s', 'k', { name: 'pdf' }))).toBe('pdf')
    expect(comparable([ent('s', 'k'), ent('m', 'm', { kind: 'mcp' })]).map((e) => e.id)).toEqual(['s'])
  })
})

describe('similar to this: the model download', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const body = Buffer.from('model bytes')
  const files = [{ name: 'model.onnx', path: 'onnx/m.onnx', size: body.length, sha256: createHash('sha256').update(body).digest('hex') }]
  const serve = (bytes: Buffer, status = 200) =>
    (async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://example.test/r/onnx/m.onnx')
      return new Response(status === 200 ? new Uint8Array(bytes) : null, { status })
    }) as typeof fetch

  it('a file with the expected size and sha256 takes its name; progress reaches the total', async () => {
    dir = mkdtempSync(join(tmpdir(), 'loadout-ml-'))
    const seen: number[] = []
    await downloadModel(dir, 'https://example.test/r/', (d) => seen.push(d), serve(body), files)
    expect(readFileSync(join(dir, 'model.onnx'))).toEqual(body)
    expect(seen.at(-1)).toBe(body.length)
    expect(await modelValid(dir, files)).toBe(true)
  })

  it('a swapped file, a longer one or an HTTP error leaves no model and no .part behind', async () => {
    dir = mkdtempSync(join(tmpdir(), 'loadout-ml-'))
    await expect(downloadModel(dir, 'https://example.test/r/', () => {}, serve(Buffer.from('MODEL BYTES')), files)).rejects.toThrow(/sha256/)
    await expect(downloadModel(dir, 'https://example.test/r/', () => {}, serve(Buffer.concat([body, body])), files)).rejects.toThrow()
    await expect(downloadModel(dir, 'https://example.test/r/', () => {}, serve(body, 404), files)).rejects.toThrow(/404/)
    expect(readdirSync(dir)).toEqual([])
    expect(await modelValid(dir, files)).toBe(false)
  })

  it('a connection that stalls is given up instead of downloading forever', async () => {
    dir = mkdtempSync(join(tmpdir(), 'loadout-ml-'))
    const stalled = (async (_u: string | URL | Request, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2]))
            init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')))
          },
        }),
      )) as typeof fetch
    await expect(downloadModel(dir, 'https://example.test/r/', () => {}, stalled, files, 50)).rejects.toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it('a present file with a wrong sha256 is not the model', async () => {
    dir = mkdtempSync(join(tmpdir(), 'loadout-ml-'))
    writeFileSync(join(dir, 'model.onnx'), 'MODEL BYTES')
    expect(await modelValid(dir, files)).toBe(false)
    expect(existsSync(join(dir, 'model.onnx'))).toBe(true)
  })
})
