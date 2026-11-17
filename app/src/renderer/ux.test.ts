import { afterEach, describe, expect, it } from 'vitest'
import type { CtxkitDoctor, Entity, SetupOptions } from '../shared/model'
import { count, fmtDateTime, fmtTime, setLang } from '../shared/i18n'
import { codeSpans } from './ui'
import { diagnose, groupFindings } from './doctor'
import { fixPatch, policySet, tickPolicy } from './ctxkit-stats'
import { matchesNow } from './views/Profiles'
import { hasMask, prefill } from './views/EditDialog'
import { skillAlerts } from './views/PlanDialog'
import { restoreUi } from './keep'

afterEach(() => setLang('ru'))

let n = 0
const ent = (over: Partial<Entity>): Entity => ({
  id: `u${n++}`,
  logicalKey: 'x',
  kind: 'plugin',
  client: 'claude-code',
  scope: 'user',
  name: 'x',
  state: 'on',
  origin: { file: '~/f', pointer: '/p' },
  detail: {},
  canToggle: true,
  canEdit: false,
  canCopy: false,
  ...over,
})

describe('counts and times: one format for the whole window', () => {
  it('Russian has three forms, English two', () => {
    expect([1, 2, 5, 11, 21, 22, 112].map((k) => count(k, ['запись', 'записи', 'записей'], ['entry', 'entries']))).toEqual([
      '1 запись', '2 записи', '5 записей', '11 записей', '21 запись', '22 записи', '112 записей',
    ])
    setLang('en')
    expect([0, 1, 2].map((k) => count(k, ['запись', 'записи', 'записей'], ['entry', 'entries']))).toEqual(['0 entries', '1 entry', '2 entries'])
  })

  it('time is 24-hour HH:MM in both languages; date and time are day-month-year', () => {
    const d = new Date(2026, 10, 7, 9, 5, 42)
    expect(fmtTime(d)).toBe('09:05')
    expect(fmtDateTime(d.getTime())).toBe('07.11.2026, 09:05')
    setLang('en')
    expect(fmtTime(d)).toBe('09:05')
    expect(fmtDateTime(d)).toBe('07/11/2026, 09:05')
  })
})

describe('text in backticks is shown as code', () => {
  it('pairs of backticks become code spans', () => {
    expect(codeSpans('run `claude plugin uninstall` then `x`.')).toEqual(['run ', { code: 'claude plugin uninstall' }, ' then ', { code: 'x' }, '.'])
  })
  it('no backticks, or an odd number of them, leaves the text alone', () => {
    expect(codeSpans('plain')).toEqual(['plain'])
    expect(codeSpans('a ` b `c` d')).toEqual(['a ` b `c` d'])
  })
})

describe('Doctor: every finding says how to fix it, grouped by severity', () => {
  it('each kind of finding carries a non-empty fix', () => {
    const list = diagnose(
      [
        ent({ kind: 'plugin', state: 'broken', name: 'ghost' }),
        ent({ kind: 'plugin', state: 'stale', name: 'dup' }),
        ent({ kind: 'plugin', state: 'unknown', name: 'p3' }),
        ent({ kind: 'marketplace', name: 'lonely' }),
        ent({ kind: 'mcp', logicalKey: 'gh', name: 'gh', scope: 'user', detail: { envKeys: ['GITHUB_TOKEN'] } }),
        ent({ kind: 'mcp', logicalKey: 'gh', name: 'gh', scope: 'project:~/w' }),
      ],
      ['config.toml: line 3: bad'],
      { backups: [{ client: 'codex', dir: '~/.codex', count: 3 }], brokenLinks: [{ client: 'deepseek', dir: '~/.dsh/node_modules', broken: 2, total: 2 }] },
    )
    expect(new Set(list.map((f) => f.id.split(':')[0]))).toEqual(new Set(['broken', 'stale', 'unknown', 'orphan', 'secret', 'dup', 'warn', 'backups', 'links']))
    for (const f of list) expect(f.fix.trim().length, f.id).toBeGreaterThan(10)
  })
  it('a count after «у» takes the genitive', () => {
    const title = (k: number) => diagnose(Array.from({ length: k }, (_, i) => ent({ state: 'unknown', name: `u${i}` })), [])[0]?.title
    expect([1, 2, 5].map(title)).toEqual([
      'Claude Code: у 1 плагина состояние не определено',
      'Claude Code: у 2 плагинов состояние не определено',
      'Claude Code: у 5 плагинов состояние не определено',
    ])
  })
  it('groups keep the severity order and drop empty groups', () => {
    const list = diagnose([ent({ state: 'broken', name: 'a' }), ent({ kind: 'marketplace', name: 'm' })], [])
    expect(groupFindings(list).map((g) => [g.severity, g.items.length])).toEqual([['error', 1], ['info', 1]])
    expect(groupFindings([])).toEqual([])
  })
})

const doc = (detail: string | null, severity: CtxkitDoctor['findings'][number]['severity'] = 'info'): CtxkitDoctor => ({
  version: '1',
  findings: detail === null ? [] : [{ id: 'policies', severity, message: 'policies', detail, fix: null }],
})
const base: SetupOptions = {
  withRules: true, desktop: false, antigravity: false, dsh: false, codex: false, noStopGate: false, lang: 'ru', advisor: 'keep', mainModel: 'keep', effort: 'keep',
  policyMode: 'keep', commitHygiene: false, confirmIrreversible: false, strayFiles: false, buildSlots: false, buildSlotsN: 2,
}

describe('Context Toolkit: policy checkboxes pick the mode themselves', () => {
  it('reads what is on now from the doctor', () => {
    expect(policySet(doc('commit_hygiene, build_slots=3'))).toEqual({ commitHygiene: true, confirmIrreversible: false, strayFiles: false, buildSlots: true, buildSlotsN: 3 })
    expect(policySet(doc(null))).toEqual({ commitHygiene: false, confirmIrreversible: false, strayFiles: false, buildSlots: false, buildSlotsN: 2 })
    expect(policySet(doc('bad json', 'warn'))).toBeNull()
    // Context Toolkit allows up to 64, the window up to 8: a larger limit is lowered, not sent on to be refused
    expect(policySet(doc('build_slots=16'))?.buildSlotsN).toBe(8)
  })
  it('a tick in "keep" mode switches to "on" and keeps the policies that are already on', () => {
    const now = policySet(doc('commit_hygiene, build_slots=3'))
    const o = tickPolicy(base, { strayFiles: true }, now)
    expect(o.policyMode).toBe('on')
    expect([o.commitHygiene, o.strayFiles, o.buildSlots, o.buildSlotsN, o.confirmIrreversible]).toEqual([true, true, true, 3, false])
  })
  it('in "on" mode a tick changes only that policy; from "off" it starts with nothing on', () => {
    const on = { ...base, policyMode: 'on' as const, commitHygiene: true }
    expect(tickPolicy(on, { commitHygiene: false }, null)).toEqual({ ...on, commitHygiene: false })
    const off = tickPolicy({ ...base, policyMode: 'off' }, { strayFiles: true }, policySet(doc('commit_hygiene')))
    expect([off.policyMode, off.commitHygiene, off.strayFiles]).toEqual(['on', false, true])
  })
  it('a doctor fix that is a setup command becomes form settings; anything else stays text', () => {
    expect(fixPatch('context-toolkit setup')).toEqual({})
    expect(fixPatch('context-toolkit setup --with-rules')).toEqual({ withRules: true })
    expect(fixPatch('context-toolkit setup --main-model sonnet')).toEqual({ mainModel: 'sonnet' })
    expect(fixPatch('context-toolkit setup --main-model <model> --effort <level>')).toBeNull()
    expect(fixPatch('fix the JSON or delete the file')).toBeNull()
    expect(fixPatch(null)).toBeNull()
  })
})

describe('Profiles: the one that matches the current state is marked', () => {
  const items = [
    { client: 'claude-code' as const, kind: 'plugin' as const, scope: 'user', name: 'a@m', enable: true },
    { client: 'codex' as const, kind: 'mcp' as const, scope: 'user', name: 'gh', enable: false },
  ]
  it('every entry exists and is in the profile state', () => {
    const list = [ent({ name: 'a@m', state: 'on' }), ent({ client: 'codex', kind: 'mcp', name: 'gh', state: 'off' })]
    expect(matchesNow({ name: 'p', items }, list)).toBe(true)
    expect(matchesNow({ name: 'p', items }, [list[0]!, ent({ client: 'codex', kind: 'mcp', name: 'gh', state: 'on' })])).toBe(false)
    expect(matchesNow({ name: 'p', items }, [list[0]!])).toBe(false)
    expect(matchesNow({ name: 'p', items: [] }, list)).toBe(false)
  })
  it('a version mismatch counts as on, an unknown state matches nothing', () => {
    expect(matchesNow({ name: 'p', items: [items[0]!] }, [ent({ name: 'a@m', state: 'stale' })])).toBe(true)
    expect(matchesNow({ name: 'p', items: [items[0]!] }, [ent({ name: 'a@m', state: 'unknown' })])).toBe(false)
  })
})

describe('"Edit command" starts from the current value, never from a mask', () => {
  it('fills the form only when the core says the values are exactly what the file holds', () => {
    expect(prefill(ent({ kind: 'mcp', detail: { command: 'npx', args: ['-y', 'pkg@1'], exact: true } }))).toEqual({ command: 'npx', args: '-y\npkg@1', partial: false })
    // a URL that lost its query has no mark in it: only the core's flag tells
    expect(prefill(ent({ kind: 'mcp', detail: { command: 'npx', args: ['mcp-remote', 'https://h/sse'], exact: false } }))).toEqual({ command: '', args: '', partial: true })
    expect(prefill(ent({ kind: 'mcp', detail: { command: 'node', args: ['a.js', '--token', '<masked>'] } }))).toEqual({ command: '', args: '', partial: true })
    expect(prefill(ent({ kind: 'mcp', detail: {} }))).toEqual({ command: '', args: '', partial: false })
  })
  it('an argument the one-per-line form cannot hold (empty, multi-line) leaves the form empty', () => {
    expect(prefill(ent({ kind: 'mcp', detail: { command: 'x', args: ['a', ''], exact: true } })).partial).toBe(true)
    expect(prefill(ent({ kind: 'mcp', detail: { command: 'x', args: ['a\nb'], exact: true } })).partial).toBe(true)
  })
  it('a typed mask is refused', () => {
    expect(hasMask('node', ['--key=<masked>'])).toBe(true)
    expect(hasMask('node', ['a.js'])).toBe(false)
  })
})

describe('skill preview: warnings are told apart from the summary and the file list', () => {
  it('the lines between the first and the last are the warnings', () => {
    expect(skillAlerts(['files: 3', 'SKILL.md runs commands', 'contains code files: run.ps1', 'SKILL.md, run.ps1'])).toEqual({
      alerts: ['SKILL.md runs commands', 'contains code files: run.ps1'],
      rest: ['files: 3', 'SKILL.md, run.ps1'],
    })
    expect(skillAlerts(['files: 1', 'SKILL.md'])).toEqual({ alerts: [], rest: ['files: 1', 'SKILL.md'] })
  })
})

describe('switching the language keeps the section, the selection and the filters', () => {
  it('restores what was kept and falls back to the matrix', () => {
    const sel = { rowKey: 'mcp:gh', client: 'codex' as const, id: null }
    const kept = { view: 'hooks' as const, sel, filters: { q: 'gh', group: 'mcp' as const, state: 'all' as const, hideUnknown: false, client: null } }
    expect(restoreUi(kept)).toEqual(kept)
    expect(restoreUi(undefined).view).toBe('matrix')
    expect(restoreUi(undefined).sel).toBeNull()
  })
})
