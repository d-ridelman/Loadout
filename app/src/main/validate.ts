import type { ChangedEvent, ClientId, Entity, EntityState, Kind, ScanDiff, ScanResult } from '../shared/model'

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
  // В окно уходят заново собранные объекты: лишние поля ядра (и чужие) до страницы не доходят.
  const clean: Entity[] = (entities as unknown[]).map((e) => {
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
    const o = e['origin'] as Record<string, string>
    return {
      id: e['id'] as string,
      logicalKey: e['logicalKey'] as string,
      kind: e['kind'] as Kind,
      client: e['client'] as ClientId,
      scope: e['scope'] as string,
      name: e['name'] as string,
      state: e['state'] as EntityState,
      ...(isStr(e['version']) ? { version: e['version'] } : {}),
      origin: { file: o['file'] as string, pointer: o['pointer'] as string },
      ...(isStr(e['note']) ? { note: e['note'] } : {}),
      detail: e['detail'] as Record<string, unknown>, // значения уже замаскированы ядром
    }
  })
  if (!(warnings as unknown[]).every(isStr)) throw new Error('предупреждения ядра неожиданной формы')
  const f = facts as Record<string, unknown>
  const backups = f['backups']
  const links = f['brokenLinks']
  const known = (v: unknown): v is ClientId => isStr(v) && CLIENTS.includes(v)
  const factsOk =
    Array.isArray(backups) &&
    backups.every((b) => isObj(b) && known(b['client']) && isStr(b['dir']) && isNum(b['count'])) &&
    Array.isArray(links) &&
    links.every((l) => isObj(l) && known(l['client']) && isStr(l['dir']) && isNum(l['broken']) && isNum(l['total']))
  if (!factsOk) throw new Error('факты ядра неожиданной формы')
  return {
    entities: clean,
    warnings: warnings as string[],
    facts: {
      backups: (backups as Record<string, unknown>[]).map((b) => ({ client: b['client'] as ClientId, dir: b['dir'] as string, count: b['count'] as number })),
      brokenLinks: (links as Record<string, unknown>[]).map((l) => ({
        client: l['client'] as ClientId,
        dir: l['dir'] as string,
        broken: l['broken'] as number,
        total: l['total'] as number,
      })),
    },
  }
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
