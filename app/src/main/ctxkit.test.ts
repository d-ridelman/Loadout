import { describe, expect, it } from 'vitest'
import type { CtxkitReport } from '../shared/model'
import { summarize, segments, pct, chars } from '../renderer/ctxkit-stats'
import { parseDoctor, parseReport, parseSetupOptions, parseUninstallOptions, setupArgs, uninstallArgs } from './ctxkit'

const doctor = {
  tool: 'ctxkit',
  schema: 1,
  version: '0.1.0',
  profile: 'C:\\Users\\x\\.claude',
  findings: [
    { id: 'hooks', severity: 'ok', message: 'хук установлен', detail: null, fix: null, extra: 'x' },
    { id: 'rules_block', severity: 'warn', message: 'блока правил нет', detail: null, fix: 'ctxkit setup --with-rules' },
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

describe('ctxkit: параметры setup', () => {
  const ok = { withRules: true, desktop: false, antigravity: true, dsh: false, noStopGate: false, lang: 'ru', advisor: 'fable', mainModel: 'keep', effort: 'keep' }

  it('принимает только булевы флаги и перечисления', () => {
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

  it('основная модель и effort: флаги только по явному выбору, «не менять» ничего не передаёт', () => {
    const a = setupArgs(parseSetupOptions({ ...ok, advisor: 'keep', mainModel: 'sonnet', effort: 'high' }), true)
    expect(a).toEqual(['setup', '--dry-run', '--with-rules', '--antigravity', '--lang', 'ru', '--main-model', 'sonnet', '--effort', 'high'])
    const keep = setupArgs(parseSetupOptions({ ...ok, advisor: 'keep' }), false)
    expect(keep.some((x) => ['--main-model', '--effort', '--advisor'].includes(x))).toBe(false)
    expect(setupArgs(parseSetupOptions({ ...ok, effort: 'xhigh' }), true)).toContain('xhigh')
  })

  it('аргументы: предпросмотр с --dry-run, без путей страницы; в разработке пути уходят в LOADOUT_HOME', () => {
    const a = setupArgs(parseSetupOptions(ok), true)
    expect(a).toEqual(['setup', '--dry-run', '--with-rules', '--antigravity', '--lang', 'ru', '--advisor', 'fable'])
    // «не менять»: --advisor не передаётся вовсе, остальное как было
    expect(setupArgs(parseSetupOptions({ ...ok, advisor: 'keep' }), true)).toEqual(['setup', '--dry-run', '--with-rules', '--antigravity', '--lang', 'ru'])
    expect(setupArgs(parseSetupOptions(ok), false)).not.toContain('--dry-run')
    expect(setupArgs(parseSetupOptions({ ...ok, noStopGate: true }), true)).toContain('--no-stop-gate')
    expect(a).not.toContain('--no-stop-gate')
    const dev = setupArgs(parseSetupOptions(ok), false, 'C:/tmp/h')
    expect(dev).toContain('--profile')
    expect(dev.filter((x) => /C:[\\/]tmp[\\/]h/.test(x))).toHaveLength(5) // профиль, пресеты Desktop, hooks.json Antigravity, каталог DSH, .claude.json
    // ни одного значения из страницы не попадает в аргументы как есть, кроме перечислений
    expect(a.every((x) => x.startsWith('--') || ['setup', 'ru', 'fable'].includes(x))).toBe(true)
  })
})

describe('ctxkit: откат (setup --uninstall)', () => {
  it('принимает только два булевых флага', () => {
    expect(parseUninstallOptions({ antigravity: true, dsh: false })).toEqual({ antigravity: true, dsh: false })
    expect(parseUninstallOptions({ antigravity: false, dsh: false, withRules: true })).toEqual({ antigravity: false, dsh: false })
    for (const bad of [null, 'x', {}, { antigravity: 'yes', dsh: false }, { antigravity: true }, { antigravity: true, dsh: 1 }]) expect(() => parseUninstallOptions(bad)).toThrow()
  })

  it('аргументы: ни одного флага setup, интеграции и пути только вместе с галочкой', () => {
    expect(uninstallArgs({ antigravity: false, dsh: false }, true, 'ru')).toEqual(['setup', '--uninstall', '--lang', 'ru', '--dry-run'])
    expect(uninstallArgs({ antigravity: true, dsh: true }, false, 'en')).toEqual(['setup', '--uninstall', '--lang', 'en', '--antigravity', '--dsh'])
    const dev = uninstallArgs({ antigravity: true, dsh: false }, true, 'ru', 'C:/tmp/h')
    expect(dev).toContain('--agy-file')
    expect(dev).not.toContain('--dsh-home')
    expect(dev.filter((x) => /C:[\\/]tmp[\\/]h/.test(x))).toHaveLength(3) // профиль, .claude.json, hooks.json Antigravity
    // с --uninstall ctxkit отвергает флаги setup
    const all = uninstallArgs({ antigravity: true, dsh: true }, false, 'ru', 'C:/tmp/h')
    for (const bad of ['--with-rules', '--desktop', '--no-stop-gate', '--advisor', '--main-model', '--effort', '--skip-version-check']) expect(all).not.toContain(bad)
  })
})

describe('ctxkit: разбор ответов', () => {
  it('doctor: лишние поля отбрасываются, чужая версия контракта отвергается', () => {
    const d = parseDoctor(JSON.stringify(doctor))
    expect(d.findings).toHaveLength(2)
    expect(d.findings[0]).toEqual({ id: 'hooks', severity: 'ok', message: 'хук установлен', detail: null, fix: null })
    expect(() => parseDoctor(JSON.stringify({ ...doctor, schema: 2 }))).toThrow('schema 1')
    expect(() => parseDoctor(JSON.stringify({ ...doctor, tool: 'other' }))).toThrow()
    expect(() => parseDoctor('не json')).toThrow('не JSON')
    expect(() => parseDoctor(JSON.stringify({ ...doctor, findings: [{ id: 'x', severity: 'fatal', message: 'm' }] }))).toThrow()
  })

  it('report: счётчики по дням, ключи агентов фильтруются, мусор не ломает', () => {
    const r = parseReport(JSON.stringify({ tool: 'ctxkit', schema: 1, days: { '2026-11-15': day, '2026-11-14': { main_turns: 'x' } } }))
    expect(r.days['2026-11-15']?.mainTurns).toEqual({ sonnet: 89, haiku: 0, opusFable: 10, other: 1 })
    expect(r.days['2026-11-15']?.agentCalls).toEqual({ checker: 2 })
    expect(r.days['2026-11-14']?.mainTurns.sonnet).toBe(0)
    expect(() => parseReport(JSON.stringify({ tool: 'ctxkit', schema: 1, days: { 'вчера': day } }))).toThrow()
    expect(() => parseReport(JSON.stringify({ tool: 'ctxkit', schema: 1 }))).toThrow()
  })
})

describe('ctxkit: итоги эффективности', () => {
  const report: CtxkitReport = parseReport(JSON.stringify({ tool: 'ctxkit', schema: 1, days: { '2026-11-15': day, '2026-11-14': { ...day, main_turns: { haiku: 0, opus_fable: 100, other: 0, sonnet: 0 }, sub_turns: 0, advisor_calls: 1 } } }))

  it('доли и суммы считаются только по счётчикам', () => {
    const s = summarize(report)
    expect(s.days).toBe(2)
    expect(s.mainTurns).toBe(200)
    expect(s.cheapShare).toBeCloseTo(0.445)
    expect(s.expensiveShare).toBeCloseTo(0.55)
    expect(s.advisorCalls).toBe(4)
    expect(s.readBlocked).toBe(8)
    expect(s.agents[0]).toEqual(['checker', 4])
  })

  it('пустой отчёт не делит на ноль', () => {
    const s = summarize({ days: {} })
    expect(s.cheapShare).toBeNull()
    expect(pct(s.cheapShare)).toBe('—')
  })

  it('сегменты столбика дают в сумме единицу и скрывают нулевые модели', () => {
    const seg = segments(report.days['2026-11-15']!)
    expect(seg.map((x) => x.key)).toEqual(['sonnet', 'opusFable', 'other'])
    expect(seg.reduce((a, x) => a + x.w, 0)).toBeCloseTo(1)
    expect(segments({ ...report.days['2026-11-15']!, mainTurns: { sonnet: 0, haiku: 0, opusFable: 0, other: 0 } })).toEqual([])
  })

  it('объём читается человеком', () => {
    expect(chars(999)).toBe('999')
    expect(chars(12_345)).toBe('12 К')
    expect(chars(1_234_567)).toBe('1,2 М')
  })
})
