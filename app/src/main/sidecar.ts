import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { t } from '../shared/i18n'

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
  private queue: { line: string; id: number | undefined; gen: number | undefined }[] = []
  private gen = 0
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

  /** Параметры собирает main-процесс из проверенных значений (id, флаг, хеш): у страницы нет способа передать ядру путь. */
  request(method: string, params?: Record<string, unknown>, onlyGeneration?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(t('ядро остановлено', 'the core was stopped')))
    if (onlyGeneration !== undefined && onlyGeneration !== this.gen) {
      return Promise.reject(new Error(t('ядро перезапустилось: повторите операцию', 'the core restarted: repeat the operation')))
    }
    if (this.dead || (!this.child && !this.restartTimer)) {
      // исчерпанные или не начатые попытки: повторный запрос (кнопка «Повторить») начинает заново
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

  /** Номер запущенного процесса ядра: растёт при каждом (пере)запуске. */
  get generation(): number {
    return this.gen
  }

  /** Закрывает stdin (по EOF ядро выходит само) и добивает процесс, если он завис. */
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
   * `onlyGeneration`: запрос годится только процессу этого поколения (запись, чей протокол уже сверен). Если процесс
   * перезапустился, пока запрос ждал в очереди, новому процессу он не уходит: тот мог оказаться другой версии.
   */
  private write(line: string, id?: number, onlyGeneration?: number): void {
    const stdin = this.child?.stdin
    if (stdin && !stdin.destroyed && stdin.writable) stdin.write(`${line}\n`)
    else this.queue.push({ line, id, gen: onlyGeneration }) // процесс ещё поднимается или перезапускается
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
    child.stdin?.on('error', () => undefined) // запись в закрытый канал: процесс уже выходит, разберёт `exit`
    // `error` и `exit` могут прийти оба: учитываем только того процесса, который ещё текущий
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
      return // в stdout обязан быть только JSON; всё прочее игнорируем
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(t(`ядро не ответило: ${String(msg.error.message ?? 'ошибка')}`, `the core did not respond: ${String(msg.error.message ?? 'error')}`)))
      else p.resolve(msg.result)
    } else if (typeof msg.method === 'string') {
      this.o.onNotification(msg.method, msg.params)
    }
  }

  private onGone(reason: string, who?: ChildProcess): void {
    if (who && this.child !== who) return // этот процесс уже обработан или заменён
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
