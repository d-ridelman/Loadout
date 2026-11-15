// Проверка упакованной сборки (`npm run pack`, затем `node e2e/pack-check.mjs`): запуск dist/win-unpacked/Loadout.exe
// на своём профиле (`--user-data-dir`, не %APPDATA%\Loadout), подключение по CDP, ядро берётся из resources, переменные
// LOADOUT_* игнорируются, замер памяти и процессора в простое. Читает настоящие конфиги (только чтение, уровень R0).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(appDir, '..')
// `PACK_DIR` — каталог установленной копии (проверка после тихой установки), по умолчанию распакованная сборка
const unpacked = process.env.PACK_DIR ?? join(appDir, 'dist', 'win-unpacked')
const exe = join(unpacked, 'Loadout.exe')
const profile = join(repo, 'state', 'loadout-qa-pack')
const port = 9341
const IDLE_MS = 10_000

const must = (c, m) => {
  if (!c) throw new Error(m)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Процессы сборки: Loadout.exe (оболочка, GPU, рендер) и ядро из resources. */
function procs() {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${unpacked.replaceAll('/', '\\')}\\*' } | Select-Object ProcessId, Name, CommandLine, WorkingSetSize, PrivatePageCount, KernelModeTime, UserModeTime | ConvertTo-Json -Compress`,
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
  must(existsSync(exe), `нет ${exe}: выполните npm run pack`)
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })
  // LOADOUT_* и APP_QA в упакованной сборке должны игнорироваться: ядро и дом берутся не отсюда
  child = spawn(exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
    env: { ...process.env, LOADOUT_HOME: join(repo, 'state', 'no-such-home'), LOADOUT_BIN: 'C:/no/such/loadout.exe', APP_QA: '1', LOADOUT_USER_DATA: join(repo, 'state', 'no-such-profile') },
    stdio: 'ignore',
  })
  let up = false
  for (let i = 0; i < 100 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false)
    if (!up) await sleep(300)
  }
  must(up, 'упакованное приложение не открыло порт отладки')
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser.contexts()[0]?.pages().find((p) => p.url().includes('index.html')) ?? (await browser.contexts()[0].waitForEvent('page'))
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  // окно сразу уводим за экран: показывать его владельцу незачем
  await page.evaluate(() => window.moveTo(-6000, 0)).catch(() => {})

  await page.waitForSelector('#grid', { timeout: 30_000 })
  must((await page.title()) === 'Loadout', 'заголовок окна не Loadout')
  const rows = await page.locator('tbody tr').count()
  console.log('строк в матрице (настоящие конфиги):', rows)
  must(rows > 10, 'в матрице мало строк: ядро не найдено в resources или LOADOUT_HOME был принят')
  must((await page.getByLabel('Уровень записи').inputValue()) === 'R0', 'уровень записи по умолчанию должен быть R0')
  must((await page.locator('#scanlines').count()) === 0, 'в сборке остались сканлайны')

  // встроенный ctxkit из resources: версия, диагностика и отчёт по настоящим транскриптам (только чтение, ничего не применяется)
  must(existsSync(join(unpacked, 'resources', 'ctxkit.exe')), 'в сборке нет resources/ctxkit.exe')
  await page.keyboard.press('7')
  await page.getByText('ctxkit 0.', { exact: false }).first().waitFor({ timeout: 20_000 })
  await page.locator('ul[aria-label="Находки диагностики"] li').first().waitFor({ timeout: 30_000 })
  await page.locator('table[aria-label="Ходы по дням"] tbody tr').first().waitFor({ timeout: 120_000 })
  const ctxText = await page.locator('main').innerText()
  console.log('ctxkit в сборке:', /ctxkit \d+\.\d+\.\d+/.exec(ctxText)?.[0], '| находок диагностики:', await page.locator('ul[aria-label="Находки диагностики"] li').count(), '| дней в отчёте:', await page.locator('table[aria-label="Ходы по дням"] tbody tr').count())
  must(!/не удалось|не найден|неподдерживаемая/.test(ctxText), 'в разделе ctxkit ошибка')
  await page.keyboard.press('1')

  const ps = procs()
  const core = ps.filter((p) => p.Name.toLowerCase() === 'loadout.exe' && /serve/.test(p.CommandLine ?? ''))
  must(core.length === 1, `ядро из resources должно быть одно, найдено: ${core.length}`)
  must(/--backups/.test(core[0].CommandLine) && core[0].CommandLine.includes('loadout-qa-pack'), 'ядро запущено без каталога бэкапов в профиле сборки')
  must(!/--home/.test(core[0].CommandLine), 'ядро получило --home из окружения: LOADOUT_HOME должен игнорироваться')

  // простой: память и процессор процессов сборки, при полных эффектах и при выключенных
  const idle = async (label) => {
    await sleep(8_000)
    const a = procs()
    await sleep(IDLE_MS)
    const b = procs()
    const t = (p) => Number(p.KernelModeTime) + Number(p.UserModeTime)
    const total = b.reduce((s, p) => s + t(p), 0) - a.reduce((s, p) => s + t(p), 0)
    const ws = b.reduce((s, p) => s + Number(p.WorkingSetSize), 0) / 1048576
    const priv = b.reduce((s, p) => s + Number(p.PrivatePageCount), 0) / 1048576
    console.log(`${label}: процессов ${b.length}, рабочий набор ${ws.toFixed(0)} МБ (общие страницы считаются в каждом процессе), приватная память ${priv.toFixed(0)} МБ, процессор за ${IDLE_MS / 1000} с: ${(total / 10_000).toFixed(0)} мс`)
    for (const p of b) {
      const before = a.find((x) => x.ProcessId === p.ProcessId)
      const type = /--type=([a-z-]+)/.exec(p.CommandLine ?? '')?.[1] ?? (p.Name === 'loadout.exe' ? 'core' : 'main')
      console.log(`   ${type.padEnd(10)} ${(Number(p.WorkingSetSize) / 1048576).toFixed(0).padStart(4)} МБ  ${before ? ((t(p) - t(before)) / 10_000).toFixed(0) : '?'} мс`)
    }
    return total / 10_000
  }
  await idle('FX полные')
  await page.evaluate(() => { document.documentElement.dataset.fx = 'off' })
  await idle('FX выкл')
  console.log('ошибки страницы:', errors.length)
  must(errors.length === 0, `ошибки страницы: ${errors.join(' | ')}`)
  console.log('OK: упакованная сборка работает')
} catch (e) {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  if (child?.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* уже закрыт */
    }
  }
  await sleep(1500)
  const left = procs()
  console.log('оставшихся процессов сборки:', left.length)
  for (const p of left) {
    try {
      execFileSync('taskkill', ['/PID', String(p.ProcessId), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* уже закрыт */
    }
  }
  if (left.length) process.exitCode = 1
}
