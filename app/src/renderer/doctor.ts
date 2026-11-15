import { plural, t } from '../shared/i18n'
import type { ClientId, Entity, Facts } from '../shared/model'
import { CLIENTS } from '../shared/model'

export type Severity = 'error' | 'warn' | 'info'

export interface Finding {
  id: string
  severity: Severity
  title: string
  detail: string
  /** Сущность, к которой ведёт «Показать». */
  entity?: Entity
}

const clientName = (id: ClientId): string => CLIENTS.find((c) => c.id === id)?.name ?? id
const SECRETISH = /token|secret|passw|credential|cookie|auth|key$|^pat$|_pat$|pwd|oauth/i

const NO_FACTS: Facts = { backups: [], brokenLinks: [] }

/**
 * Автоматические находки Доктора. Единственное место, где факты скана превращаются в выводы: ядро отдаёт
 * записи и счётчики, окно решает, что из этого проблема. Чистая функция: проверяется без окна.
 */
export function diagnose(entities: readonly Entity[], warnings: readonly string[], facts: Facts = NO_FACTS): Finding[] {
  const out: Finding[] = []

  // Резервные копии, которые копят сторонние установщики: только число, имён файлов ядро не отдаёт.
  for (const b of facts.backups) {
    out.push({
      id: `backups:${b.client}:${b.dir}`,
      severity: 'info',
      title: t(
        `${clientName(b.client)}: ${b.count} ${plural(b.count, ['резервная копия', 'резервные копии', 'резервных копий'], ['backup', 'backups'])} в ${b.dir}`,
        `${clientName(b.client)}: ${b.count} ${plural(b.count, ['резервная копия', 'резервные копии', 'резервных копий'], ['backup', 'backups'])} in ${b.dir}`,
      ),
      detail: t(
        'Их оставляют установщики сторонних инструментов при правке конфигов. Loadout копий не создаёт и не трогает; свои бэкапы будет хранить отдельно (M3).',
        'Third-party installers leave these when they edit configs. Loadout neither creates nor touches them; it will keep its own backups separately (M3).',
      ),
    })
  }

  // Ссылки (junction) на кеш, который почистили: пакет в списке есть, а запустить его нечем.
  for (const l of facts.brokenLinks) {
    if (l.broken === 0) continue
    out.push({
      id: `links:${l.client}:${l.dir}`,
      severity: l.broken === l.total ? 'error' : 'warn',
      title: t(
        `${clientName(l.client)}: ${l.broken} из ${l.total} ссылок на пакеты ведут в никуда`,
        `${clientName(l.client)}: ${l.broken} of ${l.total} package links point to nothing`,
      ),
      detail: t(
        `Каталог ${l.dir}. Цель ссылок (кеш npx) удалена; пакеты, пока их не скачают заново, не запустятся.`,
        `Directory ${l.dir}. The link target (npx cache) was deleted; the packages will not start until they are downloaded again.`,
      ),
    })
  }

  // Маркетплейс без единого плагина: остался от удалённых плагинов или добавлен впрок.
  const used = new Set<string>()
  for (const e of entities) {
    if (e.kind === 'plugin') used.add(`${e.client}|${e.name.slice(e.name.lastIndexOf('@') + 1)}`)
  }
  for (const e of entities) {
    if (e.kind !== 'marketplace' || used.has(`${e.client}|${e.name}`)) continue
    out.push({
      id: `orphan:${e.id}`,
      severity: 'info',
      title: t(`${e.name}: маркетплейс без плагинов (${clientName(e.client)})`, `${e.name}: marketplace without plugins (${clientName(e.client)})`),
      detail: t(
        'Ни один найденный плагин этого клиента не установлен из этого маркетплейса.',
        'None of the plugins found for this client were installed from this marketplace.',
      ),
      entity: e,
    })
  }

  // Несколько записей с одним именем в одном клиенте и одном состоянии (две версии плагина, десять хуков) дают
  // одну находку: подробности и остальные записи видны в инспекторе.
  const seen = new Set<string>()
  for (const e of entities) {
    if (e.state !== 'broken' && e.state !== 'stale') continue
    const once = `${e.state}:${e.client}:${e.kind}:${e.name}`
    if (seen.has(once)) continue
    seen.add(once)
    const broken = e.state === 'broken'
    out.push({
      id: `${e.state}:${e.id}`,
      severity: broken ? 'error' : 'warn',
      title: t(
        `${e.name}: ${broken ? 'сломано' : 'расхождение'} в ${clientName(e.client)}`,
        `${e.name}: ${broken ? 'broken' : 'mismatch'} in ${clientName(e.client)}`,
      ),
      detail:
        e.note ??
        (broken
          ? t('запись есть, но указывает на отсутствующее', 'the entry exists but points to something missing')
          : t('версии расходятся', 'versions differ')),
      entity: e,
    })
  }

  // Один и тот же скил или MCP в нескольких областях одного клиента: какая из записей действует, зависит от клиента.
  const byKey = new Map<string, Entity[]>()
  for (const e of entities) {
    if (e.kind !== 'skill' && e.kind !== 'mcp') continue
    const k = `${e.client}|${e.kind}|${e.logicalKey}`
    byKey.set(k, [...(byKey.get(k) ?? []), e])
  }
  for (const [k, list] of byKey) {
    const scopes = [...new Set(list.map((e) => e.scope))]
    const first = list[0]
    if (scopes.length > 1 && first) {
      out.push({
        id: `dup:${k}`,
        severity: 'warn',
        title: t(
          `${first.logicalKey}: есть в нескольких областях (${clientName(first.client)})`,
          `${first.logicalKey}: present in several scopes (${clientName(first.client)})`,
        ),
        detail: t(
          `области: ${scopes.join(', ')}. Какая запись действует, зависит от клиента.`,
          `scopes: ${scopes.join(', ')}. Which entry applies depends on the client.`,
        ),
        entity: first,
      })
    }
  }

  // Плагины project/local: флаг включения лежит в настройках проекта, ядро их не читает.
  const unknownByClient = new Map<ClientId, number>()
  for (const e of entities) {
    if (e.kind === 'plugin' && e.state === 'unknown') unknownByClient.set(e.client, (unknownByClient.get(e.client) ?? 0) + 1)
  }
  for (const [client, n] of unknownByClient) {
    out.push({
      id: `unknown:${client}`,
      severity: 'info',
      title: t(
        `${clientName(client)}: у ${n} ${plural(n, ['плагина', 'плагина', 'плагинов'], ['plugin', 'plugins'])} состояние не определено`,
        `${clientName(client)}: state unknown for ${n} ${plural(n, ['плагина', 'плагина', 'плагинов'], ['plugin', 'plugins'])}`,
      ),
      detail: t(
        'Флаг включения лежит в настройках проекта (project/local), а их Loadout пока не читает.',
        'The enabled flag lives in the project settings (project/local), which Loadout does not read yet.',
      ),
    })
  }

  // MCP, у которых в конфиге есть ключи секретов: значения там лежат как есть, Loadout их не показывает.
  for (const e of entities) {
    if (e.kind !== 'mcp') continue
    const keys = [...asStrings(e.detail['envKeys']), ...asStrings(e.detail['headerKeys'])].filter((k) => SECRETISH.test(k))
    if (keys.length > 0) {
      out.push({
        id: `secret:${e.id}`,
        severity: 'info',
        title: t(`${e.name} (${clientName(e.client)}): в конфиге есть ключи секретов`, `${e.name} (${clientName(e.client)}): the config has secret keys`),
        detail: t(
          `Ключи: ${keys.slice(0, 5).join(', ')}. Значения лежат в файле клиента, Loadout их не читает и не показывает.`,
          `Keys: ${keys.slice(0, 5).join(', ')}. The values sit in the client's file; Loadout neither reads nor shows them.`,
        ),
        entity: e,
      })
    }
  }

  warnings.forEach((w, i) =>
    out.push({ id: `warn:${i}`, severity: 'warn', title: t('Предупреждение сканера', 'Scanner warning'), detail: w }),
  )

  const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}

export function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
