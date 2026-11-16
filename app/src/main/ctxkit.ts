import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../shared/i18n'
import type { CtxkitDoctor, CtxkitReport, CtxkitStatus, DayStats, DoctorFinding, FindingSeverity, SetupOptions, UninstallOptions } from '../shared/model'

/** Разбор настроек `setup` от страницы: только булевы флаги и перечисления, всё остальное — отказ. */
export function parseSetupOptions(raw: unknown): SetupOptions {
  const invalid = (): Error => new Error(t('неверные параметры ctxkit', 'invalid ctxkit parameters'))
  if (typeof raw !== 'object' || raw === null) throw invalid()
  const r = raw as Record<string, unknown>
  const flag = (k: string): boolean => {
    if (typeof r[k] !== 'boolean') throw invalid()
    return r[k] as boolean
  }
  const lang = r['lang']
  const advisor = r['advisor']
  if (lang !== 'en' && lang !== 'ru') throw new Error(t('неверный язык ctxkit', 'invalid ctxkit language'))
  if (advisor !== 'keep' && advisor !== 'fable' && advisor !== 'opus' && advisor !== 'none') throw new Error(t('неверный советник ctxkit', 'invalid ctxkit advisor'))
  const mainModel = r['mainModel']
  const effort = r['effort']
  if (mainModel !== 'keep' && mainModel !== 'sonnet' && mainModel !== 'opus' && mainModel !== 'haiku') throw new Error(t('неверная основная модель ctxkit', 'invalid ctxkit main model'))
  if (effort !== 'keep' && effort !== 'low' && effort !== 'medium' && effort !== 'high' && effort !== 'xhigh') throw new Error(t('неверный effort ctxkit', 'invalid ctxkit effort'))
  return { withRules: flag('withRules'), desktop: flag('desktop'), antigravity: flag('antigravity'), dsh: flag('dsh'), noStopGate: flag('noStopGate'), lang, advisor, mainModel, effort }
}

/** Разбор настроек отката от страницы: два булевых флага, остальное — отказ. */
export function parseUninstallOptions(raw: unknown): UninstallOptions {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  if (typeof r['antigravity'] !== 'boolean' || typeof r['dsh'] !== 'boolean') throw new Error(t('неверные параметры ctxkit', 'invalid ctxkit parameters'))
  return { antigravity: r['antigravity'], dsh: r['dsh'] }
}

/**
 * Аргументы `ctxkit setup`. `home` задан только в разработке и проверках (`LOADOUT_HOME`): тогда всё, что пишет ctxkit,
 * уходит в этот каталог, а не в настоящий профиль (ctxkit при `--profile` не копирует себя в `~/.local/bin`).
 */
export function setupArgs(o: SetupOptions, dryRun: boolean, home?: string): string[] {
  const a = ['setup']
  if (dryRun) a.push('--dry-run')
  if (o.withRules) a.push('--with-rules')
  if (o.desktop) a.push('--desktop')
  if (o.antigravity) a.push('--antigravity')
  if (o.dsh) a.push('--dsh')
  if (o.noStopGate) a.push('--no-stop-gate')
  a.push('--lang', o.lang)
  if (o.advisor !== 'keep') a.push('--advisor', o.advisor)
  if (o.mainModel !== 'keep') a.push('--main-model', o.mainModel)
  if (o.effort !== 'keep') a.push('--effort', o.effort)
  // версию claude ctxkit проверяет в самом конце, уже после записи, и зависший `claude` оставил бы окно с ошибкой при
  // изменённых файлах; предпросмотр проверку оставляет (она нужна диагностике)
  if (!dryRun) a.push('--skip-version-check')
  if (home) a.push(...homeArgs(home))
  return a
}

/**
 * Аргументы `ctxkit setup --uninstall`: только проверенные флаги, ни одного флага самого `setup` (ctxkit их отвергает).
 * Интеграции Antigravity и DSH ctxkit включает по самим флагам путей (`--agy-file`, `--dsh-home`), поэтому в разработке и проверках
 * пути передаются только вместе с галочкой, как в настоящем профиле. Пресеты Claude Desktop откат не трогает: флаг `--desktop` не нужен.
 */
export function uninstallArgs(o: UninstallOptions, dryRun: boolean, lang: 'en' | 'ru', home?: string): string[] {
  const a = ['setup', '--uninstall', '--lang', lang]
  if (dryRun) a.push('--dry-run')
  if (o.antigravity) a.push('--antigravity')
  if (o.dsh) a.push('--dsh')
  if (home) {
    a.push('--profile', join(home, '.claude'), '--claude-json', join(home, '.claude.json'))
    if (o.antigravity) a.push('--agy-file', join(home, '.gemini', 'config', 'hooks.json'))
    if (o.dsh) a.push('--dsh-home', join(home, '.dsh'))
  }
  return a
}

/** Пути, которые ctxkit иначе берёт из настоящего профиля пользователя. */
function homeArgs(home: string): string[] {
  return [
    '--profile', join(home, '.claude'),
    '--desktop-file', join(home, 'AppData', 'Roaming', 'Claude', 'ccd-session-presets.json'),
    '--agy-file', join(home, '.gemini', 'config', 'hooks.json'),
    '--dsh-home', join(home, '.dsh'),
    // для диагностики setup читает `~/.claude.json` (число глобальных MCP): без этого он читал бы настоящий файл
    '--claude-json', join(home, '.claude.json'),
  ]
}

export const profileArgs = (home?: string): string[] => (home ? ['--profile', join(home, '.claude')] : [])

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Запуск встроенного ctxkit: без оболочки, с таймаутом, окно не показывается. Ненулевой код — не исключение (`doctor` так сообщает об ошибках). */
export function run(bin: string, args: string[], timeoutMs: number, env?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const opts = { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 << 20, encoding: 'utf8' as const, ...(env ? { env: { ...process.env, ...env } } : {}) }
    execFile(bin, args, opts, (err, stdout, stderr) => {
      const isCtxkit = bin.toLowerCase().includes('ctxkit')
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (bin === 'git') return reject(new Error(t('git не найден в PATH: установите Git for Windows', 'git not found in PATH: install Git for Windows')))
        return reject(new Error(isCtxkit ? t('ctxkit не найден в составе приложения', 'ctxkit not found in the app bundle') : t('Claude Code CLI (`claude`) не найден в PATH', 'Claude Code CLI (`claude`) not found in PATH')))
      }
      const e = err as (Error & { code?: number | string; killed?: boolean }) | null
      if (e?.killed) return reject(new Error(isCtxkit ? t('ctxkit не ответила вовремя', 'ctxkit did not respond in time') : t('команда не ответила вовремя', 'the command did not respond in time')))
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout, stderr })
    })
  })
}

const sha = (p: string): string | undefined => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : undefined)

/** Копия ctxkit по пути: совпадает с встроенной побайтово, отличается или нет. Чужие копии не запускаются, только сравниваются. */
export function compareCopy(bundled: string, copy: string): 'same' | 'different' | 'missing' {
  const c = sha(copy)
  if (c === undefined) return 'missing'
  return c === sha(bundled) ? 'same' : 'different'
}

export async function status(bundled: string, hookCopy: string, binCopy: string): Promise<CtxkitStatus> {
  if (!existsSync(bundled)) return { available: false, version: null, hook: 'missing', bin: 'missing' }
  const v = await run(bundled, ['--version'], 5000).catch(() => undefined)
  const version = /\d+\.\d+\.\d+\S*/.exec(v?.stdout ?? '')?.[0] ?? null
  return { available: true, version, hook: compareCopy(bundled, hookCopy), bin: compareCopy(bundled, binCopy) }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const SEVERITIES: readonly string[] = ['ok', 'info', 'warn', 'error']

function parseJson(text: string, what: string): Record<string, unknown> {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new Error(t(`ctxkit вернул не JSON (${what})`, `ctxkit returned non-JSON output (${what})`))
  }
  // контракт ctxkit: `schema: 1`; другую версию не разбираем, а честно сообщаем
  if (!isObj(v) || v['tool'] !== 'ctxkit' || v['schema'] !== 1) throw new Error(t(`ctxkit ${what}: неподдерживаемая версия контракта (нужна schema 1)`, `ctxkit ${what}: unsupported contract version (schema 1 required)`))
  return v
}

/** `ctxkit doctor --json`: находки пересобираются по полям, лишнее отбрасывается. */
export function parseDoctor(text: string): CtxkitDoctor {
  const v = parseJson(text, 'doctor')
  const list = v['findings']
  if (!Array.isArray(list) || list.length > 200) throw new Error(t('ctxkit doctor: неожиданная форма', 'ctxkit doctor: unexpected shape'))
  const findings: DoctorFinding[] = list.map((f: unknown) => {
    if (!isObj(f) || typeof f['id'] !== 'string' || typeof f['message'] !== 'string' || typeof f['severity'] !== 'string' || !SEVERITIES.includes(f['severity'])) {
      throw new Error(t('ctxkit doctor: неожиданная находка', 'ctxkit doctor: unexpected finding'))
    }
    const s = (x: unknown): string | null => (typeof x === 'string' ? x.slice(0, 500) : null)
    return { id: f['id'].slice(0, 60), severity: f['severity'] as FindingSeverity, message: f['message'].slice(0, 300), detail: s(f['detail']), fix: s(f['fix']) }
  })
  return { findings, version: typeof v['version'] === 'string' ? v['version'].slice(0, 30) : '' }
}

/** `ctxkit report --json`: счётчики по дням. Ключи агентов, написанные моделью, режутся по длине и виду. */
export function parseReport(text: string): CtxkitReport {
  const v = parseJson(text, 'report')
  const days = v['days']
  if (!isObj(days) || Object.keys(days).length > 400) throw new Error(t('ctxkit report: неожиданная форма', 'ctxkit report: unexpected shape'))
  const out: Record<string, DayStats> = {}
  for (const [day, raw] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isObj(raw)) throw new Error(t('ctxkit report: неожиданный день', 'ctxkit report: unexpected day'))
    const mt = isObj(raw['main_turns']) ? raw['main_turns'] : {}
    const calls: Record<string, number> = {}
    if (isObj(raw['agent_calls'])) {
      for (const [k, n] of Object.entries(raw['agent_calls']).slice(0, 100)) if (/^[\w:.-]{1,60}$/.test(k)) calls[k] = num(n)
    }
    out[day] = {
      mainTurns: { sonnet: num(mt['sonnet']), haiku: num(mt['haiku']), opusFable: num(mt['opus_fable']), other: num(mt['other']) },
      subTurns: num(raw['sub_turns']),
      advisorCalls: num(raw['advisor_calls']),
      agentCalls: calls,
      toolResultChars: num(raw['tool_result_chars']),
      readChars: num(raw['read_chars']),
      readBlocked: num(raw['read_blocked']),
      shellInspectChars: num(raw['shell_inspect_chars']),
      buildChars: num(raw['build_chars']),
      checkCalls: num(raw['check_calls']),
      checkChars: num(raw['check_chars']),
    }
  }
  return { days: out }
}
