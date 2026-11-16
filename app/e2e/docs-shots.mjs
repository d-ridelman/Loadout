// Снимки для README: `docs/screenshots/{ru,en}-*.png`, окно 1920×1080 при масштабе 1, только фикстуры.
// Запуск: `npm run docs-shots` (нужны target/release/loadout.exe, app/build/context-toolkit.exe и сборка окна, как для e2e).
// Профиль владельца не трогается: APP_QA=1, свой профиль окна в state/loadout-qa-docs, дом — копия fixtures/home во временной папке;
// хеши настоящих файлов, которые пишет `context-toolkit setup`, сверяются до и после. Перед каждым снимком окно проверяется
// на имя пользователя и путь настоящего домашнего каталога.
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
    if (Date.now() > end) throw new Error(`не дождались: ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** Копия фикстуры с подставленным `{HOME}` (как в run.mjs); имя без случайных знаков: ядро скрывает токеноподобные сегменты путей. */
function materialize(lang) {
  const home = join(tmpdir(), `loadout-docs-${lang}`)
  rmSync(home, { recursive: true, force: true })
  // фикстура держит хуки прежнего имени (ctxkit) для проверок перехода; на снимках для README — нынешнее имя
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
  // транскрипты Claude Code для блока «Эффективность»: ходы на двух моделях и вызовы checker
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
  // источники без сети: локальный маркетплейс и git-репозиторий скила вместо GitHub
  cpSync(join(repo, 'fixtures', 'marketplace'), join(home, 'src', 'market'), { recursive: true })
  const skillRepo = join(home, 'gh', 'acme', 'skills.git')
  cpSync(join(repo, 'fixtures', 'skill-src'), skillRepo, { recursive: true })
  const git = (...a) => execFileSync('git', ['-c', 'user.name=docs', '-c', 'user.email=docs@loadout.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: skillRepo, stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture')
  return home
}

// Настоящие файлы, которые пишет `context-toolkit setup` (тот же список, что в run.mjs): до и после прогона они не меняются.
const realHome = homedir()
const realFiles = ['.claude/settings.json', '.claude/CLAUDE.md', '.claude/hooks/ctxkit.exe', '.claude/hooks/context-toolkit.exe', '.claude/ctxkit.json', '.claude/context-toolkit.json', '.claude/agents/Explore.md', '.claude/agents/checker.md', '.local/bin/ctxkit.exe', '.local/bin/context-toolkit.exe', '.gemini/config/hooks.json', '.dsh/ctxkit-hooks.json', '.dsh/context-toolkit-hooks.json', '.dsh/cordis.patch.yml', '.dsh/profiles/desktop/cordis.patch.yml', 'AppData/Roaming/Claude/ccd-session-presets.json'].map((r) => join(realHome, r))
const realState = () => realFiles.map((f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'нет')).join()

/** Ни имени пользователя, ни настоящего домашнего каталога в видимом тексте, полях ввода и подсказках. */
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
  must(hit.length === 0, `${lang}-${name}: в окне личные данные (${hit.length} совпадений)`)
  must(!text.includes('fake-secret'), `${lang}-${name}: в окне секрет фикстуры`)
  must(!text.includes('ctxkit'), `${lang}-${name}: в окне прежнее имя ctxkit`)
  await page.screenshot({ path: join(outDir, `${lang}-${name}.png`) })
  console.log(`  ${lang}-${name}.png`)
}

const L = {
  ru: { add: 'Добавить MCP', client: 'Клиент', name: 'Имя', command: 'Команда', args: 'Аргументы, по одному в строке', preview: 'Предпросмотр', addGo: 'Добавить', plugin: 'Установить плагин', addMarket: 'Добавить маркетплейс…', marketSrc: 'Источник маркетплейса', addMarketGo: 'Добавить маркетплейс', catalog: 'Каталог e2e-market', close: 'Закрыть', skill: 'Установить скил', skillSrc: 'Источник скила', what: 'Что будет скачано', download: 'Скачать и показать', skillPreview: 'Предпросмотр установки', install: 'Установить', disable: 'Выключить', journal: 'Журнал операций', profName: 'Имя профиля', profile: 'рабочий', capture: 'Снять с текущего состояния', entries: 'Записи профиля', hygiene: /^Гигиена коммитов/, irreversible: /^Подтверждение необратимого/, ctxPreview: /^Предпросмотр \(/, apply: /^Применить: установить/, applied: 'Применено.', undo: 'Откатить Инструменты контекста', undoGo: 'Откатить: убрать хуки, блок правил и бинарь', eff: 'Эффективность', turns: 'Ходы по дням' },
  en: { add: 'Add MCP', client: 'Client', name: 'Name', command: 'Command', args: 'Arguments, one per line', preview: 'Preview', addGo: 'Add', plugin: 'Install plugin', addMarket: 'Add marketplace…', marketSrc: 'Marketplace source', addMarketGo: 'Add marketplace', catalog: 'Catalog e2e-market', close: 'Close', skill: 'Install skill', skillSrc: 'Skill source', what: 'What will be downloaded', download: 'Download and show', skillPreview: 'Preview installation', install: 'Install', disable: 'Disable', journal: 'Operations journal', profName: 'Profile name', profile: 'work', capture: 'Capture current state', entries: 'Profile entries', hygiene: /^Commit hygiene/, irreversible: /^Confirm irreversible/, ctxPreview: /^Preview \(/, apply: /^Apply: install/, applied: 'Applied.', undo: 'Roll back Context Toolkit', undoGo: 'Roll back: remove hooks, rules block and binary', eff: 'Efficiency', turns: 'Turns by day' },
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
    // у окна без системной рамки setContentSize попадает мимо на ширину невидимых краёв: поправка по замеру страницы
    const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [ww, hh]) => BrowserWindow.getAllWindows()[0].setContentSize(ww, hh), [w, h])
    await setSize(W, H)
    await page.waitForTimeout(300)
    const [iw, ih] = await size()
    await setSize(2 * W - iw, 2 * H - ih)
    await waitFor(async () => (await size()).join() === [W, H, 1].join(), `окно ${W}×${H} при масштабе 1`).catch(async (e) => {
      throw new Error(`${e.message}: ${(await size()).join('×')}`)
    })
    const dialog = page.locator('[role=dialog][aria-modal=true]')
    const cell = (rowName, idx) => page.locator('tbody tr', { has: page.locator('td.name b', { hasText: new RegExp(`^${rowName}$`) }) }).locator('td').nth(idx + 1)
    const applyPlan = async (label) => {
      await dialog.getByRole('button', { name: label, exact: true }).waitFor({ timeout: 8000 })
      await page.waitForFunction(() => !document.querySelector('[role=dialog] button[disabled]'), null, { timeout: 8000 })
      await dialog.getByRole('button', { name: label, exact: true }).click()
      await dialog.waitFor({ state: 'detached', timeout: 8000 })
    }

    // разделы для чтения: матрица с инспектором, радар, хуки, доктор
    await cell('tool-a', 3).click()
    await shot(page, lang, 'matrix')
    await page.keyboard.press('2')
    await waitFor(async () => (await page.locator('.node').count()) === 5, 'радар')
    await shot(page, lang, 'radar')
    await page.keyboard.press('3')
    await waitFor(async () => (await page.locator('.pipe .hk').count()) > 0, 'хуки')
    await shot(page, lang, 'hooks')
    await page.keyboard.press('4')
    await waitFor(async () => (await page.locator('.find').count()) > 0, 'доктор')
    await shot(page, lang, 'doctor')
    await page.keyboard.press('1')

    // добавить MCP: форма, затем запись (она попадёт в журнал)
    await page.getByRole('button', { name: l.add, exact: true }).click()
    await dialog.getByLabel(l.client).selectOption({ label: 'ChatGPT / Codex' })
    await dialog.getByLabel(l.name, { exact: true }).fill('notes-mcp')
    await dialog.getByLabel(l.command, { exact: true }).fill('npx')
    await dialog.getByLabel(l.args).fill('-y\nnotes-mcp@1.0.0')
    await shot(page, lang, 'add-mcp')
    await dialog.getByRole('button', { name: l.preview, exact: true }).click()
    await applyPlan(l.addGo)

    // установить плагин: маркетплейс добавляется подставным `claude`, снимок — каталог (шаг ввода пути не снимается: там полный путь)
    await page.getByRole('button', { name: l.plugin, exact: true }).click()
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

    // установить скил из «GitHub» (локальный git-репозиторий): выбор скила, затем установка
    await page.getByRole('button', { name: l.skill, exact: true }).click()
    await dialog.getByLabel(l.skillSrc).fill('acme/skills')
    await dialog.getByRole('button', { name: l.what }).click()
    await dialog.getByRole('button', { name: l.download }).click()
    await dialog.getByRole('radio', { name: /web-search/ }).check({ timeout: 20000 })
    await shot(page, lang, 'install-skill')
    await dialog.getByRole('button', { name: l.skillPreview }).click()
    await applyPlan(l.install)

    // выключить плагин p1 в Codex (R1), чтобы в журнале была и простая запись
    await page.keyboard.press('1')
    await cell('p1', 2).click()
    await page.keyboard.press('Space')
    await applyPlan(l.disable)
    await page.keyboard.press('5')
    await waitFor(async () => (await page.locator(`table[aria-label="${l.journal}"] tbody tr`).count()) >= 3, 'три записи в журнале')
    await page.locator('main details > summary').first().click() // «где хранятся копии и что в них»
    await shot(page, lang, 'journal')

    // профили: снимок текущего состояния, список записей открыт
    await page.keyboard.press('6')
    await page.getByLabel(l.profName).fill(l.profile)
    await page.getByRole('button', { name: l.capture }).click()
    await page.getByText(l.entries).click()
    await shot(page, lang, 'profiles')

    // Инструменты контекста: форма с политиками и предпросмотром, «Эффективность», предпросмотр отката после применения
    await page.keyboard.press('7')
    await page.getByText('context-toolkit 0.', { exact: false }).first().waitFor({ timeout: 15000 })
    await page.locator('#ctx-policy').selectOption('on')
    await page.getByRole('checkbox', { name: l.hygiene }).check()
    await page.getByRole('checkbox', { name: l.irreversible }).check()
    const applyBtn = page.getByRole('button', { name: l.apply })
    await page.getByRole('button', { name: l.ctxPreview }).click()
    await waitFor(() => applyBtn.isEnabled(), 'предпросмотр Инструментов контекста', 60000)
    const out = await page.locator('pre.out').innerText()
    must(out.includes(`loadout-docs-${lang}`), `предпросмотр setup пишет не в копию фикстуры: ${out.slice(0, 300)}`)
    await page.locator(`section[aria-label="${l.eff}"] table[aria-label="${l.turns}"] tbody tr`).first().waitFor({ timeout: 30000 })
    await page.evaluate(() => document.querySelector('main').scrollTo(0, 0))
    await page.locator('#ctx-policy').scrollIntoViewIfNeeded()
    await shot(page, lang, 'context-toolkit')
    await page.locator(`section[aria-label="${l.eff}"]`).evaluate((s) => s.scrollIntoView({ block: 'end' }))
    await shot(page, lang, 'context-toolkit-efficiency')
    await applyBtn.click()
    await waitFor(async () => (await page.locator('main').innerText()).includes(l.applied), 'применение Инструментов контекста', 60000)
    await page.getByRole('button', { name: l.undo, exact: true }).click()
    const undoGo = page.getByRole('button', { name: l.undoGo })
    await waitFor(() => undoGo.isEnabled(), 'предпросмотр отката', 60000)
    await undoGo.scrollIntoViewIfNeeded()
    await page.locator('pre.out').evaluate((p) => p.scrollIntoView({ block: 'center' }))
    await shot(page, lang, 'context-toolkit-rollback')
  } finally {
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))])
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* уже закрыт */
    }
    rmSync(home, { recursive: true, force: true })
  }
}

const before = realState()
try {
  for (const f of [electronExe, loadoutBin, join(appDir, 'build', 'context-toolkit.exe'), join(appDir, 'out', 'main', 'index.js')]) must(existsSync(f), `нет ${f}: соберите, как для npm run e2e`)
  mkdirSync(outDir, { recursive: true })
  for (const lang of ['ru', 'en']) {
    console.log(`проход ${lang}`)
    await pass(lang)
  }
  must(realState() === before, 'изменились настоящие файлы профиля владельца')
  console.log('OK: снимки в docs/screenshots')
} catch (e) {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  rmSync(profile, { recursive: true, force: true })
}
