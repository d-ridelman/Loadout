// Screenshots for the README: `docs/screenshots/{ru,en}-*.png`, a 1920×1080 window at scale 1, fixtures only.
// Run: `npm run docs-shots` (needs target/release/loadout.exe, app/build/context-toolkit.exe and the window build, as for e2e).
// The owner's profile is not touched: APP_QA=1, the window's own profile in state/loadout-qa-docs, the home is a copy of fixtures/home in a temporary folder;
// the hashes of the real files written by `context-toolkit setup` are compared before and after. Before each screenshot the window is checked
// for the user name and the path of the real home directory.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright-core'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(appDir, '..')
const electronExe = join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe')
const loadoutBin = join(repo, 'target', 'release', 'loadout.exe')
const outDir = join(repo, 'docs', 'screenshots')
const profile = join(repo, 'state', 'loadout-qa-docs')
const [W, H] = [1920, 1080]

const must = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** A copy of the fixture with `{HOME}` substituted (as in run.mjs); the name has no random characters: the core hides token-like path segments. */
function materialize(lang) {
  const home = join(tmpdir(), `loadout-docs-${lang}`)
  rmSync(home, { recursive: true, force: true })
  // the fixture keeps hooks with the former name (ctxkit) for the migration checks; the README screenshots use the current name
  const now = (s) => s.replaceAll('ctxkit', 'context-toolkit')
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) {
      const [s, d] = [join(from, name), join(to, now(name))]
      if (statSync(s).isDirectory()) walk(s, d)
      else writeFileSync(d, now(readFileSync(s, 'utf8')).replaceAll('{HOME_UPPER}', home.toUpperCase().replaceAll('\\', '/')).replaceAll('{HOME}', home.replaceAll('\\', '/')))
    }
  }
  walk(join(repo, 'fixtures', 'home'), home)
  // Claude Code transcripts for the "Effectiveness" block: turns on two models and checker calls
  const ts = new Date().toISOString()
  const row = (i, model, tool) =>
    JSON.stringify({ type: 'assistant', uuid: `a${i}`, timestamp: ts, message: { id: `m${i}`, model, content: [{ type: 'tool_use', id: `t${i}`, name: tool.name, input: tool.input }] } }) +
    '\n' +
    JSON.stringify({ type: 'user', uuid: `u${i}`, timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: '0123456789' }] } })
  const rows = []
  for (let i = 0; i < 8; i++) rows.push(row(i, 'claude-sonnet-5-5', { name: 'Bash', input: { command: 'ls' } }))
  for (let i = 8; i < 11; i++) rows.push(row(i, 'claude-opus-5-5', { name: 'Agent', input: { subagent_type: 'checker' } }))
  mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true })
  writeFileSync(join(home, '.claude', 'projects', 'p', 'a.jsonl'), rows.join('\n') + '\n')
  // sources without a network: a local marketplace and a git repository of the skill instead of GitHub
  cpSync(join(repo, 'fixtures', 'marketplace'), join(home, 'src', 'market'), { recursive: true })
  const skillRepo = join(home, 'gh', 'acme', 'skills.git')
  cpSync(join(repo, 'fixtures', 'skill-src'), skillRepo, { recursive: true })
  const git = (...a) => execFileSync('git', ['-c', 'user.name=docs', '-c', 'user.email=docs@loadout.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: skillRepo, stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  return home
}

// The real files written by `context-toolkit setup` (the same list as in run.mjs): they do not change between the start and the end of the run.
const realHome = homedir()
const realFiles = ['.claude/settings.json', '.claude/CLAUDE.md', '.claude/hooks/ctxkit.exe', '.claude/hooks/context-toolkit.exe', '.claude/ctxkit.json', '.claude/context-toolkit.json', '.claude/agents/Explore.md', '.claude/agents/checker.md', '.local/bin/ctxkit.exe', '.local/bin/context-toolkit.exe', '.gemini/config/hooks.json', '.dsh/ctxkit-hooks.json', '.dsh/context-toolkit-hooks.json', '.dsh/cordis.patch.yml', '.dsh/profiles/desktop/cordis.patch.yml', 'AppData/Roaming/Claude/ccd-session-presets.json'].map((r) => join(realHome, r))
const realState = () => realFiles.map((f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'нет')).join()

/** No user name and no real home directory in the visible text, input fields and tooltips. */
const user = userInfo().username.toLowerCase()
const banned = [realHome, realHome.replaceAll('\\', '/'), ...(user.length >= 3 ? [user] : [])].map((s) => s.toLowerCase())
async function shot(page, lang, name) {
  await page.waitForTimeout(300)
  const text = await page.evaluate(() => {
    const vis = (e) => e.getClientRects().length > 0
    const fields = [...document.querySelectorAll('input,textarea,select')].filter(vis).map((e) => (e.tagName === 'SELECT' ? e.selectedOptions[0]?.textContent ?? '' : e.value))
    const titles = [...document.querySelectorAll('[title]')].map((e) => e.getAttribute('title'))
    return [document.body.innerText, ...fields, ...titles].join('\n').toLowerCase()
  })
  const hit = banned.filter((b) => text.includes(b))
  must(hit.length === 0, `${lang}-${name}: personal data in the window (${hit.length} matches)`)
  must(!text.includes('fake-secret'), `${lang}-${name}: fixture secret in the window`)
  must(!text.includes('ctxkit'), `${lang}-${name}: the former name ctxkit in the window`)
  await page.screenshot({ path: join(outDir, `${lang}-${name}.png`) })
  console.log(`  ${lang}-${name}.png`)
}

const L = {
  ru: { add: 'MCP-сервер', faq: 'Вопросы и ответы', client: 'Клиент', name: 'Имя', command: 'Команда', args: 'Аргументы, по одному в строке', preview: 'Предпросмотр', addGo: 'Добавить', plugin: 'Плагин Claude Code', addMarket: 'Добавить маркетплейс…', marketSrc: 'Источник маркетплейса', addMarketGo: 'Добавить маркетплейс', catalog: 'Каталог e2e-market', close: 'Закрыть', skill: 'Скил', skillSrc: 'Источник скила', what: 'Что будет скачано', download: 'Скачать и показать', skillPreview: 'Предпросмотр установки', install: 'Установить', disable: 'Выключить', journal: 'Журнал операций', profName: 'Имя профиля', profile: 'рабочий', capture: 'Снять с текущего состояния', entries: 'Записи профиля', hygiene: /^Гигиена коммитов/, irreversible: /^Подтверждение необратимого/, ctxPreview: /^Предпросмотр \(/, apply: /^Применить: установить/, applied: 'Применено.', undo: 'Показать, что уберёт откат', welcomeOk: 'Понятно, начать', legend: 'Что значат значки', undoGo: 'Откатить: убрать хуки, блок правил и бинарь', eff: 'Эффективность', turns: 'Ходы по дням' },
  en: { add: 'MCP server', faq: 'Questions', client: 'Client', name: 'Name', command: 'Command', args: 'Arguments, one per line', preview: 'Preview', addGo: 'Add', plugin: 'Claude Code plugin', addMarket: 'Add marketplace…', marketSrc: 'Marketplace source', addMarketGo: 'Add marketplace', catalog: 'Catalog e2e-market', close: 'Close', skill: 'Skill', skillSrc: 'Skill source', what: 'What will be downloaded', download: 'Download and show', skillPreview: 'Preview installation', install: 'Install', disable: 'Disable', journal: 'Operations journal', profName: 'Profile name', profile: 'work', capture: 'Capture current state', entries: 'Profile entries', hygiene: /^Commit hygiene/, irreversible: /^Confirm irreversible/, ctxPreview: /^Preview \(/, apply: /^Apply: install/, applied: 'Applied.', undo: 'Show what the rollback removes', welcomeOk: 'Got it, start', legend: 'What the marks mean', undoGo: 'Roll back: remove hooks, rules block and binary', eff: 'Efficiency', turns: 'Turns by day' },
}

async function pass(lang) {
  const l = L[lang]
  const home = materialize(lang)
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ writeLevel: 'R2', lang }))
  const app = await electron.launch({
    executablePath: electronExe,
    args: ['--force-device-scale-factor=1', appDir],
    env: {
      ...process.env,
      APP_QA: '1',
      LOADOUT_USER_DATA: profile,
      LOADOUT_BIN: loadoutBin,
      LOADOUT_LANG: lang,
      LOADOUT_HOME: home,
      LOADOUT_CLAUDE: process.execPath,
      LOADOUT_CLAUDE_ARGS: JSON.stringify([join(appDir, 'e2e', 'fake-claude.mjs')]),
      FAKE_CLAUDE_CALLS: join(home, 'claude-calls.txt'),
      LOADOUT_GITHUB_BASE: pathToFileURL(join(home, 'gh')).href + '/',
    },
  })
  const pid = app.process().pid
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('#grid', { timeout: 20000 })
    const size = () => page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])
    // for a window without a system frame setContentSize misses by the width of the invisible borders: correct it from the measured page size
    const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [ww, hh]) => BrowserWindow.getAllWindows()[0].setContentSize(ww, hh), [w, h])
    await setSize(W, H)
    await page.waitForTimeout(300)
    const [iw, ih] = await size()
    await setSize(2 * W - iw, 2 * H - ih)
    await waitFor(async () => (await size()).join() === [W, H, 1].join(), `window ${W}×${H} at scale 1`).catch(async (e) => {
      throw new Error(`${e.message}: ${(await size()).join('×')}`)
    })
    const dialog = page.locator('[role=dialog][aria-modal=true]')
    /** The header's single "Add" list: opens it and picks the item whose name starts with `name`. */
    const addItem = async (name) => {
      await page.locator('header .addmenu > button').click()
      await page.locator('#addpop').getByRole('button', { name: new RegExp(`^${name}`) }).click()
    }
    const cell = (rowName, idx) => page.locator('tbody tr', { has: page.locator('td.name b', { hasText: new RegExp(`^${rowName}$`) }) }).locator('td').nth(idx + 1)
    const applyPlan = async (label) => {
      await dialog.getByRole('button', { name: label, exact: true }).waitFor({ timeout: 8000 })
      await page.waitForFunction(() => !document.querySelector('[role=dialog] button[disabled]'), null, { timeout: 8000 })
      await dialog.getByRole('button', { name: label, exact: true }).click()
      await dialog.waitFor({ state: 'detached', timeout: 8000 })
    }

    // the first-run card (the profile is fresh), then the matrix with the inspector and the legend open
    await page.getByRole('button', { name: l.welcomeOk }).waitFor({ timeout: 8000 })
    await shot(page, lang, 'welcome')
    await page.getByRole('button', { name: l.welcomeOk }).click()
    await page.getByText(l.legend).click()
    await cell('tool-a', 3).click()
    await shot(page, lang, 'matrix')
    await page.keyboard.press('2')
    await waitFor(async () => (await page.locator('.node').count()) === 5, 'radar')
    await shot(page, lang, 'radar')
    await page.keyboard.press('3')
    await waitFor(async () => (await page.locator('.pipe .hk').count()) > 0, 'hooks')
    await shot(page, lang, 'hooks')
    await page.keyboard.press('4')
    await waitFor(async () => (await page.locator('.find').count()) > 0, 'doctor')
    await shot(page, lang, 'doctor')
    // the help: F1, questions and answers with one open
    await page.keyboard.press('F1')
    await page.getByRole('button', { name: l.faq, exact: true }).click()
    await page.locator('.faq details summary').nth(1).click()
    await shot(page, lang, 'help')
    await page.keyboard.press('Escape')
    await page.keyboard.press('1')

    // add an MCP: the form, then the entry (it ends up in the journal)
    await addItem(l.add)
    await dialog.getByLabel(l.client).selectOption({ label: 'ChatGPT / Codex' })
    await dialog.getByLabel(l.name, { exact: true }).fill('notes-mcp')
    await dialog.getByLabel(l.command, { exact: true }).fill('npx')
    await dialog.getByLabel(l.args).fill('-y\nnotes-mcp@1.0.0')
    await shot(page, lang, 'add-mcp')
    await dialog.getByRole('button', { name: l.preview, exact: true }).click()
    await applyPlan(l.addGo)

    // install a plugin: the marketplace is added by the stand-in `claude`, the screenshot is the catalog (the path entry step is not captured: it shows the full path)
    await addItem(l.plugin)
    await dialog.getByRole('button', { name: l.addMarket }).click()
    await dialog.getByLabel(l.marketSrc).fill(join(home, 'src', 'market'))
    await dialog.getByRole('button', { name: l.preview, exact: true }).click()
    await dialog.getByRole('button', { name: l.addMarketGo, exact: true }).click()
    const catalog = dialog.getByRole('list', { name: l.catalog })
    await catalog.waitFor({ timeout: 8000 })
    await catalog.getByRole('button', { name: /^hello-plugin/ }).click()
    await dialog.getByText('claude plugin install hello-plugin@e2e-market --scope user').waitFor({ timeout: 8000 })
    await shot(page, lang, 'install-plugin')
    await dialog.getByRole('button', { name: l.close, exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: 8000 })

    // install a skill from "GitHub" (a local git repository): pick the skill, then install
    await addItem(l.skill)
    await dialog.getByLabel(l.skillSrc).fill('acme/skills')
    await dialog.getByRole('button', { name: l.what }).click()
    await dialog.getByRole('button', { name: l.download }).click()
    await dialog.getByRole('radio', { name: /web-search/ }).check({ timeout: 20000 })
    await shot(page, lang, 'install-skill')
    await dialog.getByRole('button', { name: l.skillPreview }).click()
    await applyPlan(l.install)

    // disable plugin p1 in Codex (R1), so that the journal also has a simple entry
    await page.keyboard.press('1')
    await cell('p1', 2).click()
    await page.keyboard.press('Space')
    await applyPlan(l.disable)
    await page.keyboard.press('5')
    await waitFor(async () => (await page.locator(`table[aria-label="${l.journal}"] tbody tr`).count()) >= 3, 'three journal entries')
    await page.locator('main details > summary').first().click() // "where copies are stored and what is in them"
    await shot(page, lang, 'journal')

    // profiles: a snapshot of the current state, the entry list is open
    await page.keyboard.press('6')
    await page.getByLabel(l.profName).fill(l.profile)
    await page.getByRole('button', { name: l.capture }).click()
    await page.getByText(l.entries).click()
    await shot(page, lang, 'profiles')

    // Context Toolkit: the form with policies and a preview, "Effectiveness", the rollback preview after applying
    await page.keyboard.press('7')
    await page.getByText('context-toolkit 0.', { exact: false }).first().waitFor({ timeout: 15000 })
    await page.locator('#ctx-policy').selectOption('on')
    await page.getByRole('checkbox', { name: l.hygiene }).check()
    await page.getByRole('checkbox', { name: l.irreversible }).check()
    const applyBtn = page.getByRole('button', { name: l.apply })
    await page.getByRole('button', { name: l.ctxPreview }).click()
    await waitFor(() => applyBtn.isEnabled(), 'Context Toolkit preview', 60000)
    const out = await page.locator('pre.out').innerText()
    must(out.includes(`loadout-docs-${lang}`), `the setup preview does not write to the fixture copy: ${out.slice(0, 300)}`)
    await page.locator(`section[aria-label="${l.eff}"] table[aria-label="${l.turns}"] tbody tr`).first().waitFor({ timeout: 30000 })
    await page.evaluate(() => document.querySelector('main').scrollTo(0, 0))
    await page.locator('#ctx-policy').scrollIntoViewIfNeeded()
    await shot(page, lang, 'context-toolkit')
    await page.locator(`section[aria-label="${l.eff}"]`).evaluate((s) => s.scrollIntoView({ block: 'end' }))
    await shot(page, lang, 'context-toolkit-efficiency')
    await applyBtn.click()
    await waitFor(async () => (await page.locator('main').innerText()).includes(l.applied), 'Context Toolkit applied', 60000)
    await page.getByRole('button', { name: l.undo, exact: true }).click()
    const undoGo = page.getByRole('button', { name: l.undoGo })
    await waitFor(() => undoGo.isEnabled(), 'rollback preview', 60000)
    await undoGo.scrollIntoViewIfNeeded()
    await page.locator('pre.out').evaluate((p) => p.scrollIntoView({ block: 'center' }))
    await shot(page, lang, 'context-toolkit-rollback')
  } finally {
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))])
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* already closed */
    }
    rmSync(home, { recursive: true, force: true })
  }
}

const before = realState()
try {
  for (const f of [electronExe, loadoutBin, join(appDir, 'build', 'context-toolkit.exe'), join(appDir, 'out', 'main', 'index.js')]) must(existsSync(f), `${f} not found: build it as for npm run e2e`)
  mkdirSync(outDir, { recursive: true })
  for (const lang of ['ru', 'en']) {
    console.log(`pass ${lang}`)
    await pass(lang)
  }
  must(realState() === before, 'the real files of the owner\'s profile changed')
  console.log('OK: screenshots in docs/screenshots')
} catch (e) {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  rmSync(profile, { recursive: true, force: true })
}
