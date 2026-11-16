// Check of the packaged build (`npm run pack`, then `node e2e/pack-check.mjs`): launches dist/win-unpacked/Loadout.exe
// on its own profile (`--user-data-dir`, not %APPDATA%\Loadout), connects over CDP, the core is taken from resources, the LOADOUT_*
// variables are ignored, idle memory and CPU are measured. Reads the real configs (read-only, level R0).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(appDir, '..')
// `PACK_DIR` is the directory of an installed copy (a check after a silent install), by default the unpacked build
const unpacked = process.env.PACK_DIR ?? join(appDir, 'dist', 'win-unpacked')
// the directory goes into a PowerShell command: only a plain Windows path without quotes or special characters
if (!/^[A-Za-z]:[\\/][\w .\\/()-]+$/.test(unpacked)) {
  console.error('FAILED: PACK_DIR contains invalid characters')
  process.exit(1)
}
const exe = join(unpacked, 'Loadout.exe')
const profile = join(repo, 'state', 'loadout-qa-pack')
const port = 9341
const IDLE_MS = 10_000

const must = (c, m) => {
  if (!c) throw new Error(m)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Build processes: Loadout.exe (shell, GPU, renderer) and the core from resources. */
function procs() {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      // by both the build path and our own profile: a real Loadout running for the owner under the same directory is not touched
      `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${unpacked.replaceAll('/', '\\')}\\*' -and $_.CommandLine -like '*loadout-qa-pack*' } | Select-Object ProcessId, Name, CommandLine, WorkingSetSize, PrivatePageCount, KernelModeTime, UserModeTime | ConvertTo-Json -Compress`,
    ],
    { encoding: 'utf8' },
  ).trim()
  if (!out) return []
  const v = JSON.parse(out)
  return Array.isArray(v) ? v : [v]
}

let child
let browser
try {
  must(existsSync(exe), `${exe} not found: run npm run pack`)
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })
  // LOADOUT_* and APP_QA must be ignored in the packaged build: the core and the home are not taken from there
  child = spawn(exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
    env: { ...process.env, LOADOUT_HOME: join(repo, 'state', 'no-such-home'), LOADOUT_BIN: 'C:/no/such/loadout.exe', APP_QA: '1', LOADOUT_USER_DATA: join(repo, 'state', 'no-such-profile') },
    stdio: 'ignore',
  })
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false)
    if (!up) await sleep(300)
  }
  must(up, 'the packaged app did not open the debugging port')
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes('index.html')) ?? (await browser.contexts()[0].waitForEvent('page'))
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  // move the window off-screen right away: there is no need to show it to the owner
  await page.evaluate(() => window.moveTo(-6000, 0)).catch(() => {})

  await page.waitForSelector('#grid', { timeout: 30_000 })
  must((await page.title()) === 'Loadout', 'the window title is not Loadout')
  const rows = await page.locator('tbody tr').count()
  console.log('rows in the matrix (real configs):', rows)
  must(rows > 10, 'too few rows in the matrix: the core was not found in resources or LOADOUT_HOME was accepted')
  must((await page.getByLabel('Уровень записи').inputValue()) === 'R0', 'the default write level must be R0')
  must((await page.locator('#scanlines').count()) === 0, 'scanlines are left in the build')

  // the built-in Context Toolkit from resources: version, diagnostics and a report on the real transcripts (read-only, nothing is applied)
  must(existsSync(join(unpacked, 'resources', 'context-toolkit.exe')), 'the build has no resources/context-toolkit.exe')
  await page.keyboard.press('7')
  await page.getByText('context-toolkit 0.', { exact: false }).first().waitFor({ timeout: 20_000 })
  await page.locator('ul[aria-label="Находки диагностики"] li').first().waitFor({ timeout: 30_000 })
  await page.locator('table[aria-label="Ходы по дням"] tbody tr').first().waitFor({ timeout: 120_000 })
  const ctxText = await page.locator('main').innerText()
  console.log('context-toolkit in the build:', /context-toolkit \d+\.\d+\.\d+/.exec(ctxText)?.[0], '| diagnostic findings:', await page.locator('ul[aria-label="Находки диагностики"] li').count(), '| days in the report:', await page.locator('table[aria-label="Ходы по дням"] tbody tr').count())
  // what this machine will show about the installed copies (compared byte by byte with the built-in one)
  for (const line of ctxText.split('\n').filter((l) => /(context-toolkit|ctxkit)\.exe:/.test(l))) console.log('  ', line.trim())
  must(!/не удалось|не найден|неподдерживаемая/.test(ctxText), 'error in the Context Toolkit section')
  await page.keyboard.press('1')

  const ps = procs()
  const core = ps.filter((p) => p.Name.toLowerCase() === 'loadout.exe' && /serve/.test(p.CommandLine ?? ''))
  must(core.length === 1, `there must be exactly one core from resources, found: ${core.length}`)
  must(/--backups/.test(core[0].CommandLine) && core[0].CommandLine.includes('loadout-qa-pack'), 'the core was started without the backups directory in the build profile')
  must(!/--home/.test(core[0].CommandLine), 'the core got --home from the environment: LOADOUT_HOME must be ignored')

  // idle: memory and CPU of the build processes, with full effects and with effects off
  const idle = async (label) => {
    await sleep(8_000)
    const a = procs()
    await sleep(IDLE_MS)
    const b = procs()
    const t = (p) => Number(p.KernelModeTime) + Number(p.UserModeTime)
    const total = b.reduce((s, p) => s + t(p), 0) - a.reduce((s, p) => s + t(p), 0)
    const ws = b.reduce((s, p) => s + Number(p.WorkingSetSize), 0) / 1048576
    const priv = b.reduce((s, p) => s + Number(p.PrivatePageCount), 0) / 1048576
    console.log(`${label}: processes ${b.length}, working set ${ws.toFixed(0)} MB (shared pages are counted in every process), private memory ${priv.toFixed(0)} MB, CPU over ${IDLE_MS / 1000} s: ${(total / 10_000).toFixed(0)} ms`)
    for (const p of b) {
      const before = a.find((x) => x.ProcessId === p.ProcessId)
      const type = /--type=([a-z-]+)/.exec(p.CommandLine ?? '')?.[1] ?? (p.Name === 'loadout.exe' ? 'core' : 'main')
      console.log(`   ${type.padEnd(10)} ${(Number(p.WorkingSetSize) / 1048576).toFixed(0).padStart(4)} MB  ${before ? ((t(p) - t(before)) / 10_000).toFixed(0) : '?'} ms`)
    }
    return total / 10_000
  }
  await idle('FX full')
  await page.evaluate(() => { document.documentElement.dataset.fx = 'off' })
  await idle('FX off')
  console.log('page errors:', errors.length)
  must(errors.length === 0, `page errors: ${errors.join(' | ')}`)
  console.log('OK: the packaged build works')
} catch (e) {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  if (child?.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already closed */
    }
  }
  await sleep(1500)
  const left = procs()
  console.log('remaining build processes:', left.length)
  for (const p of left) {
    try {
      execFileSync('taskkill', ['/PID', String(p.ProcessId), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already closed */
    }
  }
  if (left.length) process.exitCode = 1
}
