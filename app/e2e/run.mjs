// Window check: Playwright `_electron`, own profile, fixture home directory. Run: `npm run e2e`.
// The owner's profile is not touched: APP_QA=1 + LOADOUT_USER_DATA=state/loadout-qa.
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright-core'
import { ownCoreProcesses } from './procs.mjs'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(appDir, '..')
const electronExe = join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe')
const loadoutBin = join(repo, 'target', 'release', 'loadout.exe')
const stateDir = join(repo, 'state')
const profile = join(stateDir, 'loadout-qa')
const SIZES = [
  [1920, 1080],
  [1280, 800],
]

/** The main dialog button is named after the operation (or "Apply" for a profile bundle). */
const APPLY = /^(Включить|Выключить|Вынести в корзину|Вернуть из корзины|Записать команду|Скопировать|Добавить|Применить|Установить$)/

/**
 * English words of the old output and of the migration from the old name (and the English name Context Toolkit, which the Russian UI renders in Russian)
 * in the lines of the Russian window (except the markup `[dry-run]`/`[warn]`/`ERR:`, text in backticks or double quotes, --flags, paths and names):
 * empty means the output is Russian. The same list and the same cut-outs as in `crates/context-toolkit/tests/guard.test.mjs`.
 */
const englishLeft = (text) => {
  const en = /\b(installed|unchanged|skip|skipped|kept|update|updated|remove|removed|removing|backup|backups|created|wrote|written|not found|Setting up|Diagnostics|enabled|global|servers?|skills?|plugins?|policies(?=:)|lines|exceed|trim|restart|Quit|manually|gate|hooks?|rules|block|agent|is|are|the|with|and|not|no|of|in|to|for|or|has|have|run|pass|old name|moved|copied|move|copy|left|still|Context|Toolkit)\b/
  const strip = (s) => s
    .replace(/\[(dry-run|warn|note|ok|info)\]/g, '')
    .replace(/^ERR:/gm, '')
    .replace(/`[^`]*`/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/\S*[\\/]\S*/g, '')
    .replace(/\S+\.(json|md|yml|exe|bak)\S*/g, '')
    .replace(/--[\w-]+/g, '')
    .replace(/\b\w+(-\w+)+\b/g, '')
    .replace(/\b\w+(\.\w+)+\b/g, '')
  return text.split('\n').filter((l) => en.test(strip(l)))
}

const log = (...a) => console.log(...a)
/** A path as the window shows it: the home directory collapsed to `~`. */
const tilde = (p) => p.split(homedir()).join('~')
const must = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

/** A copy of the fixture with `{HOME}` substituted: the scanner checks that the paths from the client files exist. */
function materialize(extra) {
  // a name without random letters and digits: the core hides token-like path segments, and `mkdtemp` would give hidden paths
  const home = join(tmpdir(), `loadout-e2e-${process.pid}`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) {
      const [s, d] = [join(from, name), join(to, name)]
      if (statSync(s).isDirectory()) walk(s, d)
      else
        writeFileSync(
          d,
          readFileSync(s, 'utf8').replaceAll('{HOME_UPPER}', home.toUpperCase().replaceAll('\\', '/')).replaceAll('{HOME}', home.replaceAll('\\', '/')),
        )
    }
  }
  walk(join(repo, 'fixtures', 'home'), home)
  extra?.(home)
  return home
}

async function launch(env) {
  const app = await electron.launch({
    executablePath: electronExe,
    args: [appDir],
    // the default language is Russian (the scenarios look for Russian labels); the English pass sets LOADOUT_LANG=en itself
    // the OpenCode system config (%ProgramData%\opencode) comes from a fixture, never from the machine running the check
    env: { ...process.env, APP_QA: '1', LOADOUT_USER_DATA: profile, LOADOUT_BIN: loadoutBin, LOADOUT_LANG: 'ru', LOADOUT_OPENCODE_SYSTEM_DIR: join(repo, 'fixtures', 'system-opencode'), ...env },
  })
  const page = await app.firstWindow()
  const pid = app.process().pid
  return { app, page, pid }
}

async function resize(app, w, h) {
  await app.evaluate(({ BrowserWindow }, [ww, hh]) => BrowserWindow.getAllWindows()[0].setSize(ww, hh), [w, h])
}

// Screenshots go to a temporary directory by default, so a run leaves the tree clean (dynamic text such as the scan time makes every
// PNG differ). `E2E_UPDATE_SHOTS=1` refreshes the committed ones in state/; `E2E_SHOTS` names another directory.
// one directory per working copy: a run in another worktree must not wipe or mix in this one's screens
const shotDir = process.env.E2E_SHOTS ?? (process.env.E2E_UPDATE_SHOTS === '1' ? stateDir : join(tmpdir(), `loadout-e2e-shots-${createHash('sha1').update(repo).digest('hex').slice(0, 8)}`))
if (shotDir !== stateDir && !process.env.E2E_SHOTS) rmSync(shotDir, { recursive: true, force: true })
mkdirSync(shotDir, { recursive: true })

/** The header's single "Add" list: opens it and picks the item whose name starts with `name` (MCP server, plugin, skill). */
async function addItem(page, name) {
  await page.locator('header .addmenu > button').click()
  await page.locator('#addpop').getByRole('button', { name: new RegExp(`^${name}`) }).click()
}

async function shot(page, name) {
  // an open dialog's bottom row of buttons is in view without scrolling (Playwright scrolls before a click, so clicks never notice)
  const cut = await page.evaluate(() => {
    const box = document.querySelector('.modal .box')
    const row = box ? [...box.querySelectorAll('.actions')].pop() : null
    if (!box || !row) return null
    const [b, a] = [box.getBoundingClientRect(), row.getBoundingClientRect()]
    return a.bottom > b.bottom + 1 || a.top < b.top - 1 ? { row: [Math.round(a.top), Math.round(a.bottom)], box: [Math.round(b.top), Math.round(b.bottom)] } : null
  })
  must(!cut, `${name}: the dialog's buttons are out of view: ${JSON.stringify(cut)}`)
  await page.screenshot({ path: join(shotDir, `${name}.png`) })
}

/** Header: every element on one line (no taller than 36 px) and centred on the line (±2 px); on the right nothing goes under the window buttons. */
async function headerLayout(page, label) {
  const m = await page.evaluate(() => {
    const h = document.querySelector('header')
    const hr = h.getBoundingClientRect()
    const kids = [...h.children].filter((c) => !c.classList.contains('sp') && c.getClientRects().length > 0).map((c) => ({ c, r: c.getBoundingClientRect() }))
    const area = navigator.windowControlsOverlay?.getTitlebarAreaRect()
    const name = (c) => c.textContent.trim().slice(0, 20)
    return {
      tall: kids.filter(({ r }) => r.height > 36).map(({ c }) => name(c)),
      off: kids.filter(({ r }) => Math.abs(r.top + r.height / 2 - (hr.top + hr.height / 2)) > 2).map(({ c }) => name(c)),
      over: area ? Math.round(Math.max(...kids.map(({ r }) => r.right)) - (area.x + area.width)) : 0,
    }
  })
  log(`  header ${label}:`, JSON.stringify(m))
  must(m.tall.length === 0 && m.off.length === 0, `${label}: header: line wraps ${JSON.stringify(m.tall)}, off-centre ${JSON.stringify(m.off)}`)
  must(m.over <= 0, `${label}: the header goes under the window buttons by ${m.over}px`)
}

/**
 * Crisp text, measured: no visible text under 12px (11px mono was the softest text in the window), and the mono face only on code,
 * paths, keys, numbers and marks, never on labels and prose. Lists offenders by tag, class and the first words.
 */
async function typeCheck(page, label) {
  const bad = await page.evaluate(() => {
    const MONO_OK = 'code, kbd, pre, .mono, .wrap, .hk, .g, .sev, .logo, .delta, .more, .pipe .h, .rowname, input[spellcheck="false"], textarea[spellcheck="false"]'
    const out = []
    for (const el of document.querySelectorAll('body *')) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
      if (!own || el.getClientRects().length === 0) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden') continue
      const size = parseFloat(cs.fontSize)
      const mono = /JetBrains Mono/i.test(cs.fontFamily.split(',')[0])
      const what = `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${el.textContent.trim().slice(0, 30)}"`
      if (size < 12) out.push(`${size}px ${what}`)
      else if (mono && !el.closest(MONO_OK)) out.push(`mono ${what}`)
    }
    return out
  })
  must(bad.length === 0, `${label}: small or mono UI text: ${JSON.stringify(bad.slice(0, 8))}`)
}

/** A measurement, not "by eye": no horizontal page scroll, no clipped names, the header and cell columns are aligned. */
async function layout(page, label) {
  const m = await page.evaluate(() => {
    const de = document.documentElement
    const clipped = [...document.querySelectorAll('td.name')].filter((e) => e.scrollWidth > e.clientWidth + 1).length
    const ths = [...document.querySelectorAll('thead th')]
    const first = document.querySelector('tbody tr')
    const cells = first ? [...first.children] : []
    const misaligned = ths.length && cells.length === ths.length
      ? ths.filter((th, i) => Math.abs(th.getBoundingClientRect().left - cells[i].getBoundingClientRect().left) > 1.5).length
      : 0
    // an empty field's placeholder must fit its box (the search hint was cut to "Найти по названию (")
    const ctx = document.createElement('canvas').getContext('2d')
    const cutHints = [...document.querySelectorAll('input[placeholder]')].filter((i) => {
      if (i.value || i.getClientRects().length === 0) return false
      const cs = getComputedStyle(i)
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      return ctx.measureText(i.placeholder).width > i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 1
    }).map((i) => i.placeholder)
    return { hscroll: de.scrollWidth - de.clientWidth, clipped, misaligned, cols: ths.length, cutHints }
  })
  log(`  measurement ${label}:`, JSON.stringify(m))
  must(m.cutHints.length === 0, `${label}: placeholders cut: ${JSON.stringify(m.cutHints)}`)
  await typeCheck(page, label)
  await headerLayout(page, label)
  must(m.hscroll <= 0, `${label}: horizontal page scroll (${m.hscroll}px)`)
  must(m.clipped === 0, `${label}: clipped names: ${m.clipped}`)
  must(m.misaligned === 0, `${label}: header and cell columns are misaligned`)
}

/**
 * Core processes of this run: none must remain after the checks. Only `loadout*.exe` with the check profile directory
 * in the command line count (`--backups <profile>\backups`, see `ownCoreProcesses`): the Loadout installed
 * for the owner, the packaged-build check and e2e of a neighbouring repository copy do not interfere with the count.
 */
function coreLeftovers() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name LIKE 'loadout%.exe'" | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress`],
      { encoding: 'utf8' },
    ).trim()
    if (!out) return []
    const v = JSON.parse(out)
    return ownCoreProcesses(Array.isArray(v) ? v : [v], profile).map((p) => String(p.ProcessId))
  } catch {
    return []
  }
}

/** PID of the core started by the window on this home directory (by command line). */
function sidecarPids(homeLeaf) {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='loadout.exe'" | Where-Object { $_.CommandLine -like '*serve*' -and $_.CommandLine -like '*${homeLeaf}*' } | Select-Object -ExpandProperty ProcessId`],
    { encoding: 'utf8' },
  )
  return out.split(/\s+/).filter(Boolean)
}

/** Matrix cell label: the row by name, the client column by number (0 is Claude Code). */
function cellLabel(page, rowName, clientIdx) {
  return page.evaluate(
    ([name, idx]) => {
      const row = [...document.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td.name b')?.textContent === name)
      return row ? row.children[idx + 1]?.getAttribute('aria-label') ?? null : null
    },
    [rowName, clientIdx],
  )
}

async function waitFor(fn, what, ms = 12000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

const axeSource = readFileSync(join(appDir, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8')

/** An axe-core pass with the WCAG A/AA and ARIA rules (including contrast). Rules that are noisy for an app window are turned off. */
async function axeCheck(page, label) {
  await page.evaluate(axeSource) // over CDP: the page CSP (`script-src 'self'`) does not apply to this
  const violations = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'cat.aria', 'cat.color'] },
      // `color-contrast-enhanced` is level AAA (7:1); the project target is AA (4.5:1), which `color-contrast` checks
      rules: { 'color-contrast-enhanced': { enabled: false }, region: { enabled: false }, 'page-has-heading-one': { enabled: false }, 'landmark-one-main': { enabled: false } },
    })
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))
  })
  for (const v of violations) log(`  axe ${label}: ${v.id} (${v.impact}) ×${v.count} ${v.sample}`)
  // every screen axe sees also gets the crisp-text check (dialogs, journal, profiles, Context Toolkit, updates)
  await typeCheck(page, label)
  return violations
}

function leftovers() {
  // only the processes of this repository copy: e2e of another working folder (a neighbouring worktree) runs with its own profile, we neither count nor kill it
  const q = (p) => p.replaceAll("'", "''")
  try {
    const out = execFileSync(
      'powershell',
      // IndexOf, not -like: brackets in the path do not turn into a pattern. The main process is appDir and the Playwright debugging port
      // (the dev window `npm run dev` of the same copy does not match the filter), the children are matched by the e2e profile's --user-data-dir.
      ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $c = $_.CommandLine; $c -and ($c.IndexOf('${q(profile)}', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or ($c.IndexOf('${q(appDir)}', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $c.Contains('--remote-debugging-port'))) } | Select-Object -ExpandProperty ProcessId`],
      { encoding: 'utf8' },
    )
    return out.split(/\s+/).filter(Boolean)
  } catch {
    return []
  }
}

async function close({ app, pid }) {
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))])
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* already closed */
  }
}

const homes = []
let session

try {
  must(existsSync(electronExe), `${electronExe} not found: run npm install in app/`)
  must(existsSync(loadoutBin), `${loadoutBin} not found: cargo build --release`)
  must(existsSync(join(appDir, 'build', 'context-toolkit.exe')), 'app/build/context-toolkit.exe not found: npm run bundle:context-toolkit')
  mkdirSync(stateDir, { recursive: true })
  // a clean check profile every time: the window settings (FX) must not carry over between runs
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })

  // a long skill name to check text wrapping
  const home = materialize((h) => {
    const dir = join(h, '.claude', 'skills', 'very-long-skill-name-that-should-wrap-inside-the-name-column-without-clipping-anything')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: Длинное имя для проверки переноса\n---\n')
    // Claude Code transcripts for the ctxkit report: turns on two models, a subagent call and a tool result
    const ts = new Date().toISOString()
    const row = (i, model, tool) =>
      JSON.stringify({ type: 'assistant', uuid: `a${i}`, timestamp: ts, message: { id: `m${i}`, model, content: [{ type: 'tool_use', id: `t${i}`, name: tool.name, input: tool.input }] } }) +
      '\n' +
      JSON.stringify({ type: 'user', uuid: `u${i}`, timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: '0123456789' }] } })
    const rows = []
    for (let i = 0; i < 8; i++) rows.push(row(i, 'claude-sonnet-5-5', { name: 'Bash', input: { command: 'ls' } }))
    for (let i = 8; i < 11; i++) rows.push(row(i, 'claude-opus-5-5', { name: 'Agent', input: { subagent_type: 'checker' } }))
    mkdirSync(join(h, '.claude', 'projects', 'p'), { recursive: true })
    writeFileSync(join(h, '.claude', 'projects', 'p', 'a.jsonl'), rows.join('\n') + '\n')
  })
  homes.push(home)
  // stand-in `claude`: downloads nothing, records its arguments and registers a local marketplace
  const fakeClaude = join(appDir, 'e2e', 'fake-claude.mjs')
  const claudeCalls = join(home, 'claude-calls.txt')
  // sources without a network: a local marketplace and a git repository of the skill that is cloned instead of GitHub
  // every pass gets its own copies: `materialize` recreates the same directory
  const sources = (h) => {
    cpSync(join(repo, 'fixtures', 'marketplace'), join(h, 'src', 'market'), { recursive: true })
    const skillRepo = join(h, 'gh', 'acme', 'skills.git')
    cpSync(join(repo, 'fixtures', 'skill-src'), skillRepo, { recursive: true })
    const git = (...a) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@loadout.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: skillRepo, stdio: 'ignore' })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-q', '-m', 'fixture')
    return join(h, 'src', 'market')
  }
  const marketDir = sources(home)
  const fakeEnv = (h, calls) => ({
    LOADOUT_HOME: h,
    LOADOUT_CLAUDE: process.execPath,
    LOADOUT_CLAUDE_ARGS: JSON.stringify([fakeClaude]),
    FAKE_CLAUDE_CALLS: calls,
    LOADOUT_GITHUB_BASE: pathToFileURL(join(h, 'gh')).href + '/',
  })

  // ---- main scenario ----
  session = await launch(fakeEnv(home, claudeCalls))
  let { app, page } = session
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message.slice(0, 200)}`))
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(`console.error: ${m.text().slice(0, 200)}`))
  await page.waitForSelector('#grid', { timeout: 20000 })
  must((await page.title()) === 'Loadout', 'the window title is not Loadout')

  // ---- first run: the welcome card says what the window does, writes nothing, names the only network use; closed once, it stays closed ----
  {
    const welcome = page.getByRole('region', { name: 'Loadout: что это и чего ждать' })
    await welcome.waitFor({ timeout: 8000 })
    const w = await welcome.innerText()
    for (const s of ['Claude Code', 'Только чтение · R0', 'покажет, что изменится', 'подтверждения','проверки обновлений на GitHub', 'правом нижнем углу']) must(w.includes(s), `the welcome card lacks "${s}": ${w}`)
    for (const [ww, hh] of SIZES) {
      await resize(app, ww, hh)
      await page.waitForTimeout(150)
      await layout(page, `welcome ${ww}`)
      await shot(page, `b2-welcome-${ww}`)
    }
    await resize(app, 1280, 800)
    const vw = await axeCheck(page, 'welcome')
    must(vw.length === 0, `axe: welcome card: ${vw.map((x) => x.id).join(', ')}`)
    await welcome.getByRole('button', { name: 'Понятно, начать' }).click()
    await welcome.waitFor({ state: 'detached', timeout: 5000 })
    await waitFor(() => existsSync(join(profile, 'settings.json')) && JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).welcomed === true, 'closing the welcome card is saved')
  }

  // ---- the legend of the matrix marks: one click away above the table, every state plus +N, Δ and FX ----
  {
    const legend = page.locator('details.legend-box')
    await legend.locator('summary').click()
    const text = await legend.innerText()
    // FX left the legend: it is not a mark of the table and lives in Help → Appearance now
    for (const s of ['включено', 'выключено', 'сломано', 'расхождение версий','только в приложении', 'не определено', '+N', 'Δ']) must(text.includes(s), `the legend lacks "${s}": ${text}`)
    must((await legend.boundingBox()).y < (await page.locator('#grid').boundingBox()).y, 'the legend must be above the table')
    await shot(page, 'b2-legend-1280')
    await resize(app, 1920, 1080)
    await page.waitForTimeout(150)
    await shot(page, 'b2-legend-1920')
    await resize(app, 1280, 800)
    await legend.locator('summary').click()
  }

  // the top line is custom (no system frame): the mark, dragging; the controls do not go under the window buttons
  const bar = await page.evaluate(() => {
    const h = document.querySelector('header')
    const wco = navigator.windowControlsOverlay
    const area = wco?.getTitlebarAreaRect()
    const right = Math.max(...[...h.children].map((c) => c.getBoundingClientRect().right))
    return {
      overlay: wco?.visible === true,
      drag: getComputedStyle(h).getPropertyValue('-webkit-app-region'),
      selectDrag: getComputedStyle(h.querySelector('select')).getPropertyValue('-webkit-app-region'),
      mark: !!h.querySelector('svg.mark'),
      height: Math.round(h.getBoundingClientRect().height),
      right: Math.round(right),
      areaRight: area ? Math.round(area.x + area.width) : null,
    }
  })
  log('  top line:', JSON.stringify(bar))
  must(bar.overlay, 'the system frame is not removed: no window-buttons overlay')
  must(bar.drag === 'drag' && bar.selectDrag === 'no-drag', 'the title line must be draggable and the controls must not be')
  must(bar.mark, 'no mark in the header')
  must(bar.height === 48, `title line height ${bar.height}, must be 48 (as for the overlay)`)
  must(bar.areaRight !== null && bar.right <= bar.areaRight, `header elements go under the window buttons: ${bar.right} > ${bar.areaRight}`)
  const rowCount = await page.locator('tbody tr').count()
  log('rows in the matrix:', rowCount)
  must(rowCount > 10, 'too few rows in the matrix')
  must((await page.locator('thead th').count()) === 7, 'the header must have 7 columns (entity + 6 clients)')

  // keyboard: j, l → the selected cell and the inspector
  await page.locator('#grid').focus()
  await page.keyboard.press('j')
  await page.keyboard.press('l')
  must((await page.locator('td[aria-selected="true"]').count()) === 1, 'there is exactly one selected cell')
  // headings are set in capitals by CSS, so innerText comes in upper case
  must((await page.locator('aside').innerText()).toLowerCase().includes('инспектор'), 'the inspector is not shown')
  // Russian layout: the physical J key, where key is the Russian letter on that key
  const before = await page.locator('td[aria-selected="true"]').getAttribute('id')
  await page.evaluate(() => document.getElementById('grid').dispatchEvent(new KeyboardEvent('keydown', { key: 'о', code: 'KeyJ', bubbles: true })))
  must((await page.locator('td[aria-selected="true"]').getAttribute('id')) !== before, 'j on the Russian layout does not move the selection')

  // states and filters
  await page.getByRole('button', { name: 'скилы' }).click()
  must((await page.locator('tbody tr').count()) < rowCount, 'the "skills" filter did not narrow the list')
  // the rarer kinds are one list: picking hooks shows hook rows only
  await page.getByLabel('Другие типы').selectOption('hook')
  const hookBadges = await page.locator('tbody td.name .badge').allInnerTexts()
  must(hookBadges.length > 0 && hookBadges.every((b) => b === 'хук'), `the "Other kinds: hooks" filter shows other kinds or nothing: ${JSON.stringify(hookBadges)}`)
  await page.getByRole('button', { name: 'все типы' }).click()
  must((await page.getByLabel('Другие типы').inputValue()) === 'all', '"all types" did not reset the other-kinds list')
  await page.getByLabel('Поиск').fill('tool-b')
  must((await page.locator('tbody tr').count()) >= 1, 'search for tool-b found nothing')
  await page.getByLabel('Поиск').fill('')

  // fixture secrets must not appear anywhere in the window
  const everything = await page.evaluate(() => document.body.innerText)
  must(!everything.includes('FAKE-SECRET'), 'FAKE-SECRET found in the window')

  // palette: open, find, go; focus returns
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: 'Команда' }).fill('tool-b')
  await page.keyboard.press('Enter')
  must((await page.locator('[role=dialog][aria-label="Палитра команд"]').count()) === 0, 'the palette did not close')
  must((await page.locator('aside').innerText()).includes('tool-b'), 'the palette did not select tool-b')
  // The palette returns focus to the table on the next frame. If it is opened again sooner, the second time it remembers
  // the previous field (search), returns focus there, and the digit `2` goes into the search: the radar does not open ("the radar must have 6 clients").
  await waitFor(async () => (await page.evaluate(() => document.activeElement?.id)) === 'grid', 'after the palette focus returned to the table')
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: 'Команда' }).waitFor() // Esc is handled by the input field: wait until it gets focus
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Команда')
  await page.keyboard.press('Escape')
  must((await page.locator('[role=dialog][aria-label="Палитра команд"]').count()) === 0, 'Esc did not close the palette')
  await waitFor(async () => (await page.evaluate(() => document.activeElement?.id)) === 'grid', 'after Esc focus returned to the table, not to the input field')
  // Ctrl+K is not the single key k: the selection stays put (a row below the first, so that k would have moved it),
  // and the palette offers the action for the selected entry, not for its neighbour
  await page.locator('tbody tr', { has: page.locator('td.name b', { hasText: /^p1$/ }) }).locator('td').nth(3).click()
  const selRow = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].findIndex((r) => r.querySelector('td[aria-selected="true"]')))
  must(selRow >= 1, `the Ctrl+K check needs a row below the first, got ${selRow}`)
  const selBefore = await page.locator('td[aria-selected="true"]').getAttribute('id')
  const selName = (await page.locator('aside b').first().innerText()).toLowerCase()
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: 'Команда' }).waitFor()
  must((await page.locator('td[aria-selected="true"]').getAttribute('id')) === selBefore, 'Ctrl+K moved the selection in the matrix')
  const palAction = await page.getByRole('option').filter({ hasText: /^(Включить|Выключить): / }).first().innerText()
  must(palAction.toLowerCase().includes(selName), `the palette offers an action for another entry: "${palAction}", selected "${selName}"`)
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Команда')
  await page.keyboard.press('Escape')
  await waitFor(async () => (await page.evaluate(() => document.activeElement?.id)) === 'grid', 'after Esc focus returned to the table')
  must((await page.locator('td[aria-selected="true"]').getAttribute('id')) === selBefore, 'Ctrl+K and Esc moved the selection in the matrix')

  // sections by digits
  await page.keyboard.press('2')
  // a section is not drawn instantly: count with a wait, not right after the key press
  await waitFor(async () => (await page.locator('.node').count()) === 6, 'the radar must have 6 clients')
  // every client has its own place: no node covers another one or the row counter in the middle
  const radarHits = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.node'), document.querySelector('.rcenter .big')].map((e) => e.getBoundingClientRect())
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    return boxes.flatMap((a, i) => boxes.slice(i + 1).map((b, j) => (hit(a, b) ? `${i}/${i + 1 + j}` : null))).filter(Boolean)
  })
  must(radarHits.length === 0, `radar nodes overlap: ${radarHits.join(', ')}`)
  // a client without Doctor problems shows no warning sign, and the sign counts the same problems as the "Issues" panel
  const radarText = await page.locator('.radar').innerText()
  must(!radarText.includes('⚠ 0'), `the radar shows a zero warning: ${radarText}`)
  await page.keyboard.press('3')
  await waitFor(async () => (await page.locator('.pipe .hk').count()) > 0, 'no hooks in the pipeline')
  await page.keyboard.press('4')
  await waitFor(async () => (await page.locator('.find').count()) > 0, 'the Doctor found nothing on the fixture with breakages')
  // "Show" opens the matrix with the entry's cell selected, scrolled into view below the sticky header, and the table focused
  for (const n of [0, -1]) {
    const shows = page.getByRole('button', { name: /^Показать в матрице:/ })
    must((await shows.count()) > 0, 'the Doctor has no "Show" buttons on the fixture')
    await (n === 0 ? shows.first() : shows.last()).click()
    await waitFor(async () => (await page.locator('#grid td[aria-selected="true"]').count()) === 1, 'Doctor "Show" selects no cell')
    await waitFor(() => page.evaluate(() => document.activeElement?.id === 'grid'), 'after Doctor "Show" the table is not focused')
    const seen = await page.evaluate(() => {
      const c = document.querySelector('#grid td[aria-selected="true"]').getBoundingClientRect()
      const main = document.querySelector('main')
      const m = main.getBoundingClientRect()
      const h = document.querySelector('#grid thead').getBoundingClientRect()
      return { top: Math.round(c.top), bottom: Math.round(c.bottom), headBottom: Math.round(h.bottom), mainBottom: Math.round(m.bottom), taller: main.scrollHeight > main.clientHeight }
    })
    // the check means something only if the table does not fit: then a cell further down needs scrolling
    must(seen.taller, `the fixture matrix fits the window, the "Show" scroll check proves nothing: ${JSON.stringify(seen)}`)
    must(seen.top >= seen.headBottom - 1 && seen.bottom <= seen.mainBottom + 1, `the cell shown from the Doctor is out of view: ${JSON.stringify(seen)}`)
    await page.keyboard.press('4')
  }
  await page.keyboard.press('1')

  // screenshots by size and section
  for (const [w, h] of SIZES) {
    await resize(app, w, h)
    for (const [key, name] of [['1', 'matrix'], ['2', 'radar'], ['3', 'hooks'], ['4', 'doctor']]) {
      await page.keyboard.press(key)
      await page.waitForTimeout(250)
      if (key === '1') await layout(page, `${name}@${w}`)
      if (name === 'hooks') {
        // all pipeline events are reachable: if they do not fit, the grid scrolls instead of being clipped
        const reach = await page.evaluate(() => {
          const wrap = document.querySelector('.tablewrap.scrollx')
          const heads = [...document.querySelectorAll('.pipe .h')]
          const over = wrap.scrollWidth - wrap.clientWidth
          wrap.scrollLeft = wrap.scrollWidth
          const last = heads[heads.length - 1].getBoundingClientRect()
          return { overflowX: getComputedStyle(wrap).overflowX, events: heads.length, over, lastRight: Math.round(last.right), wrapRight: Math.round(wrap.getBoundingClientRect().right) }
        })
        must(reach.overflowX === 'auto' && reach.lastRight <= reach.wrapRight + 1, `the last hooks event is unreachable: ${JSON.stringify(reach)}`)
        // a few events share the width: no horizontal scroll (the columns once grew to the widest hook, ~450px each)
        must(reach.over <= 0, `the hooks grid scrolls sideways at ${w}px: ${JSON.stringify(reach)}`)
        await page.evaluate(() => { document.querySelector('.tablewrap.scrollx').scrollLeft = 0 })
      }
      if (name === 'radar') {
        // every client card stays inside the radar panel (the side ones stuck out at 1280 and 1920)
        const out = await page.evaluate(() => {
          const p = document.querySelector('.rwrap').closest('.hud').getBoundingClientRect()
          return [...document.querySelectorAll('.node')].filter((n) => { const r = n.getBoundingClientRect(); return r.left < p.left - 1 || r.right > p.right + 1 }).map((n) => n.querySelector('b')?.textContent)
        })
        must(out.length === 0, `radar cards stick out of the panel at ${w}: ${JSON.stringify(out)}`)
      }
      if (w === 1920) {
        const v = await axeCheck(page, name)
        must(v.length === 0, `axe found violations on the "${name}" screen: ${v.map((x) => x.id).join(', ')}`)
      }
      await shot(page, `m1-${name}-${w}`)
    }
    await page.keyboard.press('1')
  }

  // ---- live update: editing a config on disk changes the matrix without a "Scan" button and without a "loading" screen ----
  await resize(app, 1100, 700) // the minimum window size: the header is still on one line
  await page.waitForTimeout(250)
  // six client columns at the minimum width: no clipped names, no sideways scroll, header and cells aligned (layout() checks the header too)
  await layout(page, 'matrix@1100')
  // the filter bar stays within two rows at the narrowest window (it took three before the rarer kinds became one list)
  // rows by item centres (items of one row differ in height), a new row starts more than 12px below the previous centre
  const barRows = await page.evaluate(() => [...document.querySelector('main .bar').children].map((c) => { const r = c.getBoundingClientRect(); return r.top + r.height / 2 }).sort((a, b) => a - b).filter((y, i, a) => i === 0 || y - a[i - 1] > 12).length)
  must(barRows <= 2, `the matrix filter bar takes ${barRows} rows at 1100`)
  await shot(page, 'm1-matrix-1100')
  await resize(app, 1280, 800)
  await page.keyboard.press('1')
  await page.getByLabel('Поиск').fill('')
  await page.locator('#grid').focus()
  await page.evaluate(() => (document.getElementById('grid').dataset.alive = '1'))
  const cfg = join(home, '.codex', 'config.toml')
  const original = readFileSync(cfg, 'utf8')
  must(String(await cellLabel(page, 'p1', 2)).includes('включено'), 'p1 in Codex is enabled initially')
  writeFileSync(cfg, original.replace('[plugins."p1@bundled"]\nenabled = true', '[plugins."p1@bundled"]\nenabled = false'))
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('выключено'), 'the p1 glyph changed to "disabled" by itself')
  must((await page.evaluate(() => document.getElementById('grid')?.dataset.alive)) === '1', 'the table was recreated: data must change in place')
  must((await page.evaluate(() => document.activeElement?.id)) === 'grid', 'focus left the table on update')
  must((await page.locator('td.fresh').count()) > 0, 'the change is not highlighted with the Δ marker')
  must((await page.locator('td.fresh .delta').first().innerText()) === 'Δ', 'highlight without a marker (colour only)')
  must((await page.locator('main [role=status]').count()) === 0, 'the "loading" screen is shown on update')

  // ---- a killed core comes back up, the window catches up with changes made during the pause ----
  const leaf = home.split(/[\\/]/).pop()
  const pids = sidecarPids(leaf)
  must(pids.length === 1, `there must be exactly one core for the window, found: ${pids.length}`)
  execFileSync('taskkill', ['/PID', pids[0], '/F'], { stdio: 'ignore' })
  writeFileSync(cfg, original) // an edit while there is no core
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('включено'), 'after the core restart the window caught up with the edit', 15000)
  const after = sidecarPids(leaf)
  must(after.length === 1 && after[0] !== pids[0], 'the core did not restart')
  // and the watcher of the new core works
  writeFileSync(cfg, original.replace('[plugins."p1@bundled"]\nenabled = true', '[plugins."p1@bundled"]\nenabled = false'))
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('выключено'), 'the watcher of the new core works')
  writeFileSync(cfg, original)

  // ---- R1 write: toggled → the glyph changed → rollback → the glyph came back; all on a fixture copy and in the check profile ----
  await resize(app, 1280, 800)
  await page.keyboard.press('1')
  const clickCell = async (rowName, idx) => {
    await page
      .locator('tbody tr', { has: page.locator('td.name b', { hasText: new RegExp(`^${rowName}$`) }) })
      .locator('td')
      .nth(idx + 1)
      .click()
  }
  const levelSel = page.getByLabel('Уровень записи')
  const levelIs = async (l) => (await levelSel.inputValue()) === l
  /** The confirmation window on raising the level is replaced in the main process: `answer` 1 is "Enable", 0 is "Cancel". */
  const stubDialog = (answer) =>
    app.evaluate((_electron, a) => {
      globalThis.__answer = a
      globalThis.__asked ??= 0
      // main asks through this hook in the QA mode instead of opening its confirmation window (index.ts `confirm`)
      globalThis.__loadoutConfirm = async () => {
        globalThis.__asked++
        return globalThis.__answer === 1
      }
    }, answer)
  const dialog = page.locator('[role=dialog][aria-modal=true]')
  const asOff = original.replace('[plugins."p1@bundled"]\nenabled = true', '[plugins."p1@bundled"]\nenabled = false')
  must(asOff !== original, 'fixture: p1 has no enabled = true')

  // the "broken: N" counter in the footer leads to the Doctor; the Doctor groups findings and says how to fix each one
  await page.getByRole('button', { name: /^сломано: \d+, открыть Доктора/ }).click()
  await waitFor(async () => (await page.locator('main h2').first().innerText()).startsWith('Доктор'), 'the footer counter opens the Doctor')
  {
    // group headings are set in capitals by CSS
    const doc = (await page.locator('main').innerText()).toLowerCase()
    must(doc.includes('сломано ·') && doc.includes('к сведению ·') && (doc.match(/как исправить/g) ?? []).length === (await page.locator('.find').count()), `the Doctor without groups or a fix per finding: ${doc.slice(0, 400)}`)
    const sizes = await page.evaluate(() => [...document.querySelectorAll('main h2, aside h2')].map((h) => parseFloat(getComputedStyle(h).fontSize)))
    must(sizes.every((s) => s >= 18 && s <= 20), `section headings must be 18-20px: ${sizes}`)
  }
  // every section except the matrix has one page width (measured at 1920, where the cap applies)
  {
    await resize(app, 1920, 1080)
    const widths = []
    for (const key of ['2', '3', '4', '5', '6', '7']) {
      await page.keyboard.press(key)
      await page.locator('main .page').waitFor({ timeout: 5000 })
      widths.push(Math.round((await page.locator('main .page').boundingBox()).width))
    }
    must(Math.max(...widths) - Math.min(...widths) <= 1, `section pages differ in width: ${widths}`)
    await resize(app, 1280, 800)
  }
  await page.keyboard.press('1')

  // single keys also work after a mouse click on a button (focus stays on the button, not on the table)
  await page.getByRole('button', { name: /^Радар/ }).click()
  await page.keyboard.press('1')
  await waitFor(async () => (await page.locator('#grid').count()) === 1, 'after a click on a button the key 1 opens the matrix')
  // the journal is empty while there were no entries
  await page.keyboard.press('5')
  await waitFor(async () => (await page.locator('main').innerText()).includes('Операций пока не было'), 'empty journal with an explanation')
  await shot(page, 'm3-journal-empty-1280')
  await page.keyboard.press('1')

  // ---- a newcomer's path: R0 → a cell → "Disable" in the inspector → the OS asks once → the preview; no header list, no keys ----
  // (formerly the button was inactive at R0 and the hint sent the person to the header: the dead end the owner called too hard)
  await clickCell('p1', 2)
  must(await levelIs('R0'), 'the default level is R0')
  must((await page.locator('#scanlines').count()) === 0, 'scanline stripes (a linear horizontal ripple) must be removed')
  const offBtn = page.locator('aside').getByRole('button', { name: 'Выключить', exact: true })
  must(!(await offBtn.isDisabled()), 'at R0 the inspector button must be active: it asks for permission and goes on')
  must((await page.locator('aside').innerText()).includes('спросит разрешение'), 'at R0 the inspector does not say what the button will do')
  for (const [w, h] of SIZES) {
    await resize(app, w, h)
    await page.waitForTimeout(150)
    await layout(page, `novice inspector ${w}`)
    await shot(page, `n1-inspector-r0-${w}`)
  }
  await resize(app, 1280, 800)
  // the real confirmation window, not stubbed: main's own window in the app's style with the question, Cancel focused first; Esc refuses
  {
    const next = app.waitForEvent('window', { timeout: 8000 })
    await offBtn.click()
    const cw = await next
    await cw.waitForSelector('#cancel', { timeout: 8000 })
    const body = await cw.locator('body').innerText()
    must(body.includes('Разрешить Loadout включать и выключать') && body.includes('Разрешить вкл/выкл') && body.includes('Отмена'), `the confirmation window lacks its question or buttons: ${body.slice(0, 300)}`)
    must((await cw.evaluate(() => document.activeElement?.id)) === 'cancel', 'Cancel must have the focus in the confirmation window')
    const vc = await axeCheck(cw, 'confirmation window')
    must(vc.length === 0, `axe: confirmation window: ${vc.map((x) => x.id).join(', ')}`)
    // the detail names the backups folder, here the check profile inside this working copy: the committed picture shows the default
    // folder instead, so no path of the machine that ran the check gets into state/
    // main shows the folder with the home directory as "~": both forms are replaced
    const raw = join(profile, 'backups')
    await cw.evaluate((forms) => {
      for (const el of document.querySelectorAll('#d p')) for (const f of forms) el.textContent = el.textContent.split(f).join('%APPDATA%\\loadout-app\\backups')
    }, [raw, tilde(raw)])
    const shown = await cw.locator('body').innerText()
    must(!shown.includes(repo) && !shown.includes(tilde(repo)), 'the confirmation window picture would show the path of this working copy')
    await cw.screenshot({ path: join(shotDir, 'n2-confirm-window.png') })
    // the window closes on the key itself, so the press may not get its own reply: the close event is what this waits for
    await Promise.all([cw.waitForEvent('close', { timeout: 8000 }), cw.keyboard.press('Escape').catch(() => undefined)])
    await page.waitForTimeout(300) // a negative check: a wrong level would arrive after the answer
    must(await levelIs('R0'), 'Esc in the confirmation window must leave R0')
    must((await dialog.count()) === 0, 'a refused confirmation must open no preview')
    // consent with the button: the level rises to R1 and the preview opens; then back to R0 (lowering needs no confirmation)
    const next2 = app.waitForEvent('window', { timeout: 8000 })
    await offBtn.click()
    const cw2 = await next2
    await Promise.all([cw2.waitForEvent('close', { timeout: 8000 }), cw2.locator('#ok').click().catch(() => undefined)])
    await waitFor(() => levelIs('R1'), '"Allow on/off" in the confirmation window did not raise the level')
    await dialog.waitFor({ timeout: 8000 })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached', timeout: 8000 })
    await levelSel.selectOption('R0')
    await waitFor(() => levelIs('R0'), 'the level went back to R0')
    // cleaning up old copies asks in the same window, with a red (danger) button; Esc refuses and deletes nothing
    await page.keyboard.press('5')
    await page.getByText('Где хранятся копии и что в них').click()
    const next3 = app.waitForEvent('window', { timeout: 8000 })
    await page.getByRole('button', { name: 'Очистить старые копии…' }).click()
    const cw3 = await next3
    await cw3.waitForSelector('#ok.danger', { timeout: 8000 })
    must((await cw3.locator('#ok').innerText()) === 'Очистить', 'the cleanup confirmation has no "Clean up" button')
    await Promise.all([cw3.waitForEvent('close', { timeout: 8000 }), cw3.keyboard.press('Escape').catch(() => undefined)])
    await page.locator('#notice').waitFor({ timeout: 5000 })
    must((await page.locator('#notice').innerText()).includes('очистка отменена'), 'a refused cleanup did not say it was cancelled')
    await page.getByText('Где хранятся копии и что в них').click()
    await page.keyboard.press('1')
    await clickCell('p1', 2)
  }
  // a refusal (Space and the button both ask) leaves R0, opens nothing and writes nothing
  await stubDialog(0)
  let askedBefore = await app.evaluate(() => globalThis.__asked)
  // Space on another focusable control (here "Technical details") does what that control does, it does not toggle the selection
  const tech = page.locator('aside details.tech')
  await tech.locator('summary').focus()
  await page.keyboard.press('Space')
  await page.waitForTimeout(400) // a negative check: give a wrong confirmation request time to arrive
  must(await tech.evaluate((d) => d.open), 'Space on "Technical details" did not open them')
  must((await app.evaluate(() => globalThis.__asked)) === askedBefore, 'Space on "Technical details" toggled the selected entry')
  await tech.locator('summary').click()
  // the same for a button inside the table: "Clear the filters" clears them and leaves the hidden selection alone
  await page.locator('input[type=search]').fill('zzzz-no-such-entry')
  const clearBtn = page.locator('#grid').getByRole('button', { name: 'Сбросить фильтры' })
  await clearBtn.focus()
  await page.keyboard.press('Space')
  await page.waitForTimeout(400) // a negative check, as above
  must((await page.locator('input[type=search]').inputValue()) === '', 'Space on "Clear the filters" did not clear them')
  must((await app.evaluate(() => globalThis.__asked)) === askedBefore, 'Space on "Clear the filters" toggled the hidden selected entry')
  await page.getByLabel('скрыть «не определено»').check() // "Clear the filters" also shows unknown rows: back to the default view
  await clickCell('p1', 2)
  await page.locator('#grid').focus()
  await page.keyboard.press('Space')
  await waitFor(async () => (await app.evaluate(() => globalThis.__asked)) > askedBefore, 'Space at R0 did not ask for permission')
  // wait for this message, not any: the "cleanup cancelled" error from the step above may still be on screen for a moment
  await waitFor(async () => ((await page.locator('#notice').count()) ? (await page.locator('#notice').innerText()).includes('R0') : false), 'a refusal does not say the level stayed R0', 5000)
  must((await dialog.count()) === 0, 'after a refusal the preview must not open')
  must(readFileSync(cfg, 'utf8') === original, 'after a refusal the file must not change')
  // the header list asks in the same confirmation window; a refusal there leaves R0 too
  askedBefore = await app.evaluate(() => globalThis.__asked)
  await levelSel.selectOption('R1')
  await waitFor(async () => (await app.evaluate(() => globalThis.__asked)) > askedBefore, 'the confirmation window was not asked')
  // a negative check: the select is controlled and shows R0 at once, so give a wrong level time to arrive, then ask main too
  await page.waitForTimeout(600)
  must(await levelIs('R0'), 'a refusal in the confirmation window must leave R0')
  must((await page.evaluate(() => window.loadout.getWriteLevel())) === 'R0', 'a refusal in the confirmation window must leave R0 in main')
  // consent: the same button raises the level to what this entry needs (R1, a flag) and opens the preview
  await stubDialog(1)
  askedBefore = await app.evaluate(() => globalThis.__asked)
  await offBtn.click()
  await dialog.waitFor({ timeout: 8000 })
  must((await app.evaluate(() => globalThis.__asked)) === askedBefore + 1, 'the button must ask the confirmation window exactly once')
  await waitFor(() => levelIs('R1'), 'the button raised the level to R1')
  await dialog.getByText('Строю план…').waitFor({ state: 'detached', timeout: 8000 })
  const dText = await dialog.innerText()
  must(dText.includes('~/.codex/config.toml') && dText.includes('включено') && dText.includes('выключено'), `preview without the file and values: ${dText}`)
  must(!dText.includes('FAKE-SECRET') && !dText.includes(home.replaceAll('\\', '/')), 'a secret or the home path in the preview')
  const v1 = await axeCheck(page, 'preview')
  must(v1.length === 0, `axe: preview: ${v1.map((x) => x.id).join(', ')}`)
  const footerOk = () => page.evaluate(() => { const f = document.querySelector('footer'); return f.scrollHeight <= f.clientHeight + 1 && f.scrollWidth <= f.clientWidth + 1 })
  must(await footerOk(), 'the footer with the message does not fit on one line')
  await shot(page, 'm3-dialog-1280')
  await resize(app, 1920, 1080)
  await page.waitForTimeout(250)
  await shot(page, 'm3-dialog-1920')
  await resize(app, 1280, 800)
  await page.keyboard.press('Escape')
  must((await dialog.count()) === 0, 'Esc did not close the preview')
  await waitFor(async () => (await page.evaluate(() => document.activeElement?.id)) === 'grid', 'after closing the preview focus returned to the table')
  must(readFileSync(cfg, 'utf8') === original, 'cancel must not change the file')

  // a file with mixed line endings: the plan refuses, and Esc closes the window even if focus is not on "Apply"
  // no pause after writing: the plan reads the file from disk, and a change of line endings alone sends no `changed` event to wait for
  writeFileSync(cfg, original.replace('\n', '\r\n'))
  await page.keyboard.press('Space')
  await dialog.locator('[role=alert]').waitFor({ timeout: 8000 })
  must((await dialog.locator('[role=alert]').innerText()).includes('смешанные'), 'mixed line endings must make the plan refuse')
  await page.keyboard.press('Escape')
  must((await dialog.count()) === 0, 'Esc did not close the preview with a plan error')
  writeFileSync(cfg, original)

  // the file changed between the preview and the write: the write refuses, the foreign edit is intact
  await page.locator('#grid').focus()
  await page.keyboard.press('Space')
  await dialog.getByRole('button', { name: APPLY }).waitFor({ timeout: 8000 })
  await page.waitForFunction(() => !document.querySelector('[role=dialog] button[disabled]'), null, { timeout: 8000 })
  const touched = `${original}\n# дописал клиент\n`
  writeFileSync(cfg, touched)
  await dialog.getByRole('button', { name: APPLY }).click()
  await dialog.locator('[role=alert]').waitFor({ timeout: 8000 })
  must((await dialog.locator('[role=alert]').innerText()).includes('изменился'), 'a stale plan must be rejected')
  must(readFileSync(cfg, 'utf8') === touched, 'the refusal must not touch the file')
  await dialog.getByRole('button', { name: 'Отмена' }).click()
  writeFileSync(cfg, original) // a comment line changes no entry: no `changed` event follows, the next plan reads the disk

  // a plain write
  await page.locator('#grid').focus()
  // the page scrolled part way down, as in the live window where the jump showed: the selected p1 row stays in view
  const scrolled = await page.evaluate(() => { const m = document.querySelector('main'); m.scrollTop = 120; return m.scrollTop })
  must(scrolled > 0, 'the matrix page does not scroll at 1280×800: the scroll check below would prove nothing')
  await page.keyboard.press('Space')
  await dialog.getByRole('button', { name: APPLY }).waitFor({ timeout: 8000 })
  await page.waitForFunction(() => !document.querySelector('[role=dialog] button[disabled]'), null, { timeout: 8000 })
  await dialog.getByRole('button', { name: APPLY }).click()
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('выключено'), 'after the write the p1 glyph is "disabled"')
  // focus goes back to the table without moving the page (it jumped to the table's top after every preview, seen in the live window)
  await waitFor(async () => (await page.evaluate(() => document.activeElement?.id)) === 'grid', 'after the write focus returned to the table')
  must((await page.evaluate(() => document.querySelector('main').scrollTop)) === scrolled, 'closing the preview scrolled the page')
  must(readFileSync(cfg, 'utf8') === asOff, 'something besides enabled of p1 was written')
  must((await dialog.count()) === 0, 'the preview did not close after the write')
  must((await page.locator('#notice').innerText()).includes('Откат'), 'no message about the write')
  must(existsSync(join(profile, 'backups')), 'backups must be in the application profile')

  // journal and rollback
  await page.keyboard.press('5')
  await page.locator('table[aria-label="Журнал операций"] tbody tr').first().waitFor({ timeout: 8000 })
  must((await page.locator('table[aria-label="Журнал операций"] tbody tr').count()) === 1, 'the journal must have one operation')
  const v2 = await axeCheck(page, 'journal')
  must(v2.length === 0, `axe: journal: ${v2.map((x) => x.id).join(', ')}`)
  must(await footerOk(), 'the footer in the journal does not fit on one line')
  const wrapped = await page.evaluate(() => [...document.querySelectorAll('table[aria-label="Журнал операций"] td.nw')].filter((td) => { const r = document.createRange(); r.selectNodeContents(td); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size > 1 }).length)
  must(wrapped === 0, `values wrapped in the journal: ${wrapped}`)
  await shot(page, 'm3-journal-1280')
  await resize(app, 1920, 1080)
  await page.waitForTimeout(250)
  await shot(page, 'm3-journal-1920')
  await resize(app, 1280, 800)
  // the reason a rollback is not possible is text in the row, not a tooltip
  const jRow = page.locator('table[aria-label="Журнал операций"] tbody tr').first()
  // a comment changes no entry, so the watcher may stay silent: the journal is reopened to read it again
  const reopenJournal = async () => {
    await page.keyboard.press('1')
    await page.keyboard.press('5')
    await jRow.waitFor({ timeout: 8000 })
  }
  writeFileSync(cfg, `${asOff}# чужая правка\n`)
  await reopenJournal()
  await waitFor(async () => (await jRow.innerText()).includes('файл изменён после операции'), 'the journal row says the file changed after the operation')
  must(await jRow.getByRole('button', { name: 'Откатить', exact: true }).isDisabled(), 'the rollback button is active over a changed file')
  writeFileSync(cfg, asOff)
  await reopenJournal()
  await waitFor(async () => !(await jRow.getByRole('button', { name: 'Откатить', exact: true }).isDisabled()), 'the rollback is possible again once the file is back')
  // the rollback goes through the same preview: file, key, before → after; nothing is written before confirmation
  await jRow.getByRole('button', { name: 'Откатить', exact: true }).click()
  await dialog.waitFor({ timeout: 8000 })
  const rbText = await dialog.innerText()
  must(rbText.includes('~/.codex/config.toml') && rbText.includes('plugins."p1@bundled".enabled') && rbText.includes('выключено') && rbText.includes('включено'), `rollback preview: ${rbText}`)
  must(readFileSync(cfg, 'utf8') === asOff, 'the rollback wrote before confirmation')
  await dialog.getByRole('button', { name: 'Откатить', exact: true }).click()
  await dialog.waitFor({ state: 'detached', timeout: 8000 })
  await waitFor(async () => (await page.locator('table[aria-label="Журнал операций"] tbody tr').count()) === 2, 'the rollback is recorded in the journal')
  must(readFileSync(cfg, 'utf8') === original, 'after the rollback the file is byte-for-byte as before the write')
  must((await page.locator('#notice').innerText()).includes('p1@bundled'), 'the rollback message does not name the entry')
  await page.keyboard.press('1')
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('включено'), 'after the rollback the p1 glyph came back')
  // a Claude Code plugin is found in installed_plugins.json but switched in settings.json: the inspector and the preview name the latter
  await clickCell('alpha', 0)
  must((await page.locator('aside').innerText()).includes('~/.claude/settings.json'), 'the inspector does not name the file the switch writes')
  await page.keyboard.press('Space')
  await dialog.waitFor({ timeout: 8000 })
  await dialog.getByText('Строю план…').waitFor({ state: 'detached', timeout: 8000 })
  const plugText = await dialog.innerText()
  must(plugText.includes('~/.claude/settings.json') && plugText.includes('/enabledPlugins/alpha@mp') && !plugText.includes('installed_plugins'), `the plugin preview names another file: ${plugText}`)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached', timeout: 8000 })
  // OpenCode (the sixth column): a V2 server is switched by the inverse `disabled` key (R1) in a JSONC file whose comments stay;
  // the journal rollback brings the file back byte for byte
  {
    must((await page.locator('thead th').allInnerTexts()).some((h) => h.toUpperCase().includes('OPENCODE')), 'the matrix has no OpenCode column')
    const ocFile = join(home, '.config', 'opencode', 'opencode.jsonc')
    const ocOrig = readFileSync(ocFile, 'utf8')
    await clickCell('tool-a', 5)
    await page.keyboard.press('Space')
    await dialog.waitFor({ timeout: 8000 })
    await dialog.getByText('Строю план…').waitFor({ state: 'detached', timeout: 8000 })
    const ocText = await dialog.innerText()
    must(ocText.includes('~/.config/opencode/opencode.jsonc') && ocText.includes('/mcp/servers/tool-a/disabled') && ocText.includes('R1') && !ocText.includes('FAKE-SECRET'), `OpenCode toggle preview: ${ocText}`)
    await shot(page, 'm7-opencode-dialog-1280')
    await dialog.getByRole('button', { name: APPLY }).click()
    await waitFor(async () => String(await cellLabel(page, 'tool-a', 5)).includes('выключено'), 'after the write the OpenCode tool-a glyph is "disabled"')
    const ocAfter = readFileSync(ocFile, 'utf8')
    must(ocAfter.includes('"disabled": true') && ocAfter.includes('// the same server as in Antigravity') && String(await cellLabel(page, 'tool-a', 3)).includes('включено'), 'the OpenCode write lost a comment or touched the Antigravity cell')
    await page.keyboard.press('5')
    const ocRow = page.locator('table[aria-label="Журнал операций"] tbody tr', { hasText: 'tool-a' }).first()
    await ocRow.waitFor({ timeout: 8000 })
    await ocRow.getByRole('button', { name: 'Откатить', exact: true }).click()
    await dialog.waitFor({ timeout: 8000 })
    await dialog.getByRole('button', { name: 'Откатить', exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: 8000 })
    await waitFor(() => readFileSync(ocFile, 'utf8') === ocOrig, 'the OpenCode rollback restored opencode.jsonc byte for byte')
    await page.keyboard.press('1')
    await waitFor(async () => String(await cellLabel(page, 'tool-a', 5)).includes('включено'), 'after the rollback the OpenCode tool-a glyph came back')
    // the system config (%ProgramData%\opencode, a fixture here) shows as scope managed and is read only: no switch, the reason named
    await clickCell('corp-proxy', 5)
    const sysAside = await page.locator('aside').innerText()
    must(sysAside.includes('системного конфига OpenCode'), `the inspector does not say why a system OpenCode entry cannot be switched: ${sysAside.slice(0, 400)}`)
    must(await page.locator('aside').getByRole('button', { name: 'Выключить', exact: true }).isDisabled(), 'a system OpenCode entry must not offer a switch')
  }
  // ---- R2: trash, edit, copy, profiles (also on a fixture copy) ----
  // most MCP servers have no flag: at R1 their "Disable (move to trash)" asks for R2 itself, once, and opens the trash preview
  await stubDialog(1)
  must(await levelIs('R1'), 'before the trash step the level must be R1')
  await clickCell('tool-b', 3)
  askedBefore = await app.evaluate(() => globalThis.__asked)
  await page.locator('aside').getByRole('button', { name: 'Выключить (в корзину)', exact: true }).click()
  await dialog.waitFor({ timeout: 8000 })
  must((await app.evaluate(() => globalThis.__asked)) === askedBefore + 1, 'the trash button must ask the confirmation window exactly once')
  await waitFor(() => levelIs('R2'), 'the trash button raised the level to R2')
  await dialog.getByText('Строю план…').waitFor({ state: 'detached', timeout: 8000 })
  must((await dialog.innerText()).includes('в корзине Loadout'), 'the trash button did not open the trash preview')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached', timeout: 8000 })
  // the header list still raises the level after the confirmation window (lowering needs none)
  await levelSel.selectOption('R1')
  await waitFor(() => levelIs('R1'), 'the level went down to R1')
  await levelSel.selectOption('R2')
  await waitFor(() => levelIs('R2'), 'the level switched to R2')
  const agFile = join(home, '.gemini', 'config', 'mcp_config.json')
  const agOrig = readFileSync(agFile, 'utf8')
  const agJson = () => JSON.parse(readFileSync(agFile, 'utf8'))
  const applyDialog = async (label = APPLY) => {
    await dialog.getByRole('button', { name: label }).waitFor({ timeout: 8000 })
    await page.waitForFunction(() => !document.querySelector('[role=dialog] button[disabled]'), null, { timeout: 8000 })
    await dialog.getByRole('button', { name: label }).click()
    // The window closes when the write response reached the page, while the file changes earlier. While the dialog is open, single
    // keys (`5` is the journal) are disabled, and a step that pressed them right after the file appeared lost the key press: that is how the "add"
    // entry was not found in the journal. We wait for the close here, not in every step.
    await dialog.waitFor({ state: 'detached', timeout: 8000 })
  }
  const openPlan = async () => {
    await dialog.getByText('Строю план…').waitFor({ state: 'detached', timeout: 8000 })
    return dialog.innerText()
  }
  /** A journal rollback: the button in `where` opens the same preview, the dialog's button writes. Returns the preview text. */
  const rollbackRow = async (where, label = 'Откатить') => {
    await where.getByRole('button', { name: label, exact: true }).click()
    await dialog.waitFor({ timeout: 8000 })
    const text = await dialog.innerText()
    await dialog.getByRole('button', { name: 'Откатить', exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: 8000 })
    return text
  }
  const noSecretOnPage = async (what) => must(!(await page.evaluate(() => document.body.innerText)).includes('FAKE-SECRET'), `${what}: FAKE-SECRET found in the window`)

  // trash: Antigravity MCP has no flag, disabling moves the entry out of the file
  await clickCell('tool-b', 3)
  const col = await page.evaluate(() => {
    const b = [...document.querySelectorAll('aside .actions.col button')]
    const r = b.map((x) => x.getBoundingClientRect())
    return { n: b.length, lefts: new Set(r.map((x) => Math.round(x.left))).size, tops: new Set(r.map((x) => Math.round(x.top))).size }
  })
  must(col.n >= 4 && col.lefts === 1 && col.tops === col.n, `the write actions in the inspector must stand in a column, not side by side: ${JSON.stringify(col)}`)
  // a long file path wraps by segments: no segment (`/…/`) is torn between lines
  await shot(page, 'm4-inspector-1280')
  const pathSplit = await page.evaluate(() => {
    const dd = [...document.querySelectorAll('aside dd.wrap')].find((d) => d.querySelector('wbr'))
    // the top of the first and last glyph of a segment: if they differ, the segment is wrapped inside
    const tops = (s) => { const n = s.lastChild, r = document.createRange(); const at = (i) => { r.setStart(n, i); r.setEnd(n, i + 1); return Math.round(r.getBoundingClientRect().top) }; return [at(0), at(n.length - 1)] }
    return dd ? [...dd.querySelectorAll('span')].filter((s) => { const [a, b] = tops(s); return a !== b }).map((s) => s.textContent) : null
  })
  must(pathSplit !== null && pathSplit.length === 0, `the file path in the inspector is torn in the middle of a segment: ${JSON.stringify(pathSplit)}`)
  await page.keyboard.press('Space')
  const trashText = await openPlan()
  must(trashText.includes('в корзине Loadout') && trashText.includes('R2'), `trash move preview: ${trashText}`)
  must(!trashText.includes('FAKE-SECRET'), 'a secret in the trash move preview')
  await shot(page, 'm4-trash-dialog-1280')
  await applyDialog()
  await waitFor(async () => String(await cellLabel(page, 'tool-b', 3)).includes('выключено'), 'tool-b in the trash: glyph "disabled"')
  must(!('tool-b' in agJson().mcpServers) && 'tool-a' in agJson().mcpServers, 'the entry was not moved out of the file or the neighbouring one was touched')
  must((await page.locator('aside').innerText()).includes('корзине'), 'the inspector does not mention the trash')
  await noSecretOnPage('trash')
  await page.locator('#grid').focus()
  await page.keyboard.press('Space') // back
  await openPlan()
  await applyDialog()
  await waitFor(async () => String(await cellLabel(page, 'tool-b', 3)).includes('включено'), 'tool-b came back: glyph "enabled"')
  must(JSON.stringify(agJson()) === JSON.stringify(JSON.parse(agOrig)), 'after the return from the trash the file must equal the original')

  // editing a command: old values are not shown, new secrets are hidden in the preview
  const deskFile = join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
  const deskOrig = readFileSync(deskFile)
  // the form starts from the current command; with a masked part (a password argument) it starts empty and says why
  // an editable MCP whose command the core shows whole (nothing masked)
  const plain = await page.evaluate(async () => {
    const r = await window.loadout.scan()
    const e = r.ok ? r.data.entities.find((x) => x.kind === 'mcp' && x.canEdit && typeof x.detail.command === 'string' && x.detail.exact === true) : undefined
    return e ? { name: e.name, client: e.client, command: e.detail.command } : null
  })
  must(plain !== null, 'fixture: no editable MCP without masked values')
  await clickCell(plain.name, ['claude-code', 'claude-desktop', 'codex', 'antigravity', 'deepseek', 'opencode'].indexOf(plain.client))
  await page.getByRole('button', { name: 'Править команду…' }).click()
  must((await dialog.getByLabel('Команда').inputValue()) === plain.command, `the Edit command form is not filled with the current command of ${plain.name}`)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached', timeout: 5000 })
  await clickCell('desk-tool', 1)
  await page.getByRole('button', { name: 'Править команду…' }).click()
  must((await dialog.getByLabel('Команда').inputValue()) === '' && (await dialog.innerText()).includes('не может показать в точности'), 'a masked command must leave the form empty with an explanation')
  await dialog.getByLabel('Аргументы, по одному в строке').fill('<masked>')
  await dialog.getByLabel('Команда').fill('x')
  must(await dialog.getByRole('button', { name: 'Предпросмотр' }).isDisabled(), 'a typed <masked> must not reach the preview')
  await dialog.getByLabel('Команда').fill('new-cmd')
  await dialog.getByLabel('Аргументы, по одному в строке').fill('--token\nFAKE-SECRET-NEW\n--port\n8080')
  await shot(page, 'm4-edit-dialog-1280')
  await dialog.getByRole('button', { name: 'Предпросмотр' }).click()
  const editText = await openPlan()
  must(editText.includes('<masked>') && !editText.includes('FAKE-SECRET'), `edit preview: ${editText}`)
  await applyDialog()
  await waitFor(() => JSON.parse(readFileSync(deskFile, 'utf8')).mcpServers['desk-tool'].command === 'new-cmd', 'the command was written to the file')
  const editedDesk = JSON.parse(readFileSync(deskFile, 'utf8')).mcpServers['desk-tool']
  must(editedDesk.env.TOKEN === 'FAKE-SECRET-DESKENV' && editedDesk.args[1] === 'FAKE-SECRET-NEW', 'the edit touched env or wrote the wrong arguments')
  await noSecretOnPage('edit')
  await page.keyboard.press('5')
  const editRb = await rollbackRow(page.getByRole('row', { name: /правка/ }))
  must(editRb.includes('claude_desktop_config.json') && editRb.includes('/mcpServers/desk-tool') && !editRb.includes('FAKE-SECRET'), `edit rollback preview: ${editRb}`)
  await waitFor(() => readFileSync(deskFile).equals(deskOrig), 'the edit rollback restored the file byte for byte')

  // copying to another client: the format is converted by itself, env values stay inside the core
  await page.keyboard.press('1')
  const cfgBeforeCopy = readFileSync(cfg)
  await clickCell('tool-a', 3)
  await page.getByRole('button', { name: 'Копировать в клиент…' }).click()
  await dialog.getByLabel('ChatGPT / Codex').check()
  await dialog.getByRole('button', { name: 'Предпросмотр' }).click()
  const copyText = await openPlan()
  must(copyText.includes('~/.codex/config.toml') && copyText.includes('R2') && !copyText.includes('FAKE-SECRET'), `copy preview: ${copyText}`)
  await shot(page, 'm4-copy-dialog-1280')
  await applyDialog()
  await waitFor(() => readFileSync(cfg, 'utf8').includes('[mcp_servers.tool-a]'), 'the entry was copied to Codex config.toml')
  await waitFor(async () => String(await cellLabel(page, 'tool-a', 2)).includes('включено'), 'the matrix has a tool-a entry for Codex')
  await page.keyboard.press('5')
  await rollbackRow(page.getByRole('row', { name: /копия/ }))
  await waitFor(() => readFileSync(cfg).equals(cfgBeforeCopy), 'the copy rollback restored config.toml byte for byte')

  // adding a new MCP: env values go only to the core, the rollback restores the file byte for byte
  await page.keyboard.press('1')
  // a taken name is reported by the form itself, before any plan
  await addItem(page, 'MCP-сервер')
  await dialog.getByLabel('Клиент').selectOption({ label: 'Antigravity' })
  await dialog.getByLabel('Имя', { exact: true }).fill('tool-a')
  await dialog.getByLabel('Команда', { exact: true }).fill('npx')
  await dialog.locator('[role=alert]').waitFor({ timeout: 8000 })
  must((await dialog.locator('[role=alert]').innerText()).includes('уже есть MCP-сервер «tool-a»'), 'the form does not say the name is taken')
  must(await dialog.getByRole('button', { name: 'Предпросмотр' }).isDisabled(), 'the preview is offered for a taken name')
  await dialog.getByRole('button', { name: 'Отмена' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 8000 })
  // a refusal of the core is shown as the core said it, and "Back to the form" keeps everything typed, env included
  writeFileSync(cfg, cfgBeforeCopy.toString('utf8').replace('\n', '\r\n'))
  const addEnv = 'API_TOKEN=FAKE-SECRET-ADDED'
  await addItem(page, 'MCP-сервер')
  await dialog.getByLabel('Клиент').selectOption({ label: 'ChatGPT / Codex' })
  await dialog.getByLabel('Имя', { exact: true }).fill('e2e-added')
  await dialog.getByLabel('Команда', { exact: true }).fill('npx')
  await dialog.getByLabel('Аргументы, по одному в строке').fill('-y\nsome-mcp')
  await dialog.getByLabel(/Переменные окружения/).fill(addEnv)
  await dialog.getByRole('button', { name: 'Предпросмотр' }).click()
  await dialog.locator('[role=alert]').waitFor({ timeout: 8000 })
  const coreRefusal = await dialog.locator('[role=alert]').innerText()
  must(coreRefusal.includes('смешанные') && !coreRefusal.includes('ядро не ответило'), `a core refusal must be shown as is: ${coreRefusal}`)
  await dialog.getByRole('button', { name: 'Назад к форме' }).click()
  await dialog.getByLabel('Имя', { exact: true }).waitFor({ timeout: 8000 })
  const kept = {
    to: await dialog.getByLabel('Клиент').inputValue(),
    name: await dialog.getByLabel('Имя', { exact: true }).inputValue(),
    command: await dialog.getByLabel('Команда', { exact: true }).inputValue(),
    args: await dialog.getByLabel('Аргументы, по одному в строке').inputValue(),
    env: await dialog.getByLabel(/Переменные окружения/).inputValue(),
  }
  must(kept.to === 'codex' && kept.name === 'e2e-added' && kept.command === 'npx' && kept.args === '-y\nsome-mcp' && kept.env === addEnv, `"Back to the form" lost what was typed: ${JSON.stringify({ ...kept, env: kept.env === addEnv })}`)
  writeFileSync(cfg, cfgBeforeCopy)
  await shot(page, 'm4-add-dialog-1280')
  await dialog.getByRole('button', { name: 'Предпросмотр' }).click()
  const addText = await openPlan()
  must(addText.includes('~/.codex/config.toml') && addText.includes('API_TOKEN') && !addText.includes('FAKE-SECRET'), `add preview: ${addText}`)
  await applyDialog()
  await waitFor(() => readFileSync(cfg, 'utf8').includes('[mcp_servers.e2e-added]'), 'the new server was written to Codex config.toml')
  await noSecretOnPage('add')
  await page.keyboard.press('5')
  await rollbackRow(page.getByRole('row', { name: /добавление/ }))
  await waitFor(() => readFileSync(cfg).equals(cfgBeforeCopy), 'the add rollback restored config.toml byte for byte')

  // installing a Claude Code CLI plugin: first the command, then a separate confirmation; bad names are rejected
  await page.keyboard.press('1')
  const pluginErr = (s, dry) => page.evaluate(async ([x, d]) => (await window.loadout.pluginInstall(x, d)).error ?? 'ok', [s, dry])
  must((await pluginErr('x@y --scope local', true)) !== 'ok' && (await pluginErr('../x@y', true)) !== 'ok', 'a plugin name with a space or a path must be rejected')
  must((await pluginErr('only-name', true)) !== 'ok', 'a name without a marketplace must be rejected')
  must((await pluginErr('demo@market', false)).includes('предпросмотр'), 'install without a preview must refuse')
  // marketplace: input that would become a flag, a second command or a foreign git scheme is rejected before launch
  const mpErr = (s, dry) => page.evaluate(async ([x, d]) => (await window.loadout.marketplaceAdd(x, d)).error ?? 'ok', [s, dry])
  for (const bad of ['a/b --scope local', '-x', 'ext::sh -c x', 'file:///C:/x', 'https://u:p@x.test/m', '\\\\srv\\share', join(home, 'nope')]) {
    must((await mpErr(bad, true)) !== 'ok', `the marketplace source must be rejected: ${bad}`)
  }
  must((await mpErr(marketDir, false)).includes('предпросмотр'), 'adding a marketplace without a preview must refuse')
  // marketplace → catalog → install by picking from the list
  await addItem(page, 'Плагин Claude Code')
  await dialog.getByRole('button', { name: 'Добавить маркетплейс…' }).click()
  await dialog.getByLabel('Источник маркетплейса').fill(marketDir)
  await dialog.getByRole('button', { name: 'Предпросмотр' }).click()
  // in the preview the home directory is collapsed to `~`; this step has no screenshot: the input field shows the full path with the user name
  await dialog.getByText(`claude plugin marketplace add --scope user ${tilde(marketDir)}`).waitFor({ timeout: 8000 })
  must(!existsSync(claudeCalls), 'the preview must not run claude')
  await dialog.getByRole('button', { name: 'Добавить маркетплейс', exact: true }).click()
  const catalog = dialog.getByRole('list', { name: 'Каталог e2e-market' })
  await catalog.waitFor({ timeout: 8000 })
  must(await catalog.getByRole('button', { name: /^tool-plugin/ }).isDisabled(), 'a plugin with a command source cannot be installed from here')
  // "Refresh catalog" re-reads the catalogs from disk (no network, no claude call) and says so
  const callsBefore = existsSync(claudeCalls) ? readFileSync(claudeCalls, 'utf8') : ''
  await dialog.getByRole('button', { name: 'Обновить каталог' }).click()
  await dialog.getByText(/^Каталог перечитан с диска/).waitFor({ timeout: 8000 })
  must((existsSync(claudeCalls) ? readFileSync(claudeCalls, 'utf8') : '') === callsBefore && (await catalog.count()) === 1, 'refreshing the catalog ran claude or lost the catalog')
  await catalog.getByRole('button', { name: /^hello-plugin/ }).click()
  await dialog.getByText('claude plugin install hello-plugin@e2e-market --scope user').waitFor({ timeout: 8000 })
  const vCat = await axeCheck(page, 'marketplace catalog')
  must(vCat.length === 0, `axe: marketplace catalog: ${vCat.map((x) => x.id).join(', ')}`)
  await shot(page, 'm4-plugin-dialog-1280')
  // the smallest window (1100×640): the catalog dialog scrolls, its buttons stay in view (shot() measures that)
  await resize(app, 1100, 640)
  await page.waitForTimeout(150)
  await shot(page, 'm4-plugin-dialog-1100x640')
  await resize(app, 1280, 800)
  await dialog.getByRole('button', { name: 'Установить', exact: true }).click()
  const calls = () => (existsSync(claudeCalls) ? readFileSync(claudeCalls, 'utf8').trim().split('\n') : [])
  await waitFor(() => calls().join('|') === `plugin marketplace add --scope user ${marketDir}|plugin install hello-plugin@e2e-market --scope user`, 'claude was called with the exact add and install commands')
  await dialog.waitFor({ state: 'detached', timeout: 8000 })

  // a skill from "GitHub" (a local git repository instead of the network): what and where → download → choose → core plan → journal → rollback
  const skillErr = (s, dry) => page.evaluate(async ([x, d]) => (await window.loadout.skillFetch(x, d)).error ?? 'ok', [s, dry])
  for (const bad of ['acme/skills --upload-pack=x', '-acme/x', 'acme/skills/../x', 'https://gitlab.com/a/b', 'relative\\dir']) {
    must((await skillErr(bad, true)) !== 'ok', `the skill source must be rejected: ${bad}`)
  }
  must((await skillErr('acme/skills', false)).includes('скачано'), 'a download without showing "what will be downloaded" must refuse')
  const badPlan = await page.evaluate(async () => (await window.loadout.plan({ op: 'installSkill', stage: '../../x', sub: '', name: 'a' })).ok)
  must(badPlan === false, 'a skill install plan with a path instead of a preparation number must be rejected')
  const skillDir = join(home, '.claude', 'skills', 'web-search')
  await addItem(page, 'Скил')
  await dialog.getByLabel('Источник скила').fill('acme/skills')
  await dialog.getByRole('button', { name: 'Что будет скачано' }).click()
  await dialog.getByText(/Будет скачано:.*git .*clone --depth 1 .*acme\/skills\.git/).waitFor({ timeout: 8000 })
  await dialog.getByRole('button', { name: 'Скачать и показать' }).click()
  await dialog.getByRole('radio', { name: /web-search/ }).waitFor({ timeout: 20000 })
  await dialog.getByRole('radio', { name: /web-search/ }).check()
  const vSkill = await axeCheck(page, 'skill choice')
  must(vSkill.length === 0, `axe: skill choice: ${vSkill.map((x) => x.id).join(', ')}`)
  await shot(page, 'm6-skill-dialog-1280')
  await dialog.getByRole('button', { name: 'Предпросмотр установки' }).click()
  const skillPlan = await openPlan()
  must(skillPlan.includes('~/.claude/skills/web-search/') && skillPlan.includes('helper.py') && skillPlan.includes('файлы кода'), `skill install preview: ${skillPlan}`)
  must(!existsSync(skillDir), 'the skill is not installed before confirmation')
  // the code warning stands apart in a highlighted box, the size summary and the file list do not
  {
    const box = dialog.getByRole('note', { name: 'Внимание: скил с кодом' })
    const boxText = await box.innerText()
    must(boxText.includes('файлы кода') && boxText.includes('helper.py') && !boxText.includes('файлов:'), `the skill code warning is not set apart: ${boxText}`)
  }
  await shot(page, 'm6-skill-plan-1280')
  await applyDialog()
  await waitFor(() => existsSync(join(skillDir, 'SKILL.md')) && existsSync(join(skillDir, 'helper.py')), 'the skill is installed in ~/.claude/skills/web-search')
  await dialog.waitFor({ state: 'detached', timeout: 8000 })
  await page.keyboard.press('1')
  const skillRow = page.locator('tbody tr', { has: page.locator('td.name b', { hasText: /^web-search$/ }) })
  await waitFor(async () => (await skillRow.count()) === 1, 'the installed skill is visible in the matrix')
  await page.keyboard.press('5')
  await rollbackRow(page.getByRole('row', { name: /установка скила/ }))
  await waitFor(() => !existsSync(skillDir), 'the rollback removed the skill')
  await page.keyboard.press('1')
  await waitFor(async () => (await skillRow.count()) === 0, 'after the skill rollback it is not in the matrix')

  // profiles: capture the state, tweak, apply as a bundle, roll back the whole bundle
  await page.keyboard.press('6')
  await page.getByLabel('Имя профиля').fill('e2e')
  await page.getByRole('button', { name: 'Сохранить текущее состояние' }).click()
  const card = page.getByRole('region', { name: 'Профиль e2e' })
  await card.waitFor({ timeout: 8000 })
  await card.getByText('Записи профиля').click()
  // right after opening, the list is visible whole from the first row (clipping at the top of the screenshot is the scroll from `uncheck()` below)
  const plistOpen = await card.locator('details .plist').evaluate((ul) => ({ top: ul.scrollTop, gap: Math.round(ul.querySelector('li').getBoundingClientRect().top - ul.getBoundingClientRect().top) }))
  must(plistOpen.top === 0 && plistOpen.gap >= 0, `the profile entry list opens clipped: ${JSON.stringify(plistOpen)}`)
  await card.locator('li', { hasText: 'p1@bundled' }).getByRole('checkbox').uncheck()
  await card.getByRole('button', { name: 'Сохранить изменения' }).click()
  await waitFor(async () => !(await card.getByRole('button', { name: 'Сохранить изменения' }).isEnabled()), 'profile saved')
  const profLayout = await page.evaluate(() => ({ hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth }))
  must(profLayout.hscroll <= 0 && profLayout.main <= 1, `horizontal scroll in profiles: ${JSON.stringify(profLayout)}`)
  const v3 = await axeCheck(page, 'profiles')
  must(v3.length === 0, `axe: profiles: ${v3.map((x) => x.id).join(', ')}`)
  await card.locator('details .plist').evaluate((ul) => { ul.scrollTop = 0 }) // `uncheck()` scrolled the list to p1: the screenshot shows what is seen on opening
  await shot(page, 'm4-profiles-1280')
  await resize(app, 1920, 1080)
  await page.waitForTimeout(250)
  await shot(page, 'm4-profiles-1920')
  await resize(app, 1280, 800)
  // the profile's Apply asks for R2 itself: at R0 a refusal opens nothing and keeps R0, consent raises to R2 and opens the batch preview
  await levelSel.selectOption('R0') // lowering needs no confirmation
  await waitFor(() => levelIs('R0'), 'the level went down to R0 before the profile apply')
  await stubDialog(0)
  askedBefore = await app.evaluate(() => globalThis.__asked)
  await card.getByRole('button', { name: 'Применить…' }).click()
  await waitFor(async () => (await app.evaluate(() => globalThis.__asked)) === askedBefore + 1, '"Apply…" at R0 did not ask for R2')
  await page.waitForTimeout(400) // a negative check: a wrong dialog would open after the answer
  must((await dialog.count()) === 0 && (await levelIs('R0')), 'after a refusal the profile apply must open nothing and leave R0')
  await stubDialog(1)
  await card.getByRole('button', { name: 'Применить…' }).click()
  await waitFor(() => levelIs('R2'), '"Apply…" raised the level to R2 after consent')
  await dialog.getByText('Строю план…').waitFor({ state: 'detached', timeout: 8000 })
  const batchText = await dialog.innerText()
  must(batchText.includes('Изменится записей: 1') && batchText.includes('p1@bundled'), `bundle preview: ${batchText}`)
  await shot(page, 'm4-batch-dialog-1280')
  await applyDialog()
  await dialog.waitFor({ state: 'detached', timeout: 8000 }) // while the dialog is open, single keys are disabled
  await page.keyboard.press('1')
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('выключено'), 'profile applied: p1 disabled')
  // the applied profile now describes the state exactly: it is marked; the destructive button is far from "Apply"
  await page.keyboard.press('6')
  await waitFor(async () => (await card.innerText()).includes('совпадает с текущим состоянием'), 'the applied profile is marked as matching the current state')
  const gap = await card.evaluate((c) => {
    const b = (name) => [...c.querySelectorAll('button')].find((x) => x.textContent.trim() === name).getBoundingClientRect()
    return Math.round(b('Удалить профиль…').left - b('Сохранить изменения').right)
  })
  must(gap >= 150, `"Delete profile" sits next to the main buttons (${gap}px)`)
  await page.keyboard.press('5')
  const batchRb = await rollbackRow(page.locator('table[aria-label="Журнал операций"]'), 'Откатить пакет')
  must(batchRb.includes('p1@bundled') && batchRb.includes('~/.codex/config.toml'), `batch rollback preview: ${batchRb}`)
  await page.keyboard.press('1')
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('включено'), 'bundle rolled back: p1 came back')
  must(readFileSync(cfg).equals(cfgBeforeCopy), 'after the bundle rollback config.toml equals the original')
  await page.keyboard.press('6')
  must(!(await card.innerText()).includes('совпадает с текущим состоянием'), 'after the batch rollback the profile no longer matches, but is still marked')
  // deleting asks once more: the first press only offers the confirmation
  await card.getByRole('button', { name: 'Удалить профиль…' }).click()
  must((await card.count()) === 1, 'the profile was deleted without confirmation')
  await card.getByRole('button', { name: 'Не удалять' }).click()
  must(
    await card.getByRole('button', { name: 'Удалить профиль…' }).evaluate((b) => b === document.activeElement),
    '"Keep it" returns the focus to "Delete profile…"',
  )
  await card.getByRole('button', { name: 'Удалить профиль…' }).click()
  await card.getByRole('button', { name: 'Удалить навсегда' }).click()
  await waitFor(async () => (await card.count()) === 0, 'profile deleted')

  // ---- built-in Context Toolkit: install and apply on a fixture copy, diagnostics and effectiveness ----
  const claudeDir = join(home, '.claude')
  const hookExe = join(claudeDir, 'hooks', 'context-toolkit.exe')
  const settingsFile = join(claudeDir, 'settings.json')
  const opts = { withRules: true, desktop: false, antigravity: false, dsh: false, noStopGate: false, lang: 'ru', advisor: 'keep', mainModel: 'keep', effort: 'keep', policyMode: 'keep', commitHygiene: false, confirmIrreversible: false, strayFiles: false, buildSlots: false, buildSlotsN: 2 } // default form: advisor, main model, effort and policies are "do not change"
  const ctxkitJson = join(claudeDir, 'context-toolkit.json')
  // Context Toolkit must not touch the real owner profile: hashes of the files that `setup` writes, before and after the whole step.
  // `~/.claude.json` is not compared: the running Claude Code rewrites it, setup only reads it (the checks use --claude-json pointing to a copy).
  const realHome = homedir()
  const realFiles = ['.claude/settings.json', '.claude/CLAUDE.md', '.claude/hooks/ctxkit.exe', '.claude/hooks/context-toolkit.exe', '.claude/ctxkit.json', '.claude/context-toolkit.json', '.claude/agents/Explore.md', '.claude/agents/checker.md', '.local/bin/ctxkit.exe', '.local/bin/context-toolkit.exe', '.gemini/config/hooks.json', '.dsh/ctxkit-hooks.json', '.dsh/context-toolkit-hooks.json', '.dsh/cordis.patch.yml', '.dsh/profiles/desktop/cordis.patch.yml', 'AppData/Roaming/Claude/ccd-session-presets.json'].map((r) => join(realHome, r))
  const realState = () => realFiles.map((f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'нет'))
  const realBefore = realState()
  const realBackups = () => (existsSync(join(realHome, '.claude', 'backups')) ? readdirSync(join(realHome, '.claude', 'backups')).filter((n) => !n.startsWith('.claude.json.backup')).length : 0)
  const realBackupsBefore = realBackups()
  must(!existsSync(hookExe), 'the fixture copy already has Context Toolkit')
  await page.keyboard.press('7')
  await page.getByText('context-toolkit 0.', { exact: false }).first().waitFor({ timeout: 15000 })
  must(await page.getByRole('heading', { name: 'Инструменты контекста', level: 2 }).isVisible(), 'the section heading is not the Context Toolkit one')
  must(await page.locator('nav').getByRole('button', { name: /^Инструменты контекста/ }).isVisible(), 'the navigation has no Context Toolkit item')
  must((await page.locator('main').innerText()).includes('нет: «Применить» установит'), 'before the install the hooks copy must be "absent"')
  // a doctor fix that is a `context-toolkit setup` command is a window action: the button leads to the Apply form, no CLI text
  {
    const fixBtn = page.getByRole('button', { name: 'Исправить: настроить форму «Применить»' }).first()
    await waitFor(async () => (await fixBtn.count()) > 0, 'a doctor setup fix shown as a button')
    must(!(await page.locator('ul[aria-label="Находки диагностики"]').innerText()).includes('→ context-toolkit setup'), 'the setup command is still shown as a CLI hint')
    await fixBtn.click()
    must(await page.evaluate(() => document.activeElement?.textContent?.startsWith('Предпросмотр')), 'the fix button did not lead to the preview button')
  }
  must(!(await page.locator('main').innerText()).includes('прежняя версия'), 'a clean fixture copy must have no line about a previous version')
  const applyBtn = page.getByRole('button', { name: /^Применить: установить/ })
  must(await applyBtn.isDisabled(), 'apply is available without a preview')
  // the main-process core refuses even bypassing the page: without a preview and without the required level
  const refusal = (o) => page.evaluate(async (x) => (await window.loadout.ctxkitSetup(x, false)).error ?? 'ok', o)
  must((await refusal(opts)).includes('предпросмотр'), 'apply without a preview was not rejected in main')
  must((await refusal({ ...opts, lang: 'de' })).includes('язык'), 'an invalid language was not rejected')
  const settingsBefore = readFileSync(settingsFile, 'utf8')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await page.locator('pre.out').waitFor({ timeout: 30000 })
  const preview = await page.locator('pre.out').innerText()
  // the path of the real home directory (with the user name) is not allowed in the output, with either forward or back slashes
  const leaks = [realHome, realHome.replaceAll('\\', '/')].some((h) => preview.toLowerCase().includes(h.toLowerCase()))
  must(preview.includes('Шлюз Stop: включён'), `no Stop gate line in the preview: ${preview.slice(0, 300)}`)
  must(preview.includes('[dry-run]') && !preview.includes('FAKE-SECRET') && !leaks, `setup preview: ${preview.slice(0, 300)}`)
  must(preview.includes('advisorModel: (не задано) (оставлено'), `the preview with the default form must leave advisorModel: ${preview.slice(0, 400)}`)
  // the default form "Policies: do not change": context-toolkit.json is not created and not mentioned as a change
  must(preview.includes('политики: нет (оставлено') && !existsSync(ctxkitJson), `"Policies: do not change" must not create context-toolkit.json: ${preview.slice(0, 600)}`)
  // Russian UI: the preview has no English service phrases of the old output
  must(englishLeft(preview).length === 0, `English phrases in the Russian setup preview: ${englishLeft(preview).slice(0, 5).join(' // ')}`)
  must(readFileSync(settingsFile, 'utf8') === settingsBefore && !existsSync(hookExe), 'the preview changed files')
  await waitFor(() => applyBtn.isEnabled(), 'after the preview apply is available')
  await page.getByLabel('Язык подсказок, хуков и вывода Инструментов контекста').selectOption('en')
  must(await applyBtn.isDisabled(), 'after the settings change the old preview must not allow apply')
  await page.getByLabel('Язык подсказок, хуков и вывода Инструментов контекста').selectOption('ru')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'preview repeated')
  await shot(page, 'm5-ctxkit-1280')
  await resize(app, 1920, 1080)
  await page.waitForTimeout(250)
  await shot(page, 'm5-ctxkit-1920')
  await resize(app, 1280, 800)
  await applyBtn.click()
  await waitFor(() => existsSync(hookExe), 'setup installed the hooks binary')
  await waitFor(() => readFileSync(settingsFile, 'utf8').includes('context-toolkit.exe'), 'setup wrote the hooks to settings.json')
  must(existsSync(join(claudeDir, 'backups')), 'setup did not make a backup before writing')
  await waitFor(async () => (await page.locator('main').innerText()).includes('~/.claude/hooks/context-toolkit.exe: ● совпадает'), 'status: the hooks copy matches the built-in one')
  // diagnostics and effectiveness on the fixture transcripts
  await page.locator('ul[aria-label="Находки диагностики"] li').first().waitFor({ timeout: 15000 })
  await page.locator('table[aria-label="Ходы по дням"] tbody tr').first().waitFor({ timeout: 30000 })
  const eff = await page.locator('main').innerText()
  must(eff.includes('на Sonnet и Haiku') && eff.includes('checker ×'), `no effectiveness summary: ${eff.slice(-600)}`)
  // the period and "Recalculate" on one line; during the calculation the button is busy and it is visible; afterwards the calculation time
  const recalc = page.locator('section[aria-label="Эффективность"]').getByRole('button', { name: /^(Пересчитать|Считаю…)$/ })
  await waitFor(async () => (await page.locator('section[aria-label="Эффективность"] [role=status]').innerText()).includes('Посчитано в'), 'after the first calculation the time is shown')
  const effRow = await page.evaluate(() => {
    const s = document.querySelector('select[aria-label="Период отчёта"]').getBoundingClientRect()
    const b = [...document.querySelectorAll('section[aria-label="Эффективность"] button')][0].getBoundingClientRect()
    return { dy: Math.abs(s.top + s.height / 2 - (b.top + b.height / 2)), below: b.top > s.bottom }
  })
  must(effRow.dy <= 4 && !effRow.below, `the period and "Recalculate" must be on one line: ${JSON.stringify(effRow)}`)
  await page.getByLabel('Период отчёта').selectOption('30')
  await waitFor(async () => (await recalc.innerText()).includes('Считаю') || (await page.locator('section[aria-label="Эффективность"] [role=status]').innerText()).includes('Посчитано'), 'changing the period starts a calculation')
  await waitFor(async () => (await recalc.isEnabled()) && (await recalc.innerText()) === 'Пересчитать', 'the 30-day calculation finished, the button is available again')
  await page.getByLabel('Период отчёта').selectOption('14')
  await waitFor(async () => (await recalc.isEnabled()) && (await recalc.innerText()) === 'Пересчитать', 'the 14-day calculation finished')
  // the whole diagnostics list, without internal scrolling that clipped the last finding
  const diag = await page.evaluate(() => { const u = document.querySelector('ul[aria-label="Находки диагностики"]'); return u.scrollHeight - u.clientHeight })
  must(diag <= 1, `the diagnostics list scrolls inside and clips rows: ${diag}`)
  await page.locator('section[aria-label="Диагностика"]').screenshot({ path: join(shotDir, 'm5-ctxkit-diag-1280.png') })
  await page.locator('section[aria-label="Эффективность"]').screenshot({ path: join(shotDir, 'm5-ctxkit-efficiency-1280.png') })
  const ctxLayout = await page.evaluate(() => ({ h: document.documentElement.scrollWidth - document.documentElement.clientWidth, m: document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth }))
  must(ctxLayout.h <= 0 && ctxLayout.m <= 1, `horizontal scroll in the Context Toolkit section: ${JSON.stringify(ctxLayout)}`)
  const v4 = await axeCheck(page, 'Context Toolkit')
  must(v4.length === 0, `axe: Context Toolkit: ${v4.map((x) => x.id).join(', ')}`)
  await noSecretOnPage('Context Toolkit')
  // applying with the default form (advisor "do not change") does not create model, advisorModel and effortLevel
  const sKeep = JSON.parse(readFileSync(settingsFile, 'utf8'))
  const sBase = JSON.parse(settingsBefore)
  for (const k of ['model', 'advisorModel', 'effortLevel', 'modelSettings']) must(JSON.stringify(sKeep[k]) === JSON.stringify(sBase[k]) && !(k in sKeep), `the default form wrote ${k}: ${JSON.stringify(sKeep[k])}`)
  // an explicit Fable choice: the preview shows the change, apply writes advisorModel
  await page.getByLabel('Модель-советник').selectOption('fable')
  must(await applyBtn.isDisabled(), 'after choosing the advisor the old preview must not allow apply')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'preview with the Fable advisor')
  must((await page.locator('pre.out').innerText()).includes('advisorModel: (не задано) -> fable'), 'the preview with Fable did not show the advisorModel entry')
  must(!('advisorModel' in JSON.parse(readFileSync(settingsFile, 'utf8'))), 'the preview with Fable wrote advisorModel')
  await applyBtn.click()
  await waitFor(() => JSON.parse(readFileSync(settingsFile, 'utf8')).advisorModel === 'fable', 'the explicit Fable choice wrote advisorModel')
  // Stop gate: installed by default (hook + finding stop_gate "ok"), with the checkbox cleared the hook is removed (finding "no gate")
  const ourStop = () => (JSON.parse(readFileSync(settingsFile, 'utf8')).hooks?.Stop ?? []).filter((g) => (g.hooks ?? []).some((h) => /(^|[\\/"])context-toolkit(\.exe)?("|\s|$)/i.test(h.command ?? ''))).length
  const findings = () => page.locator('ul[aria-label="Находки диагностики"]').innerText()
  must(ourStop() === 1, `our Stop hook is missing after apply (${ourStop()})`)
  await waitFor(async () => (await findings()).includes('шлюз Stop установлен'), 'doctor: the Stop gate is installed')
  const gateBox = page.getByRole('checkbox', { name: /Шлюз Stop/ })
  must(await gateBox.isChecked(), 'the "Stop gate" checkbox must be checked by default')
  await gateBox.uncheck()
  must(await applyBtn.isDisabled(), 'after the checkbox changes the old preview must not allow apply')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'preview without the Stop gate')
  must(ourStop() === 1, 'the preview without the gate changed settings.json')
  await applyBtn.click()
  await waitFor(() => ourStop() === 0, 'setup removed the Stop hook when the checkbox is cleared')
  await waitFor(async () => (await findings()).includes('нет шлюза Stop'), 'doctor: no Stop gate')
  must(JSON.parse(readFileSync(settingsFile, 'utf8')).hooks.PreToolUse !== undefined, 'removing the gate affected the other hooks')
  // the window passes --advisor only on an explicit choice: the main model and effort stay as they were, the advisor is the form's choice (Fable is chosen above)
  const sNow = JSON.parse(readFileSync(settingsFile, 'utf8'))
  const sPre = JSON.parse(settingsBefore)
  must(sNow.model === sPre.model && sNow.effortLevel === sPre.effortLevel && JSON.stringify(sNow.modelSettings) === JSON.stringify(sPre.modelSettings), 'the window changed model, effortLevel or modelSettings')
  must(sNow.advisorModel === 'fable', `advisorModel from the form was not written: ${sNow.advisorModel}`)
  // the "Main model" and "Effort" selects: default "Do not change", an explicit Sonnet + high choice is visible in the preview and written after apply
  const mainSel = page.getByLabel('Основная модель', { exact: true })
  const effortSel = page.getByLabel('Усилие модели (effort)', { exact: true })
  must((await mainSel.inputValue()) === 'keep' && (await effortSel.inputValue()) === 'keep', 'the main model and effort selects must default to "Do not change"')
  must((await mainSel.locator('option').allInnerTexts()).join('|') === 'Не менять (по умолчанию)|Sonnet|Opus|Haiku', 'main model options')
  must((await effortSel.locator('option').allInnerTexts()).join('|') === 'Не менять (по умолчанию)|low|medium|high|xhigh', 'effort options')
  must((await page.locator('#ctx-effort-hint').innerText()).includes('2.1.251'), 'there is no Claude Code version hint under the effort select')
  await mainSel.selectOption('sonnet')
  await effortSel.selectOption('high')
  must(await applyBtn.isDisabled(), 'after choosing the model and effort the old preview must not allow apply')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'preview with Sonnet and high')
  const modelPreview = await page.locator('pre.out').innerText()
  for (const line of ['model: (не задано) -> sonnet', 'effortLevel: (не задано) -> high', 'effort modelSettings.claude-sonnet-5-5: (не задано) -> high']) must(modelPreview.includes(line), `the preview with Sonnet and high lacks the line "${line}": ${modelPreview.slice(0, 500)}`)
  must(englishLeft(modelPreview).length === 0, `English phrases in the Russian preview with a model: ${englishLeft(modelPreview).slice(0, 5).join(' // ')}`)
  must(!('model' in JSON.parse(readFileSync(settingsFile, 'utf8'))), 'the preview with Sonnet wrote model')
  await mainSel.selectOption('keep')
  await effortSel.selectOption('keep')
  must(await applyBtn.isDisabled(), 'after returning to "Do not change" the old preview must not allow apply')
  await mainSel.selectOption('sonnet')
  await effortSel.selectOption('high')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'preview with Sonnet and high repeated')
  await applyBtn.click()
  await waitFor(() => JSON.parse(readFileSync(settingsFile, 'utf8')).model === 'sonnet', 'the Sonnet choice wrote model')
  const sModel = JSON.parse(readFileSync(settingsFile, 'utf8'))
  must(sModel.modelSettings?.['claude-sonnet-5-5']?.effortLevel === 'high' && sModel.effortLevel === 'high', `effort high was not written: ${JSON.stringify({ ms: sModel.modelSettings, e: sModel.effortLevel })}`)
  const foreignStart = (s) => s.hooks.SessionStart.flatMap((g) => g.hooks ?? []).map((h) => h.command).filter((c) => !/context-toolkit|ctxkit/i.test(c))
  must(sModel.advisorModel === 'fable' && JSON.stringify(foreignStart(sModel)) === JSON.stringify(foreignStart(sPre)), `writing the model and effort touched the advisor or foreign hooks: ${sModel.advisorModel} ${JSON.stringify(sModel.hooks.SessionStart)} / ${JSON.stringify(sPre.hooks.SessionStart)}`)
  // leaving the section and coming back: the checkbox is taken from the profile (no gate), not reset to "gate enabled"
  await page.keyboard.press('1')
  await page.keyboard.press('7')
  await page.locator('ul[aria-label="Находки диагностики"] li').first().waitFor({ timeout: 15000 })
  await waitFor(async () => (await findings()).includes('нет шлюза Stop'), 'doctor after returning to the section')
  await waitFor(async () => !(await page.getByRole('checkbox', { name: /Шлюз Stop/ }).isChecked()), 'the "Stop gate" checkbox must stay cleared after returning to the section')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(async () => (await page.locator('pre.out').innerText()).includes('Шлюз Stop: выключен'), 'the preview after returning must say "Stop gate: off"')
  must(ourStop() === 0, 'the preview after returning brought the gate back')
  // ---- "Protection" policies from the window: "do not change" does not create context-toolkit.json; "enable selected" with two policies creates it, the preview shows the lines ----
  must(!existsSync(ctxkitJson), 'context-toolkit.json must not exist before choosing policies: "do not change" does not create it')
  const polSel = page.getByLabel('Политики', { exact: true })
  const hygiene = page.getByRole('checkbox', { name: /Гигиена коммитов/ })
  const slotsBox = page.getByRole('checkbox', { name: /Лимит параллельных сборок/ })
  const slotsNum = page.getByLabel('Лимит параллельных сборок, от 1 до 8')
  must((await polSel.inputValue()) === 'keep' && (await polSel.locator('option').allInnerTexts()).join('|') === 'Не менять (по умолчанию)|Включить выбранные|Выключить все', 'policies select: default "Do not change"')
  must((await page.locator('#ctx-policy-hint').innerText()).includes('файла политик нет'), 'the caption under the policies without a policy file must say there is none')
  // under "Do not change" the checkboxes show what is on now (no file: nothing) and a tick switches the mode by itself
  must(!(await hygiene.isDisabled()) && !(await hygiene.isChecked()) && !(await slotsBox.isChecked()), 'with "Do not change" and no policy file the checkboxes must show nothing on and be available')
  await hygiene.check()
  must((await polSel.inputValue()) === 'on', 'a policy tick did not switch the mode to "Turn on the selected"')
  await slotsBox.check()
  await slotsNum.fill('3')
  must(await applyBtn.isDisabled(), 'after choosing policies the old preview must not allow apply')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'preview with policies')
  const polPreview = await page.locator('pre.out').innerText()
  for (const line of ['политика commit_hygiene: выкл -> вкл', 'политика build_slots: выкл -> 3', 'политика stray_files: выкл (без изменений)']) must(polPreview.includes(line), `the policy preview lacks the line "${line}": ${polPreview.slice(0, 700)}`)
  must(englishLeft(polPreview).length === 0, `English phrases in the Russian policy preview: ${englishLeft(polPreview).slice(0, 5).join(' // ')}`)
  must(!existsSync(ctxkitJson), 'the policy preview created context-toolkit.json')
  await page.locator('fieldset.choices', { has: page.locator('#ctx-policy') }).screenshot({ path: join(shotDir, 'm5-ctxkit-policies-1280.png') })
  await applyBtn.click()
  await waitFor(() => existsSync(ctxkitJson), 'apply created context-toolkit.json')
  const polCfg = JSON.parse(readFileSync(ctxkitJson, 'utf8'))
  must(polCfg.policies?.commit_hygiene === true && polCfg.policies?.build_slots === 3 && !polCfg.policies?.stray_files && polCfg.created_by === 'context-toolkit setup', `context-toolkit.json after apply: ${JSON.stringify(polCfg)}`)
  // the "currently enabled" caption comes from the policies finding and does not change the form
  await waitFor(async () => (await page.locator('#ctx-policy-hint').innerText()).includes('Сейчас включены: commit_hygiene, build_slots=3'), 'the "Currently enabled" caption from diagnostics')
  must((await polSel.inputValue()) === 'on', 'the caption from diagnostics changed the form')
  await polSel.selectOption('keep')
  // back to "Turn on the selected" through the list: it starts from the policies on now, nothing is switched off unseen
  await polSel.selectOption('on')
  must((await hygiene.isChecked()) && (await slotsBox.isChecked()) && (await slotsNum.inputValue()) === '3', 'choosing "Turn on the selected" dropped the policies that are on')
  await polSel.selectOption('keep')
  // ---- rollback on a fixture copy: preview, R2, foreign hooks in place, a repeat is safe ----
  const undoOpts = { antigravity: false, dsh: false }
  const undoRefusal = (o, dry) => page.evaluate(async ([x, d]) => (await window.loadout.ctxkitUninstall(x, d)).error ?? 'ok', [o, dry])
  const undoPreviewBtn = page.getByRole('button', { name: 'Показать, что уберёт откат', exact: true })
  const undoGoBtn = page.getByRole('button', { name: 'Откатить: убрать хуки, блок правил и бинарь' })
  const foreignCmds = (s) => Object.values(s.hooks ?? {}).flat().flatMap((g) => g.hooks ?? []).map((h) => h.command ?? '').filter((c) => !/(^|[\\/"])(context-toolkit|ctxkit)(\.exe)?("|\s|$)/i.test(c)).sort()
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v)
  const claudeMd = join(claudeDir, 'CLAUDE.md')
  const settingsHooked = readFileSync(settingsFile, 'utf8')
  must(foreignCmds(JSON.parse(settingsBefore)).length === 3 && JSON.stringify(foreignCmds(JSON.parse(settingsHooked))) === JSON.stringify(foreignCmds(JSON.parse(settingsBefore))), 'before the rollback the foreign hooks of the fixture must be in place')
  must(existsSync(claudeMd) && readFileSync(claudeMd, 'utf8').includes('<!-- context-toolkit:start -->'), 'before the rollback CLAUDE.md has no rules block')
  must((await undoGoBtn.count()) === 0, 'the rollback button is visible without a rollback preview')
  must((await undoRefusal(undoOpts, false)).includes('предпросмотр'), 'a rollback without a rollback preview (only a setup preview exists) was not rejected in main')
  must((await undoRefusal({ antigravity: 'yes', dsh: false }, true)).includes('параметры'), 'invalid rollback parameters were not rejected')
  must((await undoRefusal(undoOpts, 'x')).includes('параметры'), 'an invalid rollback dryRun was not rejected')
  // busy state: right after the click the button shows "Counting…" with a spinner, the status line says it is in progress, all buttons are disabled
  const busyNow = await page.evaluate(() => {
    const sec = document.querySelector('section[aria-label="Откат"]')
    const b = [...sec.querySelectorAll('button')].find((x) => x.textContent === 'Показать, что уберёт откат')
    // the state is captured at the first moment the DOM showed the busy state (MutationObserver, not a pause: the response is fast)
    return new Promise((resolve) => {
      const snap = () => ({ label: b.textContent, spin: !!b.querySelector('.spin'), status: sec.querySelector('[role=status]').textContent, allDisabled: [...sec.querySelectorAll('button')].every((x) => x.disabled) })
      const mo = new MutationObserver(() => {
        if (b.textContent !== 'Считаю…') return
        mo.disconnect()
        resolve(snap())
      })
      mo.observe(sec, { childList: true, subtree: true, characterData: true })
      setTimeout(() => { mo.disconnect(); resolve(snap()) }, 3000)
      b.click()
    })
  })
  must(busyNow.label === 'Считаю…' && busyNow.spin && busyNow.status.includes('Считаю предпросмотр отката') && busyNow.allDisabled, `rollback button busy state: ${JSON.stringify(busyNow)}`)
  await undoGoBtn.waitFor({ timeout: 30000 })
  await waitFor(() => undoGoBtn.isDisabled().then((d) => !d), 'after the rollback preview the rollback button is available')
  const undoPreview = await page.locator('pre.out').innerText()
  must(undoPreview.includes('[dry-run]') && undoPreview.includes('Не тронуто') && undoPreview.includes('sonnet') && undoPreview.includes('fable'), `the rollback preview lacks the "not touched" list with model and advisorModel: ${undoPreview.slice(0, 600)}`)
  must(![realHome, realHome.replaceAll('\\', '/')].some((h) => undoPreview.toLowerCase().includes(h.toLowerCase())), 'the rollback preview showed the path of the real profile')
  must(englishLeft(undoPreview).length === 0, `English phrases in the Russian rollback preview: ${englishLeft(undoPreview).slice(0, 5).join(' // ')}`)
  must(undoPreview.includes('context-toolkit.json удалён (его создал setup)') && existsSync(ctxkitJson), `the rollback preview must list the removal of the context-toolkit.json created by setup, and the file must still exist:${undoPreview.slice(0, 500)}`)
  must((await page.locator('main').innerText()).includes('Предпросмотр отката: файлы не менялись.'), 'no rollback preview caption')
  must(readFileSync(settingsFile, 'utf8') === settingsHooked && existsSync(hookExe), 'the rollback preview changed files')
  // the rollback preview does not allow "Apply", and changing the form clears the rollback preview
  must(await applyBtn.isDisabled(), 'after the rollback preview "Apply" must not be available')
  must((await refusal(opts)).includes('предпросмотр'), 'apply after the rollback preview was not rejected in main')
  await page.getByRole('checkbox', { name: 'Antigravity' }).check()
  must((await undoGoBtn.count()) === 0, 'after the form changes the rollback button must disappear')
  await page.getByRole('checkbox', { name: 'Antigravity' }).uncheck()
  await undoPreviewBtn.click()
  await waitFor(() => undoGoBtn.isEnabled(), 'rollback preview repeated')
  // alignment of the new form rows by measurement: labels and selects on one left edge, buttons of equal width, hints in the card, nothing clipped
  const formLayout = () => page.evaluate(() => {
    const sec = document.querySelector('section[aria-label="Применение"]')
    const r = (e) => e.getBoundingClientRect()
    const ids = ['ctx-lang', 'ctx-main', 'ctx-effort', 'ctx-advisor']
    const sels = ids.map((id) => r(document.getElementById(id)))
    const lbls = ids.map((id) => r(document.querySelector(`label[for=${id}]`)))
    const btns = [...sec.querySelectorAll('.actions button')]
    const br = btns.map(r)
    const hints = [...sec.querySelectorAll('.field > .small')].map(r)
    const spread = (xs) => Math.max(...xs) - Math.min(...xs)
    // the rollback card comes after the apply card, its red button is not in the apply row
    const undoSec = document.querySelector('section[aria-label="Откат"]')
    return {
      selDx: spread(sels.map((x) => x.left)), lblDx: spread(lbls.map((x) => x.left)), lblSelDx: Math.abs(lbls[0].left - sels[0].left),
      btnCount: btns.length, btnLeftDx: Math.abs(br[0].left - sels[0].left), btnWidthDx: 0,
      btnClipped: btns.some((b) => b.scrollWidth > b.clientWidth + 1),
      // preview then apply, on one line, apply filled as the main action
      btnsOrdered: br.length === 2 && Math.abs(br[0].top - br[1].top) <= 1 && br[1].left >= br[0].right && btns[1].classList.contains('primary'),
      undoBelow: r(undoSec).top >= r(sec).bottom,
      hintsOut: hints.some((x) => x.right > r(sec).right + 0.5 || x.left < r(sec).left - 0.5),
      statusBelow: r(sec.querySelector('[role=status]')).top >= br[br.length - 1].bottom - 1,
      hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, mScroll: document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth,
    }
  })
  for (const w of [1100, 1280, 1920]) {
    await resize(app, w, 800)
    await page.waitForTimeout(250)
    const f = await formLayout()
    must(f.selDx <= 1 && f.lblDx <= 1 && f.lblSelDx <= 1 && f.btnCount === 2 && f.btnLeftDx <= 1 && !f.btnClipped && f.btnsOrdered && f.undoBelow && !f.hintsOut && f.statusBelow && f.hScroll <= 0 && f.mScroll <= 1, `alignment of the Context Toolkit form at ${w}: ${JSON.stringify(f)}`)
    if (w !== 1100) await shot(page, `m5-ctxkit-undo-${w}`)
  }
  await resize(app, 1280, 800)
  await page.waitForTimeout(250)
  const v5 = await axeCheck(page, 'Context Toolkit: rollback preview')
  must(v5.length === 0, `axe: the Context Toolkit form with a rollback preview: ${v5.map((x) => x.id).join(', ')}`)
  await undoGoBtn.click()
  await waitFor(() => !existsSync(hookExe), 'the rollback removed the hooks binary')
  await waitFor(async () => (await page.locator('main').innerText()).includes('Откат выполнен.'), 'after the rollback there is no "Rollback done." caption')
  await waitFor(async () => (await page.locator('#notice').innerText().catch(() => '')).includes('Откат Инструментов контекста выполнен'), 'after the rollback there is no notification')
  must(await page.evaluate(() => document.activeElement?.textContent === 'Показать, что уберёт откат'), 'after the rollback focus did not return to the rollback preview button')
  must((await undoRefusal(undoOpts, false)).includes('предпросмотр'), 'one rollback preview allowed a second rollback')
  await waitFor(async () => (await page.locator('main').innerText()).includes('~/.claude/hooks/context-toolkit.exe: ✕ нет'), 'status after the rollback: the hooks copy is gone')
  const undone = JSON.parse(readFileSync(settingsFile, 'utf8'))
  must(!/context-toolkit|ctxkit/i.test(JSON.stringify(undone)), `our entries remain in settings.json after the rollback: ${JSON.stringify(undone).slice(0, 400)}`)
  must(JSON.stringify(foreignCmds(undone)) === JSON.stringify(foreignCmds(JSON.parse(settingsBefore))), 'the rollback touched foreign hooks')
  must(undone.model === 'sonnet' && undone.advisorModel === 'fable' && undone.modelSettings?.['claude-sonnet-5-5']?.effortLevel === 'high', 'the rollback touched the model, advisor or effort: it leaves them')
  const { model: _m, advisorModel: _a, effortLevel: _e, modelSettings: _s, ...rest } = undone
  must(JSON.stringify(canon(rest)) === JSON.stringify(canon(JSON.parse(settingsBefore))), `after the rollback settings.json without model, advisor and effort differs from the original: ${JSON.stringify(canon(rest)).slice(0, 400)}`)
  must(!existsSync(claudeMd) || !/context-toolkit|ctxkit/i.test(readFileSync(claudeMd, 'utf8')), 'the rollback left the rules block in CLAUDE.md')
  must(!existsSync(ctxkitJson), 'the rollback from the window did not remove the context-toolkit.json created by setup')
  must(existsSync(join(claudeDir, 'agents', 'checker.md')) && existsSync(join(claudeDir, 'agents', 'Explore.md')), 'the rollback deleted the agents: it leaves them')
  must((await page.locator('pre.out').innerText()).includes('backups'), 'the rollback output has no path to the settings.json backup')
  // a repeat is safe: the second rollback changes nothing and does not fail
  const settingsUndone = readFileSync(settingsFile, 'utf8')
  await undoPreviewBtn.click()
  await waitFor(() => undoGoBtn.isEnabled(), 'repeated rollback preview')
  await undoGoBtn.click()
  await waitFor(async () => (await page.locator('main').innerText()).includes('Откат выполнен.'), 'the repeated rollback finished')
  must(readFileSync(settingsFile, 'utf8') === settingsUndone && !existsSync(hookExe) && !(await page.locator('main [role=alert]').count()), 'the repeated rollback changed files or showed an error')
  // integration checkboxes reach setup: the rollback preview with Antigravity and DeepSeek Harness mentions them (on a copy, writes nothing)
  const integ = await page.evaluate(async () => (await window.loadout.ctxkitUninstall({ antigravity: true, dsh: true }, true)).data?.output ?? '')
  must(/antigravity/i.test(integ) && /DeepSeek/i.test(integ) && integ.includes('[dry-run]'), `the rollback preview with integrations has no lines about Antigravity and DeepSeek: ${integ.slice(0, 400)}`)
  must(englishLeft(integ).length === 0, `English phrases in the Russian rollback preview with integrations: ${englishLeft(integ).slice(0, 5).join(' // ')}`)
  must(![realHome, realHome.replaceAll('\\', '/')].some((h) => integ.toLowerCase().includes(h.toLowerCase())), 'the rollback preview with integrations showed the path of the real profile')
  // ---- migration from the previous install (ctxkit) on a fixture copy: the line about the previous version, its preview button,
  // "Apply", the result under the new name, foreign entries in place; then the rollback returns the copy to the state before the step ----
  const oldHookExe = join(claudeDir, 'hooks', 'ctxkit.exe')
  mkdirSync(join(claudeDir, 'hooks'), { recursive: true })
  copyFileSync(join(appDir, 'build', 'context-toolkit.exe'), oldHookExe) // a binary with the previous name: its --version is also "our product"
  const oldCmd = `"${oldHookExe.replaceAll('\\', '/')}"`
  const sLegacy = JSON.parse(readFileSync(settingsFile, 'utf8'))
  sLegacy.env = { ...(sLegacy.env ?? {}), CTXKIT_LANG: 'ru' }
  const oldGroup = (matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: oldCmd, timeout: 10 }] })
  sLegacy.hooks = { ...sLegacy.hooks, PreToolUse: [oldGroup('Bash|PowerShell|Write|Read|Edit|MultiEdit'), ...(sLegacy.hooks?.PreToolUse ?? [])], PostToolUse: [oldGroup('Edit|Write|MultiEdit'), ...(sLegacy.hooks?.PostToolUse ?? [])] }
  writeFileSync(settingsFile, JSON.stringify(sLegacy, null, 2))
  const mdOwn = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : ''
  writeFileSync(claudeMd, `${mdOwn}\n<!-- ctxkit:start -->\n## Команда моделей и экономия контекста (ctxkit)\n\n- старое правило\n<!-- ctxkit:end -->\n`)
  writeFileSync(join(claudeDir, 'ctxkit.json'), JSON.stringify({ created_by: 'ctxkit setup', policies: { stray_files: true } }))
  await page.keyboard.press('1')
  await page.keyboard.press('7')
  const legacyLine = 'Установлена прежняя версия (ctxkit): нажмите «Применить», чтобы перейти на «Инструменты контекста»'
  await waitFor(async () => (await page.locator('main').innerText()).includes(legacyLine), 'the section did not see the previous install (ctxkit)')
  await waitFor(async () => (await findings()).includes('старом имени ctxkit'), 'doctor: no finding about the old name')
  await page.locator('section[aria-label="Установка"]').screenshot({ path: join(shotDir, 'm5-ctxkit-legacy-1280.png') })
  must((await axeCheck(page, 'Context Toolkit: previous version')).length === 0, 'axe: the previous version line')
  await page.getByRole('button', { name: 'Предпросмотр перехода', exact: true }).click()
  await waitFor(() => applyBtn.isEnabled(), 'the migration preview allowed "Apply"')
  const legacyPreview = await page.locator('pre.out').innerText()
  // the old binary is still run by the DeepSeek Harness hooks of the fixture (~/.dsh/ctxkit-hooks.json, and the desktop profile, which
  // setup --dsh would rewrite, is absent from the fixture): the migration leaves it and says why, otherwise DSH would be left with a hook pointing nowhere
  for (const line of ['старое имя: хуки на ctxkit.exe ->', 'старое имя: env.CTXKIT_LANG -> env.CONTEXT_TOOLKIT_LANG', '[dry-run] старое имя: копирование', 'старый бинарь оставлен', 'читает только этот файл']) must(legacyPreview.includes(line), `the migration preview lacks the line "${line}": ${legacyPreview.slice(0, 800)}`)
  must(englishLeft(legacyPreview).length === 0, `English phrases in the Russian migration preview: ${englishLeft(legacyPreview).slice(0, 5).join(' // ')}`)
  must(existsSync(oldHookExe) && readFileSync(settingsFile, 'utf8').includes('ctxkit.exe'), 'the migration preview changed files')
  await applyBtn.click()
  await waitFor(() => existsSync(hookExe) && !readFileSync(settingsFile, 'utf8').includes('ctxkit.exe'), 'migration: hooks on the new binary')
  const legacyOut = await page.locator('pre.out').innerText()
  must(existsSync(oldHookExe) && legacyOut.includes('старый бинарь оставлен') && legacyOut.includes('DeepSeek Harness') && legacyOut.includes('context-toolkit setup --dsh'), `migration: the old binary that DSH still needs must stay with an explanation: ${legacyOut.slice(-800)}`)
  await waitFor(async () => (await page.locator('main').innerText()).includes('Остался бинарь прежней версии ~/.claude/hooks/ctxkit.exe'), 'after the migration there is no line about the leftover old binary')
  const sMoved = JSON.parse(readFileSync(settingsFile, 'utf8'))
  must(!JSON.stringify(sMoved.hooks).includes('ctxkit.exe') && JSON.stringify(sMoved.hooks).includes('context-toolkit.exe'), `migration: hooks are not on the new binary: ${JSON.stringify(sMoved.hooks).slice(0, 400)}`)
  must(sMoved.env?.CONTEXT_TOOLKIT_LANG === 'ru' && !('CTXKIT_LANG' in (sMoved.env ?? {})), `migration: hooks language: ${JSON.stringify(sMoved.env)}`)
  must(JSON.stringify(foreignCmds(sMoved)) === JSON.stringify(foreignCmds(JSON.parse(settingsBefore))), 'the migration touched foreign hooks')
  const mdMoved = readFileSync(claudeMd, 'utf8')
  must(mdMoved.includes('<!-- context-toolkit:start -->') && !mdMoved.includes('ctxkit:') && mdMoved.startsWith(mdOwn.trimEnd()), `migration: rules block: ${mdMoved.slice(-400)}`)
  // ctxkit.json created by setup stays together with the old binary that reads it; the new file is its copy
  must(existsSync(join(claudeDir, 'ctxkit.json')) && JSON.parse(readFileSync(ctxkitJson, 'utf8')).policies?.stray_files === true, 'migration: the policy file was not copied or the old one was removed while the old binary is still needed')
  await waitFor(async () => { const m = await page.locator('main').innerText(); return !m.includes('Установлена прежняя версия') && m.includes('~/.claude/hooks/context-toolkit.exe: ● совпадает') }, 'after the migration the previous version line remained')
  await page.locator('section[aria-label="Установка"]').screenshot({ path: join(shotDir, 'm5-ctxkit-legacy-left-1280.png') })
  await undoPreviewBtn.click()
  await waitFor(() => undoGoBtn.isEnabled(), 'rollback preview after the migration')
  await undoGoBtn.click()
  await waitFor(() => !existsSync(hookExe) && !existsSync(oldHookExe) && !existsSync(ctxkitJson) && !existsSync(join(claudeDir, 'ctxkit.json')), 'the rollback after the migration removes both binaries and both policy files')
  must(!/context-toolkit|ctxkit/i.test(readFileSync(settingsFile, 'utf8')) && JSON.stringify(foreignCmds(JSON.parse(readFileSync(settingsFile, 'utf8')))) === JSON.stringify(foreignCmds(JSON.parse(settingsBefore))), 'the rollback after the migration left ours or touched foreign')
  await levelSel.selectOption('R0') // lowering needs no confirmation
  await waitFor(() => levelIs('R0'), 'the level went down to R0 before the Context Toolkit refusal')
  // the page's Apply asks for R2 itself: after a preview at R0 a refusal in the confirmation window installs nothing and keeps R0
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'the preview at R0 enables Apply (it asks for the level on click)')
  await stubDialog(0)
  askedBefore = await app.evaluate(() => globalThis.__asked)
  await applyBtn.click()
  await waitFor(async () => (await app.evaluate(() => globalThis.__asked)) === askedBefore + 1, 'Context Toolkit Apply at R0 did not ask for R2')
  await page.waitForTimeout(400) // a negative check: a wrong run would start after the answer
  must(!existsSync(hookExe) && (await levelIs('R0')), 'after a refusal Context Toolkit Apply must install nothing and leave R0')
  await page.keyboard.press('1')
  must((await refusal(opts)).includes('R2'), 'at R0 apply was not rejected in main')
  must((await undoRefusal(undoOpts, false)).includes('R2'), 'at R0 the rollback was not rejected in main')
  must(JSON.stringify(realState()) === JSON.stringify(realBefore), 'setup changed a file of the real owner profile')
  must(realBackups() === realBackupsBefore, 'setup created a backup in the real owner profile')
  await waitFor(() => levelIs('R0'), 'the level went back to R0')

  // ---- help in the window: F1 / the header button, getting started, sections, questions, shortcuts, appearance ----
  {
    const help = page.getByRole('dialog', { name: 'Справка' })
    await page.keyboard.press('F1')
    await help.waitFor({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await help.waitFor({ state: 'detached', timeout: 5000 })
    // a click on the help's plain text moves focus off the dialog: Esc must still close it
    await page.keyboard.press('F1')
    await help.waitFor({ timeout: 5000 })
    await help.locator('h2').click()
    await page.keyboard.press('Escape')
    await help.waitFor({ state: 'detached', timeout: 5000 })
    await page.getByRole('button', { name: /^Справка/ }).click()
    await help.waitFor({ timeout: 5000 })
    const tab = (name) => help.getByRole('button', { name, exact: true })
    await tab('С чего начать').click()
    must((await help.locator('ol.steps li').count()) === 3, 'getting started must be three steps')
    await tab('Вопросы и ответы').click()
    const qs = help.locator('.faq details')
    must((await qs.count()) >= 8, `too few questions in the FAQ: ${await qs.count()}`)
    await qs.filter({ hasText: 'Как выключить MCP-сервер' }).locator('summary').click()
    must((await help.innerText()).includes('спросит разрешение'), 'the FAQ answer on disabling does not say that Loadout asks for permission')
    for (const [w, h] of SIZES) {
      await resize(app, w, h)
      await page.waitForTimeout(150)
      await layout(page, `help ${w}`)
      await shot(page, `h1-help-faq-${w}`)
    }
    await resize(app, 1280, 800)
    const vh = await axeCheck(page, 'help')
    must(vh.length === 0, `axe: help: ${vh.map((x) => x.id).join(', ')}`)
    await tab('Клавиши').click()
    must((await help.innerText()).includes('F1'), 'the shortcuts tab lacks F1')
    // reduced motion → "FX: off" by default is applied on load; here we check the switch, which lives in Help → Appearance now
    await tab('Вид').click()
    await help.getByLabel('Анимация').selectOption('off')
    must((await page.evaluate(() => document.documentElement.dataset.fx)) === 'off', 'FX did not turn off')
    // Tab from a block the script focused stays inside the dialog
    await page.evaluate(() => document.querySelector('.help-body')?.setAttribute('tabindex', '-1'))
    await page.locator('.help-body').focus()
    await page.keyboard.press('Tab')
    must(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), 'Tab left the help dialog')
    await page.keyboard.press('Escape')
    await help.waitFor({ state: 'detached', timeout: 5000 })
    await waitFor(() => page.evaluate(() => document.activeElement?.textContent?.startsWith('Справка') ?? false), 'focus did not return to the Help button')
    // a section's "More in Help" opens the help on that section
    await page.keyboard.press('4')
    await page.locator('main').getByRole('button', { name: 'Подробнее в справке' }).click()
    await help.locator('#help-doctor.hit').waitFor({ timeout: 5000 })
    must((await page.evaluate(() => document.activeElement?.id)) === 'help-doctor', 'the help did not focus the section it was opened for')
    await shot(page, 'h2-help-section-1280')
    // the welcome card comes back from the help
    await tab('С чего начать').click()
    await help.getByRole('button', { name: 'Показать приветствие снова' }).click()
    await page.getByRole('region', { name: 'Loadout: что это и чего ждать' }).waitFor({ timeout: 5000 })
    await page.getByRole('button', { name: 'Понятно, начать' }).click()
    // a term explains itself on keyboard focus, not only on hover
    await page.locator('header .term').focus()
    must(await page.locator('header .term .tip').isVisible(), 'the write level term shows no explanation on focus')
    await shot(page, 'h3-term-1280')
    // a term inside the narrow inspector: its explanation stays inside the window
    await page.keyboard.press('1')
    await clickCell('tool-a', 3)
    await page.locator('aside details.tech summary').click()
    const scopeTerm = page.locator('aside details.tech .term').first()
    await scopeTerm.focus()
    const tipBox = await scopeTerm.locator('.tip').boundingBox()
    const vw = await page.evaluate(() => innerWidth)
    must(tipBox && tipBox.x >= 0 && tipBox.x + tipBox.width <= vw, `the scope explanation goes off the window: ${JSON.stringify(tipBox)} of ${vw}`)
    await shot(page, 'h4-term-inspector-1280')
    await page.locator('aside details.tech summary').click()
    await page.locator('#grid').focus()
  }

  must(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`)
  await close(session)

  // ---- app updates: main has a stand-in updater in QA mode (no network); the states come from its events ----
  session = await launch({ LOADOUT_HOME: home })
  {
    const { app: ua, page: up } = session
    const updErrors = []
    up.on('pageerror', (e) => updErrors.push(`pageerror: ${e.message.slice(0, 200)}`))
    up.on('console', (m) => m.type() === 'error' && updErrors.push(`console.error: ${m.text().slice(0, 200)}`))
    await up.waitForSelector('#grid', { timeout: 20000 })
    const emit = (event, arg) => ua.evaluate((_e, [ev, a]) => void globalThis.__loadoutUpdater.emit(ev, ev === 'error' ? new Error(a) : a), [event, arg])
    const calls = () => ua.evaluate(() => [...globalThis.__loadoutUpdater.calls])
    const both = async (name) => {
      for (const [w, h] of SIZES) {
        await resize(ua, w, h)
        await up.waitForTimeout(150)
        await shot(up, `${name}-${w}`)
      }
      await resize(ua, 1280, 800)
    }
    const version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version
    must((await up.locator('#privacy').innerText()).includes('в сеть только за обновлениями (GitHub)'), 'the footer does not say that the update check goes online')
    const cut = await up.evaluate(() => [...document.querySelectorAll('footer, footer > span, #privacy')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent))
    must(cut.length === 0, `footer text is cut at 1280: ${JSON.stringify(cut)}`)
    must((await up.locator('.welcome').count()) === 0, 'the welcome card came back after a restart')
    // the visible "vX.Y.Z" starts the accessible name; a new version is added in words
    const btn = up.getByRole('button', { name: new RegExp(`^v${version} — обновления`) })
    must((await btn.getAttribute('aria-label')) === `v${version} — обновления`, 'the version button name')
    await btn.click()
    const pop = up.getByRole('dialog', { name: 'Обновления' })
    const auto = pop.getByRole('checkbox', { name: 'Проверять обновления автоматически' })
    must(await auto.isChecked(), 'automatic update checks must be on by default')
    must((await pop.innerText()).includes(`Установлена версия ${version}`), 'the panel does not show the installed version')
    await both('upd-panel')
    await pop.getByRole('button', { name: 'Проверить сейчас' }).click()
    await waitFor(async () => (await calls()).includes('check'), '"Check now" calls the updater')
    await pop.getByText('Проверяем…').waitFor({ timeout: 5000 })
    // a failed manual check: a calm line, no raw error or stack, the window keeps working
    await emit('error', 'net::ERR_INTERNET_DISCONNECTED\n    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:2:1)')
    await pop.getByText(/^Нет связи с GitHub/).waitFor({ timeout: 5000 })
    must(!/net::|SimpleURLLoader/.test(await up.locator('body').innerText()), 'the raw network error reached the window')
    await both('upd-panel-error')
    await up.keyboard.press('Escape')
    await pop.waitFor({ state: 'detached', timeout: 5000 })
    must(await btn.evaluate((el) => el === document.activeElement), 'Escape did not return focus to the version button')
    const card = up.getByRole('status', { name: 'Обновление Loadout' })
    await card.getByText(/^Нет связи с GitHub/).waitFor({ timeout: 5000 })
    await both('upd-error')
    await up.keyboard.press('2') // the card does not block the window: keys and sections work
    await up.keyboard.press('1')
    await up.waitForSelector('#grid', { timeout: 5000 })
    // a new version: offered, nothing is downloaded by itself; release notes HTML from the feed never reaches the page
    await emit('update-available', { version: '9.9.9', releaseNotes: '<img src=x onerror="document.title=1">' })
    await card.getByText('Доступна версия 9.9.9').waitFor({ timeout: 5000 })
    must((await up.locator('footer img').count()) === 0, 'release notes HTML reached the window')
    must(!(await calls()).includes('download'), 'the update started downloading by itself')
    await both('upd-available')
    // a toast and the update card at the same time: both whole, no overlap, at the narrowest window too
    await up.getByLabel('Уровень записи').selectOption('R0')
    // at R0 "Add" asks for R2 in the confirmation window; a refusal gives the info toast this check needs
    await ua.evaluate(() => {
      globalThis.__loadoutConfirm = async () => false
    })
    await addItem(up, 'MCP-сервер')
    const toast = up.locator('#notice')
    await toast.waitFor({ timeout: 5000 })
    must((await up.locator('.toasts[role=status] #notice').count()) === 1, 'an info toast must sit in the status live region')
    for (const w of [1100, 1280, 1920]) {
      await resize(ua, w, 800)
      await up.waitForTimeout(150)
      const m = await up.evaluate(() => {
        const a = document.querySelector('#notice').getBoundingClientRect()
        const b = document.querySelector('.upd-card').getBoundingClientRect()
        const t = document.querySelector('#notice .toast-text')
        return { overlap: !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top), clipped: t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1, right: a.right, vw: innerWidth }
      })
      must(!m.overlap && !m.clipped && m.right <= m.vw, `toast and update card at ${w}: ${JSON.stringify(m)}`)
      if (w !== 1100) await shot(up, `b2-toast-update-${w}`)
    }
    await resize(ua, 1280, 800)
    const vt = await axeCheck(up, 'toast')
    must(vt.length === 0, `axe found violations on the toast: ${vt.map((x) => x.id).join(', ')}`)
    await toast.getByRole('button', { name: 'Закрыть уведомление' }).click()
    await toast.waitFor({ state: 'detached', timeout: 3000 })
    const va = await axeCheck(up, 'update card')
    must(va.length === 0, `axe found violations on the update card: ${va.map((x) => x.id).join(', ')}`)
    await card.getByRole('button', { name: 'Что нового (GitHub)' }).click()
    await waitFor(async () => (await ua.evaluate(() => globalThis.__loadoutUpdater.opened)).includes('https://github.com/d-ridelman/Loadout/releases/tag/v9.9.9'), 'release notes open the GitHub release page')
    await card.getByRole('button', { name: 'Скачать' }).click()
    await waitFor(async () => (await calls()).includes('download'), '"Download" calls the updater')
    await emit('download-progress', { percent: 42.4 })
    await card.getByText('Скачивается версия 9.9.9: 42%').waitFor({ timeout: 5000 })
    must(Number(await card.locator('progress').getAttribute('value')) === 42, 'the progress bar does not show 42%')
    await both('upd-downloading')
    await emit('update-downloaded', { version: '9.9.9' })
    await card.getByRole('button', { name: 'Перезапустить и обновить' }).waitFor({ timeout: 5000 })
    await both('upd-ready')
    await card.getByRole('button', { name: 'Перезапустить и обновить' }).click()
    await waitFor(async () => (await calls()).includes('install:true:true'), '"Restart and update": a silent install that starts the new version')
    await card.getByRole('button', { name: 'Скрыть' }).click()
    await card.waitFor({ state: 'detached', timeout: 5000 })
    // with the card hidden the ready update is still announced by the button name, not only by its dot and colour
    must((await btn.getAttribute('aria-label')).endsWith('есть новая версия'), 'the version button does not say a new version is ready')
    // the setting turns off, is saved and survives a restart; the footer then says nothing is sent
    await btn.click()
    must(await auto.evaluate((el) => el === document.activeElement), 'focus did not move into the update panel')
    const vp = await axeCheck(up, 'update panel')
    must(vp.length === 0, `axe found violations on the update panel: ${vp.map((x) => x.id).join(', ')}`)
    await auto.uncheck()
    await waitFor(() => JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).autoUpdate === false, 'the "check automatically" setting was not saved')
    must((await up.locator('#privacy').innerText()).includes('ничего не отправляет'), 'with checks off the footer must say nothing is sent')
    must(updErrors.length === 0, `page errors (updates): ${updErrors.join(' | ')}`)
  }
  await close(session)
  session = await launch({ LOADOUT_HOME: home })
  await session.page.waitForSelector('#grid', { timeout: 20000 })
  await session.page.getByRole('button', { name: /— обновления/ }).click()
  must(!(await session.page.getByRole('checkbox', { name: 'Проверять обновления автоматически' }).isChecked()), 'the switched-off setting did not survive a restart')
  await close(session)

  // ---- "loading" state ----
  session = await launch({ LOADOUT_HOME: home, LOADOUT_QA_DELAY_MS: '3000' })
  await session.page.waitForSelector('main [role=status]', { timeout: 10000 })
  await resize(session.app, 1280, 800)
  await shot(session.page, 'm1-state-loading-1280')
  await session.page.waitForSelector('#grid', { timeout: 20000 })
  await close(session)

  // ---- "error" state: the core is not found ----
  session = await launch({ LOADOUT_HOME: home, LOADOUT_BIN: join(repo, 'target', 'release', 'loadout-missing.exe') })
  await session.page.waitForSelector('main [role=alert]', { timeout: 10000 })
  {
    // the person reads what to do; the raw text (path) is folded under "Details" and carries no developer advice
    const alert = session.page.locator('main [role=alert]')
    const seen = await alert.innerText()
    must(seen.includes('Повторить') && seen.includes('переустановите') && !seen.includes('loadout-missing'), `the error screen without a human hint or with the raw path unfolded: ${seen}`)
    must((await alert.textContent()).includes('ядро не найдено') && !/cargo/i.test(await alert.textContent()), 'the folded detail must name the missing core and give no cargo advice')
    await alert.locator('summary').click()
    must((await alert.innerText()).includes('loadout-missing'), 'the details do not open')
  }
  await resize(session.app, 1280, 800)
  await shot(session.page, 'm1-state-error-1280')
  await close(session)

  // ---- "error": the core starts but returns the wrong thing (node.exe posing as the core) ----
  const fake = join(mkdtempSync(join(tmpdir(), 'loadout-fake-')), 'loadout-fake.exe')
  cpSync(process.execPath, fake)
  homes.push(dirname(fake))
  session = await launch({ LOADOUT_HOME: home, LOADOUT_BIN: fake })
  await session.page.waitForSelector('main [role=alert]', { timeout: 15000 })
  must((await session.page.locator('main [role=alert]').textContent()).includes('ядро не ответило'), 'message about a core failure')
  await session.page.getByRole('button', { name: 'Повторить' }).click()
  await close(session)

  // ---- "empty" state ----
  const empty = mkdtempSync(join(tmpdir(), 'loadout-empty-'))
  homes.push(empty)
  // empty means no system config either
  session = await launch({ LOADOUT_HOME: empty, LOADOUT_OPENCODE_SYSTEM_DIR: join(empty, 'no-system-config') })
  await session.page.waitForSelector('#grid', { timeout: 20000 })
  must((await session.page.locator('td.empty').innerText()).includes('Не найдено ни одного клиента'), 'empty state')
  must((await session.page.locator('td.empty').getByRole('button', { name: 'Обновить' }).count()) === 1, 'the empty matrix offers no next step')
  await resize(session.app, 1280, 800)
  await shot(session.page, 'm1-state-empty-1280')
  // the other sections of an empty home say what to do too, and nothing is clipped at either width
  for (const [key, name, text] of [['3', 'hooks', 'Хуков не найдено'], ['4', 'doctor', 'Всё чисто'], ['6', 'profiles', 'Профилей пока нет']]) {
    await session.page.keyboard.press(key)
    await waitFor(async () => (await session.page.locator('main').innerText()).includes(text), `empty ${name}`)
    for (const [w, h] of SIZES) {
      await resize(session.app, w, h)
      await session.page.waitForTimeout(150)
      await layout(session.page, `empty ${name} ${w}`)
      await shot(session.page, `b2-empty-${name}-${w}`)
    }
  }
  await close(session)
  session = undefined

  // ---- English UI: not a single Cyrillic letter in the text, in the attributes, or in the core responses ----
  const enHome = materialize(() => {})
  homes.push(enHome)
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ writeLevel: 'R2', welcomed: true }))
  // the journal of the Russian scenarios stays: entries made in another language are shown in the current one (relang in the core)
  const enMarket = sources(enHome)
  session = await launch({ ...fakeEnv(enHome, join(enHome, 'claude-calls.txt')), LOADOUT_LANG: 'en' })
  {
    const { app: enApp, page: en } = session
    const enErrors = []
    en.on('pageerror', (e) => enErrors.push(`pageerror: ${e.message.slice(0, 200)}`))
    await en.waitForSelector('#grid', { timeout: 20000 })
    await resize(enApp, 1280, 800)
    must((await en.evaluate(() => document.documentElement.lang)) === 'en', 'html lang is not en')
    // page text, labels, tooltips and placeholders: everything the user or a screen reader sees
    const cyrillic = (where) =>
      en.evaluate((w) => {
        const bad = []
        const re = /[А-Яа-яЁё]/
        const text = document.body.innerText
        for (const line of text.split('\n')) if (re.test(line)) bad.push(`text: ${line.trim().slice(0, 90)}`)
        for (const el of document.querySelectorAll('[aria-label],[title],[placeholder],[alt]'))
          for (const a of ['aria-label', 'title', 'placeholder', 'alt']) {
            const v = el.getAttribute(a)
            if (v && re.test(v)) bad.push(`${a}: ${v.slice(0, 90)}`)
          }
        return bad.map((b) => `${w}: ${b}`)
      }, where)
    const enOk = async (where) => {
      const bad = await cyrillic(where)
      must(bad.length === 0, `Cyrillic in the English UI:\n${bad.slice(0, 12).join('\n')}`)
    }
    await enOk('matrix')
    await layout(en, 'en-matrix@1280')
    await resize(enApp, 1100, 700)
    await en.waitForTimeout(250)
    await headerLayout(en, 'en@1100')
    await resize(enApp, 1280, 800)
    await en.waitForTimeout(250)
    await shot(en, 'en-matrix-1280')
    for (const [key, name] of [['2', 'radar'], ['3', 'hooks'], ['4', 'doctor'], ['5', 'journal'], ['6', 'profiles'], ['7', 'ctxkit']]) {
      await en.keyboard.press(key)
      await en.waitForTimeout(700)
      await enOk(name)
      await shot(en, `en-${name}-1280`)
    }
    // Context Toolkit in English: the form with policies, preview and apply, preview and rollback; the core output (`pre.out`) is also free of Cyrillic
    {
      const ctxJson = join(enHome, '.claude', 'context-toolkit.json')
      const ctxHook = join(enHome, '.claude', 'hooks', 'context-toolkit.exe')
      const enApply = en.getByRole('button', { name: /^Apply: install/ })
      const enPreview = en.getByRole('button', { name: /^Preview/ })
      await en.getByText('context-toolkit 0.', { exact: false }).first().waitFor({ timeout: 15000 })
      must(await en.getByRole('heading', { name: 'Context Toolkit', level: 2 }).isVisible(), 'the section heading is not “Context Toolkit”')
      must(await en.locator('nav').getByRole('button', { name: /^Context Toolkit/ }).isVisible(), 'the navigation does not say “Context Toolkit”')
      await enPreview.click()
      await en.locator('pre.out').waitFor({ timeout: 30000 })
      await enOk('ctxkit: preview')
      const pv = await en.locator('pre.out').innerText()
      must(pv.includes('[dry-run] profile:') && pv.includes('Stop gate: on') && pv.includes('policies: none (kept; pass --policy'), `preview of Context Toolkit in English: ${pv.slice(0, 500)}`)
      await en.getByLabel('Policies', { exact: true }).selectOption('on')
      await en.getByRole('checkbox', { name: /^Commit hygiene/ }).check()
      await en.getByRole('checkbox', { name: /^Stray report files/ }).check()
      must(await enApply.isDisabled(), 'Context Toolkit (EN): the old preview must not allow Apply after the form changed')
      await enPreview.click()
      await waitFor(() => enApply.isEnabled(), 'Context Toolkit (EN): preview with policies')
      await enOk('ctxkit: preview with policies')
      const pv2 = await en.locator('pre.out').innerText()
      must(pv2.includes('policy commit_hygiene: off -> on') && pv2.includes('policy stray_files: off -> on') && !existsSync(ctxJson), `policy lines of the preview in English: ${pv2.slice(0, 700)}`)
      await en.locator('fieldset.choices', { has: en.locator('#ctx-policy') }).screenshot({ path: join(shotDir, 'en-ctxkit-policies-1280.png') })
      await enApply.click()
      await waitFor(() => existsSync(ctxHook) && existsSync(ctxJson), 'Context Toolkit (EN): apply wrote the hook binary and context-toolkit.json')
      await waitFor(async () => (await en.locator('main').innerText()).includes('Applied.'), 'Context Toolkit (EN): no “Applied.” caption')
      await enOk('ctxkit: applied')
      await waitFor(async () => (await en.locator('#ctx-policy-hint').innerText()).includes('Currently on: commit_hygiene, stray_files'), 'Context Toolkit (EN): the “Currently on” caption from the doctor')
      await enOk('ctxkit: policies caption')
      await en.getByRole('button', { name: 'Show what the rollback removes', exact: true }).click()
      const enUndo = en.getByRole('button', { name: 'Roll back: remove hooks, rules block and binary' })
      await waitFor(() => enUndo.isEnabled(), 'Context Toolkit (EN): rollback preview')
      await enOk('ctxkit: rollback preview')
      must((await en.locator('pre.out').innerText()).includes('[dry-run]') && existsSync(ctxJson), 'Context Toolkit (EN): the rollback preview must write nothing')
      await shot(en, 'en-ctxkit-undo-1280')
      await enUndo.click()
      await waitFor(async () => (await en.locator('main').innerText()).includes('Rolled back.'), 'Context Toolkit (EN): no “Rolled back.” caption')
      await waitFor(() => !existsSync(ctxJson) && !existsSync(ctxHook), 'Context Toolkit (EN): rollback removed context-toolkit.json and the binary')
      await enOk('ctxkit: rolled back')
    }
    await en.keyboard.press('1')
    // palette
    await en.keyboard.press('Control+k')
    await en.waitForTimeout(300)
    await enOk('palette')
    await en.keyboard.press('Escape')
    // add: a taken name (the form says so before any plan) and a core plan — both in English
    const enDialog = en.locator('[role=dialog][aria-modal=true]')
    await addItem(en, 'MCP server')
    await enDialog.getByLabel('Client').selectOption({ label: 'Antigravity' })
    await enDialog.getByLabel('Name', { exact: true }).fill('tool-a')
    await enDialog.getByLabel('Command', { exact: true }).fill('npx')
    await enDialog.locator('[role=alert]').waitFor({ timeout: 8000 })
    await enOk('add: taken name')
    await shot(en, 'en-add-error-1280')
    // the tallest form at the smallest window: Preview and Cancel stay in view while the form scrolls
    await resize(enApp, 1100, 640)
    await en.waitForTimeout(150)
    await shot(en, 'en-add-error-1100x640')
    await resize(enApp, 1280, 800)
    await enDialog.getByRole('button', { name: 'Cancel' }).click()
    await addItem(en, 'MCP server')
    await enDialog.getByLabel('Client').selectOption({ label: 'Antigravity' })
    await enDialog.getByLabel('Name', { exact: true }).fill('en-added')
    await enDialog.getByLabel('Command', { exact: true }).fill('npx')
    await enDialog.getByRole('button', { name: 'Preview' }).click()
    await enDialog.getByText('~/.gemini/config/mcp_config.json').waitFor({ timeout: 8000 })
    await enOk('add: core plan')
    await shot(en, 'en-add-plan-1280')
    await enDialog.getByRole('button', { name: 'Cancel' }).click()
    // plugin install: preview
    await addItem(en, 'Claude Code plugin')
    await enDialog.getByRole('button', { name: 'Add marketplace…' }).click()
    await enDialog.getByLabel('Marketplace source').fill(enMarket)
    await enDialog.getByRole('button', { name: 'Preview' }).click()
    await enDialog.getByText(`claude plugin marketplace add --scope user ${tilde(enMarket)}`).waitFor({ timeout: 8000 })
    await enOk('marketplace add')
    await enDialog.getByRole('button', { name: 'Add marketplace', exact: true }).click()
    await enDialog.getByRole('list', { name: 'Catalog e2e-market' }).getByRole('button', { name: /^hello-plugin/ }).click()
    await enDialog.getByText('claude plugin install hello-plugin@e2e-market --scope user').waitFor({ timeout: 8000 })
    await enOk('plugin dialog')
    await shot(en, 'en-plugin-1280')
    // install by a real launch (stand-in claude): the same commands, the window closes, not a word of Russian in the window
    await enDialog.getByRole('button', { name: 'Install', exact: true }).click()
    const enCalls = () => (existsSync(join(enHome, 'claude-calls.txt')) ? readFileSync(join(enHome, 'claude-calls.txt'), 'utf8').trim().split('\n') : [])
    await waitFor(() => enCalls().join('|') === `plugin marketplace add --scope user ${enMarket}|plugin install hello-plugin@e2e-market --scope user`, 'claude (EN) called with the exact add and install commands')
    await enDialog.waitFor({ state: 'detached', timeout: 8000 })
    await enOk('plugin installed')
    // skill: showing "what will be downloaded", download, choice and the core plan
    await addItem(en, 'Skill')
    await enDialog.getByLabel('Skill source').fill('acme/skills')
    await enDialog.getByRole('button', { name: 'What will be downloaded' }).click()
    await enDialog.getByText(/Will download:/).waitFor({ timeout: 8000 })
    await enDialog.getByRole('button', { name: 'Download and show' }).click()
    await enDialog.getByRole('radio', { name: /web-search/ }).check({ timeout: 20000 })
    await enOk('skill dialog')
    await shot(en, 'en-skill-1280')
    await enDialog.getByRole('button', { name: 'Preview installation' }).click()
    await enDialog.getByText('~/.claude/skills/web-search/').waitFor({ timeout: 8000 })
    await enOk('skill plan')
    await shot(en, 'en-skill-plan-1280')
    // skill install and rollback from the journal: the journal entry and everything the window shows meanwhile, in English
    const enSkill = join(enHome, '.claude', 'skills', 'web-search')
    await enDialog.getByRole('button', { name: 'Install', exact: true }).click()
    await enDialog.waitFor({ state: 'detached', timeout: 8000 })
    await waitFor(() => existsSync(join(enSkill, 'SKILL.md')), 'skill (EN) installed')
    await en.keyboard.press('5')
    const skillRowEn = en.getByRole('row').filter({ hasText: /web-search/ }).first()
    await skillRowEn.waitFor({ timeout: 8000 })
    await enOk('journal after the skill install')
    await shot(en, 'en-journal-skill-1280')
    await skillRowEn.getByRole('button', { name: 'Roll back', exact: true }).click()
    await enDialog.getByRole('button', { name: 'Roll back', exact: true }).waitFor({ timeout: 8000 })
    await enOk('rollback preview')
    await enDialog.getByRole('button', { name: 'Roll back', exact: true }).click()
    await enDialog.waitFor({ state: 'detached', timeout: 8000 })
    await waitFor(() => !existsSync(enSkill), 'skill (EN) rolled back from the journal')
    await enOk('journal after the skill rollback')
    await en.keyboard.press('1')
    await en.waitForSelector('#grid', { timeout: 15000 })
    // write from the matrix: trash, edit and copy (dialogs and core plans)
    const enCell = (row, idx) =>
      en.locator('tbody tr', { has: en.locator('td.name b', { hasText: new RegExp(`^${row}$`) }) }).locator('td').nth(idx + 1).click()
    await enCell('tool-a', 3)
    await enOk('inspector')
    await shot(en, 'en-inspector-1280')
    await en.getByRole('button', { name: 'Disable (move to trash)' }).click()
    await enDialog.getByText('Loadout trash').first().waitFor({ timeout: 8000 })
    await enOk('trash plan')
    await shot(en, 'en-trash-plan-1280')
    await enDialog.getByRole('button', { name: 'Cancel' }).click()
    await en.getByRole('button', { name: 'Edit command…' }).click()
    await enOk('edit dialog')
    await enDialog.getByRole('button', { name: 'Cancel' }).click()
    await en.getByRole('button', { name: 'Copy to client…' }).click()
    await enOk('copy dialog')
    await enDialog.getByRole('button', { name: 'Cancel' }).click()
    // the journal after a write in English: the entry itself and the rollback
    await enCell('tool-a', 3)
    await en.getByRole('button', { name: 'Disable (move to trash)' }).click()
    await enDialog.getByRole('button', { name: 'Move to trash' }).click()
    await enDialog.waitFor({ state: 'detached', timeout: 8000 })
    await en.keyboard.press('5')
    // on a timeout say what the window shows instead (this step once timed out with no clue)
    await en.getByRole('row').filter({ hasText: 'Loadout trash' }).first().waitFor({ timeout: 8000 }).catch(async (e) => {
      throw new Error(`${e.message.split('\n')[0]}; the window shows: ${JSON.stringify((await en.locator('body').innerText()).slice(0, 900))}`)
    })
    await enOk('journal row')
    await shot(en, 'en-journal-1280')
    // the language switch: to Russian and back; the open section and the matrix selection stay
    await en.getByLabel('Language').selectOption('ru')
    await en.getByRole('button', { name: 'Матрица' }).waitFor({ timeout: 10000 })
    must((await en.evaluate(() => document.documentElement.lang)) === 'ru', 'after switching to RU lang is not ru')
    must((await en.locator('nav [aria-current=page]').innerText()).startsWith('Журнал'), 'the language switch left the journal')
    await en.getByLabel('Язык').selectOption('en')
    await en.getByRole('button', { name: 'Matrix' }).waitFor({ timeout: 10000 })
    must((await en.locator('nav [aria-current=page]').innerText()).startsWith('Journal'), 'the language switch back left the journal')
    await en.keyboard.press('1')
    await en.waitForSelector('#grid', { timeout: 15000 })
    must((await en.locator('td[aria-selected="true"]').count()) === 1, 'the language switch lost the matrix selection')
    // after RU→EN: the write level survived saving the language, the restarted core speaks English and accepts a write
    must((await en.getByLabel('Write').inputValue()) === 'R2', 'the language change reset the write level')
    must(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).lang === 'en', 'the language was not saved to settings.json')
    await en.waitForSelector('#grid', { timeout: 15000 })
    await enCell('tool-b', 3)
    await en.getByRole('button', { name: 'Disable (move to trash)' }).click()
    await enDialog.getByText('Loadout trash').first().waitFor({ timeout: 8000 })
    await enOk('plan after the switch')
    await enDialog.getByRole('button', { name: 'Move to trash' }).click()
    await enDialog.waitFor({ state: 'detached', timeout: 8000 })
    await en.keyboard.press('5')
    await en.getByRole('row').filter({ hasText: 'Loadout trash' }).first().getByRole('button', { name: 'Roll back', exact: true }).click()
    await enDialog.getByRole('button', { name: 'Roll back', exact: true }).click()
    await enDialog.waitFor({ state: 'detached', timeout: 8000 })
    await en.waitForTimeout(800)
    await enOk('journal after rollback')
    must(enErrors.length === 0, `page errors (EN): ${enErrors.join(' | ')}`)
  }
  await close(session)
  session = undefined

  log('OK: all scenarios passed')
  log(`screenshots: ${shotDir}`)
} catch (e) {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  if (session) await close(session).catch(() => {})
  process.exitCode = 1
} finally {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
  const core = coreLeftovers()
  log('remaining core processes of this run (loadout*.exe with the check profile):', core.length)
  for (const id of core) {
    try {
      execFileSync('taskkill', ['/PID', id, '/F'], { stdio: 'ignore' })
    } catch {
      /* already closed */
    }
  }
  if (core.length) process.exitCode = 1
  const left = leftovers()
  log('remaining electron processes of the check profile:', left.length)
  if (left.length) {
    for (const id of left) {
      try {
        execFileSync('taskkill', ['/PID', id, '/T', '/F'], { stdio: 'ignore' })
      } catch {
        /* already closed */
      }
    }
    process.exitCode = 1
  }
}
