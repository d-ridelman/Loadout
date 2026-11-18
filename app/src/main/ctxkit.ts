import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../shared/i18n'
import { MAX_BUILD_SLOTS } from '../shared/model'
import type { CtxkitDoctor, CtxkitReport, CtxkitStatus, DayStats, DoctorFinding, FindingSeverity, SetupOptions, UninstallOptions } from '../shared/model'

/** Parses the `setup` options from the page: only boolean flags and enums, anything else is rejected. */
export function parseSetupOptions(raw: unknown): SetupOptions {
  const invalid = (): Error => new Error(t('неверные параметры Инструментов контекста', 'invalid Context Toolkit parameters'))
  if (typeof raw !== 'object' || raw === null) throw invalid()
  const r = raw as Record<string, unknown>
  const flag = (k: string): boolean => {
    if (typeof r[k] !== 'boolean') throw invalid()
    return r[k] as boolean
  }
  const lang = r['lang']
  const advisor = r['advisor']
  if (lang !== 'en' && lang !== 'ru') throw new Error(t('неверный язык Инструментов контекста', 'invalid Context Toolkit language'))
  if (advisor !== 'keep' && advisor !== 'fable' && advisor !== 'opus' && advisor !== 'none') throw new Error(t('неверный советник Инструментов контекста', 'invalid Context Toolkit advisor'))
  const mainModel = r['mainModel']
  const effort = r['effort']
  if (mainModel !== 'keep' && mainModel !== 'sonnet' && mainModel !== 'opus' && mainModel !== 'haiku') throw new Error(t('неверная основная модель Инструментов контекста', 'invalid Context Toolkit main model'))
  if (effort !== 'keep' && effort !== 'low' && effort !== 'medium' && effort !== 'high' && effort !== 'xhigh') throw new Error(t('неверный effort Инструментов контекста', 'invalid Context Toolkit effort'))
  const policyMode = r['policyMode']
  if (policyMode !== 'keep' && policyMode !== 'on' && policyMode !== 'off') throw new Error(t('неверный режим политик Инструментов контекста', 'invalid Context Toolkit policy mode'))
  const slots = r['buildSlotsN']
  if (typeof slots !== 'number' || !Number.isInteger(slots) || slots < 1 || slots > MAX_BUILD_SLOTS) throw new Error(t('неверный лимит сборок Инструментов контекста (1–8)', 'invalid Context Toolkit build limit (1–8)'))
  return {
    withRules: flag('withRules'),
    desktop: flag('desktop'),
    antigravity: flag('antigravity'),
    dsh: flag('dsh'),
    codex: flag('codex'),
    opencode: flag('opencode'),
    noStopGate: flag('noStopGate'),
    lang,
    advisor,
    mainModel,
    effort,
    policyMode,
    commitHygiene: flag('commitHygiene'),
    confirmIrreversible: flag('confirmIrreversible'),
    strayFiles: flag('strayFiles'),
    buildSlots: flag('buildSlots'),
    buildSlotsN: slots,
  }
}

/** Value of `--policy`: names from a closed list plus an integer, no free text from the user; `undefined` means the flag is not passed. */
export function policyArg(o: SetupOptions): string | undefined {
  if (o.policyMode === 'keep') return undefined
  if (o.policyMode === 'off') return 'none'
  const list = [o.commitHygiene && 'commit-hygiene', o.confirmIrreversible && 'confirm-irreversible', o.strayFiles && 'stray-files', o.buildSlots && `build-slots=${o.buildSlotsN}`].filter(Boolean)
  return list.length ? list.join(',') : 'none' // "enable the selected" with nothing selected is the same as "disable all"
}

/** Parses the rollback options from the page: four boolean flags, anything else is rejected. */
export function parseUninstallOptions(raw: unknown): UninstallOptions {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  if (typeof r['antigravity'] !== 'boolean' || typeof r['dsh'] !== 'boolean' || typeof r['codex'] !== 'boolean' || typeof r['opencode'] !== 'boolean') throw new Error(t('неверные параметры Инструментов контекста', 'invalid Context Toolkit parameters'))
  return { antigravity: r['antigravity'], dsh: r['dsh'], codex: r['codex'], opencode: r['opencode'] }
}

/**
 * Arguments for `context-toolkit setup`. `home` is set only in development and checks (`LOADOUT_HOME`): then everything
 * Context Toolkit writes goes to this directory instead of the real profile (with `--profile` it does not copy itself to `~/.local/bin`).
 */
export function setupArgs(o: SetupOptions, dryRun: boolean, home?: string): string[] {
  const a = ['setup']
  if (dryRun) a.push('--dry-run')
  if (o.withRules) a.push('--with-rules')
  if (o.desktop) a.push('--desktop')
  if (o.antigravity) a.push('--antigravity')
  if (o.dsh) a.push('--dsh')
  if (o.codex) a.push('--codex')
  if (o.opencode) a.push('--opencode')
  if (o.noStopGate) a.push('--no-stop-gate')
  a.push('--lang', o.lang)
  if (o.advisor !== 'keep') a.push('--advisor', o.advisor)
  if (o.mainModel !== 'keep') a.push('--main-model', o.mainModel)
  if (o.effort !== 'keep') a.push('--effort', o.effort)
  const policy = policyArg(o)
  if (policy) a.push('--policy', policy)
  // setup checks the claude version at the very end, after writing, and a hung `claude` would leave the window with an error
  // while the files are already changed; the preview keeps the check (diagnostics need it)
  if (!dryRun) a.push('--skip-version-check')
  if (home) a.push(...homeArgs(home))
  return a
}

/**
 * Arguments for `context-toolkit setup --uninstall`: only validated flags, none of the `setup` flags themselves (the rollback rejects them).
 * The rollback enables the Antigravity and DSH integrations by the path flags themselves (`--agy-file`, `--dsh-home`), so in development and checks
 * the paths are passed only together with the checkbox, as in a real profile. The rollback does not touch Claude Desktop presets: no `--desktop` flag is needed.
 */
export function uninstallArgs(o: UninstallOptions, dryRun: boolean, lang: 'en' | 'ru', home?: string): string[] {
  const a = ['setup', '--uninstall', '--lang', lang]
  if (dryRun) a.push('--dry-run')
  if (o.antigravity) a.push('--antigravity')
  if (o.dsh) a.push('--dsh')
  if (o.codex) a.push('--codex')
  if (o.opencode) a.push('--opencode')
  if (home) {
    a.push('--profile', join(home, '.claude'), '--claude-json', join(home, '.claude.json'))
    if (o.antigravity) a.push('--agy-file', join(home, '.gemini', 'config', 'hooks.json'))
    if (o.dsh) a.push('--dsh-home', join(home, '.dsh'))
    if (o.codex) a.push('--codex-home', join(home, '.codex'))
    if (o.opencode) a.push('--opencode-home', join(home, '.config', 'opencode'))
  }
  return a
}

/** Paths that Context Toolkit would otherwise take from the user's real profile. */
function homeArgs(home: string): string[] {
  return [
    '--profile', join(home, '.claude'),
    '--desktop-file', join(home, 'AppData', 'Roaming', 'Claude', 'ccd-session-presets.json'),
    '--agy-file', join(home, '.gemini', 'config', 'hooks.json'),
    '--dsh-home', join(home, '.dsh'),
    '--codex-home', join(home, '.codex'),
    '--opencode-home', join(home, '.config', 'opencode'),
    // for diagnostics setup reads `~/.claude.json` (the number of global MCPs): without this it would read the real file
    '--claude-json', join(home, '.claude.json'),
  ]
}

export const profileArgs = (home?: string): string[] => (home ? ['--profile', join(home, '.claude')] : [])
/** `doctor` with a test home also checks the OpenCode plugin there (with `--profile` alone it leaves OpenCode out). */
export const doctorArgs = (home?: string): string[] => (home ? [...profileArgs(home), '--opencode-home', join(home, '.config', 'opencode')] : [])

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs the bundled Context Toolkit: no shell, with a timeout, no window shown. A non-zero exit code is not an exception (`doctor` reports errors that way). */
export function run(bin: string, args: string[], timeoutMs: number, env?: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const opts = { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 << 20, encoding: 'utf8' as const, ...(env ? { env: { ...process.env, ...env } } : {}) }
    execFile(bin, args, opts, (err, stdout, stderr) => {
      const isCtxkit = /context-toolkit|ctxkit/i.test(bin)
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (bin === 'git') return reject(new Error(t('git не найден в PATH: установите Git for Windows', 'git not found in PATH: install Git for Windows')))
        return reject(new Error(isCtxkit ? t('Инструменты контекста не найдены в составе приложения', 'Context Toolkit not found in the app bundle') : t('Claude Code CLI (`claude`) не найден в PATH', 'Claude Code CLI (`claude`) not found in PATH')))
      }
      const e = err as (Error & { code?: number | string; killed?: boolean }) | null
      if (e?.killed) return reject(new Error(isCtxkit ? t('Инструменты контекста не ответили вовремя', 'Context Toolkit did not respond in time') : t('команда не ответила вовремя', 'the command did not respond in time')))
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout, stderr })
    })
  })
}

const sha = (p: string): string | undefined => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : undefined)

/** A binary copy at a path: byte-identical to the bundled one, different, or missing. Foreign copies are never run, only compared. */
export function compareCopy(bundled: string, copy: string): 'same' | 'different' | 'missing' {
  const c = sha(copy)
  if (c === undefined) return 'missing'
  return c === sha(bundled) ? 'same' : 'different'
}

export const BIN = 'context-toolkit.exe'
/** Binary name before the rename: its copy in `hooks/` marks an earlier install, which "Apply" migrates to the new name. */
export const OLD_BIN = 'ctxkit.exe'

/** Install state: copies in `hooksDir` (called by the hooks) and `binDir` (PATH), a copy under the old name in `hooksDir`, and the clients. */
export async function status(bundled: string, hooksDir: string, binDir: string, home: string, codexHome: string, opencodeDir: string): Promise<CtxkitStatus> {
  const legacy = existsSync(join(hooksDir, OLD_BIN))
  const clients = clientStates(home, codexHome, opencodeDir)
  if (!existsSync(bundled)) return { available: false, version: null, hook: 'missing', bin: 'missing', legacy, clients }
  const v = await run(bundled, ['--version'], 5000).catch(() => undefined)
  const version = /\d+\.\d+\.\d+\S*/.exec(v?.stdout ?? '')?.[0] ?? null
  return { available: true, version, hook: compareCopy(bundled, join(hooksDir, BIN)), bin: compareCopy(bundled, join(binDir, BIN)), legacy, clients }
}

/** A hook command whose program (the first word, after a PowerShell `& `) is our binary under either name, as `our_name` in setup.rs. */
export const runsOurBinary = (cmd: string): boolean => {
  const first = /^\s*(?:&\s*)?(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(cmd)
  const word = first?.[1] ?? first?.[2] ?? first?.[3] ?? ''
  return /^(context-toolkit|ctxkit)(\.exe)?$/i.test(word.split(/[\\/]/).pop() ?? '')
}

const readJson = (p: string): unknown => {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''))
  } catch {
    return undefined
  }
}

/** Commands of a Claude-shaped `hooks` object (`{event: [{hooks: [{command}]}]}`); anything else gives none. */
function hookCommands(hooks: unknown): string[] {
  if (!isObj(hooks)) return []
  return Object.values(hooks).flatMap((groups) =>
    (Array.isArray(groups) ? groups : []).flatMap((g: unknown) => (isObj(g) && Array.isArray(g['hooks']) ? g['hooks'] : []).map((h: unknown) => (isObj(h) && typeof h['command'] === 'string' ? h['command'] : ''))),
  )
}

/**
 * Where our hooks are, read from the files `setup` writes (nothing is run). A client is `absent` when its home folder is missing;
 * OpenCode is `on` while the plugin of `setup --opencode` is in its config folder (`doctor` says whether it is the current one).
 */
export function clientStates(home: string, codexHome: string, opencodeDir: string): CtxkitStatus['clients'] {
  const ours = (cmds: string[]): boolean => cmds.some(runsOurBinary)
  const state = (dir: string, on: () => boolean): 'on' | 'off' | 'absent' => (!existsSync(dir) ? 'absent' : on() ? 'on' : 'off')
  const settings = readJson(join(home, '.claude', 'settings.json'))
  const agy = readJson(join(home, '.gemini', 'config', 'hooks.json'))
  const codex = readJson(join(codexHome, 'hooks.json'))
  return {
    claude: state(join(home, '.claude'), () => ours(hookCommands(isObj(settings) ? settings['hooks'] : undefined))),
    codex: state(codexHome, () => ours(hookCommands(isObj(codex) ? codex['hooks'] : undefined))),
    antigravity: state(join(home, '.gemini'), () => isObj(agy) && Object.keys(agy).some((k) => k === 'context-toolkit' || k === 'ctxkit')),
    dsh: state(join(home, '.dsh'), () => ['context-toolkit-hooks.json', 'ctxkit-hooks.json'].some((f) => existsSync(join(home, '.dsh', f)))),
    opencode: state(opencodeDir, () => existsSync(join(opencodeDir, 'plugins', 'loadout-context-toolkit', 'index.js'))),
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const SEVERITIES: readonly string[] = ['ok', 'info', 'warn', 'error']

function parseJson(text: string, what: string): Record<string, unknown> {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new Error(t(`Инструменты контекста вернули не JSON (${what})`, `Context Toolkit returned non-JSON output (${what})`))
  }
  // contract: `schema: 1`, `tool` is the binary name (it was `ctxkit` before the rename); another version is not parsed, we report it honestly
  if (!isObj(v) || (v['tool'] !== 'context-toolkit' && v['tool'] !== 'ctxkit') || v['schema'] !== 1) {
    throw new Error(t(`context-toolkit ${what}: неподдерживаемая версия контракта (нужна schema 1)`, `context-toolkit ${what}: unsupported contract version (schema 1 required)`))
  }
  return v
}

/** `context-toolkit doctor --json`: findings are rebuilt field by field, anything extra is dropped. */
export function parseDoctor(text: string): CtxkitDoctor {
  const v = parseJson(text, 'doctor')
  const list = v['findings']
  if (!Array.isArray(list) || list.length > 200) throw new Error(t('context-toolkit doctor: неожиданная форма', 'context-toolkit doctor: unexpected shape'))
  const findings: DoctorFinding[] = list.map((f: unknown) => {
    if (!isObj(f) || typeof f['id'] !== 'string' || typeof f['message'] !== 'string' || typeof f['severity'] !== 'string' || !SEVERITIES.includes(f['severity'])) {
      throw new Error(t('context-toolkit doctor: неожиданная находка', 'context-toolkit doctor: unexpected finding'))
    }
    const s = (x: unknown): string | null => (typeof x === 'string' ? x.slice(0, 500) : null)
    return { id: f['id'].slice(0, 60), severity: f['severity'] as FindingSeverity, message: f['message'].slice(0, 300), detail: s(f['detail']), fix: s(f['fix']) }
  })
  return { findings, version: typeof v['version'] === 'string' ? v['version'].slice(0, 30) : '' }
}

/** `context-toolkit report --json`: per-day counters. Agent keys written by the model are limited by length and shape. */
export function parseReport(text: string): CtxkitReport {
  const v = parseJson(text, 'report')
  const days = v['days']
  if (!isObj(days) || Object.keys(days).length > 400) throw new Error(t('context-toolkit report: неожиданная форма', 'context-toolkit report: unexpected shape'))
  const out: Record<string, DayStats> = {}
  for (const [day, raw] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isObj(raw)) throw new Error(t('context-toolkit report: неожиданный день', 'context-toolkit report: unexpected day'))
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
