import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Entity } from '../shared/model'

/**
 * "Similar to this": the model measured in ml-eval (paraphrase-multilingual-MiniLM-L12-v2, int8), at a pinned revision and
 * checked by sha256. It is downloaded only on the person's click, from Hugging Face, and never ships in the installer.
 */
const REV = 'e8f8c211226b894fcb81acc59f3b34ba3efd5f42'
export const MODEL_BASE = `https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/resolve/${REV}/`
export interface ModelFile {
  name: string
  /** The path under the base address. */
  path: string
  size: number
  sha256: string
}
export const MODEL_FILES: ModelFile[] = [
  { name: 'model.onnx', path: 'onnx/model_quint8_avx2.onnx', size: 118453870, sha256: '98a01d88b7de996cdea58c32ca71208c09968d143798814b2ea09d3439dc334f' },
  { name: 'tokenizer.json', path: 'tokenizer.json', size: 9081518, sha256: '2c3387be76557bd40970cec13153b3bbf80407865484b209e655e5e4729076b8' },
]
export const megabytes = (files: ModelFile[]): number => Math.round(files.reduce((s, f) => s + f.size, 0) / 1e6)
/** The folder of this revision inside the app profile. */
export const modelDirName = `minilm-${REV.slice(0, 8)}`

export const sha256File = async (file: string): Promise<string> => {
  const h = createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

/** Every file is there with its size (the sha256 is checked once per run, before the first use). */
export const modelPresent = (dir: string, files = MODEL_FILES): boolean =>
  files.every((f) => existsSync(join(dir, f.name)) && statSync(join(dir, f.name)).size === f.size)

export async function modelValid(dir: string, files = MODEL_FILES): Promise<boolean> {
  if (!modelPresent(dir, files)) return false
  for (const f of files) if ((await sha256File(join(dir, f.name))) !== f.sha256) return false
  return true
}

/**
 * Downloads the files into `dir`: each goes to `<name>.part` and takes its own name only when the size and sha256 match, so a
 * broken or swapped download never becomes the model. `fetchFn` is the global fetch (follows redirects to the file server).
 */
export async function downloadModel(
  dir: string,
  base: string,
  onProgress: (done: number, total: number) => void,
  fetchFn: typeof fetch = fetch,
  files = MODEL_FILES,
  stallMs = STALL_MS,
): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const total = files.reduce((s, f) => s + f.size, 0)
  let done = 0
  for (const f of files) {
    const target = join(dir, f.name)
    if (existsSync(target) && statSync(target).size === f.size && (await sha256File(target)) === f.sha256) {
      done += f.size
      onProgress(done, total)
      continue
    }
    const part = `${target}.part`
    // a stalled connection is aborted: without it the state would stay "downloading" until a restart
    const abort = new AbortController()
    let stall = setTimeout(() => abort.abort(), stallMs)
    const h = createHash('sha256')
    let got = 0
    try {
      const res = await fetchFn(base + f.path, { signal: abort.signal })
      if (!res.ok || !res.body) {
        abort.abort() // drop the connection of an error answer at once
        throw new Error(`HTTP ${res.status}`)
      }
      const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0], { signal: abort.signal })
      body.on('data', (c: Buffer) => {
        clearTimeout(stall)
        stall = setTimeout(() => abort.abort(), stallMs)
        h.update(c)
        got += c.length
        if (got > f.size) body.destroy(new Error('the file is larger than expected'))
        onProgress(done + got, total)
      })
      await pipeline(body, createWriteStream(part))
    } catch (e) {
      rmSync(part, { force: true })
      throw e
    } finally {
      clearTimeout(stall)
    }
    const sum = h.digest('hex')
    if (got !== f.size || sum !== f.sha256) {
      rmSync(part, { force: true })
      throw new Error(`${f.name}: the size or sha256 does not match`)
    }
    renameSync(part, target)
    done += f.size
  }
}

/** The text a skill is compared by: the recipe of the measurement (`name: description`, the name alone without one). */
export function textOf(e: Entity): string {
  const d = typeof e.detail.description === 'string' ? e.detail.description.trim() : ''
  return d ? `${e.name}: ${d}` : e.name
}

/** The entries "similar to this" works on: skills, the only kind the measurement covered. */
export const comparable = (es: Entity[]): Entity[] => es.filter((e) => e.kind === 'skill')

export interface Neighbour {
  id: string
  score: number
}

/**
 * The `k` entries closest to `target` by cosine (the vectors are unit length), one per logical key: the same skill in another
 * client is already in the same matrix row, so it and the target's own key are left out.
 */
export function nearest(target: Entity, items: Entity[], vec: (e: Entity) => number[] | undefined, k = 3): Neighbour[] {
  const t = vec(target)
  if (!t) return []
  const best = new Map<string, Neighbour>()
  for (const e of items) {
    if (e.logicalKey === target.logicalKey) continue
    const v = vec(e)
    if (!v || v.length !== t.length) continue
    let score = 0
    for (let i = 0; i < t.length; i++) score += t[i]! * v[i]!
    const was = best.get(e.logicalKey)
    if (!was || score > was.score) best.set(e.logicalKey, { id: e.id, score })
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k)
}

const EMBED_TIMEOUT_MS = 120_000
/** A download that receives nothing for this long is given up (the person can press the button again). */
export const STALL_MS = 60_000

/** Runs `loadout-ml embed` once for the texts, one JSON line in and one vector out per text (`prefix`: a script for a QA fake). */
export function embed(bin: string, modelDir: string, texts: string[], prefix: string[] = []): Promise<number[][]> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, [...prefix, 'embed', '--model', modelDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.setEncoding('utf8').on('data', (c: string) => (out += c))
    p.stderr.setEncoding('utf8').on('data', (c: string) => (err = (err + c).slice(-2000)))
    // a program that exits before reading all of a large input breaks the pipe: its exit code tells what happened, not the pipe
    p.stdin.on('error', () => undefined)
    // a hung program must not hold the queue of requests forever
    const timer = setTimeout(() => p.kill(), EMBED_TIMEOUT_MS)
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code === null) return reject(new Error(`loadout-ml did not answer within ${EMBED_TIMEOUT_MS / 1000} s`))
      if (code !== 0) return reject(new Error(err.trim() || `loadout-ml exit ${code}`))
      const lines = out.split('\n').filter((l) => l.trim())
      if (lines.length !== texts.length) return reject(new Error(`loadout-ml: ${lines.length} vectors for ${texts.length} texts`))
      try {
        resolve(lines.map((l) => JSON.parse(l) as number[]))
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    p.stdin.end(texts.map((x) => JSON.stringify(x)).join('\n') + '\n')
  })
}
