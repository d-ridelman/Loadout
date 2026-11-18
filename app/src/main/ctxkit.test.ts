import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CtxkitReport } from '../shared/model'
import { summarize, segments, pct, chars } from '../renderer/ctxkit-stats'
import { clientNow, ctxClients } from '../renderer/ctxkit-clients'
import { setLang } from '../shared/i18n'
import { BIN, OLD_BIN, clientStates as states, doctorArgs, parseDoctor, parseReport, parseSetupOptions, parseUninstallOptions, runsOurBinary, setupArgs, status, uninstallArgs } from './ctxkit'

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
  const ok = { withRules: true, desktop: false, antigravity: true, dsh: false, codex: false, opencode: false, noStopGate: false, lang: 'ru', advisor: 'fable', mainModel: 'keep', effort: 'keep', policyMode: 'keep', commitHygiene: false, confirmIrreversible: false, strayFiles: false, buildSlots: false, buildSlotsN: 2 }

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
    expect(dev.filter((x) => /C:[\\/]tmp[\\/]h/.test(x))).toHaveLength(7) // profile, Desktop presets, Antigravity hooks.json, DSH, Codex and OpenCode directories, .claude.json
    expect(setupArgs(parseSetupOptions({ ...ok, codex: true }), true)).toContain('--codex')
    expect(setupArgs(parseSetupOptions({ ...ok, opencode: true }), true)).toContain('--opencode')
    expect(setupArgs(parseSetupOptions(ok), true)).not.toContain('--opencode')
    expect(() => parseSetupOptions({ ...ok, opencode: undefined })).toThrow()
    expect(() => parseSetupOptions({ ...ok, codex: 'yes' })).toThrow()
    expect(() => parseSetupOptions({ ...ok, codex: undefined })).toThrow()
    // no value from the page reaches the arguments as is, except enums
    expect(a.every((x) => x.startsWith('--') || ['setup', 'ru', 'fable'].includes(x))).toBe(true)
    expect(setupArgs(parseSetupOptions({ ...ok, policyMode: 'on', commitHygiene: true }), true).filter((x) => !x.startsWith('--'))).toEqual(['setup', 'ru', 'fable', 'commit-hygiene'])
  })
})

describe('ctxkit: rollback (setup --uninstall)', () => {
  it('accepts only four boolean flags', () => {
    expect(parseUninstallOptions({ antigravity: true, dsh: false, codex: true, opencode: true })).toEqual({ antigravity: true, dsh: false, codex: true, opencode: true })
    expect(parseUninstallOptions({ antigravity: false, dsh: false, codex: false, opencode: false, withRules: true })).toEqual({ antigravity: false, dsh: false, codex: false, opencode: false })
    for (const bad of [null, 'x', {}, { antigravity: 'yes', dsh: false, codex: false, opencode: false }, { antigravity: true }, { antigravity: true, dsh: 1, codex: false, opencode: false }, { antigravity: true, dsh: false }, { antigravity: true, dsh: false, codex: false }]) expect(() => parseUninstallOptions(bad)).toThrow()
  })

  it('arguments: no setup flags, integrations and paths only together with the checkbox', () => {
    const none = { antigravity: false, dsh: false, codex: false, opencode: false }
    expect(uninstallArgs(none, true, 'ru')).toEqual(['setup', '--uninstall', '--lang', 'ru', '--dry-run'])
    expect(uninstallArgs({ antigravity: true, dsh: true, codex: true, opencode: true }, false, 'en')).toEqual(['setup', '--uninstall', '--lang', 'en', '--antigravity', '--dsh', '--codex', '--opencode'])
    const dev = uninstallArgs({ ...none, antigravity: true }, true, 'ru', 'C:/tmp/h')
    expect(dev).toContain('--agy-file')
    expect(dev).not.toContain('--dsh-home')
    expect(dev).not.toContain('--opencode-home')
    expect(dev.filter((x) => /C:[\\/]tmp[\\/]h/.test(x))).toHaveLength(3) // profile, .claude.json, Antigravity hooks.json
    expect(uninstallArgs({ ...none, codex: true }, true, 'ru', 'C:/tmp/h')).toContain('--codex-home')
    expect(uninstallArgs({ ...none, opencode: true }, true, 'ru', 'C:/tmp/h')).toContain('--opencode-home')
    // doctor looks at the OpenCode of a test home only when told where it is
    expect(doctorArgs()).toEqual([])
    expect(doctorArgs('C:/tmp/h')).toContain('--opencode-home')
    // with --uninstall ctxkit rejects setup flags
    const all = uninstallArgs({ antigravity: true, dsh: true, codex: true, opencode: true }, false, 'ru', 'C:/tmp/h')
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
      expect(await status(join(root, 'нет.exe'), hooks, bin, root, join(root, '.codex'), join(root, 'oc'))).toMatchObject({ available: false, version: null, hook: 'missing', bin: 'missing', legacy: false })
      writeFileSync(join(hooks, OLD_BIN), 'old')
      const old = await status(bundled, hooks, bin, root, join(root, '.codex'), join(root, 'oc'))
      expect([old.hook, old.bin, old.legacy]).toEqual(['missing', 'missing', true])
      writeFileSync(join(hooks, BIN), 'x')
      writeFileSync(join(bin, BIN), 'y')
      rmSync(join(hooks, OLD_BIN))
      const now = await status(bundled, hooks, bin, root, join(root, '.codex'), join(root, 'oc'))
      expect([now.hook, now.bin, now.legacy]).toEqual(['same', 'different', false])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ctxkit: hooks by client', () => {
  it('our binary is the program of the command under either name, not a word somewhere in it', () => {
    for (const c of ['"C:/u/.claude/hooks/context-toolkit.exe" --codex', "& 'C:/u/.claude/hooks/context-toolkit.exe' --dsh", 'C:/x/ctxkit.exe --agy', '/home/u/.claude/hooks/context-toolkit']) expect(runsOurBinary(c)).toBe(true)
    for (const c of ['C:/tools/logger.exe ctxkit', 'node C:/tools/ctxkit-helper/stop.js', 'context-toolkit-x.exe', '']) expect(runsOurBinary(c)).toBe(false)
  })

  it('reads the files setup writes: on, off without our hooks, absent without the client folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'ctk-clients-'))
    const oc = join(home, '.config', 'opencode')
    const clientStates = (h: string, codex: string): ReturnType<typeof states> => states(h, codex, oc)
    try {
      expect(clientStates(home, join(home, '.codex'))).toEqual({ claude: 'absent', codex: 'absent', antigravity: 'absent', dsh: 'absent', opencode: 'absent' })
      for (const d of ['.claude', '.codex', '.gemini/config', '.dsh', '.config/opencode/plugins']) mkdirSync(join(home, d), { recursive: true })
      writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'C:/tools/logger.exe ctxkit' }] }] } }))
      writeFileSync(join(home, '.claude', 'settings.json'), '{ broken')
      expect(clientStates(home, join(home, '.codex'))).toEqual({ claude: 'off', codex: 'off', antigravity: 'off', dsh: 'off', opencode: 'off' })
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: '"C:/u/.claude/hooks/context-toolkit.exe"' }] }] } }))
      writeFileSync(join(home, '.codex', 'hooks.json'), `\uFEFF${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|apply_patch', hooks: [{ command: '"C:/u/.claude/hooks/context-toolkit.exe" --codex' }] }] } })}`)
      writeFileSync(join(home, '.gemini', 'config', 'hooks.json'), JSON.stringify({ 'context-toolkit': { PreToolUse: [] } }))
      writeFileSync(join(home, '.dsh', 'context-toolkit-hooks.json'), '{}')
      writeFileSync(join(oc, 'plugins', 'status.js'), 'export default {}')
      expect(clientStates(home, join(home, '.codex'))).toEqual({ claude: 'on', codex: 'on', antigravity: 'on', dsh: 'on', opencode: 'off' })
      mkdirSync(join(oc, 'plugins', 'loadout-context-toolkit'))
      writeFileSync(join(oc, 'plugins', 'loadout-context-toolkit', 'index.js'), '// Context Toolkit')
      expect(clientStates(home, join(home, '.codex')).opencode).toBe('on')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('ctxkit: the support table of the section', () => {
  it('names every client once, its checkbox is a setup flag, and both languages are filled in', () => {
    for (const l of ['ru', 'en'] as const) {
      setLang(l)
      const rows = ctxClients()
      expect(rows.map((r) => r.id).sort()).toEqual(['antigravity', 'claude', 'codex', 'dsh', 'opencode'])
      for (const r of rows) expect(r.name && r.gets).toBeTruthy()
      expect(rows.filter((r) => r.flag).map((r) => r.flag)).toEqual(['codex', 'antigravity', 'dsh', 'opencode'])
      // what is not supported or not checked live is said, not hidden
      expect(rows.find((r) => r.id === 'opencode')?.lacks).toContain('Stop')
      expect(rows.find((r) => r.id === 'codex')?.lacks).toContain('/hooks')
    }
    setLang('ru')
    const all = { claude: 'on', codex: 'on', antigravity: 'on', dsh: 'on', opencode: 'off' } as const
    expect(clientNow('opencode', all).text).toContain('не стоят')
    expect(clientNow('opencode', { ...all, opencode: 'on' }).text).toContain('плагин стоит')
    expect(clientNow('codex', undefined).text).toBe('…')
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
