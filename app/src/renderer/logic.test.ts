import { describe, expect, it } from 'vitest'
import type { CtxkitDoctor, Entity, FindingSeverity } from '../shared/model'
import { policiesNow, stopGateOff } from './ctxkit-stats'
import { buildRows, clientStat, onlyUnknown, scopeRank } from './aggregate'
import { plural } from '../shared/i18n'
import { diagnose } from './doctor'
import { nameTaken } from './views/AddDialog'
import { withModifier } from './views/Matrix'

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

describe('"Add MCP" form', () => {
  it('a name the client already has (its own MCP of the user scope, the trash included) is taken before any plan', () => {
    const list = [
      ent({ kind: 'mcp', client: 'antigravity', name: 'tool-a' }),
      ent({ kind: 'mcp', client: 'codex', name: 'proj-only', scope: '~/work/p' }),
      ent({ kind: 'plugin', client: 'antigravity', name: 'plug' }),
      ent({ kind: 'mcp', client: 'antigravity', name: 'gone', state: 'off' }),
    ]
    expect(nameTaken(list, 'antigravity', 'tool-a')).toBe(true)
    expect(nameTaken(list, 'antigravity', 'gone')).toBe(true)
    expect(nameTaken(list, 'codex', 'tool-a')).toBe(false)
    expect(nameTaken(list, 'codex', 'proj-only')).toBe(false)
    expect(nameTaken(list, 'antigravity', 'plug')).toBe(false)
    expect(nameTaken(list, 'antigravity', 'Tool-A')).toBe(false)
  })
})

describe('single-key shortcuts', () => {
  it('a press with Ctrl, Meta or Alt is not a single-key shortcut (Ctrl+K must not move the selection)', () => {
    const k = (o: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }>) => withModifier({ ctrlKey: false, metaKey: false, altKey: false, ...o })
    expect(k({})).toBe(false)
    expect(k({ ctrlKey: true })).toBe(true)
    expect(k({ metaKey: true })).toBe(true)
    expect(k({ altKey: true })).toBe(true)
  })
})

describe('aggregate', () => {
  it('plugins and MCPs go to separate rows and groups, while one type with one name in different clients merges into a row', () => {
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

  it('the cell is determined by the user entry, not by dozens of project entries', () => {
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

  it('nine Codex hooks under one key give one row with nine instances', () => {
    const rows = buildRows(
      Array.from({ length: 9 }, (_, i) =>
        ent({ kind: 'hook', client: 'codex', logicalKey: 'orca-agent-hooks', name: `E${i}: codex-hook` }),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cells.codex?.instances).toHaveLength(9)
  })

  it('a scoped package name keeps its leading @, the marketplace suffix is dropped', () => {
    const rows = buildRows([
      ent({ logicalKey: '@deepseek-ai/dsh-x', name: '@deepseek-ai/dsh-x', client: 'deepseek' }),
      ent({ logicalKey: 'harnio', name: 'harnio@harnio' }),
    ])
    expect(rows.map((r) => r.name).sort()).toEqual(['@deepseek-ai/dsh-x', 'harnio'])
  })

  it('a row made only of "undetermined" is flagged', () => {
    const rows = buildRows([ent({ logicalKey: 'a', state: 'unknown', scope: 'project:~/x' })])
    expect(onlyUnknown(rows[0]!)).toBe(true)
    expect(scopeRank('user')).toBeLessThan(scopeRank('project:~/x'))
  })

  it('the OpenCode system config speaks for its cell; a Claude Code "managed" entry does not', () => {
    expect(scopeRank('managed', 'opencode')).toBeLessThan(scopeRank('user', 'opencode'))
    expect(scopeRank('managed', 'claude-code')).toBeGreaterThan(scopeRank('user', 'claude-code'))
    const rows = buildRows([
      ent({ logicalKey: 'srv', client: 'opencode', scope: 'user', state: 'on' }),
      ent({ logicalKey: 'srv', client: 'opencode', scope: 'managed', state: 'off' }),
    ])
    expect(rows[0]!.cells.opencode?.state).toBe('off')
  })
})

describe('Stop gate checkbox', () => {
  const doc = (...f: [string, FindingSeverity][]): CtxkitDoctor => ({
    version: '1',
    findings: f.map(([id, severity]) => ({ id, severity, message: id, detail: null, fix: null })),
  })
  it('taken from the stop_gate finding, but only when ctxkit is installed', () => {
    expect(stopGateOff(doc(['hooks', 'ok'], ['stop_gate', 'info']))).toBe(true)
    expect(stopGateOff(doc(['hooks', 'ok'], ['stop_gate', 'ok']))).toBe(false)
    expect(stopGateOff(doc(['hooks', 'error'], ['stop_gate', 'info']))).toBe(true)
    // clean profile: no hook, "no gate" is not a user choice, the default gate stays
    expect(stopGateOff(doc(['hooks', 'warn'], ['stop_gate', 'info']))).toBeNull()
    expect(stopGateOff(doc())).toBeNull()
  })
})

describe('"currently enabled" label in the "Protections" block', () => {
  const doc = (...f: [string, FindingSeverity, string | null][]): CtxkitDoctor => ({
    version: '1',
    findings: f.map(([id, severity, detail]) => ({ id, severity, message: `m-${id}`, detail, fix: null })),
  })
  it('with ctxkit.json the label comes from the policies finding; without the file it is null', () => {
    expect(policiesNow(doc())).toBeNull()
    expect(policiesNow(doc(['policies', 'info', 'commit_hygiene, build_slots=2']))).toEqual({ text: 'commit_hygiene, build_slots=2', broken: false })
    expect(policiesNow(doc(['policies', 'warn', 'x']))).toEqual({ text: 'm-policies', broken: true })
  })
})

describe('doctor', () => {
  it('broken and diverged come first, scanner warnings are kept', () => {
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

  it('two entries of one plugin with a divergence give one finding; number declension', () => {
    const f = diagnose([ent({ name: 'dup@mp', state: 'stale' }), ent({ name: 'dup@mp', state: 'stale' })], [])
    expect(f).toHaveLength(1)
    expect([1, 2, 5, 11, 21, 22].map((n) => plural(n, ['плагина', 'плагина', 'плагинов'], ['plugin', 'plugins']))).toEqual([
      'плагина', 'плагина', 'плагинов', 'плагинов', 'плагина', 'плагина',
    ])
  })

  it('core facts turn into findings: backups, broken links, a marketplace without plugins', () => {
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

  it('the fix for copies in several scopes promises disabling only when a copy can be toggled', () => {
    const fixOf = (list: Entity[]) => diagnose(list, []).find((x) => x.id.startsWith('dup:'))?.fix ?? ''
    const togglable = fixOf([
      ent({ kind: 'mcp', logicalKey: 'p', scope: 'user', canToggle: true }),
      ent({ kind: 'mcp', logicalKey: 'p', scope: 'project:~', canToggle: true }),
    ])
    expect(togglable).toContain('выключите')
    const builtin = fixOf([
      ent({ kind: 'skill', logicalKey: 's', client: 'codex', scope: 'user' }),
      ent({ kind: 'skill', logicalKey: 's', client: 'codex', scope: 'builtin' }),
    ])
    expect(builtin).not.toContain('выключите')
    expect(builtin).toContain('Встроенную копию')
    expect(builtin).toContain('user')
    const manual = fixOf([
      ent({ kind: 'skill', logicalKey: 'm', scope: 'user' }),
      ent({ kind: 'skill', logicalKey: 'm', scope: 'project:~/w' }),
    ])
    expect(manual).not.toContain('выключите')
    expect(manual).toContain('не переключает')
    const several = fixOf([
      ent({ kind: 'skill', logicalKey: 'v', scope: 'user' }),
      ent({ kind: 'skill', logicalKey: 'v', scope: 'project:~/w' }),
      ent({ kind: 'skill', logicalKey: 'v', scope: 'builtin' }),
    ])
    expect(several).toContain('ваши копии (user, project:~/w)')
    const part = fixOf([
      ent({ kind: 'mcp', logicalKey: 'q', scope: 'user', canToggle: true }),
      ent({ kind: 'mcp', logicalKey: 'q', scope: 'plugin:kit' }),
    ])
    expect(part).toContain('только копию из области: user')
    expect(part).toContain('правьте ту, что действует')
    expect(part).toContain('отключив плагин')
    const fromPlugin = fixOf([
      ent({ kind: 'skill', logicalKey: 'w', scope: 'plugin:kit' }),
      ent({ kind: 'skill', logicalKey: 'w', scope: 'builtin' }),
    ])
    expect(fromPlugin).not.toContain('удалите')
    expect(fromPlugin).toContain('отключите плагин')
    const twoPlugins = fixOf([
      ent({ kind: 'skill', logicalKey: 'z', client: 'antigravity', scope: 'plugin:a' }),
      ent({ kind: 'skill', logicalKey: 'z', client: 'antigravity', scope: 'plugin:b' }),
    ])
    expect(twoPlugins).not.toContain('удалите')
    expect(twoPlugins).not.toContain('Встроенную')
    expect(twoPlugins).toContain('плагины (a, b)')
  })

  it('a skill in two scopes of one client is a finding, in different clients it is not', () => {
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

  it('MCP secret keys are mentioned by name only', () => {
    const f = diagnose([ent({ kind: 'mcp', name: 'srv', detail: { envKeys: ['API_KEY', 'LANG'] } })], [])
    expect(f).toHaveLength(1)
    expect(f[0]?.what).toContain('API_KEY')
    expect(f[0]?.what).not.toContain('LANG')
  })

  it('every finding says separately what is wrong and why; the core note is the "what"', () => {
    const f = diagnose(
      [
        ent({ name: 'lost@mp', state: 'broken', note: 'installPath не существует на диске' }),
        ent({ kind: 'marketplace', name: 'lonely', logicalKey: 'lonely' }),
        ent({ kind: 'plugin', name: 'p@x', state: 'unknown', client: 'codex' }),
      ],
      ['~/x: не JSON'],
      { backups: [{ client: 'codex', dir: '~/.codex', count: 2 }], brokenLinks: [{ client: 'deepseek', dir: '~/.dsh/x', broken: 1, total: 2 }] },
    )
    expect(f.length).toBe(6)
    for (const x of f) {
      expect(x.what.length, x.id).toBeGreaterThan(0)
      expect(x.why.length, x.id).toBeGreaterThan(0)
      expect(x.why, x.id).not.toBe(x.what)
    }
    expect(f.find((x) => x.id.startsWith('broken'))?.what).toBe('installPath не существует на диске')
    expect(f.filter((x) => !x.client).map((x) => x.id)).toEqual(['warn:0'])
  })
})

describe('radar', () => {
  it('counts the matrix cells and the Doctor problems of a client, facts without an entry included', () => {
    const entities = [
      // one dsh plugin read from the user patch and a profile: one matrix cell, not two entries
      ent({ client: 'deepseek', logicalKey: 'dsh-x', scope: 'user' }),
      ent({ client: 'deepseek', logicalKey: 'dsh-x', scope: 'profile:default' }),
      ent({ client: 'codex', logicalKey: 'y', state: 'broken', note: 'нет' }),
    ]
    const rows = buildRows(entities)
    const findings = diagnose(entities, [], { backups: [], brokenLinks: [{ client: 'deepseek', dir: '~/.dsh/x', broken: 3, total: 3 }] })
    expect(clientStat(rows, findings, 'deepseek')).toEqual({ cells: 1, issues: 1, worst: 'error' })
    expect(clientStat(rows, findings, 'codex')).toEqual({ cells: 1, issues: 1, worst: 'error' })
    expect(clientStat(rows, findings, 'antigravity')).toEqual({ cells: 0, issues: 0, worst: null })
  })
})

describe('Codex connectors', () => {
  it('a cached app shows its manifest name, its id stays as the hint', () => {
    const rows = buildRows([
      ent({ kind: 'connector', client: 'codex', scope: 'cloud', name: 'app-69f0dc45', logicalKey: 'app-69f0dc45', detail: { displayName: 'GitHub' } }),
      ent({ kind: 'connector', client: 'codex', scope: 'cloud', name: 'app-0b1c2d3e', logicalKey: 'app-0b1c2d3e', detail: { displayName: null } }),
      ent({ kind: 'plugin', client: 'antigravity', name: 'p1', logicalKey: 'p1', detail: { displayName: 'Плагин один' } }),
    ])
    expect(rows.map((r) => [r.name, r.hint])).toEqual([
      ['p1', undefined],
      ['app-0b1c2d3e', undefined],
      ['GitHub', 'app-69f0dc45'],
    ])
  })

  it('the manifest name wins even when the config entry of the same app comes first', () => {
    const rows = buildRows([
      ent({ kind: 'connector', client: 'codex', scope: 'cloud', name: 'app-abc', logicalKey: 'app-abc' }),
      ent({ kind: 'connector', client: 'codex', scope: 'cloud', name: 'app-abc', logicalKey: 'app-abc', detail: { displayName: 'Linear' } }),
    ])
    expect(rows.map((r) => [r.name, r.hint])).toEqual([['Linear', 'app-abc']])
  })
})
