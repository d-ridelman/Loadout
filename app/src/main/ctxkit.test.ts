import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CtxkitReport } from '../shared/model'
import { summarize, segments, pct, chars } from '../renderer/ctxkit-stats'
import { BIN, OLD_BIN, parseDoctor, parseReport, parseSetupOptions, parseUninstallOptions, setupArgs, status, uninstallArgs } from './ctxkit'

const doctor = {
  tool: 'context-toolkit',
  schema: 1,
  version: '0.1.0',
  profile: 'C:\\Users\\x\\.claude',
  findings: [
    { id: 'hooks', severity: 'ok', message: 'хук установлен', detail: null, fix: null, extra: 'x' },
    { id: 'rules_block', severity: 'warn', message: 'блока правил нет', detail: null, fix: 'context-toolkit setup --with-rules' },
  ],
}

const day = {
  advisor_calls: 3,
  agent_calls: { checker: 2, 'bad name with spaces': 9 },
  build_chars: 1,
  check_calls: 5,
  check_chars: 400,
  main_turns: { haiku: 0, opus_fable: 10, other: 1, sonnet: 89 },
  read_blocked: 4,
  read_chars: 1000,
  shell_inspect_chars: 200,
  sub_turns: 50,
  tool_result_chars: 5000,
}

describe('ctxkit: setup parameters', () => {
  const ok = { withRules: true, desktop: false, antigravity: true, dsh: false, noStopGate: false, lang: 'ru', advisor: 'fable', mainModel: 'keep', effort: 'keep', policyMode: 'keep', commitHygiene: false, confirmIrreversible: false, strayFiles: false, buildSlots: false, buildSlotsN: 2 }

  it('policies: enums and the number 1-8 are checked strictly, user text never reaches the arguments', () => {
    for (const m of ['keep', 'on', 'off']) expect(parseSetupOptions({ ...ok, policyMode: m }).policyMode).toBe(m)
    for (const m of ['ON', 'none', '--policy x', '', undefined, true]) expect(() => parseSetupOptions({ ...ok, policyMode: m })).toThrow()
    for (const n of [1, 2, 8]) expect(parseSetupOptions({ ...ok, buildSlotsN: n }).buildSlotsN).toBe(n)
    for (const n of [0, 9, 2.5, -1, '2', '2,stray-files', NaN, Infinity, undefined, null]) expect(() => parseSetupOptions({ ...ok, buildSlotsN: n })).toThrow()
    for (const k of ['commitHygiene', 'confirmIrreversible', 'strayFiles', 'buildSlots']) {
      expect(() => parseSetupOptions({ ...ok, [k]: 'yes' })).toThrow()
      expect(() => parseSetupOptions({ ...ok, [k]: undefined })).toThrow()
    }
  })

  it('--policy: "leave unchanged" passes no flag; "enable selected" passes a list from a closed set; "disable all" and an empty selection give none', () => {
    const args = (o: object) => setupArgs(parseSetupOptions({ ...ok, ...o }), true)
    expect(args({})).not.toContain('--policy')
    // a selection made under "leave unchanged" is not sent
    expect(args({ commitHygiene: true, buildSlots: true })).not.toContain('--policy')
    const val = (o: object) => {
      const a = args(o)
      return a[a.indexOf('--policy') + 1]
    }
    expect(val({ policyMode: 'on', commitHygiene: true, confirmIrreversible: true, strayFiles: true, buildSlots: true, buildSlotsN: 3 })).toBe('commit-hygiene,confirm-irreversible,stray-files,build-slots=3')
    expect(val({ policyMode: 'on', strayFiles: true, buildSlots: true })).toBe('stray-files,build-slots=2')
    expect(val({ policyMode: 'on', commitHygiene: true })).toBe('commit-hygiene')
    expect(val({ policyMode: 'on' })).toBe('none')
    expect(val({ policyMode: 'off', commitHygiene: true })).toBe('none')
  })

  it('accepts only boolean flags and enums', () => {
    expect(parseSetupOptions(ok)).toEqual(ok)
    expect(() => parseSetupOptions({ ...ok, noStopGate: 'no' })).toThrow()
    expect(() => parseSetupOptions({ ...ok, noStopGate: undefined })).toThrow()
    expect(() => parseSetupOptions({ ...ok, lang: 'de' })).toThrow()
    expect(() => parseSetupOptions({ ...ok, advisor: '--hook-cmd evil.exe' })).toThrow()
    expect(parseSetupOptions({ ...ok, advisor: 'keep' }).advisor).toBe('keep')
    expect(() => parseSetupOptions({ ...ok, advisor: 'KEEP' })).toThrow()
    expect(() => parseSetupOptions({ ...ok, desktop: 'yes' })).toThrow()
    expect(() => parseSetupOptions(null)).toThrow()
    expect(() => parseSetupOptions({ ...ok, mainModel: undefined })).toThrow()
    for (const m of ['sonnet', 'opus', 'haiku']) expect(parseSetupOptions({ ...ok, mainModel: m }).mainModel).toBe(m)
    for (const m of ['fable', 'Sonnet', '--main-model x', '', 'none']) expect(() => parseSetupOptions({ ...ok, mainModel: m })).toThrow()
    for (const x of ['low', 'medium', 'high', 'xhigh']) expect(parseSetupOptions({ ...ok, effort: x }).effort).toBe(x)
    for (const x of ['max', 'HIGH', '--effort', '', undefined]) expect(() => parseSetupOptions({ ...ok, effort: x })).toThrow()
  })

  it('main model and effort: flags only on an explicit choice, "leave unchanged" passes nothing', () => {
    const a = setupArgs(parseSetupOptions({ ...ok, advisor: 'keep', mainModel: 'sonnet', effort: 'high' }), true)
    expect(a).toEqual(['setup', '--dry-run', '--with-rules', '--antigravity', '--lang', 'ru', '--main-model', 'sonnet', '--effort', 'high'])
    const keep = setupArgs(parseSetupOptions({ ...ok, advisor: 'keep' }), false)
    expect(keep.some((x) => ['--main-model', '--effort', '--advisor'].includes(x))).toBe(false)
    expect(setupArgs(parseSetupOptions({ ...ok, effort: 'xhigh' }), true)).toContain('xhigh')
  })

  it('arguments: preview with --dry-run, no page paths; in development the paths go to LOADOUT_HOME', () => {
    const a = setupArgs(parseSetupOptions(ok), true)
    expect(a).toEqual(['setup', '--dry-run', '--with-rules', '--antigravity', '--lang', 'ru', '--advisor', 'fable'])
    // "leave unchanged": --advisor is not passed at all, the rest as before
    expect(setupArgs(parseSetupOptions({ ...ok, advisor: 'keep' }), true)).toEqual(['setup', '--dry-run', '--with-rules', '--antigravity', '--lang', 'ru'])
    expect(setupArgs(parseSetupOptions(ok), false)).not.toContain('--dry-run')
    expect(setupArgs(parseSetupOptions({ ...ok, noStopGate: true }), true)).toContain('--no-stop-gate')
    expect(a).not.toContain('--no-stop-gate')
    const dev = setupArgs(parseSetupOptions(ok), false, 'C:/tmp/h')
    expect(dev).toContain('--profile')
    expect(dev.filter((x) => /C:[\\/]tmp[\\/]h/.test(x))).toHaveLength(5) // profile, Desktop presets, Antigravity hooks.json, DSH directory, .claude.json
    // no value from the page reaches the arguments as is, except enums
    expect(a.every((x) => x.startsWith('--') || ['setup', 'ru', 'fable'].includes(x))).toBe(true)
    expect(setupArgs(parseSetupOptions({ ...ok, policyMode: 'on', commitHygiene: true }), true).filter((x) => !x.startsWith('--'))).toEqual(['setup', 'ru', 'fable', 'commit-hygiene'])
  })
})

describe('ctxkit: rollback (setup --uninstall)', () => {
  it('accepts only two boolean flags', () => {
    expect(parseUninstallOptions({ antigravity: true, dsh: false })).toEqual({ antigravity: true, dsh: false })
    expect(parseUninstallOptions({ antigravity: false, dsh: false, withRules: true })).toEqual({ antigravity: false, dsh: false })
    for (const bad of [null, 'x', {}, { antigravity: 'yes', dsh: false }, { antigravity: true }, { antigravity: true, dsh: 1 }]) expect(() => parseUninstallOptions(bad)).toThrow()
  })

  it('arguments: no setup flags, integrations and paths only together with the checkbox', () => {
    expect(uninstallArgs({ antigravity: false, dsh: false }, true, 'ru')).toEqual(['setup', '--uninstall', '--lang', 'ru', '--dry-run'])
    expect(uninstallArgs({ antigravity: true, dsh: true }, false, 'en')).toEqual(['setup', '--uninstall', '--lang', 'en', '--antigravity', '--dsh'])
    const dev = uninstallArgs({ antigravity: true, dsh: false }, true, 'ru', 'C:/tmp/h')
    expect(dev).toContain('--agy-file')
    expect(dev).not.toContain('--dsh-home')
    expect(dev.filter((x) => /C:[\\/]tmp[\\/]h/.test(x))).toHaveLength(3) // profile, .claude.json, Antigravity hooks.json
    // with --uninstall ctxkit rejects setup flags
    const all = uninstallArgs({ antigravity: true, dsh: true }, false, 'ru', 'C:/tmp/h')
    for (const bad of ['--with-rules', '--desktop', '--no-stop-gate', '--advisor', '--main-model', '--effort', '--skip-version-check']) expect(all).not.toContain(bad)
  })
})

describe('ctxkit: response parsing', () => {
  it('doctor: extra fields are dropped, a foreign contract version is rejected', () => {
    const d = parseDoctor(JSON.stringify(doctor))
    expect(d.findings).toHaveLength(2)
    expect(d.findings[0]).toEqual({ id: 'hooks', severity: 'ok', message: 'хук установлен', detail: null, fix: null })
    expect(() => parseDoctor(JSON.stringify({ ...doctor, schema: 2 }))).toThrow('schema 1')
    expect(() => parseDoctor(JSON.stringify({ ...doctor, tool: 'other' }))).toThrow()
    // a binary of the old name (`tool: ctxkit`) speaks the same contract
    expect(parseDoctor(JSON.stringify({ ...doctor, tool: 'ctxkit' })).findings).toHaveLength(2)
    expect(() => parseDoctor('не json')).toThrow('не JSON')
    expect(() => parseDoctor(JSON.stringify({ ...doctor, findings: [{ id: 'x', severity: 'fatal', message: 'm' }] }))).toThrow()
  })

  it('report: per-day counters, agent keys are filtered, garbage does not break it', () => {
    const r = parseReport(JSON.stringify({ tool: 'context-toolkit', schema: 1, days: { '2026-11-15': day, '2026-11-14': { main_turns: 'x' } } }))
    expect(r.days['2026-11-15']?.mainTurns).toEqual({ sonnet: 89, haiku: 0, opusFable: 10, other: 1 })
    expect(r.days['2026-11-15']?.agentCalls).toEqual({ checker: 2 })
    expect(r.days['2026-11-14']?.mainTurns.sonnet).toBe(0)
    expect(() => parseReport(JSON.stringify({ tool: 'ctxkit', schema: 1, days: { 'вчера': day } }))).toThrow()
    expect(() => parseReport(JSON.stringify({ tool: 'ctxkit', schema: 1 }))).toThrow()
  })
})

describe('ctxkit: install state', () => {
  it('copies under the new name are compared with the bundled one, a copy under the old name in hooks marks a previous install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ctk-status-'))
    try {
      const hooks = join(root, 'hooks')
      const bin = join(root, 'bin')
      mkdirSync(hooks)
      mkdirSync(bin)
      const bundled = join(root, BIN)
      writeFileSync(bundled, 'x') // is not run: the version will be null, comparison is by bytes
      expect(await status(join(root, 'нет.exe'), hooks, bin)).toEqual({ available: false, version: null, hook: 'missing', bin: 'missing', legacy: false })
      writeFileSync(join(hooks, OLD_BIN), 'old')
      const old = await status(bundled, hooks, bin)
      expect([old.hook, old.bin, old.legacy]).toEqual(['missing', 'missing', true])
      writeFileSync(join(hooks, BIN), 'x')
      writeFileSync(join(bin, BIN), 'y')
      rmSync(join(hooks, OLD_BIN))
      const now = await status(bundled, hooks, bin)
      expect([now.hook, now.bin, now.legacy]).toEqual(['same', 'different', false])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ctxkit: efficiency totals', () => {
  const report: CtxkitReport = parseReport(JSON.stringify({ tool: 'ctxkit', schema: 1, days: { '2026-11-15': day, '2026-11-14': { ...day, main_turns: { haiku: 0, opus_fable: 100, other: 0, sonnet: 0 }, sub_turns: 0, advisor_calls: 1 } } }))

  it('shares and sums are computed from counters only', () => {
    const s = summarize(report)
    expect(s.days).toBe(2)
    expect(s.mainTurns).toBe(200)
    expect(s.cheapShare).toBeCloseTo(0.445)
    expect(s.expensiveShare).toBeCloseTo(0.55)
    expect(s.advisorCalls).toBe(4)
    expect(s.readBlocked).toBe(8)
    expect(s.agents[0]).toEqual(['checker', 4])
  })

  it('an empty report does not divide by zero', () => {
    const s = summarize({ days: {} })
    expect(s.cheapShare).toBeNull()
    expect(pct(s.cheapShare)).toBe('—')
  })

  it('bar segments sum to one and hide zero models', () => {
    const seg = segments(report.days['2026-11-15']!)
    expect(seg.map((x) => x.key)).toEqual(['sonnet', 'opusFable', 'other'])
    expect(seg.reduce((a, x) => a + x.w, 0)).toBeCloseTo(1)
    expect(segments({ ...report.days['2026-11-15']!, mainTurns: { sonnet: 0, haiku: 0, opusFable: 0, other: 0 } })).toEqual([])
  })

  it('sizes are human-readable', () => {
    expect(chars(999)).toBe('999')
    expect(chars(12_345)).toBe('12 К')
    expect(chars(1_234_567)).toBe('1,2 М')
  })
})
