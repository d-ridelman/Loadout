// IPC gate of the main process: whom we answer and what we accept from the page. No electron, so it can be tested with vitest (gate.test.ts).
import { t } from '../shared/i18n'
import { CLIENTS } from '../shared/model'
import type { ClientId, Intent, WriteLevel } from '../shared/model'
import { skillNameOk } from './install'

export const ENTITY_RE = /^[0-9a-f]{16}(-\d{1,4})?$/
export const SHA_RE = /^[0-9a-f]{64}$/
export const OP_RE = /^[0-9]{13}-[0-9]{2}$/
export const BATCH_RE = /^[0-9]{13}$/
export const NAME_RE = /^[\p{L}\p{N} _.-]{1,40}$/u
const STAGE_RE = /^[0-9a-f]{32}$/
const SUB_RE = /^([A-Za-z0-9._-]{1,100}(\/[A-Za-z0-9._-]{1,100})*)?$/

const CLIENT_IDS: readonly string[] = CLIENTS.map((c) => c.id)
const invalid = (): Error => new Error(t('неверные параметры', 'invalid parameters'))
export const isShort = (v: unknown): v is string => typeof v === 'string' && v.length <= 500 && !/\p{Cc}/u.test(v)

/** New MCP: fields are rebuilt; the core enforces the final rules for name, address and env. */
function validateAdd(r: Record<string, unknown>): Intent {
  const { to, name, command, args, url, env } = r
  if (typeof to !== 'string' || !CLIENT_IDS.includes(to) || !isShort(name) || !isShort(command) || !isShort(url)) {
    throw invalid()
  }
  if (!Array.isArray(args) || args.length > 64 || !args.every(isShort)) throw new Error(t('неверные аргументы', 'invalid arguments'))
  if (!Array.isArray(env) || env.length > 30) throw new Error(t('неверные переменные окружения', 'invalid environment variables'))
  const pairs = env.map((p: unknown) => {
    const k = (p as Record<string, unknown> | null)?.['key']
    const v = (p as Record<string, unknown> | null)?.['value']
    if (!isShort(k) || !isShort(v) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new Error(t('неверные переменные окружения', 'invalid environment variables'))
    return { key: k, value: v }
  })
  return { op: 'add', to: to as ClientId, name, command, args: args as string[], url, env: pairs }
}

/** Parses an intent from the page: only the entry id and what to do with it. Everything else is dropped. */
export function validateIntent(raw: unknown): Intent {
  if (typeof raw !== 'object' || raw === null) throw invalid()
  const r = raw as Record<string, unknown>
  if (r['op'] === 'add') return validateAdd(r)
  if (r['op'] === 'installSkill') {
    // the core finds the staging directory by its number itself; it re-checks the inner path and the name
    const { stage, sub, name } = r
    if (typeof stage !== 'string' || !STAGE_RE.test(stage) || typeof sub !== 'string' || !SUB_RE.test(sub) || typeof name !== 'string' || !skillNameOk(name)) {
      throw invalid()
    }
    return { op: 'installSkill', stage, sub, name }
  }
  const entity = r['entity']
  if (typeof entity !== 'string' || !ENTITY_RE.test(entity)) throw invalid()
  if (r['op'] === 'toggle' && typeof r['enable'] === 'boolean') return { op: 'toggle', entity, enable: r['enable'] }
  if (r['op'] === 'edit' && isShort(r['command']) && r['command'].trim() !== '') {
    const args = r['args']
    if (!Array.isArray(args) || args.length > 64 || !args.every(isShort)) throw new Error(t('неверные аргументы', 'invalid arguments'))
    return { op: 'edit', entity, command: r['command'], args: args as string[] }
  }
  if (r['op'] === 'copy' && typeof r['to'] === 'string' && CLIENT_IDS.includes(r['to'])) {
    return { op: 'copy', entity, to: r['to'] as ClientId }
  }
  throw invalid()
}

export function validateName(v: unknown): string {
  if (typeof v !== 'string' || !NAME_RE.test(v) || v.trim() !== v) throw new Error(t('имя профиля: 1–40 знаков (буквы, цифры, пробел, _ - .)', 'profile name: 1-40 characters (letters, digits, space, _ - .)'))
  return v
}

export function parseSha(v: unknown): string {
  if (typeof v !== 'string' || !SHA_RE.test(v)) throw invalid()
  return v
}

export function parseOp(v: unknown): string {
  if (typeof v !== 'string' || !OP_RE.test(v)) throw new Error(t('неверный номер операции', 'invalid operation number'))
  return v
}

export function parseBatch(v: unknown): string {
  if (typeof v !== 'string' || !BATCH_RE.test(v)) throw new Error(t('неверный номер пакета', 'invalid batch number'))
  return v
}

/** The level the page asks to set. */
export function parseLevel(v: unknown): WriteLevel {
  if (v !== 'R0' && v !== 'R1' && v !== 'R2') throw new Error(t('неизвестный уровень', 'unknown level'))
  return v
}

/** The level main grants to a write under the current setting: R0 means writing is off. */
export function grantedOf(have: WriteLevel): 'R1' | 'R2' {
  if (have === 'R0') throw new Error(t('запись выключена (R0): включите уровень записи в шапке окна', 'writing is off (R0): enable a write level in the window header'))
  return have
}

/** Sender address: the built page file or the same origin as the dev server (not a string prefix: `http://localhost:5173.evil.test` does not pass). */
export function isTrustedUrl(url: string, indexUrl: string, devUrl: string | undefined): boolean {
  if (url.split('#')[0] === indexUrl) return true
  try {
    return devUrl !== undefined && new URL(url).origin === new URL(devUrl).origin
  } catch {
    return false
  }
}

/** All we need from an IPC event: the sender frame. */
export interface SenderEvent {
  senderFrame?: { url: string } | null
}

export const trustedSender = (e: SenderEvent, indexUrl: string, devUrl: string | undefined): boolean => isTrustedUrl(e.senderFrame?.url ?? '', indexUrl, devUrl)

/** Write channels answer only our page: a foreign sender throws before any work is done. */
export function assertTrusted(e: SenderEvent, indexUrl: string, devUrl: string | undefined): void {
  if (!trustedSender(e, indexUrl, devUrl)) throw new Error('untrusted sender')
}
