import { describe, expect, it } from 'vitest'
import type { Entity } from '../shared/model'
import { validateProjects, validateScan } from '../main/validate'
import { copyIntent } from './views/CopyDialog'
import { candidates, sources } from './views/TransferDialog'

const ent = (over: Partial<Entity>): Entity => ({
  id: 'x',
  logicalKey: 'x',
  kind: 'skill',
  client: 'claude-code',
  scope: 'user',
  name: 'x',
  state: 'on',
  origin: { file: '~/x', pointer: '' },
  detail: {},
  canToggle: false,
  canEdit: false,
  canCopy: true,
  ...over,
})

describe('copying between clients: the list of the transfer window', () => {
  const list = [
    ent({ id: 'a', name: 'b-skill' }),
    ent({ id: 'b', name: 'a-skill', copyWhy: { opencode: 'already read' } }),
    ent({ id: 'c', kind: 'mcp', name: 'srv' }),
    ent({ id: 'd', name: 'builtin', canCopy: false }),
    ent({ id: 'e', name: 'proj', scope: 'project:~/w/app', project: '0123456789abcdef' }),
    ent({ id: 'f', client: 'codex', name: 'cx' }),
  ]

  it('takes the source client’s copyable entries of the place, sorted, refused ones with their reason', () => {
    const rows = candidates(list, 'claude-code', 'opencode', false)
    expect(rows.map((r) => r.entity.id)).toEqual(['c', 'b', 'a'])
    expect(rows.find((r) => r.entity.id === 'b')?.why).toBe('already read')
    expect(rows.find((r) => r.entity.id === 'a')?.why).toBeUndefined()
    expect(candidates(list, 'claude-code', 'codex', true).map((r) => r.entity.id)).toEqual(['e'])
  })

  it('offers as sources only the clients with something to copy there', () => {
    expect(sources(list, false)).toEqual(['claude-code', 'codex'])
    expect(sources(list, true)).toEqual(['claude-code'])
  })

  it('a project entry carries its project id, a user one does not', () => {
    expect(copyIntent(list[4]!, 'codex')).toEqual({ op: 'copy', entity: 'e', to: 'codex', project: '0123456789abcdef' })
    expect(copyIntent(list[0]!, 'codex')).toEqual({ op: 'copy', entity: 'a', to: 'codex' })
  })
})

describe('copying between clients: what main lets through from the core', () => {
  const base = {
    id: 'i', logicalKey: 'k', name: 'n', scope: 'user', client: 'claude-code', kind: 'skill', state: 'on',
    origin: { file: '~/f', pointer: '' }, detail: {}, canToggle: false, canEdit: false,
  }
  const scan = (e: Record<string, unknown>) => validateScan({ entities: [{ ...base, ...e }], warnings: [], facts: { backups: [], brokenLinks: [] } }).entities[0]!

  it('keeps only known clients and short strings in copyWhy, and a well-formed project id', () => {
    const e = scan({ canCopy: true, copyWhy: { opencode: 'why', chrome: 'x', codex: 5 }, project: '0123456789abcdef' })
    expect(e.canCopy).toBe(true)
    expect(e.copyWhy).toEqual({ opencode: 'why' })
    expect(e.project).toBe('0123456789abcdef')
    const bad = scan({ canCopy: 'yes', project: 'C:/work' })
    expect(bad.canCopy).toBe(false)
    expect(bad.project).toBeUndefined()
  })

  it('the project list is rebuilt field by field and refuses a malformed id', () => {
    expect(validateProjects([{ id: '0123456789abcdef', path: '~/w/app', claude: true, codex: false, extra: 1 }])).toEqual([
      { id: '0123456789abcdef', path: '~/w/app', claude: true, codex: false },
    ])
    expect(() => validateProjects([{ id: '../x', path: '~', claude: true, codex: false }])).toThrow()
  })
})
