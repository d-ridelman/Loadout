import { plural, t } from '../shared/i18n'
import type { ClientId, Entity, Facts } from '../shared/model'
import { CLIENTS } from '../shared/model'
import { BACKUP_DIR_HINT } from '../shared/backups'

export type Severity = 'error' | 'warn' | 'info'

export interface Finding {
  id: string
  severity: Severity
  /** A short headline: whose and what kind of problem. */
  title: string
  /** What is wrong: the observed fact. */
  what: string
  /** Why it matters or where it comes from. */
  why: string
  /** What the person can do about it ("How to fix"). */
  fix: string
  /** The client the finding belongs to; scanner warnings have none. The Radar counts problems by this field. */
  client?: ClientId
  /** The entity that "Show" leads to. */
  entity?: Entity
}

const clientName = (id: ClientId): string => CLIENTS.find((c) => c.id === id)?.name ?? id
const SECRETISH = /token|secret|passw|credential|cookie|auth|key$|^pat$|_pat$|pwd|oauth/i

const NO_FACTS: Facts = { backups: [], brokenLinks: [] }

/**
 * Automatic Doctor findings. The only place where scan facts become conclusions: the core hands over
 * entries and counters, the window decides what is a problem. A pure function: testable without the window.
 */
export function diagnose(entities: readonly Entity[], warnings: readonly string[], facts: Facts = NO_FACTS): Finding[] {
  const out: Finding[] = []

  // Backups piled up by third-party installers: only the count, the core does not return file names.
  for (const b of facts.backups) {
    const copies = `${b.count} ${plural(b.count, ['резервная копия', 'резервные копии', 'резервных копий'], ['backup', 'backups'])}`
    out.push({
      id: `backups:${b.client}:${b.dir}`,
      severity: 'info',
      client: b.client,
      title: t(`${clientName(b.client)}: ${copies} в ${b.dir}`, `${clientName(b.client)}: ${copies} in ${b.dir}`),
      what: t(
        `В ${b.dir} лежат файлы *.bak, *.backup, *.recovery: ${b.count}.`,
        `${b.dir} holds *.bak, *.backup, *.recovery files: ${b.count}.`,
      ),
      why: t(
        `Их оставляют установщики сторонних инструментов при правке конфигов. Loadout рядом с конфигами копий не создаёт и эти не трогает: свои бэкапы он хранит отдельно, в ${BACKUP_DIR_HINT}.`,
        `Third-party installers leave these when they edit configs. Loadout makes no copies next to the configs and leaves these alone: it keeps its own backups separately, in ${BACKUP_DIR_HINT}.`,
      ),
      fix: t(
        'Если старые копии не нужны, удалите их сами (например, в Проводнике). Работе клиента они не мешают.',
        'If you no longer need the old copies, delete them yourself (in File Explorer, for example). They do not get in the client’s way.',
      ),
    })
  }

  // Links (junctions) into a cache that was cleaned: the package is listed but there is nothing to launch.
  for (const l of facts.brokenLinks) {
    if (l.broken === 0) continue
    out.push({
      id: `links:${l.client}:${l.dir}`,
      severity: l.broken === l.total ? 'error' : 'warn',
      client: l.client,
      title: t(
        `${clientName(l.client)}: ${l.broken} из ${l.total} ссылок на пакеты ведут в никуда`,
        `${clientName(l.client)}: ${l.broken} of ${l.total} package links point to nothing`,
      ),
      what: t(`В каталоге ${l.dir} ссылки (junction) указывают на удалённые папки.`, `In ${l.dir} the links (junctions) point to deleted folders.`),
      why: t(
        'Цель ссылок (кеш npx) удалена; пакеты, пока их не скачают заново, не запустятся.',
        'The link target (npx cache) was deleted; the packages will not start until they are downloaded again.',
      ),
      fix: t(
        'Скачайте пакеты заново средствами самого клиента (переустановка пакета или его команда обновления). Loadout ссылки не правит.',
        'Download the packages again with the client itself (reinstall the package or run its update command). Loadout does not repair the links.',
      ),
    })
  }

  // A marketplace with no plugins: left over from removed plugins or added in advance.
  const used = new Set<string>()
  for (const e of entities) {
    if (e.kind === 'plugin') used.add(`${e.client}|${e.name.slice(e.name.lastIndexOf('@') + 1)}`)
  }
  for (const e of entities) {
    if (e.kind !== 'marketplace' || used.has(`${e.client}|${e.name}`)) continue
    out.push({
      id: `orphan:${e.id}`,
      severity: 'info',
      client: e.client,
      title: t(`${e.name}: маркетплейс без плагинов (${clientName(e.client)})`, `${e.name}: marketplace without plugins (${clientName(e.client)})`),
      what: t(
        'Ни один найденный плагин этого клиента не установлен из этого маркетплейса.',
        'None of the plugins found for this client were installed from this marketplace.',
      ),
      why: t(
        'Обычно он остаётся после удаления плагинов или добавлен заранее.',
        'It usually remains after its plugins were removed, or was added in advance.',
      ),
      fix:
        e.client === 'claude-code'
          ? t(`Если он нужен, ничего делать не надо. Если нет, удалите его командой \`claude plugin marketplace remove ${e.name}\`.`, `If you need it, there is nothing to do. If not, remove it with \`claude plugin marketplace remove ${e.name}\`.`)
          : t('Если он нужен, ничего делать не надо. Если нет, удалите его в настройках клиента.', 'If you need it, there is nothing to do. If not, remove it in the client’s settings.'),
      entity: e,
    })
  }

  // Several entries with one name in one client and one state (two plugin versions, ten hooks) produce
  // one finding: details and the remaining entries are visible in the inspector.
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
      client: e.client,
      title: t(
        `${e.name}: ${broken ? 'сломано' : 'расхождение'} в ${clientName(e.client)}`,
        `${e.name}: ${broken ? 'broken' : 'mismatch'} in ${clientName(e.client)}`,
      ),
      // the core note is the observed fact; the reason is the same for every entry of this state
      what:
        e.note ??
        (broken
          ? t('запись есть, но указывает на отсутствующее', 'the entry exists but points to something missing')
          : t('версии расходятся', 'versions differ')),
      why: broken
        ? t('Клиент не сможет загрузить эту запись, пока то, на что она указывает, не появится на месте.', 'The client cannot load this entry until what it points to is back in place.')
        : t('В одной области записано несколько версий: какая из них загрузится, решает клиент.', 'Several versions are recorded in one scope: which one loads is up to the client.'),
      fix: broken
        ? t(
            'Нажмите «Показать»: в инспекторе видно, в каком файле запись. Верните на место то, на что она указывает, или выключите её.',
            'Press “Show”: the inspector names the file of the entry. Put back what it points to, or disable the entry.',
          )
        : t(
            'Обновите или переустановите его средствами клиента, чтобы осталась одна версия, затем нажмите «Обновить» (клавиша R).',
            'Update or reinstall it with the client so that one version is left, then press Refresh (key R).',
          ),
      entity: e,
    })
  }

  // The same skill or MCP in several scopes of one client: which entry takes effect depends on the client.
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
        client: first.client,
        title: t(
          `${first.logicalKey}: есть в нескольких областях (${clientName(first.client)})`,
          `${first.logicalKey}: present in several scopes (${clientName(first.client)})`,
        ),
        what: t(`Одна и та же запись найдена в областях: ${scopes.join(', ')}.`, `The same entry is found in scopes: ${scopes.join(', ')}.`),
        why: t('Какая из них действует, решает клиент: правка одной может ничего не изменить.', 'Which one applies is up to the client: editing one of them may change nothing.'),
        fix: dupFix(list, scopes),
        entity: first,
      })
    }
  }

  // Plugins whose enable flag is in settings the core did not read (managed, or a project that is gone).
  const unknownByClient = new Map<ClientId, number>()
  for (const e of entities) {
    if (e.kind === 'plugin' && e.state === 'unknown') unknownByClient.set(e.client, (unknownByClient.get(e.client) ?? 0) + 1)
  }
  for (const [client, n] of unknownByClient) {
    // after «у» the genitive: «у 1 плагина», «у 2 плагинов», «у 5 плагинов»
    const plugins = `${n} ${plural(n, ['плагина', 'плагинов', 'плагинов'], ['plugin', 'plugins'])}`
    out.push({
      id: `unknown:${client}`,
      severity: 'info',
      client,
      title: t(`${clientName(client)}: у ${plugins} состояние не определено`, `${clientName(client)}: state unknown for ${plugins}`),
      what: t('Включены они или нет, по прочитанным файлам сказать нельзя.', 'Whether they are on cannot be told from the files read.'),
      why: t(
        'Их флаг включения лежит там, куда Loadout не заглядывает: в управляемых настройках, в проекте, которого уже нет на диске, или в конфиге без ключа enabled. Причина у каждой записи — в инспекторе.',
        'Their enable flag is where Loadout does not look: in managed settings, in a project that is no longer on disk, or in a config without an enabled key. Each entry states its reason in the inspector.',
      ),
      fix: t(
        'Обычно ничего. Включён ли плагин, видно в самом клиенте. Строки, где состояние не определено ни в одном клиенте, матрица по умолчанию прячет (галочка «скрыть «не определено»»).',
        'Usually nothing. The client itself shows whether the plugin is on. Rows whose state is unknown in every client are hidden in the matrix by default (the “hide "unknown"” checkbox).',
      ),
    })
  }

  // MCPs whose config has secret keys: the values sit there as they are, Loadout does not show them.
  for (const e of entities) {
    if (e.kind !== 'mcp') continue
    const keys = [...asStrings(e.detail['envKeys']), ...asStrings(e.detail['headerKeys'])].filter((k) => SECRETISH.test(k))
    if (keys.length > 0) {
      out.push({
        id: `secret:${e.id}`,
        severity: 'info',
        client: e.client,
        title: t(`${e.name} (${clientName(e.client)}): в конфиге есть ключи секретов`, `${e.name} (${clientName(e.client)}): the config has secret keys`),
        what: t(`Ключи: ${keys.slice(0, 5).join(', ')}.`, `Keys: ${keys.slice(0, 5).join(', ')}.`),
        why: t(
          'Значения лежат в файле клиента; Loadout показывает только имена ключей, не значения.',
          "The values sit in the client's file; Loadout shows only the key names, not the values.",
        ),
        fix: t(
          'Ничего, пока файл клиента остаётся только на этом компьютере. Если он попадает в git или облако, перенесите секреты в переменные окружения.',
          'Nothing, as long as the client file stays on this computer. If it goes into git or a cloud folder, move the secrets into environment variables.',
        ),
        entity: e,
      })
    }
  }

  warnings.forEach((w, i) =>
    out.push({
      id: `warn:${i}`,
      severity: 'warn',
      title: t('Предупреждение сканера', 'Scanner warning'),
      what: w,
      why: t('Файл или его часть не прочитаны: записей оттуда в списке нет.', 'A file or part of it was not read: its entries are missing from the list.'),
      fix: t(
        'Откройте файл из предупреждения в редакторе и исправьте место, на которое оно указывает, затем нажмите «Обновить» (клавиша R).',
        'Open the file named in the warning, fix the place it points to, then press Refresh (key R).',
      ),
    }),
  )

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity])
}

const RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 }

/** Findings by severity, most serious first; empty groups are left out. */
export function groupFindings(list: readonly Finding[]): { severity: Severity; items: Finding[] }[] {
  return (['error', 'warn', 'info'] as const).map((severity) => ({ severity, items: list.filter((f) => f.severity === severity) })).filter((g) => g.items.length > 0)
}

/** How to fix copies in several scopes: promise "disable" only where Loadout can toggle a copy. */
function dupFix(list: readonly Entity[], scopes: readonly string[]): string {
  // a copy that came with a plugin goes away with the plugin, deleting its file by hand does not last
  const plug = scopes.some((s) => s.startsWith('plugin:'))
    ? t(' Копию из плагина убирают, отключив плагин.', ' A copy from a plugin goes away when you disable the plugin.')
    : ''
  if (list.every((e) => e.canToggle)) {
    return t(
      'Нажмите «Показать»: в инспекторе перечислены все копии и их файлы. Лишнюю выключите, а если нужны обе, правьте ту, что действует.',
      'Press “Show”: the inspector lists every copy and its file. Disable the spare one; if you need both, edit the one that takes effect.',
    )
  }
  const togglable = [...new Set(list.filter((e) => e.canToggle).map((e) => e.scope))]
  if (togglable.length > 0) {
    const one = togglable.length === 1
    return t(
      `Нажмите «Показать»: в инспекторе перечислены все копии и их файлы. Loadout выключает только ${one ? 'копию из области' : 'копии из областей'}: ${togglable.join(', ')}. Если лишняя копия в другой области, уберите её вручную; если нужны обе, правьте ту, что действует.${plug}`,
      `Press “Show”: the inspector lists every copy and its file. Loadout can disable only the ${one ? 'copy of the scope' : 'copies of the scopes'}: ${togglable.join(', ')}. If the spare copy is in another scope, remove it by hand; if you need both, edit the one that takes effect.${plug}`,
    )
  }
  // your own copies are those you can delete: not the built-in one, not one that a plugin brings
  const own = scopes.filter((s) => s !== 'builtin' && !s.startsWith('plugin:'))
  if (own.length === 0) {
    const builtin = scopes.includes('builtin')
      ? t('Встроенную копию ставит сам клиент, убрать её нельзя. ', 'The built-in copy comes with the client and cannot be removed. ')
      : ''
    const plugins = scopes.filter((s) => s.startsWith('plugin:')).map((s) => s.slice('plugin:'.length))
    return (
      builtin +
      (plugins.length > 1
        ? t(`Копии принесли плагины (${plugins.join(', ')}): отключите тот, чья копия лишняя.`, `The copies come with the plugins (${plugins.join(', ')}): disable the one whose copy is not needed.`)
        : t('Если копия из плагина не нужна, отключите плагин.', 'If the copy from the plugin is not needed, disable the plugin.'))
    )
  }
  if (scopes.includes('builtin')) {
    const many = own.length > 1
    return t(
      `Встроенную копию ставит сам клиент, убрать её нельзя. Если ${many ? 'ваши копии' : 'ваша копия'} (${own.join(', ')}) ${many ? 'сделаны' : 'сделана'} намеренно, ничего делать не нужно. Если нет, удалите ${many ? 'лишние папки' : 'её папку'} вручную: путь — в инспекторе по кнопке «Показать». Loadout такие записи не переключает.${plug}`,
      `The built-in copy comes with the client and cannot be removed. If your ${many ? 'copies' : 'copy'} (${own.join(', ')}) ${many ? 'are' : 'is'} there on purpose, nothing needs doing. If not, delete ${many ? 'the spare folders' : 'its folder'} by hand: the path is in the inspector under “Show”. Loadout does not toggle such entries.${plug}`,
    )
  }
  return t(
    `Loadout такие записи не переключает. Нажмите «Показать»: в инспекторе перечислены все копии и их файлы. Лишнюю удалите вручную, а если нужны обе, правьте ту, что действует.${plug}`,
    `Loadout does not toggle such entries. Press “Show”: the inspector lists every copy and its file. Delete the spare one by hand; if you need both, edit the one that takes effect.${plug}`,
  )
}

export function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
