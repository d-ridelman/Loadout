import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { t } from '../shared/i18n'

export interface SidecarOptions {
  bin: string
  args: string[]
  /** Core notification (`ready`, `changed`). The body is already parsed as JSON but not validated. */
  onNotification: (method: string, params: unknown) => void
  maxRestarts?: number
  baseDelayMs?: number
  /** How long the process must run for the restart counter to reset. */
  stableMs?: number
  requestTimeoutMs?: number
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/**
 * One long-lived `loadout serve` process and JSON-RPC over its stdio. On a crash it restarts with a growing delay and
 * an attempt limit; requests made during a restart wait, but no longer than the timeout. It has no Electron dependency:
 * it is tested in vitest against a stand-in process.
 */
export class Sidecar {
  private child: ChildProcess | undefined
  private pending = new Map<number, Pending>()
  private queue: { line: string; id: number | undefined; gen: number | undefined }[] = []
  private gen = 0
  private nextId = 1
  private attempts = 0
  private startedAt = 0
  private restartTimer: NodeJS.Timeout | undefined
  private stopping = false
  private dead = false
  /** After `stop()` a request does not bring the core back up: the app is closing. Only an explicit `start()` clears this. */
  private closed = false

  constructor(private readonly o: SidecarOptions) {}

  start(): void {
    this.stopping = false
    this.closed = false
    this.dead = false
    this.spawnChild()
  }

  /** The main process builds the params from validated values (id, flag, hash): the page has no way to pass a path to the core. */
  request(method: string, params?: Record<string, unknown>, onlyGeneration?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(t('ядро остановлено', 'the core was stopped')))
    if (onlyGeneration !== undefined && onlyGeneration !== this.gen) {
      return Promise.reject(new Error(t('ядро перезапустилось: повторите операцию', 'the core restarted: repeat the operation')))
    }
    if (this.dead || (!this.child && !this.restartTimer)) {
      // attempts exhausted or never started: a repeated request (the "Retry" button) starts over
      this.attempts = 0
      this.start()
      if (onlyGeneration !== undefined) return Promise.reject(new Error(t('ядро перезапустилось: повторите операцию', 'the core restarted: repeat the operation')))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const sec = (this.o.requestTimeoutMs ?? 20_000) / 1000
        reject(new Error(t(`ядро не ответило: нет ответа на ${method} за ${sec} с`, `the core did not respond: no reply to ${method} within ${sec} s`)))
      }, this.o.requestTimeoutMs ?? 20_000)
      this.pending.set(id, { resolve, reject, timer })
      this.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }), id, onlyGeneration)
    })
  }

  /** Number of the running core process: grows on every (re)start. */
  get generation(): number {
    return this.gen
  }

  /** Closes stdin (the core exits by itself on EOF) and kills the process if it hangs. */
  stop(): void {
    this.stopping = true
    this.closed = true
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    this.failAll(t('ядро остановлено', 'the core was stopped'))
    const child = this.child
    if (!child) return
    child.stdin?.end()
    const killer = setTimeout(() => child.kill(), 1500)
    child.once('exit', () => clearTimeout(killer))
  }

  /**
   * `onlyGeneration`: the request is valid only for the process of this generation (a write whose protocol is already checked). If the
   * process restarted while the request waited in the queue, it is not sent to the new process: that one may be a different version.
   */
  private write(line: string, id?: number, onlyGeneration?: number): void {
    const stdin = this.child?.stdin
    if (stdin && !stdin.destroyed && stdin.writable) stdin.write(`${line}\n`)
    else this.queue.push({ line, id, gen: onlyGeneration }) // the process is still starting or restarting
  }

  private spawnChild(): void {
    this.startedAt = Date.now()
    let child: ChildProcess
    try {
      child = spawn(this.o.bin, this.o.args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch (e) {
      this.onGone(e instanceof Error ? e.message : t('не удалось запустить', 'failed to start'))
      return
    }
    this.child = child
    this.gen++
    createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line))
    child.stdin?.on('error', () => undefined) // write to a closed pipe: the process is already exiting, `exit` will handle it
    // `error` and `exit` may both arrive: only count them for the process that is still current
    child.once('error', (e) => this.onGone(e.message, child))
    child.once('exit', (code, signal) => this.onGone(t(`процесс завершился (${code ?? signal})`, `the process exited (${code ?? signal})`), child))
    for (const q of this.queue.splice(0)) {
      if (q.gen !== undefined && q.gen !== this.gen) {
        const p = q.id === undefined ? undefined : this.pending.get(q.id)
        if (p && q.id !== undefined) {
          this.pending.delete(q.id)
          clearTimeout(p.timer)
          p.reject(new Error(t('ядро перезапустилось: повторите операцию', 'the core restarted: repeat the operation')))
        }
        continue
      }
      this.write(q.line, q.id, q.gen)
    }
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; result?: unknown; error?: { message?: unknown }; method?: unknown; params?: unknown }
    try {
      msg = JSON.parse(line)
    } catch {
      return // stdout must carry JSON only; ignore everything else
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      // the core did answer: its own words (already in the window language), not "the core did not respond"
      if (msg.error) p.reject(new Error(typeof msg.error.message === 'string' && msg.error.message ? msg.error.message : t('ядро отказало без пояснения', 'the core refused without an explanation')))
      else p.resolve(msg.result)
    } else if (typeof msg.method === 'string') {
      this.o.onNotification(msg.method, msg.params)
    }
  }

  private onGone(reason: string, who?: ChildProcess): void {
    if (who && this.child !== who) return // this process was already handled or replaced
    const ranFor = Date.now() - this.startedAt
    this.child = undefined
    this.failAll(t(`ядро не ответило: ${reason}`, `the core did not respond: ${reason}`))
    if (this.stopping) return
    if (ranFor > (this.o.stableMs ?? 30_000)) this.attempts = 0
    if (this.attempts >= (this.o.maxRestarts ?? 5)) {
      this.dead = true
      return
    }
    const delay = Math.min((this.o.baseDelayMs ?? 500) * 2 ** this.attempts, 8_000)
    this.attempts++
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (!this.stopping) this.spawnChild()
    }, delay)
  }

  private failAll(message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(message))
      this.pending.delete(id)
    }
    this.queue.length = 0
  }
}
