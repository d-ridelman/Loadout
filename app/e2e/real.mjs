// The window on the owner's real data (without LOADOUT_HOME) under a check profile. The window is kept off-screen.
// Screenshots go to state/real-*.png: they contain real names, so they are in .gitignore and do not reach the repository.
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright-core'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(appDir, '..')
const profile = join(repo, 'state', 'loadout-qa-real')
rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })

const app = await electron.launch({
  executablePath: join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: [appDir],
  env: { ...process.env, APP_QA: '1', LOADOUT_USER_DATA: profile, LOADOUT_BIN: join(repo, 'target', 'release', 'loadout.exe') },
})
const pid = app.process().pid
try {
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1920, 1080))
  await page.waitForSelector('#grid', { timeout: 20000 })
  await page.waitForTimeout(500)
  const rows = await page.locator('tbody tr').count()
  console.log('rows in the matrix on real data:', rows)
  for (const [key, name] of [['1', 'matrix'], ['2', 'radar'], ['3', 'hooks'], ['4', 'doctor']]) {
    await page.keyboard.press(key)
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(repo, 'state', `real-${name}.png`) })
  }
  console.log('Doctor findings:', await page.evaluate(() => document.querySelectorAll('.find').length))
} finally {
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))])
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* already closed */
  }
  rmSync(profile, { recursive: true, force: true })
}
