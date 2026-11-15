import type { ChangedEvent, ScanDiff, ScanResult } from '../shared/model'

const CLIENTS = ['claude-code', 'claude-desktop', 'codex', 'antigravity', 'deepseek']
const KINDS = ['plugin', 'mcp', 'skill', 'hook', 'agent', 'command', 'marketplace', 'connector']
const STATES = ['on', 'off', 'broken', 'stale', 'cloud', 'unknown']

const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Всё, что приходит от ядра, проходит эту проверку до того, как попадёт в окно: и ответ на запрос, и push. */
export function validateScan(raw: unknown): ScanResult {
  if (!isObj(raw) || !Array.isArray(raw['entities']) || !Array.isArray(raw['warnings']) || !isObj(raw['facts'])) {
    throw new Error('ядро вернуло данные неожиданной формы')
  }
  const { entities, warnings, facts } = raw
  if (entities.length > 100_000) throw new Error('ядро вернуло слишком много записей')
  for (const e of entities as unknown[]) {
    const ok =
      isObj(e) &&
      isStr(e['id']) &&
      isStr(e['logicalKey']) &&
      isStr(e['name']) &&
      isStr(e['scope']) &&
      isStr(e['client']) && CLIENTS.includes(e['client']) &&
      isStr(e['kind']) && KINDS.includes(e['kind']) &&
      isStr(e['state']) && STATES.includes(e['state']) &&
      isObj(e['origin']) && isStr(e['origin']['file']) && isStr(e['origin']['pointer']) &&
      isObj(e['detail'])
    if (!ok) throw new Error('в ответе ядра есть запись неожиданной формы')
  }
  if (!(warnings as unknown[]).every(isStr)) throw new Error('предупреждения ядра неожиданной формы')
  const f = facts as Record<string, unknown>
  const backups = f['backups']
  const links = f['brokenLinks']
  const factsOk =
    Array.isArray(backups) &&
    backups.every((b) => isObj(b) && isStr(b['client']) && isStr(b['dir']) && isNum(b['count'])) &&
    Array.isArray(links) &&
    links.every((l) => isObj(l) && isStr(l['client']) && isStr(l['dir']) && isNum(l['broken']) && isNum(l['total']))
  if (!factsOk) throw new Error('факты ядра неожиданной формы')
  return raw as unknown as ScanResult
}

function ids(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 100_000 || !v.every(isStr)) throw new Error('список id неожиданной формы')
  return v
}

/** Разбор `params` уведомления `changed`: только id и признаки. */
export function validateDiff(raw: unknown): ScanDiff {
  if (!isObj(raw)) throw new Error('событие ядра неожиданной формы')
  return {
    added: ids(raw['added']),
    removed: ids(raw['removed']),
    changed: ids(raw['changed']),
    warningsChanged: raw['warningsChanged'] === true,
    factsChanged: raw['factsChanged'] === true,
  }
}

export type { ChangedEvent }
