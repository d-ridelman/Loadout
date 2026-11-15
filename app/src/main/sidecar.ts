import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface SidecarOptions {
  bin: string
  args: string[]
  /** Уведомление ядра (`ready`, `changed`). Тело уже разобрано как JSON, но не проверено. */
  onNotification: (method: string, params: unknown) => void
  maxRestarts?: number
  baseDelayMs?: number
  /** Сколько процесс должен проработать, чтобы счётчик перезапусков сбросился. */
  stableMs?: number
  requestTimeoutMs?: number
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Один постоянный процесс `loadout serve` и JSON-RPC по его stdio. При падении перезапускается с растущей паузой и
 * пределом попыток; запросы во время перезапуска ждут, но не дольше таймаута. Привязки к Electron нет: проверяется
 * в vitest на подставном процессе.
 */
export class Sidecar {
  private child: ChildProcess | undefined
  private pending = new Map<number, Pending>()
  private queue: string[] = []
  private nextId = 1
  private attempts = 0
  private startedAt = 0
  private restartTimer: NodeJS.Timeout | undefined
  private stopping = false
  private dead = false
  /** После `stop()` запрос не поднимает ядро заново: приложение закрывается. Снимает только явный `start()`. */
  private closed = false

  constructor(private readonly o: SidecarOptions) {}

  start(): void {
    this.stopping = false
    this.closed = false
    this.dead = false
    this.spawnChild()
  }

  /** Запрос без аргументов: у страницы нет способа передать ядру путь. */
  request(method: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('ядро остановлено'))
    if (this.dead || (!this.child && !this.restartTimer)) {
      // исчерпанные или не начатые попытки: повторный запрос (кнопка «Повторить») начинает заново
      this.attempts = 0
      this.start()
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ядро не ответило: нет ответа на ${method} за ${(this.o.requestTimeoutMs ?? 20_000) / 1000} с`))
      }, this.o.requestTimeoutMs ?? 20_000)
      this.pending.set(id, { resolve, reject, timer })
      this.write(JSON.stringify({ jsonrpc: '2.0', id, method }))
    })
  }

  /** Закрывает stdin (по EOF ядро выходит само) и добивает процесс, если он завис. */
  stop(): void {
    this.stopping = true
    this.closed = true
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    this.failAll('ядро остановлено')
    const child = this.child
    if (!child) return
    child.stdin?.end()
    const killer = setTimeout(() => child.kill(), 1500)
    child.once('exit', () => clearTimeout(killer))
  }

  private write(line: string): void {
    const stdin = this.child?.stdin
    if (stdin && !stdin.destroyed && stdin.writable) stdin.write(`${line}\n`)
    else this.queue.push(line) // процесс ещё поднимается или перезапускается
  }

  private spawnChild(): void {
    this.startedAt = Date.now()
    let child: ChildProcess
    try {
      child = spawn(this.o.bin, this.o.args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch (e) {
      this.onGone(e instanceof Error ? e.message : 'не удалось запустить')
      return
    }
    this.child = child
    createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line))
    child.stdin?.on('error', () => undefined) // запись в закрытый канал: процесс уже выходит, разберёт `exit`
    // `error` и `exit` могут прийти оба: учитываем только того процесса, который ещё текущий
    child.once('error', (e) => this.onGone(e.message, child))
    child.once('exit', (code, signal) => this.onGone(`процесс завершился (${code ?? signal})`, child))
    for (const line of this.queue.splice(0)) this.write(line)
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; result?: unknown; error?: { message?: unknown }; method?: unknown; params?: unknown }
    try {
      msg = JSON.parse(line)
    } catch {
      return // в stdout обязан быть только JSON; всё прочее игнорируем
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`ядро не ответило: ${String(msg.error.message ?? 'ошибка')}`))
      else p.resolve(msg.result)
    } else if (typeof msg.method === 'string') {
      this.o.onNotification(msg.method, msg.params)
    }
  }

  private onGone(reason: string, who?: ChildProcess): void {
    if (who && this.child !== who) return // этот процесс уже обработан или заменён
    const ranFor = Date.now() - this.startedAt
    this.child = undefined
    this.failAll(`ядро не ответило: ${reason}`)
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
