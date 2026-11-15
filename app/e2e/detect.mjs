// Детектор дизайна Impeccable по живому окну (CDP). Окно запускается отдельно от Playwright: ему нужен свой порт.
// Запуск: `node e2e/detect.mjs`. Результат печатается в консоль; ничего не пишется вне state/loadout-qa и временной папки.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(appDir, '..')
const port = 9333
const profile = join(repo, 'state', 'loadout-qa-detect')
const electronExe = join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe')

const root = join(homedir(), '.claude', 'plugins', 'cache', 'impeccable', 'impeccable')
const versions = existsSync(root) ? readdirSync(root).sort() : []
const detector = versions.length ? join(root, versions.at(-1), 'skills', 'impeccable', 'scripts', 'impeccable.cmd') : ''
if (!detector || !existsSync(detector)) {
  console.error('FAILED: детектор Impeccable не найден')
  process.exit(1)
}

const home = join(tmpdir(), `loadout-detect-${process.pid}`)
const walk = (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const n of readdirSync(from)) {
    const [s, d] = [join(from, n), join(to, n)]
    if (statSync(s).isDirectory()) walk(s, d)
    else writeFileSync(d, readFileSync(s, 'utf8').replaceAll('{HOME_UPPER}', home.toUpperCase().replaceAll('\\', '/')).replaceAll('{HOME}', home.replaceAll('\\', '/')))
  }
}
rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })
walk(join(repo, 'fixtures', 'home'), home)

const child = spawn(electronExe, [`--remote-debugging-port=${port}`, appDir], {
  env: { ...process.env, APP_QA: '1', LOADOUT_USER_DATA: profile, LOADOUT_BIN: join(repo, 'target', 'release', 'loadout.exe'), LOADOUT_HOME: home },
  stdio: 'ignore',
})
try {
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      up = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
    } catch {
      /* порт ещё закрыт */
    }
  }
  if (!up) throw new Error('окно не поднялось')
  await new Promise((r) => setTimeout(r, 2500)) // окно успевает показать данные
  const out = execFileSync(detector, ['detect', '--cdp', String(port)], { encoding: 'utf8', shell: true, timeout: 120000 })
  console.log(out)
} catch (e) {
  console.error('FAILED:', e instanceof Error ? (e.stdout ?? e.message) : e)
  process.exitCode = 1
} finally {
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* уже закрыт */
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
}
