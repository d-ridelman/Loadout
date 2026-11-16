import { describe, expect, it } from 'vitest'
import type { CtxkitDoctor, Entity, FindingSeverity } from '../shared/model'
import { policiesNow, stopGateOff } from './ctxkit-stats'
import { buildRows, onlyUnknown, scopeRank } from './aggregate'
import { plural } from '../shared/i18n'
import { diagnose } from './doctor'

let n = 0
const ent = (over: Partial<Entity>): Entity => ({
  id: `e${n++}`,
  logicalKey: 'x',
  kind: 'plugin',
  client: 'claude-code',
  scope: 'user',
  name: 'x',
  state: 'on',
  origin: { file: '~/f', pointer: '/p' },
  detail: {},
  canToggle: false,
  canEdit: false,
  ...over,
})

describe('aggregate', () => {
  it('плагины и MCP разведены по разным строкам и группам, а один тип с одним именем в разных клиентах сводится в строку', () => {
    const rows = buildRows([
      ent({ kind: 'plugin', logicalKey: 'glidehand', name: 'glidehand@glidehand' }),
      ent({ kind: 'plugin', logicalKey: 'glidehand', name: 'glidehand@glidehand', client: 'codex' }),
      ent({ kind: 'mcp', logicalKey: 'glidehand', name: 'glidehand', client: 'codex' }),
      ent({ kind: 'marketplace', logicalKey: 'glidehand', name: 'glidehand' }),
    ])
    expect(rows).toHaveLength(3)
    const plugin = rows.find((r) => r.group === 'plugin')
    const mcp = rows.find((r) => r.group === 'mcp')
    expect(Object.keys(plugin?.cells ?? {}).sort()).toEqual(['claude-code', 'codex'])
    expect(plugin?.name).toBe('glidehand')
    expect(mcp?.kinds).toEqual(['mcp'])
    expect(Object.keys(mcp?.cells ?? {})).toEqual(['codex'])
  })

  it('ячейку определяет user-запись, а не десятки project-записей', () => {
    const rows = buildRows([
      ent({ logicalKey: 'p', scope: 'project:~/a', state: 'unknown' }),
      ent({ logicalKey: 'p', scope: 'project:~/b', state: 'unknown' }),
      ent({ logicalKey: 'p', scope: 'user', state: 'on' }),
    ])
    const cell = rows[0]?.cells['claude-code']
    expect(cell?.state).toBe('on')
    expect(cell?.instances).toHaveLength(3)
    expect(cell?.instances[0]?.scope).toBe('user')
  })

  it('девять хуков Codex под одним ключом дают одну строку с девятью экземплярами', () => {
    const rows = buildRows(
      Array.from({ length: 9 }, (_, i) =>
        ent({ kind: 'hook', client: 'codex', logicalKey: 'orca-agent-hooks', name: `E${i}: codex-hook` }),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cells.codex?.instances).toHaveLength(9)
  })

  it('имя областного пакета не теряет ведущую @, суффикс маркетплейса отбрасывается', () => {
    const rows = buildRows([
      ent({ logicalKey: '@deepseek-ai/dsh-x', name: '@deepseek-ai/dsh-x', client: 'deepseek' }),
      ent({ logicalKey: 'harnio', name: 'harnio@harnio' }),
    ])
    expect(rows.map((r) => r.name).sort()).toEqual(['@deepseek-ai/dsh-x', 'harnio'])
  })

  it('строка только из «не определено» помечается', () => {
    const rows = buildRows([ent({ logicalKey: 'a', state: 'unknown', scope: 'project:~/x' })])
    expect(onlyUnknown(rows[0]!)).toBe(true)
    expect(scopeRank('user')).toBeLessThan(scopeRank('project:~/x'))
  })
})

describe('галочка шлюза Stop', () => {
  const doc = (...f: [string, FindingSeverity][]): CtxkitDoctor => ({
    version: '1',
    findings: f.map(([id, severity]) => ({ id, severity, message: id, detail: null, fix: null })),
  })
  it('берётся из находки stop_gate, но только когда ctxkit установлен', () => {
    expect(stopGateOff(doc(['hooks', 'ok'], ['stop_gate', 'info']))).toBe(true)
    expect(stopGateOff(doc(['hooks', 'ok'], ['stop_gate', 'ok']))).toBe(false)
    expect(stopGateOff(doc(['hooks', 'error'], ['stop_gate', 'info']))).toBe(true)
    // чистый профиль: хука нет, «нет шлюза» — не выбор пользователя, остаётся шлюз по умолчанию
    expect(stopGateOff(doc(['hooks', 'warn'], ['stop_gate', 'info']))).toBeNull()
    expect(stopGateOff(doc())).toBeNull()
  })
})

describe('подпись «сейчас включены» в блоке «Защиты»', () => {
  const doc = (...f: [string, FindingSeverity, string | null][]): CtxkitDoctor => ({
    version: '1',
    findings: f.map(([id, severity, detail]) => ({ id, severity, message: `m-${id}`, detail, fix: null })),
  })
  it('есть ctxkit.json — подпись из находки policies; нет файла — null', () => {
    expect(policiesNow(doc())).toBeNull()
    expect(policiesNow(doc(['policies', 'info', 'commit_hygiene, build_slots=2']))).toEqual({ text: 'commit_hygiene, build_slots=2', broken: false })
    expect(policiesNow(doc(['policies', 'warn', 'x']))).toEqual({ text: 'm-policies', broken: true })
  })
})

describe('doctor', () => {
  it('сломанное и расходящееся идут первыми, предупреждения сканера сохраняются', () => {
    const f = diagnose(
      [
        ent({ name: 'a', state: 'stale', note: 'версии' }),
        ent({ name: 'b', state: 'broken', note: 'нет пути' }),
      ],
      ['~/x: не JSON'],
    )
    expect(f.map((x) => x.severity)).toEqual(['error', 'warn', 'warn'])
    expect(f[0]?.title).toContain('b')
  })

  it('две записи одного плагина с расхождением дают одну находку; склонение числа', () => {
    const f = diagnose([ent({ name: 'dup@mp', state: 'stale' }), ent({ name: 'dup@mp', state: 'stale' })], [])
    expect(f).toHaveLength(1)
    expect([1, 2, 5, 11, 21, 22].map((n) => plural(n, ['плагина', 'плагина', 'плагинов'], ['plugin', 'plugins']))).toEqual([
      'плагина', 'плагина', 'плагинов', 'плагинов', 'плагина', 'плагина',
    ])
  })

  it('факты ядра превращаются в находки: копии, битые ссылки, маркетплейс без плагинов', () => {
    const f = diagnose(
      [
        ent({ kind: 'marketplace', name: 'lonely', logicalKey: 'lonely' }),
        ent({ kind: 'marketplace', name: 'used', logicalKey: 'used' }),
        ent({ kind: 'plugin', name: 'p@used', logicalKey: 'p' }),
      ],
      [],
      {
        backups: [{ client: 'codex', dir: '~/.codex', count: 21 }],
        brokenLinks: [
          { client: 'deepseek', dir: '~/.dsh/x', broken: 3, total: 3 },
          { client: 'deepseek', dir: '~/.dsh/y', broken: 0, total: 5 },
        ],
      },
    )
    const ids = f.map((x) => x.id.split(':')[0])
    expect(ids.sort()).toEqual(['backups', 'links', 'orphan'])
    expect(f.find((x) => x.id.startsWith('backups'))?.title).toContain('21 резервная копия')
    expect(f.find((x) => x.id.startsWith('links'))?.severity).toBe('error')
    expect(f.find((x) => x.id.startsWith('orphan'))?.title).toContain('lonely')
  })

  it('скил в двух областях одного клиента — находка, в разных клиентах — нет', () => {
    const dup = diagnose(
      [
        ent({ kind: 'skill', logicalKey: 's', scope: 'user' }),
        ent({ kind: 'skill', logicalKey: 's', scope: 'builtin' }),
      ],
      [],
    )
    expect(dup.some((x) => x.id.startsWith('dup:'))).toBe(true)
    const apart = diagnose(
      [
        ent({ kind: 'skill', logicalKey: 's', client: 'codex' }),
        ent({ kind: 'skill', logicalKey: 's', client: 'antigravity' }),
      ],
      [],
    )
    expect(apart.some((x) => x.id.startsWith('dup:'))).toBe(false)
  })

  it('ключи секретов MCP упомянуты только по имени', () => {
    const f = diagnose([ent({ kind: 'mcp', name: 'srv', detail: { envKeys: ['API_KEY', 'LANG'] } })], [])
    expect(f).toHaveLength(1)
    expect(f[0]?.detail).toContain('API_KEY')
    expect(f[0]?.detail).not.toContain('LANG')
  })
})
