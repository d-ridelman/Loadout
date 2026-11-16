// Проверка окна: Playwright `_electron`, свой профиль, фикстурный домашний каталог. Запуск: `npm run e2e`.
// Профиль владельца не трогается: APP_QA=1 + LOADOUT_USER_DATA=state/loadout-qa.
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

/** Главная кнопка диалога называется по операции (или «Применить» у пакета профиля). */
const APPLY = /^(Включить|Выключить|Вынести в корзину|Вернуть из корзины|Записать команду|Скопировать|Добавить|Применить|Установить$)/

/**
 * Английские слова старого вывода и перехода со старого имени (и английское имя Context Toolkit: по-русски «Инструменты
 * контекста») в строках русского окна (кроме разметки `[dry-run]`/`[warn]`/`ERR:`, `кода`, "значений", --флагов, путей и имён):
 * пусто — вывод русский. Тот же список и те же вырезки, что в `crates/context-toolkit/tests/guard.test.mjs`.
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
/** Путь так, как его показывает окно: домашний каталог свёрнут в `~`. */
const tilde = (p) => p.split(homedir()).join('~')
const must = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

/** Копия фикстуры с подставленным `{HOME}`: сканер проверяет существование путей из файлов клиентов. */
function materialize(extra) {
  // имя без случайных букв и цифр: ядро скрывает токеноподобные сегменты путей, и `mkdtemp` дал бы скрытые пути
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
    // язык по умолчанию — русский (сценарии ищут русские подписи); английский проход задаёт LOADOUT_LANG=en сам
    env: { ...process.env, APP_QA: '1', LOADOUT_USER_DATA: profile, LOADOUT_BIN: loadoutBin, LOADOUT_LANG: 'ru', ...env },
  })
  const page = await app.firstWindow()
  const pid = app.process().pid
  return { app, page, pid }
}

async function resize(app, w, h) {
  await app.evaluate(({ BrowserWindow }, [ww, hh]) => BrowserWindow.getAllWindows()[0].setSize(ww, hh), [w, h])
}

async function shot(page, name) {
  await page.screenshot({ path: join(stateDir, `${name}.png`) })
}

/** Шапка: каждый элемент в одну строку (не выше 36 px) и по центру строки (±2 px); справа не заходят под кнопки окна. */
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
  log(`  шапка ${label}:`, JSON.stringify(m))
  must(m.tall.length === 0 && m.off.length === 0, `${label}: шапка: перенос строк ${JSON.stringify(m.tall)}, не по центру ${JSON.stringify(m.off)}`)
  must(m.over <= 0, `${label}: шапка заходит под кнопки окна на ${m.over}px`)
}

/** Замер, а не «на глаз»: нет горизонтальной прокрутки страницы, нет обрезанных имён, колонки шапки и ячеек выровнены. */
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
    return { hscroll: de.scrollWidth - de.clientWidth, clipped, misaligned, cols: ths.length }
  })
  log(`  замер ${label}:`, JSON.stringify(m))
  await headerLayout(page, label)
  must(m.hscroll <= 0, `${label}: горизонтальная прокрутка страницы (${m.hscroll}px)`)
  must(m.clipped === 0, `${label}: обрезанных имён: ${m.clipped}`)
  must(m.misaligned === 0, `${label}: колонки шапки и ячеек смещены`)
}

/**
 * Процессы ядра этого прогона: после проверок их остаться не должно. Считаются только `loadout*.exe` с каталогом
 * проверочного профиля в командной строке (`--backups <профиль>\backups`, см. `ownCoreProcesses`): установленный
 * у владельца Loadout, проверка упакованной сборки и e2e соседней копии репозитория счёту не мешают.
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

/** PID ядра, запущенного окном на этом домашнем каталоге (по командной строке). */
function sidecarPids(homeLeaf) {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='loadout.exe'" | Where-Object { $_.CommandLine -like '*serve*' -and $_.CommandLine -like '*${homeLeaf}*' } | Select-Object -ExpandProperty ProcessId`],
    { encoding: 'utf8' },
  )
  return out.split(/\s+/).filter(Boolean)
}

/** Подпись ячейки матрицы: строка по имени, колонка клиента по номеру (0 — Claude Code). */
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
    if (Date.now() > end) throw new Error(`не дождались: ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

const axeSource = readFileSync(join(appDir, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8')

/** Обход axe-core по правилам WCAG A/AA и ARIA (включая контраст). Шумные для окна приложения правила выключены. */
async function axeCheck(page, label) {
  await page.evaluate(axeSource) // через CDP: CSP страницы (`script-src 'self'`) на это не распространяется
  const violations = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'cat.aria', 'cat.color'] },
      // `color-contrast-enhanced` — уровень AAA (7:1); цель проекта — AA (4,5:1), его проверяет `color-contrast`
      rules: { 'color-contrast-enhanced': { enabled: false }, region: { enabled: false }, 'page-has-heading-one': { enabled: false }, 'landmark-one-main': { enabled: false } },
    })
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))
  })
  for (const v of violations) log(`  axe ${label}: ${v.id} (${v.impact}) ×${v.count} ${v.sample}`)
  return violations
}

function leftovers() {
  // только процессы этой копии репозитория: e2e другой рабочей папки (соседний worktree) идёт со своим профилем, его не считаем и не убиваем
  const q = (p) => p.replaceAll("'", "''")
  try {
    const out = execFileSync(
      'powershell',
      // IndexOf, а не -like: скобки в пути не превращаются в шаблон. Основной процесс — appDir и порт отладки Playwright
      // (dev-окно `npm run dev` этой же копии под фильтр не попадает), дочерние — по --user-data-dir профиля e2e.
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
    /* уже закрыт */
  }
}

const homes = []
let session

try {
  must(existsSync(electronExe), `нет ${electronExe}: выполните npm install в app/`)
  must(existsSync(loadoutBin), `нет ${loadoutBin}: cargo build --release`)
  must(existsSync(join(appDir, 'build', 'context-toolkit.exe')), 'нет app/build/context-toolkit.exe: npm run bundle:context-toolkit')
  mkdirSync(stateDir, { recursive: true })
  // чистый проверочный профиль каждый раз: настройки окна (FX) не должны переходить между прогонами
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })

  // длинное имя скила для проверки переноса текста
  const home = materialize((h) => {
    const dir = join(h, '.claude', 'skills', 'very-long-skill-name-that-should-wrap-inside-the-name-column-without-clipping-anything')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: Длинное имя для проверки переноса\n---\n')
    // транскрипты Claude Code для отчёта ctxkit: ходы на двух моделях, вызов субагента и результат инструмента
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
  // подставной `claude`: ничего не скачивает, записывает свои аргументы и регистрирует локальный маркетплейс
  const fakeClaude = join(appDir, 'e2e', 'fake-claude.mjs')
  const claudeCalls = join(home, 'claude-calls.txt')
  // источники без сети: локальный маркетплейс и git-репозиторий скила, который клонируется вместо GitHub
  // каждый проход получает свои копии: `materialize` пересоздаёт тот же каталог
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

  // ---- основной сценарий ----
  session = await launch(fakeEnv(home, claudeCalls))
  let { app, page } = session
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message.slice(0, 200)}`))
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(`console.error: ${m.text().slice(0, 200)}`))
  await page.waitForSelector('#grid', { timeout: 20000 })
  must((await page.title()) === 'Loadout', 'заголовок окна не Loadout')

  // верхняя строка — своя (системной рамки нет): знак, перетаскивание, элементы управления не заходят под кнопки окна
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
  log('  верхняя строка:', JSON.stringify(bar))
  must(bar.overlay, 'системная рамка не убрана: нет наложения кнопок окна')
  must(bar.drag === 'drag' && bar.selectDrag === 'no-drag', 'строка заголовка должна перетаскиваться, а элементы управления нет')
  must(bar.mark, 'в шапке нет знака')
  must(bar.height === 48, `высота строки заголовка ${bar.height}, нужно 48 (как у наложения)`)
  must(bar.areaRight !== null && bar.right <= bar.areaRight, `элементы шапки заходят под кнопки окна: ${bar.right} > ${bar.areaRight}`)
  const rowCount = await page.locator('tbody tr').count()
  log('строк в матрице:', rowCount)
  must(rowCount > 10, 'в матрице слишком мало строк')
  must((await page.locator('thead th').count()) === 6, 'в шапке должно быть 6 колонок (сущность + 5 клиентов)')

  // клавиатура: j, l → выбранная ячейка и инспектор
  await page.locator('#grid').focus()
  await page.keyboard.press('j')
  await page.keyboard.press('l')
  must((await page.locator('td[aria-selected="true"]').count()) === 1, 'выбранная ячейка одна')
  // заголовки в CSS набраны капсом, поэтому innerText приходит заглавными
  must((await page.locator('aside').innerText()).toLowerCase().includes('инспектор'), 'инспектор не показан')
  // русская раскладка: физическая клавиша J при key = «о»
  const before = await page.locator('td[aria-selected="true"]').getAttribute('id')
  await page.evaluate(() => document.getElementById('grid').dispatchEvent(new KeyboardEvent('keydown', { key: 'о', code: 'KeyJ', bubbles: true })))
  must((await page.locator('td[aria-selected="true"]').getAttribute('id')) !== before, 'j на русской раскладке не двигает выбор')

  // состояния и фильтры
  await page.getByRole('button', { name: 'скилы' }).click()
  must((await page.locator('tbody tr').count()) < rowCount, 'фильтр «скилы» не сузил список')
  await page.getByRole('button', { name: 'все типы' }).click()
  await page.getByLabel('Поиск').fill('tool-b')
  must((await page.locator('tbody tr').count()) >= 1, 'поиск tool-b ничего не нашёл')
  await page.getByLabel('Поиск').fill('')

  // секреты фикстуры не должны появиться нигде в окне
  const everything = await page.evaluate(() => document.body.innerText)
  must(!everything.includes('FAKE-SECRET'), 'в окне найден FAKE-SECRET')

  // палитра: открыть, найти, перейти; фокус возвращается
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: 'Команда' }).fill('tool-b')
  await page.keyboard.press('Enter')
  must((await page.locator('[role=dialog][aria-label="Палитра команд"]').count()) === 0, 'палитра не закрылась')
  must((await page.locator('aside').innerText()).includes('tool-b'), 'палитра не выбрала tool-b')
  // Палитра возвращает фокус на таблицу в следующем кадре. Если открыть её снова раньше, второй раз она запомнит
  // прежнее поле (поиск), вернёт фокус туда, и цифра `2` уйдёт в поиск: радар не откроется («на радаре должно быть 5 клиентов»).
  await waitFor(async () => (await page.evaluate(() => document.activeElement?.id)) === 'grid', 'после палитры фокус вернулся на таблицу')
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: 'Команда' }).waitFor() // Esc обрабатывает поле ввода: ждём, пока оно получит фокус
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Команда')
  await page.keyboard.press('Escape')
  must((await page.locator('[role=dialog][aria-label="Палитра команд"]').count()) === 0, 'Esc не закрыл палитру')
  await waitFor(async () => (await page.evaluate(() => document.activeElement?.id)) === 'grid', 'после Esc фокус вернулся на таблицу, а не в поле ввода')

  // разделы по цифрам
  await page.keyboard.press('2')
  // раздел рисуется не мгновенно: считаем с ожиданием, а не сразу после нажатия клавиши
  await waitFor(async () => (await page.locator('.node').count()) === 5, 'на радаре должно быть 5 клиентов')
  await page.keyboard.press('3')
  await waitFor(async () => (await page.locator('.pipe .hk').count()) > 0, 'в конвейере нет хуков')
  await page.keyboard.press('4')
  await waitFor(async () => (await page.locator('.find').count()) > 0, 'Доктор ничего не нашёл на фикстуре с поломками')
  await page.keyboard.press('1')

  // снимки по размерам и разделам
  for (const [w, h] of SIZES) {
    await resize(app, w, h)
    for (const [key, name] of [['1', 'matrix'], ['2', 'radar'], ['3', 'hooks'], ['4', 'doctor']]) {
      await page.keyboard.press(key)
      await page.waitForTimeout(250)
      if (key === '1') await layout(page, `${name}@${w}`)
      if (name === 'hooks') {
        // все события конвейера достижимы: если они не помещаются, сетка прокручивается, а не обрезается
        const reach = await page.evaluate(() => {
          const wrap = document.querySelector('.tablewrap.scrollx')
          const heads = [...document.querySelectorAll('.pipe .h')]
          wrap.scrollLeft = wrap.scrollWidth
          const last = heads[heads.length - 1].getBoundingClientRect()
          return { overflowX: getComputedStyle(wrap).overflowX, events: heads.length, lastRight: Math.round(last.right), wrapRight: Math.round(wrap.getBoundingClientRect().right) }
        })
        must(reach.overflowX === 'auto' && reach.lastRight <= reach.wrapRight + 1, `последнее событие хуков недостижимо: ${JSON.stringify(reach)}`)
        await page.evaluate(() => { document.querySelector('.tablewrap.scrollx').scrollLeft = 0 })
      }
      if (w === 1920) {
        const v = await axeCheck(page, name)
        must(v.length === 0, `axe нашёл нарушения на экране «${name}»: ${v.map((x) => x.id).join(', ')}`)
      }
      await shot(page, `m1-${name}-${w}`)
    }
    await page.keyboard.press('1')
  }

  // ---- живое обновление: правка конфига на диске меняет матрицу без кнопки «Скан» и без экрана «загрузка» ----
  await resize(app, 1100, 700) // минимальный размер окна: шапка по-прежнему в одну строку
  await page.waitForTimeout(250)
  await headerLayout(page, 'ru@1100')
  await shot(page, 'm1-matrix-1100')
  await resize(app, 1280, 800)
  await page.keyboard.press('1')
  await page.getByLabel('Поиск').fill('')
  await page.locator('#grid').focus()
  await page.evaluate(() => (document.getElementById('grid').dataset.alive = '1'))
  const cfg = join(home, '.codex', 'config.toml')
  const original = readFileSync(cfg, 'utf8')
  must(String(await cellLabel(page, 'p1', 2)).includes('включено'), 'p1 в Codex исходно включён')
  writeFileSync(cfg, original.replace('[plugins."p1@bundled"]\nenabled = true', '[plugins."p1@bundled"]\nenabled = false'))
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('выключено'), 'глиф p1 сменился на «выключено» сам')
  must((await page.evaluate(() => document.getElementById('grid')?.dataset.alive)) === '1', 'таблица пересоздана: данные должны меняться на месте')
  must((await page.evaluate(() => document.activeElement?.id)) === 'grid', 'фокус слетел с таблицы при обновлении')
  must((await page.locator('td.fresh').count()) > 0, 'изменение не подсвечено значком Δ')
  must((await page.locator('td.fresh .delta').first().innerText()) === 'Δ', 'подсветка без значка (только цвет)')
  must((await page.locator('[role=status]').count()) === 0, 'при обновлении показан экран «загрузка»')

  // ---- убитое ядро поднимается заново, окно догоняет изменения, сделанные за время паузы ----
  const leaf = home.split(/[\\/]/).pop()
  const pids = sidecarPids(leaf)
  must(pids.length === 1, `ядро для окна должно быть одно, найдено: ${pids.length}`)
  execFileSync('taskkill', ['/PID', pids[0], '/F'], { stdio: 'ignore' })
  writeFileSync(cfg, original) // правка, пока ядра нет
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('включено'), 'после перезапуска ядра окно догнало правку', 15000)
  const after = sidecarPids(leaf)
  must(after.length === 1 && after[0] !== pids[0], 'ядро не перезапустилось')
  // и сторож у нового ядра работает
  writeFileSync(cfg, original.replace('[plugins."p1@bundled"]\nenabled = true', '[plugins."p1@bundled"]\nenabled = false'))
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('выключено'), 'сторож нового ядра работает')
  writeFileSync(cfg, original)

  // ---- запись R1: переключил → глиф сменился → откат → глиф вернулся; всё на копии фикстуры и в профиле проверок ----
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
  /** Диалог ОС при повышении уровня подменяем в main-процессе: `answer` 1 — «Включить», 0 — «Отмена». */
  const stubDialog = (answer) =>
    app.evaluate(({ dialog }, a) => {
      globalThis.__answer = a
      dialog.showMessageBox = async () => ({ response: globalThis.__answer, checkboxChecked: false })
    }, answer)
  const dialog = page.locator('[role=dialog][aria-modal=true]')
  const asOff = original.replace('[plugins."p1@bundled"]\nenabled = true', '[plugins."p1@bundled"]\nenabled = false')
  must(asOff !== original, 'фикстура: у p1 нет enabled = true')

  // одиночные клавиши работают и после клика мышью по кнопке (фокус остаётся на кнопке, а не на таблице)
  await page.getByRole('button', { name: /^Радар/ }).click()
  await page.keyboard.press('1')
  await waitFor(async () => (await page.locator('#grid').count()) === 1, 'после клика по кнопке клавиша 1 открывает матрицу')
  // журнал пуст, пока записей не было
  await page.keyboard.press('5')
  await waitFor(async () => (await page.locator('main').innerText()).includes('Операций пока не было'), 'пустой журнал с пояснением')
  await shot(page, 'm3-journal-empty-1280')
  await page.keyboard.press('1')

  await clickCell('p1', 2)
  must(await levelIs('R0'), 'по умолчанию уровень R0')
  must((await page.locator('#scanlines').count()) === 0, 'полосы-сканлайны (линейная горизонтальная рябь) должны быть убраны')
  await page.keyboard.press('Space')
  must((await dialog.count()) === 0, 'при R0 предпросмотр не открывается')
  must((await page.locator('#notice').innerText()).includes('R0'), 'при R0 нет объяснения')
  must(readFileSync(cfg, 'utf8') === original, 'при R0 файл не должен меняться')
  must(await page.getByRole('button', { name: 'Выключить', exact: true }).isDisabled(), 'при R0 кнопка в инспекторе неактивна')

  // отказ в окне ОС оставляет R0, согласие поднимает до R1
  await stubDialog(0)
  await levelSel.selectOption('R1')
  await page.waitForTimeout(600)
  must(await levelIs('R0'), 'отказ в диалоге ОС должен оставить R0')
  await stubDialog(1)
  await levelSel.selectOption('R1')
  await waitFor(() => levelIs('R1'), 'уровень переключился на R1')
  await clickCell('p1', 2)
  await page.keyboard.press('Space')
  await dialog.waitFor({ timeout: 8000 })
  await dialog.getByText('Строю план…').waitFor({ state: 'detached', timeout: 8000 })
  const dText = await dialog.innerText()
  must(dText.includes('~/.codex/config.toml') && dText.includes('включено') && dText.includes('выключено'), `предпросмотр без файла и значений: ${dText}`)
  must(!dText.includes('FAKE-SECRET') && !dText.includes(home.replaceAll('\\', '/')), 'в предпросмотре секрет или путь дома')
  const v1 = await axeCheck(page, 'предпросмотр')
  must(v1.length === 0, `axe: предпросмотр: ${v1.map((x) => x.id).join(', ')}`)
  const footerOk = () => page.evaluate(() => { const f = document.querySelector('footer'); return f.scrollHeight <= f.clientHeight + 1 && f.scrollWidth <= f.clientWidth + 1 })
  must(await footerOk(), 'подвал с сообщением не помещается в одну строку')
  await shot(page, 'm3-dialog-1280')
  await resize(app, 1920, 1080)
  await page.waitForTimeout(250)
  await shot(page, 'm3-dialog-1920')
  await resize(app, 1280, 800)
  await page.keyboard.press('Escape')
  must((await dialog.count()) === 0, 'Esc не закрыл предпросмотр')
  await waitFor(async () => (await page.evaluate(() => document.activeElement?.id)) === 'grid', 'после закрытия предпросмотра фокус вернулся на таблицу')
  must(readFileSync(cfg, 'utf8') === original, 'отмена не должна менять файл')

  // файл со смешанными переводами строк: план отказывает, и Esc закрывает окно, даже если фокус не на «Применить»
  writeFileSync(cfg, original.replace('\n', '\r\n'))
  await page.waitForTimeout(600)
  await page.keyboard.press('Space')
  await dialog.locator('[role=alert]').waitFor({ timeout: 8000 })
  must((await dialog.locator('[role=alert]').innerText()).includes('смешанные'), 'смешанные переводы строк должны давать отказ в плане')
  await page.keyboard.press('Escape')
  must((await dialog.count()) === 0, 'Esc не закрыл предпросмотр с ошибкой плана')
  writeFileSync(cfg, original)
  await page.waitForTimeout(600)

  // файл изменился между предпросмотром и записью: запись отказывает, чужая правка цела
  await page.locator('#grid').focus()
  await page.keyboard.press('Space')
  await dialog.getByRole('button', { name: APPLY }).waitFor({ timeout: 8000 })
  await page.waitForFunction(() => !document.querySelector('[role=dialog] button[disabled]'), null, { timeout: 8000 })
  const touched = `${original}\n# дописал клиент\n`
  writeFileSync(cfg, touched)
  await dialog.getByRole('button', { name: APPLY }).click()
  await dialog.locator('[role=alert]').waitFor({ timeout: 8000 })
  must((await dialog.locator('[role=alert]').innerText()).includes('изменился'), 'устаревший план должен быть отвергнут')
  must(readFileSync(cfg, 'utf8') === touched, 'отказ не должен трогать файл')
  await dialog.getByRole('button', { name: 'Отмена' }).click()
  writeFileSync(cfg, original)
  await page.waitForTimeout(600) // сторож заметил возврат файла, прежде чем строить новый план

  // обычная запись
  await page.locator('#grid').focus()
  await page.keyboard.press('Space')
  await dialog.getByRole('button', { name: APPLY }).waitFor({ timeout: 8000 })
  await page.waitForFunction(() => !document.querySelector('[role=dialog] button[disabled]'), null, { timeout: 8000 })
  await dialog.getByRole('button', { name: APPLY }).click()
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('выключено'), 'после записи глиф p1 «выключено»')
  must(readFileSync(cfg, 'utf8') === asOff, 'записан не только enabled у p1')
  must((await dialog.count()) === 0, 'предпросмотр не закрылся после записи')
  must((await page.locator('#notice').innerText()).includes('Откат'), 'нет сообщения о записи')
  must(existsSync(join(profile, 'backups')), 'бэкапы должны лежать в профиле приложения')

  // журнал и откат
  await page.keyboard.press('5')
  await page.locator('table[aria-label="Журнал операций"] tbody tr').first().waitFor({ timeout: 8000 })
  must((await page.locator('table[aria-label="Журнал операций"] tbody tr').count()) === 1, 'в журнале должна быть одна операция')
  const v2 = await axeCheck(page, 'журнал')
  must(v2.length === 0, `axe: журнал: ${v2.map((x) => x.id).join(', ')}`)
  must(await footerOk(), 'подвал в журнале не помещается в одну строку')
  const wrapped = await page.evaluate(() => [...document.querySelectorAll('table[aria-label="Журнал операций"] td.nw')].filter((td) => { const r = document.createRange(); r.selectNodeContents(td); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size > 1 }).length)
  must(wrapped === 0, `в журнале перенесены значения: ${wrapped}`)
  await shot(page, 'm3-journal-1280')
  await resize(app, 1920, 1080)
  await page.waitForTimeout(250)
  await shot(page, 'm3-journal-1920')
  await resize(app, 1280, 800)
  await page.getByRole('button', { name: 'Откатить' }).click()
  await waitFor(async () => (await page.locator('table[aria-label="Журнал операций"] tbody tr').count()) === 2, 'откат записан в журнал')
  must(readFileSync(cfg, 'utf8') === original, 'после отката файл побайтово как до записи')
  await page.keyboard.press('1')
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('включено'), 'после отката глиф p1 вернулся')
  // ---- R2: корзина, правка, копирование, профили (тоже на копии фикстуры) ----
  await stubDialog(1)
  await levelSel.selectOption('R2')
  await waitFor(() => levelIs('R2'), 'уровень переключился на R2')
  const agFile = join(home, '.gemini', 'config', 'mcp_config.json')
  const agOrig = readFileSync(agFile, 'utf8')
  const agJson = () => JSON.parse(readFileSync(agFile, 'utf8'))
  const applyDialog = async (label = APPLY) => {
    await dialog.getByRole('button', { name: label }).waitFor({ timeout: 8000 })
    await page.waitForFunction(() => !document.querySelector('[role=dialog] button[disabled]'), null, { timeout: 8000 })
    await dialog.getByRole('button', { name: label }).click()
    // Окно закрывается, когда ответ о записи дошёл до страницы, а файл меняется раньше. Пока диалог открыт, одиночные
    // клавиши (`5` — журнал) отключены, и шаг, нажавший их сразу после появления файла, терял нажатие: так «добавление»
    // не находилось в журнале. Ждём закрытия здесь, а не в каждом шаге.
    await dialog.waitFor({ state: 'detached', timeout: 8000 })
  }
  const openPlan = async () => {
    await dialog.getByText('Строю план…').waitFor({ state: 'detached', timeout: 8000 })
    return dialog.innerText()
  }
  const noSecretOnPage = async (what) => must(!(await page.evaluate(() => document.body.innerText)).includes('FAKE-SECRET'), `${what}: в окне найден FAKE-SECRET`)

  // корзина: у MCP Antigravity нет флага, выключение выносит запись из файла
  await clickCell('tool-b', 3)
  const col = await page.evaluate(() => {
    const b = [...document.querySelectorAll('aside .actions.col button')]
    const r = b.map((x) => x.getBoundingClientRect())
    return { n: b.length, lefts: new Set(r.map((x) => Math.round(x.left))).size, tops: new Set(r.map((x) => Math.round(x.top))).size }
  })
  must(col.n >= 4 && col.lefts === 1 && col.tops === col.n, `действия записи в инспекторе должны стоять столбцом, а не рядом: ${JSON.stringify(col)}`)
  // длинный путь файла переносится по сегментам: ни один сегмент (`/…/`) не разорван между строками
  await shot(page, 'm4-inspector-1280')
  const pathSplit = await page.evaluate(() => {
    const dd = [...document.querySelectorAll('aside dd.wrap')].find((d) => d.querySelector('wbr'))
    // верх первого и последнего знака сегмента: разные — сегмент перенесён внутри
    const tops = (s) => { const n = s.lastChild, r = document.createRange(); const at = (i) => { r.setStart(n, i); r.setEnd(n, i + 1); return Math.round(r.getBoundingClientRect().top) }; return [at(0), at(n.length - 1)] }
    return dd ? [...dd.querySelectorAll('span')].filter((s) => { const [a, b] = tops(s); return a !== b }).map((s) => s.textContent) : null
  })
  must(pathSplit !== null && pathSplit.length === 0, `путь файла в инспекторе разорван посреди сегмента: ${JSON.stringify(pathSplit)}`)
  await page.keyboard.press('Space')
  const trashText = await openPlan()
  must(trashText.includes('в корзине Loadout') && trashText.includes('R2'), `предпросмотр выноса в корзину: ${trashText}`)
  must(!trashText.includes('FAKE-SECRET'), 'в предпросмотре выноса секрет')
  await shot(page, 'm4-trash-dialog-1280')
  await applyDialog()
  await waitFor(async () => String(await cellLabel(page, 'tool-b', 3)).includes('выключено'), 'tool-b в корзине: глиф «выключено»')
  must(!('tool-b' in agJson().mcpServers) && 'tool-a' in agJson().mcpServers, 'запись не вынесена из файла или тронута соседняя')
  must((await page.locator('aside').innerText()).includes('корзине'), 'инспектор не говорит про корзину')
  await noSecretOnPage('корзина')
  await page.locator('#grid').focus()
  await page.keyboard.press('Space') // обратно
  await openPlan()
  await applyDialog()
  await waitFor(async () => String(await cellLabel(page, 'tool-b', 3)).includes('включено'), 'tool-b вернулся: глиф «включено»')
  must(JSON.stringify(agJson()) === JSON.stringify(JSON.parse(agOrig)), 'после возврата из корзины файл должен быть равен исходному')

  // правка команды: старые значения не показываются, новые секреты в предпросмотре скрыты
  const deskFile = join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
  const deskOrig = readFileSync(deskFile)
  await clickCell('desk-tool', 1)
  await page.getByRole('button', { name: 'Править команду…' }).click()
  await dialog.getByLabel('Команда').fill('new-cmd')
  await dialog.getByLabel('Аргументы, по одному в строке').fill('--token\nFAKE-SECRET-NEW\n--port\n8080')
  await shot(page, 'm4-edit-dialog-1280')
  await dialog.getByRole('button', { name: 'Предпросмотр' }).click()
  const editText = await openPlan()
  must(editText.includes('<masked>') && !editText.includes('FAKE-SECRET'), `предпросмотр правки: ${editText}`)
  await applyDialog()
  await waitFor(() => JSON.parse(readFileSync(deskFile, 'utf8')).mcpServers['desk-tool'].command === 'new-cmd', 'команда записана в файл')
  const editedDesk = JSON.parse(readFileSync(deskFile, 'utf8')).mcpServers['desk-tool']
  must(editedDesk.env.TOKEN === 'FAKE-SECRET-DESKENV' && editedDesk.args[1] === 'FAKE-SECRET-NEW', 'правка тронула env или записала не те аргументы')
  await noSecretOnPage('правка')
  await page.keyboard.press('5')
  await page.getByRole('row', { name: /правка/ }).getByRole('button', { name: 'Откатить', exact: true }).click()
  await waitFor(() => readFileSync(deskFile).equals(deskOrig), 'откат правки вернул файл побайтово')

  // копирование в другой клиент: формат переводится сам, значения env остаются внутри ядра
  await page.keyboard.press('1')
  const cfgBeforeCopy = readFileSync(cfg)
  await clickCell('tool-a', 3)
  await page.getByRole('button', { name: 'Копировать в клиент…' }).click()
  await dialog.getByLabel('ChatGPT / Codex').check()
  await dialog.getByRole('button', { name: 'Предпросмотр' }).click()
  const copyText = await openPlan()
  must(copyText.includes('~/.codex/config.toml') && copyText.includes('R2') && !copyText.includes('FAKE-SECRET'), `предпросмотр копирования: ${copyText}`)
  await shot(page, 'm4-copy-dialog-1280')
  await applyDialog()
  await waitFor(() => readFileSync(cfg, 'utf8').includes('[mcp_servers.tool-a]'), 'запись скопирована в config.toml Codex')
  await waitFor(async () => String(await cellLabel(page, 'tool-a', 2)).includes('включено'), 'в матрице у Codex появилась запись tool-a')
  await page.keyboard.press('5')
  await page.getByRole('row', { name: /копия/ }).getByRole('button', { name: 'Откатить', exact: true }).click()
  await waitFor(() => readFileSync(cfg).equals(cfgBeforeCopy), 'откат копии вернул config.toml побайтово')

  // добавление нового MCP: значения env уходят только в ядро, откат возвращает файл побайтово
  await page.keyboard.press('1')
  await page.getByRole('button', { name: 'Добавить MCP', exact: true }).click()
  await dialog.getByLabel('Клиент').selectOption({ label: 'ChatGPT / Codex' })
  await dialog.getByLabel('Имя', { exact: true }).fill('e2e-added')
  await dialog.getByLabel('Команда', { exact: true }).fill('npx')
  await dialog.getByLabel('Аргументы, по одному в строке').fill('-y\nsome-mcp')
  await dialog.getByLabel(/Переменные окружения/).fill('API_TOKEN=FAKE-SECRET-ADDED')
  await shot(page, 'm4-add-dialog-1280')
  await dialog.getByRole('button', { name: 'Предпросмотр' }).click()
  const addText = await openPlan()
  must(addText.includes('~/.codex/config.toml') && addText.includes('API_TOKEN') && !addText.includes('FAKE-SECRET'), `предпросмотр добавления: ${addText}`)
  await applyDialog()
  await waitFor(() => readFileSync(cfg, 'utf8').includes('[mcp_servers.e2e-added]'), 'новый сервер записан в config.toml Codex')
  await noSecretOnPage('добавление')
  await page.keyboard.press('5')
  await page.getByRole('row', { name: /добавление/ }).getByRole('button', { name: 'Откатить', exact: true }).click()
  await waitFor(() => readFileSync(cfg).equals(cfgBeforeCopy), 'откат добавления вернул config.toml побайтово')

  // установка плагина CLI Claude Code: сначала команда, потом отдельное подтверждение; плохие имена отвергаются
  await page.keyboard.press('1')
  const pluginErr = (s, dry) => page.evaluate(async ([x, d]) => (await window.loadout.pluginInstall(x, d)).error ?? 'ok', [s, dry])
  must((await pluginErr('x@y --scope local', true)) !== 'ok' && (await pluginErr('../x@y', true)) !== 'ok', 'имя плагина с пробелом или путём должно отвергаться')
  must((await pluginErr('only-name', true)) !== 'ok', 'имя без маркетплейса должно отвергаться')
  must((await pluginErr('demo@market', false)).includes('предпросмотр'), 'установка без предпросмотра должна отказывать')
  // маркетплейс: ввод, который стал бы флагом, второй командой или чужой схемой git, отвергается до запуска
  const mpErr = (s, dry) => page.evaluate(async ([x, d]) => (await window.loadout.marketplaceAdd(x, d)).error ?? 'ok', [s, dry])
  for (const bad of ['a/b --scope local', '-x', 'ext::sh -c x', 'file:///C:/x', 'https://u:p@x.test/m', '\\\\srv\\share', join(home, 'nope')]) {
    must((await mpErr(bad, true)) !== 'ok', `источник маркетплейса должен отвергаться: ${bad}`)
  }
  must((await mpErr(marketDir, false)).includes('предпросмотр'), 'добавление маркетплейса без предпросмотра должно отказывать')
  // маркетплейс → каталог → установка выбором из списка
  await page.getByRole('button', { name: 'Установить плагин', exact: true }).click()
  await dialog.getByRole('button', { name: 'Добавить маркетплейс…' }).click()
  await dialog.getByLabel('Источник маркетплейса').fill(marketDir)
  await dialog.getByRole('button', { name: 'Предпросмотр' }).click()
  // в предпросмотре домашний каталог свёрнут в `~`; снимка этого шага нет: в поле ввода полный путь с именем пользователя
  await dialog.getByText(`claude plugin marketplace add --scope user ${tilde(marketDir)}`).waitFor({ timeout: 8000 })
  must(!existsSync(claudeCalls), 'предпросмотр не должен запускать claude')
  await dialog.getByRole('button', { name: 'Добавить маркетплейс', exact: true }).click()
  const catalog = dialog.getByRole('list', { name: 'Каталог e2e-market' })
  await catalog.waitFor({ timeout: 8000 })
  must(await catalog.getByRole('button', { name: /^tool-plugin/ }).isDisabled(), 'плагин с источником command отсюда не ставится')
  await catalog.getByRole('button', { name: /^hello-plugin/ }).click()
  await dialog.getByText('claude plugin install hello-plugin@e2e-market --scope user').waitFor({ timeout: 8000 })
  const vCat = await axeCheck(page, 'каталог маркетплейса')
  must(vCat.length === 0, `axe: каталог маркетплейса: ${vCat.map((x) => x.id).join(', ')}`)
  await shot(page, 'm4-plugin-dialog-1280')
  await dialog.getByRole('button', { name: 'Установить', exact: true }).click()
  const calls = () => (existsSync(claudeCalls) ? readFileSync(claudeCalls, 'utf8').trim().split('\n') : [])
  await waitFor(() => calls().join('|') === `plugin marketplace add --scope user ${marketDir}|plugin install hello-plugin@e2e-market --scope user`, 'claude вызван с точными командами добавления и установки')
  await dialog.waitFor({ state: 'detached', timeout: 8000 })

  // скил из «GitHub» (локальный git-репозиторий вместо сети): что и куда → скачать → выбрать → план ядра → журнал → откат
  const skillErr = (s, dry) => page.evaluate(async ([x, d]) => (await window.loadout.skillFetch(x, d)).error ?? 'ok', [s, dry])
  for (const bad of ['acme/skills --upload-pack=x', '-acme/x', 'acme/skills/../x', 'https://gitlab.com/a/b', 'relative\\dir']) {
    must((await skillErr(bad, true)) !== 'ok', `источник скила должен отвергаться: ${bad}`)
  }
  must((await skillErr('acme/skills', false)).includes('скачано'), 'загрузка без показа «что будет скачано» должна отказывать')
  const badPlan = await page.evaluate(async () => (await window.loadout.plan({ op: 'installSkill', stage: '../../x', sub: '', name: 'a' })).ok)
  must(badPlan === false, 'план установки скила с путём вместо номера подготовки должен отвергаться')
  const skillDir = join(home, '.claude', 'skills', 'web-search')
  await page.getByRole('button', { name: 'Установить скил', exact: true }).click()
  await dialog.getByLabel('Источник скила').fill('acme/skills')
  await dialog.getByRole('button', { name: 'Что будет скачано' }).click()
  await dialog.getByText(/Будет скачано:.*git .*clone --depth 1 .*acme\/skills\.git/).waitFor({ timeout: 8000 })
  await dialog.getByRole('button', { name: 'Скачать и показать' }).click()
  await dialog.getByRole('radio', { name: /web-search/ }).waitFor({ timeout: 20000 })
  await dialog.getByRole('radio', { name: /web-search/ }).check()
  const vSkill = await axeCheck(page, 'выбор скила')
  must(vSkill.length === 0, `axe: выбор скила: ${vSkill.map((x) => x.id).join(', ')}`)
  await shot(page, 'm6-skill-dialog-1280')
  await dialog.getByRole('button', { name: 'Предпросмотр установки' }).click()
  const skillPlan = await openPlan()
  must(skillPlan.includes('~/.claude/skills/web-search/') && skillPlan.includes('helper.py') && skillPlan.includes('файлы кода'), `предпросмотр установки скила: ${skillPlan}`)
  must(!existsSync(skillDir), 'до подтверждения скил не установлен')
  await shot(page, 'm6-skill-plan-1280')
  await applyDialog()
  await waitFor(() => existsSync(join(skillDir, 'SKILL.md')) && existsSync(join(skillDir, 'helper.py')), 'скил установлен в ~/.claude/skills/web-search')
  await dialog.waitFor({ state: 'detached', timeout: 8000 })
  await page.keyboard.press('1')
  const skillRow = page.locator('tbody tr', { has: page.locator('td.name b', { hasText: /^web-search$/ }) })
  await waitFor(async () => (await skillRow.count()) === 1, 'установленный скил виден в матрице')
  await page.keyboard.press('5')
  await page.getByRole('row', { name: /установка скила/ }).getByRole('button', { name: 'Откатить', exact: true }).click()
  await waitFor(() => !existsSync(skillDir), 'откат убрал скил')
  await page.keyboard.press('1')
  await waitFor(async () => (await skillRow.count()) === 0, 'после отката скила нет в матрице')

  // профили: снять состояние, поправить, применить пакетом, откатить пакет целиком
  await page.keyboard.press('6')
  await page.getByLabel('Имя профиля').fill('e2e')
  await page.getByRole('button', { name: 'Снять с текущего состояния' }).click()
  const card = page.getByRole('region', { name: 'Профиль e2e' })
  await card.waitFor({ timeout: 8000 })
  await card.getByText('Записи профиля').click()
  // сразу после открытия список виден с первой строки целиком (обрезка сверху на снимке — прокрутка от `uncheck()` ниже)
  const plistOpen = await card.locator('details .plist').evaluate((ul) => ({ top: ul.scrollTop, gap: Math.round(ul.querySelector('li').getBoundingClientRect().top - ul.getBoundingClientRect().top) }))
  must(plistOpen.top === 0 && plistOpen.gap >= 0, `список записей профиля открывается обрезанным: ${JSON.stringify(plistOpen)}`)
  await card.locator('li', { hasText: 'p1@bundled' }).getByRole('checkbox').uncheck()
  await card.getByRole('button', { name: 'Сохранить изменения' }).click()
  await waitFor(async () => !(await card.getByRole('button', { name: 'Сохранить изменения' }).isEnabled()), 'профиль сохранён')
  const profLayout = await page.evaluate(() => ({ hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth }))
  must(profLayout.hscroll <= 0 && profLayout.main <= 1, `горизонтальная прокрутка в профилях: ${JSON.stringify(profLayout)}`)
  const v3 = await axeCheck(page, 'профили')
  must(v3.length === 0, `axe: профили: ${v3.map((x) => x.id).join(', ')}`)
  await card.locator('details .plist').evaluate((ul) => { ul.scrollTop = 0 }) // `uncheck()` прокрутил список к p1: на снимке то, что видно при открытии
  await shot(page, 'm4-profiles-1280')
  await resize(app, 1920, 1080)
  await page.waitForTimeout(250)
  await shot(page, 'm4-profiles-1920')
  await resize(app, 1280, 800)
  await card.getByRole('button', { name: 'Применить…' }).click()
  await dialog.getByText('Строю план…').waitFor({ state: 'detached', timeout: 8000 })
  const batchText = await dialog.innerText()
  must(batchText.includes('Изменится записей: 1') && batchText.includes('p1@bundled'), `предпросмотр пакета: ${batchText}`)
  await shot(page, 'm4-batch-dialog-1280')
  await applyDialog()
  await dialog.waitFor({ state: 'detached', timeout: 8000 }) // пока диалог открыт, одиночные клавиши отключены
  await page.keyboard.press('1')
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('выключено'), 'профиль применён: p1 выключен')
  await page.keyboard.press('5')
  await page.getByRole('button', { name: 'Откатить пакет' }).click()
  await page.keyboard.press('1')
  await waitFor(async () => String(await cellLabel(page, 'p1', 2)).includes('включено'), 'пакет откатан: p1 вернулся')
  must(readFileSync(cfg).equals(cfgBeforeCopy), 'после отката пакета config.toml равен исходному')
  await page.keyboard.press('6')
  await card.getByRole('button', { name: 'Удалить профиль' }).click()
  await waitFor(async () => (await card.count()) === 0, 'профиль удалён')

  // ---- встроенные Инструменты контекста: установить и применить на копии фикстуры, диагностика и эффективность ----
  const claudeDir = join(home, '.claude')
  const hookExe = join(claudeDir, 'hooks', 'context-toolkit.exe')
  const settingsFile = join(claudeDir, 'settings.json')
  const opts = { withRules: true, desktop: false, antigravity: false, dsh: false, noStopGate: false, lang: 'ru', advisor: 'keep', mainModel: 'keep', effort: 'keep', policyMode: 'keep', commitHygiene: false, confirmIrreversible: false, strayFiles: false, buildSlots: false, buildSlotsN: 2 } // форма по умолчанию: советник, основная модель, effort и политики «не менять»
  const ctxkitJson = join(claudeDir, 'context-toolkit.json')
  // Настоящий профиль владельца Инструменты контекста трогать не должны: хеши файлов, которые `setup` пишет, до и после всего шага.
  // `~/.claude.json` не сравниваем: его переписывает работающий Claude Code, setup его только читает (в проверках с --claude-json на копию).
  const realHome = homedir()
  const realFiles = ['.claude/settings.json', '.claude/CLAUDE.md', '.claude/hooks/ctxkit.exe', '.claude/hooks/context-toolkit.exe', '.claude/ctxkit.json', '.claude/context-toolkit.json', '.claude/agents/Explore.md', '.claude/agents/checker.md', '.local/bin/ctxkit.exe', '.local/bin/context-toolkit.exe', '.gemini/config/hooks.json', '.dsh/ctxkit-hooks.json', '.dsh/context-toolkit-hooks.json', '.dsh/cordis.patch.yml', '.dsh/profiles/desktop/cordis.patch.yml', 'AppData/Roaming/Claude/ccd-session-presets.json'].map((r) => join(realHome, r))
  const realState = () => realFiles.map((f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'нет'))
  const realBefore = realState()
  const realBackups = () => (existsSync(join(realHome, '.claude', 'backups')) ? readdirSync(join(realHome, '.claude', 'backups')).filter((n) => !n.startsWith('.claude.json.backup')).length : 0)
  const realBackupsBefore = realBackups()
  must(!existsSync(hookExe), 'в копии фикстуры уже есть Инструменты контекста')
  await page.keyboard.press('7')
  await page.getByText('context-toolkit 0.', { exact: false }).first().waitFor({ timeout: 15000 })
  must(await page.getByRole('heading', { name: 'Инструменты контекста', level: 2 }).isVisible(), 'заголовок раздела не «Инструменты контекста»')
  must(await page.locator('nav').getByRole('button', { name: /^Инструменты контекста/ }).isVisible(), 'в навигации нет «Инструменты контекста»')
  must((await page.locator('main').innerText()).includes('нет: «Применить» установит'), 'до установки копия хуков должна быть «нет»')
  must(!(await page.locator('main').innerText()).includes('прежняя версия'), 'на чистой копии фикстуры не должно быть строки о прежней версии')
  const applyBtn = page.getByRole('button', { name: /^Применить: установить/ })
  must(await applyBtn.isDisabled(), 'применение доступно без предпросмотра')
  // ядро-main отказывает и в обход страницы: без предпросмотра и без нужного уровня
  const refusal = (o) => page.evaluate(async (x) => (await window.loadout.ctxkitSetup(x, false)).error ?? 'ok', o)
  must((await refusal(opts)).includes('предпросмотр'), 'применение без предпросмотра не отвергнуто в main')
  must((await refusal({ ...opts, lang: 'de' })).includes('язык'), 'неверный язык не отвергнут')
  const settingsBefore = readFileSync(settingsFile, 'utf8')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await page.locator('pre.out').waitFor({ timeout: 30000 })
  const preview = await page.locator('pre.out').innerText()
  // путь настоящего домашнего каталога (с именем пользователя) в выводе недопустим ни с прямыми, ни с обратными слэшами
  const leaks = [realHome, realHome.replaceAll('\\', '/')].some((h) => preview.toLowerCase().includes(h.toLowerCase()))
  must(preview.includes('Шлюз Stop: включён'), `в предпросмотре нет строки про шлюз Stop: ${preview.slice(0, 300)}`)
  must(preview.includes('[dry-run]') && !preview.includes('FAKE-SECRET') && !leaks, `предпросмотр setup: ${preview.slice(0, 300)}`)
  must(preview.includes('advisorModel: (не задано) (оставлено'), `предпросмотр с формой по умолчанию должен оставлять advisorModel: ${preview.slice(0, 400)}`)
  // форма по умолчанию «Политики: не менять»: context-toolkit.json не создаётся и не упоминается как изменение
  must(preview.includes('политики: нет (оставлено') && !existsSync(ctxkitJson), `«Политики: не менять» не должно создавать context-toolkit.json: ${preview.slice(0, 600)}`)
  // русский интерфейс: в предпросмотре нет английских служебных фраз старого вывода
  must(englishLeft(preview).length === 0, `английские фразы в русском предпросмотре setup: ${englishLeft(preview).slice(0, 5).join(' // ')}`)
  must(readFileSync(settingsFile, 'utf8') === settingsBefore && !existsSync(hookExe), 'предпросмотр изменил файлы')
  await waitFor(() => applyBtn.isEnabled(), 'после предпросмотра применение доступно')
  await page.getByLabel('Язык подсказок, хуков и вывода Инструментов контекста').selectOption('en')
  must(await applyBtn.isDisabled(), 'после смены настроек старый предпросмотр не должен разрешать применение')
  await page.getByLabel('Язык подсказок, хуков и вывода Инструментов контекста').selectOption('ru')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'предпросмотр повторён')
  await shot(page, 'm5-ctxkit-1280')
  await resize(app, 1920, 1080)
  await page.waitForTimeout(250)
  await shot(page, 'm5-ctxkit-1920')
  await resize(app, 1280, 800)
  await applyBtn.click()
  await waitFor(() => existsSync(hookExe), 'setup установил бинарь хуков')
  await waitFor(() => readFileSync(settingsFile, 'utf8').includes('context-toolkit.exe'), 'setup прописал хуки в settings.json')
  must(existsSync(join(claudeDir, 'backups')), 'setup не сделал бэкап перед записью')
  await waitFor(async () => (await page.locator('main').innerText()).includes('~/.claude/hooks/context-toolkit.exe: ● совпадает'), 'статус: копия хуков совпадает со встроенной')
  // диагностика и эффективность по транскриптам фикстуры
  await page.locator('ul[aria-label="Находки диагностики"] li').first().waitFor({ timeout: 15000 })
  await page.locator('table[aria-label="Ходы по дням"] tbody tr').first().waitFor({ timeout: 30000 })
  const eff = await page.locator('main').innerText()
  must(eff.includes('на Sonnet и Haiku') && eff.includes('checker ×'), `нет сводки эффективности: ${eff.slice(-600)}`)
  // период и «Пересчитать» в одной строке; во время подсчёта кнопка занята и это видно; после — время подсчёта
  const recalc = page.locator('section[aria-label="Эффективность"]').getByRole('button', { name: /^(Пересчитать|Считаю…)$/ })
  await waitFor(async () => (await page.locator('section[aria-label="Эффективность"] [role=status]').innerText()).includes('Посчитано в'), 'после первого подсчёта видно время')
  const effRow = await page.evaluate(() => {
    const s = document.querySelector('select[aria-label="Период отчёта"]').getBoundingClientRect()
    const b = [...document.querySelectorAll('section[aria-label="Эффективность"] button')][0].getBoundingClientRect()
    return { dy: Math.abs(s.top + s.height / 2 - (b.top + b.height / 2)), below: b.top > s.bottom }
  })
  must(effRow.dy <= 4 && !effRow.below, `период и «Пересчитать» должны быть в одной строке: ${JSON.stringify(effRow)}`)
  await page.getByLabel('Период отчёта').selectOption('30')
  await waitFor(async () => (await recalc.innerText()).includes('Считаю') || (await page.locator('section[aria-label="Эффективность"] [role=status]').innerText()).includes('Посчитано'), 'смена периода запускает подсчёт')
  await waitFor(async () => (await recalc.isEnabled()) && (await recalc.innerText()) === 'Пересчитать', 'подсчёт за 30 дней завершился, кнопка снова доступна')
  await page.getByLabel('Период отчёта').selectOption('14')
  await waitFor(async () => (await recalc.isEnabled()) && (await recalc.innerText()) === 'Пересчитать', 'подсчёт за 14 дней завершился')
  // список диагностики целиком, без внутренней прокрутки, которая обрезала последнюю находку
  const diag = await page.evaluate(() => { const u = document.querySelector('ul[aria-label="Находки диагностики"]'); return u.scrollHeight - u.clientHeight })
  must(diag <= 1, `список диагностики прокручивается внутри и обрезает строки: ${diag}`)
  await page.locator('section[aria-label="Диагностика"]').screenshot({ path: join(stateDir, 'm5-ctxkit-diag-1280.png') })
  await page.locator('section[aria-label="Эффективность"]').screenshot({ path: join(stateDir, 'm5-ctxkit-efficiency-1280.png') })
  const ctxLayout = await page.evaluate(() => ({ h: document.documentElement.scrollWidth - document.documentElement.clientWidth, m: document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth }))
  must(ctxLayout.h <= 0 && ctxLayout.m <= 1, `горизонтальная прокрутка в разделе Инструментов контекста: ${JSON.stringify(ctxLayout)}`)
  const v4 = await axeCheck(page, 'Инструменты контекста')
  must(v4.length === 0, `axe: Инструменты контекста: ${v4.map((x) => x.id).join(', ')}`)
  await noSecretOnPage('Инструменты контекста')
  // применение с формой по умолчанию (советник «не менять») не создаёт model, advisorModel и effortLevel
  const sKeep = JSON.parse(readFileSync(settingsFile, 'utf8'))
  const sBase = JSON.parse(settingsBefore)
  for (const k of ['model', 'advisorModel', 'effortLevel', 'modelSettings']) must(JSON.stringify(sKeep[k]) === JSON.stringify(sBase[k]) && !(k in sKeep), `форма по умолчанию записала ${k}: ${JSON.stringify(sKeep[k])}`)
  // явный выбор Fable: предпросмотр показывает смену, применение пишет advisorModel
  await page.getByLabel('Модель-советник').selectOption('fable')
  must(await applyBtn.isDisabled(), 'после выбора советника старый предпросмотр не должен разрешать применение')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'предпросмотр с советником Fable')
  must((await page.locator('pre.out').innerText()).includes('advisorModel: (не задано) -> fable'), 'предпросмотр с Fable не показал запись advisorModel')
  must(!('advisorModel' in JSON.parse(readFileSync(settingsFile, 'utf8'))), 'предпросмотр с Fable записал advisorModel')
  await applyBtn.click()
  await waitFor(() => JSON.parse(readFileSync(settingsFile, 'utf8')).advisorModel === 'fable', 'явный выбор Fable записал advisorModel')
  // шлюз Stop: по умолчанию ставится (хук + находка stop_gate «ok»), со снятой галочкой хук убирается (находка «нет шлюза»)
  const ourStop = () => (JSON.parse(readFileSync(settingsFile, 'utf8')).hooks?.Stop ?? []).filter((g) => (g.hooks ?? []).some((h) => /(^|[\\/"])context-toolkit(\.exe)?("|\s|$)/i.test(h.command ?? ''))).length
  const findings = () => page.locator('ul[aria-label="Находки диагностики"]').innerText()
  must(ourStop() === 1, `после применения нет нашего хука Stop (${ourStop()})`)
  await waitFor(async () => (await findings()).includes('шлюз Stop установлен'), 'доктор: шлюз Stop установлен')
  const gateBox = page.getByRole('checkbox', { name: /Шлюз Stop/ })
  must(await gateBox.isChecked(), 'галочка «Шлюз Stop» по умолчанию должна стоять')
  await gateBox.uncheck()
  must(await applyBtn.isDisabled(), 'после смены галочки старый предпросмотр не должен разрешать применение')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'предпросмотр без шлюза Stop')
  must(ourStop() === 1, 'предпросмотр без шлюза изменил settings.json')
  await applyBtn.click()
  await waitFor(() => ourStop() === 0, 'setup убрал хук Stop при снятой галочке')
  await waitFor(async () => (await findings()).includes('нет шлюза Stop'), 'доктор: нет шлюза Stop')
  must(JSON.parse(readFileSync(settingsFile, 'utf8')).hooks.PreToolUse !== undefined, 'снятие шлюза затронуло остальные хуки')
  // окно передаёт --advisor только при явном выборе: основная модель и effort остаются как были, советник — выбор из формы (Fable выбран выше)
  const sNow = JSON.parse(readFileSync(settingsFile, 'utf8'))
  const sPre = JSON.parse(settingsBefore)
  must(sNow.model === sPre.model && sNow.effortLevel === sPre.effortLevel && JSON.stringify(sNow.modelSettings) === JSON.stringify(sPre.modelSettings), 'окно изменило model, effortLevel или modelSettings')
  must(sNow.advisorModel === 'fable', `advisorModel из формы не записан: ${sNow.advisorModel}`)
  // селекты «Основная модель» и «Effort»: по умолчанию «Не менять», явный выбор Sonnet + high виден в предпросмотре и пишется после применения
  const mainSel = page.getByLabel('Основная модель', { exact: true })
  const effortSel = page.getByLabel('Effort', { exact: true })
  must((await mainSel.inputValue()) === 'keep' && (await effortSel.inputValue()) === 'keep', 'селекты основной модели и effort по умолчанию должны быть «Не менять»')
  must((await mainSel.locator('option').allInnerTexts()).join('|') === 'Не менять (по умолчанию)|Sonnet|Opus|Haiku', 'варианты основной модели')
  must((await effortSel.locator('option').allInnerTexts()).join('|') === 'Не менять (по умолчанию)|low|medium|high|xhigh', 'варианты effort')
  must((await page.locator('#ctx-effort-hint').innerText()).includes('2.1.251'), 'под селектом effort нет подсказки про версию Claude Code')
  await mainSel.selectOption('sonnet')
  await effortSel.selectOption('high')
  must(await applyBtn.isDisabled(), 'после выбора модели и effort старый предпросмотр не должен разрешать применение')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'предпросмотр с Sonnet и high')
  const modelPreview = await page.locator('pre.out').innerText()
  for (const line of ['model: (не задано) -> sonnet', 'effortLevel: (не задано) -> high', 'effort modelSettings.claude-sonnet-5-5: (не задано) -> high']) must(modelPreview.includes(line), `предпросмотр с Sonnet и high без строки «${line}»: ${modelPreview.slice(0, 500)}`)
  must(englishLeft(modelPreview).length === 0, `английские фразы в русском предпросмотре с моделью: ${englishLeft(modelPreview).slice(0, 5).join(' // ')}`)
  must(!('model' in JSON.parse(readFileSync(settingsFile, 'utf8'))), 'предпросмотр с Sonnet записал model')
  await mainSel.selectOption('keep')
  await effortSel.selectOption('keep')
  must(await applyBtn.isDisabled(), 'после возврата к «Не менять» старый предпросмотр не должен разрешать применение')
  await mainSel.selectOption('sonnet')
  await effortSel.selectOption('high')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'предпросмотр с Sonnet и high повторён')
  await applyBtn.click()
  await waitFor(() => JSON.parse(readFileSync(settingsFile, 'utf8')).model === 'sonnet', 'выбор Sonnet записал model')
  const sModel = JSON.parse(readFileSync(settingsFile, 'utf8'))
  must(sModel.modelSettings?.['claude-sonnet-5-5']?.effortLevel === 'high' && sModel.effortLevel === 'high', `effort high не записан: ${JSON.stringify({ ms: sModel.modelSettings, e: sModel.effortLevel })}`)
  const foreignStart = (s) => s.hooks.SessionStart.flatMap((g) => g.hooks ?? []).map((h) => h.command).filter((c) => !/context-toolkit|ctxkit/i.test(c))
  must(sModel.advisorModel === 'fable' && JSON.stringify(foreignStart(sModel)) === JSON.stringify(foreignStart(sPre)), `запись модели и effort затронула советника или чужие хуки: ${sModel.advisorModel} ${JSON.stringify(sModel.hooks.SessionStart)} / ${JSON.stringify(sPre.hooks.SessionStart)}`)
  // уход из раздела и возврат: галочка берётся из профиля (шлюза нет), а не сбрасывается на «шлюз включён»
  await page.keyboard.press('1')
  await page.keyboard.press('7')
  await page.locator('ul[aria-label="Находки диагностики"] li').first().waitFor({ timeout: 15000 })
  await waitFor(async () => (await findings()).includes('нет шлюза Stop'), 'доктор после возврата в раздел')
  await waitFor(async () => !(await page.getByRole('checkbox', { name: /Шлюз Stop/ }).isChecked()), 'галочка «Шлюз Stop» после возврата в раздел должна остаться снятой')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(async () => (await page.locator('pre.out').innerText()).includes('Шлюз Stop: выключен'), 'предпросмотр после возврата должен говорить «Шлюз Stop: выключен»')
  must(ourStop() === 0, 'предпросмотр после возврата вернул шлюз')
  // ---- политики «Защиты» из окна: «не менять» не создаёт context-toolkit.json; «включить выбранные» с двумя политиками создаёт его, предпросмотр показывает строки ----
  must(!existsSync(ctxkitJson), 'до выбора политик context-toolkit.json не должно быть: «не менять» его не создаёт')
  const polSel = page.getByLabel('Политики', { exact: true })
  const hygiene = page.getByRole('checkbox', { name: /Гигиена коммитов/ })
  const slotsBox = page.getByRole('checkbox', { name: /Лимит параллельных сборок/ })
  const slotsNum = page.getByLabel('Лимит параллельных сборок, от 1 до 8')
  must((await polSel.inputValue()) === 'keep' && (await polSel.locator('option').allInnerTexts()).join('|') === 'Не менять (по умолчанию)|Включить выбранные|Выключить все', 'селект политик: по умолчанию «Не менять»')
  must((await page.locator('#ctx-policy-hint').innerText()).includes('файла политик нет'), 'подпись под политиками без файла политик должна говорить, что его нет')
  must(await hygiene.isDisabled() && await slotsBox.isDisabled() && await page.getByRole('checkbox', { name: /Неожиданные файлы-отчёты/ }).isDisabled() && await page.getByRole('checkbox', { name: /Подтверждение необратимого/ }).isDisabled(), 'при «Не менять» чекбоксы политик должны быть недоступны')
  // отмеченное при «Не менять» не уходит в setup: окно держит настройки, а main — аргументы (без --policy)
  await polSel.selectOption('on')
  await hygiene.check()
  await slotsBox.check()
  await slotsNum.fill('3')
  must(await applyBtn.isDisabled(), 'после выбора политик старый предпросмотр не должен разрешать применение')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'предпросмотр с политиками')
  const polPreview = await page.locator('pre.out').innerText()
  for (const line of ['политика commit_hygiene: выкл -> вкл', 'политика build_slots: выкл -> 3', 'политика stray_files: выкл (без изменений)']) must(polPreview.includes(line), `предпросмотр политик без строки «${line}»: ${polPreview.slice(0, 700)}`)
  must(englishLeft(polPreview).length === 0, `английские фразы в русском предпросмотре политик: ${englishLeft(polPreview).slice(0, 5).join(' // ')}`)
  must(!existsSync(ctxkitJson), 'предпросмотр политик создал context-toolkit.json')
  await page.locator('fieldset.choices', { has: page.locator('#ctx-policy') }).screenshot({ path: join(stateDir, 'm5-ctxkit-policies-1280.png') })
  await applyBtn.click()
  await waitFor(() => existsSync(ctxkitJson), 'применение создало context-toolkit.json')
  const polCfg = JSON.parse(readFileSync(ctxkitJson, 'utf8'))
  must(polCfg.policies?.commit_hygiene === true && polCfg.policies?.build_slots === 3 && !polCfg.policies?.stray_files && polCfg.created_by === 'context-toolkit setup', `context-toolkit.json после применения: ${JSON.stringify(polCfg)}`)
  // подпись «сейчас включены» берётся из находки policies, а форму не меняет
  await waitFor(async () => (await page.locator('#ctx-policy-hint').innerText()).includes('Сейчас включены: commit_hygiene, build_slots=3'), 'подпись «Сейчас включены» из диагностики')
  must((await polSel.inputValue()) === 'on', 'подпись из диагностики изменила форму')
  await polSel.selectOption('keep')
  // ---- откат на копии фикстуры: предпросмотр, R2, чужие хуки на месте, повтор безопасен ----
  const undoOpts = { antigravity: false, dsh: false }
  const undoRefusal = (o, dry) => page.evaluate(async ([x, d]) => (await window.loadout.ctxkitUninstall(x, d)).error ?? 'ok', [o, dry])
  const undoPreviewBtn = page.getByRole('button', { name: 'Откатить Инструменты контекста', exact: true })
  const undoGoBtn = page.getByRole('button', { name: 'Откатить: убрать хуки, блок правил и бинарь' })
  const foreignCmds = (s) => Object.values(s.hooks ?? {}).flat().flatMap((g) => g.hooks ?? []).map((h) => h.command ?? '').filter((c) => !/(^|[\\/"])(context-toolkit|ctxkit)(\.exe)?("|\s|$)/i.test(c)).sort()
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v)
  const claudeMd = join(claudeDir, 'CLAUDE.md')
  const settingsHooked = readFileSync(settingsFile, 'utf8')
  must(foreignCmds(JSON.parse(settingsBefore)).length === 3 && JSON.stringify(foreignCmds(JSON.parse(settingsHooked))) === JSON.stringify(foreignCmds(JSON.parse(settingsBefore))), 'до отката чужие хуки фикстуры должны быть на месте')
  must(existsSync(claudeMd) && readFileSync(claudeMd, 'utf8').includes('<!-- context-toolkit:start -->'), 'до отката в CLAUDE.md нет блока правил')
  must((await undoGoBtn.count()) === 0, 'кнопка отката видна без предпросмотра отката')
  must((await undoRefusal(undoOpts, false)).includes('предпросмотр'), 'откат без предпросмотра отката (есть только предпросмотр setup) не отвергнут в main')
  must((await undoRefusal({ antigravity: 'yes', dsh: false }, true)).includes('параметры'), 'неверные параметры отката не отвергнуты')
  must((await undoRefusal(undoOpts, 'x')).includes('параметры'), 'неверный dryRun отката не отвергнут')
  // занятость: сразу после нажатия кнопка показывает «Считаю…» со спиннером, строка состояния говорит, что идёт, все кнопки заблокированы
  const busyNow = await page.evaluate(() => {
    const sec = document.querySelector('section[aria-label="Применение"]')
    const b = [...sec.querySelectorAll('button')].find((x) => x.textContent === 'Откатить Инструменты контекста')
    // состояние снимается в первый же момент, когда DOM показал занятость (MutationObserver, а не пауза: ответ быстрый)
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
  must(busyNow.label === 'Считаю…' && busyNow.spin && busyNow.status.includes('Считаю предпросмотр отката') && busyNow.allDisabled, `занятость кнопки отката: ${JSON.stringify(busyNow)}`)
  await undoGoBtn.waitFor({ timeout: 30000 })
  await waitFor(() => undoGoBtn.isDisabled().then((d) => !d), 'после предпросмотра отката кнопка отката доступна')
  const undoPreview = await page.locator('pre.out').innerText()
  must(undoPreview.includes('[dry-run]') && undoPreview.includes('Не тронуто') && undoPreview.includes('sonnet') && undoPreview.includes('fable'), `предпросмотр отката без списка «не тронуто» с model и advisorModel: ${undoPreview.slice(0, 600)}`)
  must(![realHome, realHome.replaceAll('\\', '/')].some((h) => undoPreview.toLowerCase().includes(h.toLowerCase())), 'предпросмотр отката показал путь настоящего профиля')
  must(englishLeft(undoPreview).length === 0, `английские фразы в русском предпросмотре отката: ${englishLeft(undoPreview).slice(0, 5).join(' // ')}`)
  must(undoPreview.includes('context-toolkit.json удалён (его создал setup)') && existsSync(ctxkitJson), `предпросмотр отката не обещает убрать context-toolkit.json, созданный setup (и не должен трогать его): ${undoPreview.slice(0, 500)}`)
  must((await page.locator('main').innerText()).includes('Предпросмотр отката: файлы не менялись.'), 'нет подписи предпросмотра отката')
  must(readFileSync(settingsFile, 'utf8') === settingsHooked && existsSync(hookExe), 'предпросмотр отката изменил файлы')
  // предпросмотр отката не разрешает «Применить», а смена формы гасит предпросмотр отката
  must(await applyBtn.isDisabled(), 'после предпросмотра отката «Применить» не должно быть доступно')
  must((await refusal(opts)).includes('предпросмотр'), 'применение после предпросмотра отката не отвергнуто в main')
  await page.getByRole('checkbox', { name: 'Antigravity' }).check()
  must((await undoGoBtn.count()) === 0, 'после смены формы кнопка отката должна пропасть')
  await page.getByRole('checkbox', { name: 'Antigravity' }).uncheck()
  await undoPreviewBtn.click()
  await waitFor(() => undoGoBtn.isEnabled(), 'предпросмотр отката повторён')
  // выравнивание новых строк формы замером: подписи и селекты по одной левой границе, кнопки одной ширины, подсказки в карточке, ничего не обрезано
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
    return {
      selDx: spread(sels.map((x) => x.left)), lblDx: spread(lbls.map((x) => x.left)), lblSelDx: Math.abs(lbls[0].left - sels[0].left),
      btnCount: btns.length, btnLeftDx: spread(br.map((x) => x.left)), btnWidthDx: spread(br.map((x) => x.width)),
      btnClipped: btns.some((b) => b.scrollWidth > b.clientWidth + 1),
      btnsOrdered: br.every((x, i) => i === 0 || x.top >= br[i - 1].bottom - 1),
      hintsOut: hints.some((x) => x.right > r(sec).right + 0.5 || x.left < r(sec).left - 0.5),
      statusBelow: r(sec.querySelector('[role=status]')).top >= br[br.length - 1].bottom - 1,
      hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, mScroll: document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth,
    }
  })
  for (const w of [1100, 1280, 1920]) {
    await resize(app, w, 800)
    await page.waitForTimeout(250)
    const f = await formLayout()
    must(f.selDx <= 1 && f.lblDx <= 1 && f.lblSelDx <= 1 && f.btnCount === 4 && f.btnLeftDx <= 1 && f.btnWidthDx <= 1 && !f.btnClipped && f.btnsOrdered && !f.hintsOut && f.statusBelow && f.hScroll <= 0 && f.mScroll <= 1, `выравнивание формы Инструментов контекста на ${w}: ${JSON.stringify(f)}`)
    if (w !== 1100) await shot(page, `m5-ctxkit-undo-${w}`)
  }
  await resize(app, 1280, 800)
  await page.waitForTimeout(250)
  const v5 = await axeCheck(page, 'Инструменты контекста: предпросмотр отката')
  must(v5.length === 0, `axe: форма Инструментов контекста с предпросмотром отката: ${v5.map((x) => x.id).join(', ')}`)
  await undoGoBtn.click()
  await waitFor(() => !existsSync(hookExe), 'откат убрал бинарь хуков')
  await waitFor(async () => (await page.locator('main').innerText()).includes('Откат выполнен.'), 'после отката нет подписи «Откат выполнен.»')
  await waitFor(async () => (await page.locator('#notice').innerText().catch(() => '')).includes('Откат Инструментов контекста выполнен'), 'после отката нет уведомления')
  must(await page.evaluate(() => document.activeElement?.textContent === 'Откатить Инструменты контекста'), 'после отката фокус не вернулся на кнопку предпросмотра отката')
  must((await undoRefusal(undoOpts, false)).includes('предпросмотр'), 'один предпросмотр отката разрешил второй откат')
  await waitFor(async () => (await page.locator('main').innerText()).includes('~/.claude/hooks/context-toolkit.exe: ✕ нет'), 'статус после отката: копии хуков нет')
  const undone = JSON.parse(readFileSync(settingsFile, 'utf8'))
  must(!/context-toolkit|ctxkit/i.test(JSON.stringify(undone)), `после отката в settings.json остались наши записи: ${JSON.stringify(undone).slice(0, 400)}`)
  must(JSON.stringify(foreignCmds(undone)) === JSON.stringify(foreignCmds(JSON.parse(settingsBefore))), 'откат тронул чужие хуки')
  must(undone.model === 'sonnet' && undone.advisorModel === 'fable' && undone.modelSettings?.['claude-sonnet-5-5']?.effortLevel === 'high', 'откат тронул модель, советника или effort: их он оставляет')
  const { model: _m, advisorModel: _a, effortLevel: _e, modelSettings: _s, ...rest } = undone
  must(JSON.stringify(canon(rest)) === JSON.stringify(canon(JSON.parse(settingsBefore))), `после отката settings.json без модели, советника и effort не равен исходному: ${JSON.stringify(canon(rest)).slice(0, 400)}`)
  must(!existsSync(claudeMd) || !/context-toolkit|ctxkit/i.test(readFileSync(claudeMd, 'utf8')), 'откат оставил блок правил в CLAUDE.md')
  must(!existsSync(ctxkitJson), 'откат из окна не убрал context-toolkit.json, который создал setup')
  must(existsSync(join(claudeDir, 'agents', 'checker.md')) && existsSync(join(claudeDir, 'agents', 'Explore.md')), 'откат удалил агентов: он их оставляет')
  must((await page.locator('pre.out').innerText()).includes('backups'), 'в выводе отката нет пути к бэкапу settings.json')
  // повтор безопасен: второй откат ничего не меняет и не падает
  const settingsUndone = readFileSync(settingsFile, 'utf8')
  await undoPreviewBtn.click()
  await waitFor(() => undoGoBtn.isEnabled(), 'предпросмотр повторного отката')
  await undoGoBtn.click()
  await waitFor(async () => (await page.locator('main').innerText()).includes('Откат выполнен.'), 'повторный откат завершился')
  must(readFileSync(settingsFile, 'utf8') === settingsUndone && !existsSync(hookExe) && !(await page.locator('section[aria-label="Применение"] [role=alert]').count()), 'повторный откат изменил файлы или показал ошибку')
  // галочки интеграций доходят до setup: предпросмотр отката с Antigravity и DeepSeek Harness говорит про них (на копии, ничего не пишет)
  const integ = await page.evaluate(async () => (await window.loadout.ctxkitUninstall({ antigravity: true, dsh: true }, true)).data?.output ?? '')
  must(/antigravity/i.test(integ) && /DeepSeek/i.test(integ) && integ.includes('[dry-run]'), `предпросмотр отката с интеграциями без строк про Antigravity и DeepSeek: ${integ.slice(0, 400)}`)
  must(englishLeft(integ).length === 0, `английские фразы в русском предпросмотре отката с интеграциями: ${englishLeft(integ).slice(0, 5).join(' // ')}`)
  must(![realHome, realHome.replaceAll('\\', '/')].some((h) => integ.toLowerCase().includes(h.toLowerCase())), 'предпросмотр отката с интеграциями показал путь настоящего профиля')
  // ---- переход с прежней установки (ctxkit) на копии фикстуры: строка о прежней версии, её кнопка предпросмотра,
  // «Применить», итог на новом имени, чужое на месте; затем откат возвращает копию к состоянию до шага ----
  const oldHookExe = join(claudeDir, 'hooks', 'ctxkit.exe')
  mkdirSync(join(claudeDir, 'hooks'), { recursive: true })
  copyFileSync(join(appDir, 'build', 'context-toolkit.exe'), oldHookExe) // бинарь прежнего имени: его --version тоже «наш продукт»
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
  await waitFor(async () => (await page.locator('main').innerText()).includes(legacyLine), 'раздел не увидел прежнюю установку (ctxkit)')
  await waitFor(async () => (await findings()).includes('старом имени ctxkit'), 'доктор: нет находки о старом имени')
  await page.locator('section[aria-label="Установка"]').screenshot({ path: join(stateDir, 'm5-ctxkit-legacy-1280.png') })
  must((await axeCheck(page, 'Инструменты контекста: прежняя версия')).length === 0, 'axe: строка о прежней версии')
  await page.getByRole('button', { name: 'Предпросмотр перехода', exact: true }).click()
  await waitFor(() => applyBtn.isEnabled(), 'предпросмотр перехода разрешил «Применить»')
  const legacyPreview = await page.locator('pre.out').innerText()
  // старый бинарь ещё запускают хуки DeepSeek Harness фикстуры (~/.dsh/ctxkit-hooks.json, а профиля desktop, который
  // setup --dsh переписал бы, у фикстуры нет): переход его оставляет и говорит почему, иначе DSH остался бы с хуком на пустое место
  for (const line of ['старое имя: хуки на ctxkit.exe ->', 'старое имя: env.CTXKIT_LANG -> env.CONTEXT_TOOLKIT_LANG', '[dry-run] старое имя: перенос', 'старый бинарь оставлен']) must(legacyPreview.includes(line), `предпросмотр перехода без строки «${line}»: ${legacyPreview.slice(0, 800)}`)
  must(englishLeft(legacyPreview).length === 0, `английские фразы в русском предпросмотре перехода: ${englishLeft(legacyPreview).slice(0, 5).join(' // ')}`)
  must(existsSync(oldHookExe) && readFileSync(settingsFile, 'utf8').includes('ctxkit.exe'), 'предпросмотр перехода изменил файлы')
  await applyBtn.click()
  await waitFor(() => existsSync(hookExe) && !readFileSync(settingsFile, 'utf8').includes('ctxkit.exe'), 'переход: хуки на новом бинаре')
  const legacyOut = await page.locator('pre.out').innerText()
  must(existsSync(oldHookExe) && legacyOut.includes('старый бинарь оставлен') && legacyOut.includes('DeepSeek Harness') && legacyOut.includes('context-toolkit setup --dsh'), `переход: старый бинарь, который ещё нужен DSH, должен остаться с объяснением: ${legacyOut.slice(-800)}`)
  await waitFor(async () => (await page.locator('main').innerText()).includes('Остался бинарь прежней версии ~/.claude/hooks/ctxkit.exe'), 'после перехода нет строки об оставшемся старом бинаре')
  const sMoved = JSON.parse(readFileSync(settingsFile, 'utf8'))
  must(!JSON.stringify(sMoved.hooks).includes('ctxkit.exe') && JSON.stringify(sMoved.hooks).includes('context-toolkit.exe'), `переход: хуки не на новом бинаре: ${JSON.stringify(sMoved.hooks).slice(0, 400)}`)
  must(sMoved.env?.CONTEXT_TOOLKIT_LANG === 'ru' && !('CTXKIT_LANG' in (sMoved.env ?? {})), `переход: язык хуков: ${JSON.stringify(sMoved.env)}`)
  must(JSON.stringify(foreignCmds(sMoved)) === JSON.stringify(foreignCmds(JSON.parse(settingsBefore))), 'переход тронул чужие хуки')
  const mdMoved = readFileSync(claudeMd, 'utf8')
  must(mdMoved.includes('<!-- context-toolkit:start -->') && !mdMoved.includes('ctxkit:') && mdMoved.startsWith(mdOwn.trimEnd()), `переход: блок правил: ${mdMoved.slice(-400)}`)
  must(!existsSync(join(claudeDir, 'ctxkit.json')) && JSON.parse(readFileSync(ctxkitJson, 'utf8')).policies?.stray_files === true, 'переход: файл политик не перенесён')
  await waitFor(async () => { const m = await page.locator('main').innerText(); return !m.includes('Установлена прежняя версия') && m.includes('~/.claude/hooks/context-toolkit.exe: ● совпадает') }, 'после перехода строка о прежней версии осталась')
  await page.locator('section[aria-label="Установка"]').screenshot({ path: join(stateDir, 'm5-ctxkit-legacy-left-1280.png') })
  await undoPreviewBtn.click()
  await waitFor(() => undoGoBtn.isEnabled(), 'предпросмотр отката после перехода')
  await undoGoBtn.click()
  await waitFor(() => !existsSync(hookExe) && !existsSync(oldHookExe) && !existsSync(ctxkitJson), 'откат после перехода убирает оба бинаря и файл политик')
  must(!/context-toolkit|ctxkit/i.test(readFileSync(settingsFile, 'utf8')) && JSON.stringify(foreignCmds(JSON.parse(readFileSync(settingsFile, 'utf8')))) === JSON.stringify(foreignCmds(JSON.parse(settingsBefore))), 'откат после перехода оставил наше или тронул чужое')
  await page.keyboard.press('1')
  await levelSel.selectOption('R0') // понижение подтверждения не требует
  must((await refusal(opts)).includes('R2'), 'при R0 применение не отвергнуто в main')
  must((await undoRefusal(undoOpts, false)).includes('R2'), 'при R0 откат не отвергнут в main')
  must(JSON.stringify(realState()) === JSON.stringify(realBefore), 'setup изменил файл настоящего профиля владельца')
  must(realBackups() === realBackupsBefore, 'setup создал бэкап в настоящем профиле владельца')
  await waitFor(() => levelIs('R0'), 'уровень вернулся в R0')

  // reduced motion → «FX: выкл» по умолчанию применяется при загрузке; здесь проверяем переключатель
  await page.getByLabel('Уровень эффектов').selectOption('off')
  must((await page.evaluate(() => document.documentElement.dataset.fx)) === 'off', 'FX не выключился')

  must(pageErrors.length === 0, `ошибки страницы: ${pageErrors.join(' | ')}`)
  await close(session)

  // ---- состояние «загрузка» ----
  session = await launch({ LOADOUT_HOME: home, LOADOUT_QA_DELAY_MS: '3000' })
  await session.page.waitForSelector('[role=status]', { timeout: 10000 })
  await resize(session.app, 1280, 800)
  await shot(session.page, 'm1-state-loading-1280')
  await session.page.waitForSelector('#grid', { timeout: 20000 })
  await close(session)

  // ---- состояние «ошибка»: ядро не найдено ----
  session = await launch({ LOADOUT_HOME: home, LOADOUT_BIN: join(repo, 'target', 'release', 'loadout-missing.exe') })
  await session.page.waitForSelector('[role=alert]', { timeout: 10000 })
  must((await session.page.locator('[role=alert]').innerText()).includes('ядро не найдено'), 'сообщение об отсутствии ядра')
  await resize(session.app, 1280, 800)
  await shot(session.page, 'm1-state-error-1280')
  await close(session)

  // ---- «ошибка»: ядро запускается, но отдаёт не то (node.exe под видом ядра) ----
  const fake = join(mkdtempSync(join(tmpdir(), 'loadout-fake-')), 'loadout-fake.exe')
  cpSync(process.execPath, fake)
  homes.push(dirname(fake))
  session = await launch({ LOADOUT_HOME: home, LOADOUT_BIN: fake })
  await session.page.waitForSelector('[role=alert]', { timeout: 15000 })
  must((await session.page.locator('[role=alert]').innerText()).includes('ядро не ответило'), 'сообщение о сбое ядра')
  await session.page.getByRole('button', { name: 'Повторить' }).click()
  await close(session)

  // ---- состояние «пусто» ----
  const empty = mkdtempSync(join(tmpdir(), 'loadout-empty-'))
  homes.push(empty)
  session = await launch({ LOADOUT_HOME: empty })
  await session.page.waitForSelector('#grid', { timeout: 20000 })
  must((await session.page.locator('td.empty').innerText()).includes('не найдено'), 'пустое состояние')
  await resize(session.app, 1280, 800)
  await shot(session.page, 'm1-state-empty-1280')
  await close(session)
  session = undefined

  // ---- английский интерфейс: ни одной кириллической буквы ни в тексте, ни в атрибутах, ни в ответах ядра ----
  const enHome = materialize(() => {})
  homes.push(enHome)
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ writeLevel: 'R2' }))
  // журнал русских сценариев остаётся: записи, сделанные на другом языке, показываются на текущем (relang в ядре)
  const enMarket = sources(enHome)
  session = await launch({ ...fakeEnv(enHome, join(enHome, 'claude-calls.txt')), LOADOUT_LANG: 'en' })
  {
    const { app: enApp, page: en } = session
    const enErrors = []
    en.on('pageerror', (e) => enErrors.push(`pageerror: ${e.message.slice(0, 200)}`))
    await en.waitForSelector('#grid', { timeout: 20000 })
    await resize(enApp, 1280, 800)
    must((await en.evaluate(() => document.documentElement.lang)) === 'en', 'html lang не en')
    // текст страницы, подписи, подсказки и плейсхолдеры: всё, что видит пользователь или экранный диктор
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
      must(bad.length === 0, `кириллица в английском интерфейсе:\n${bad.slice(0, 12).join('\n')}`)
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
    // Context Toolkit на английском: форма с политиками, предпросмотр и применение, предпросмотр и откат; вывод ядра (`pre.out`) тоже без кириллицы
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
      await en.locator('fieldset.choices', { has: en.locator('#ctx-policy') }).screenshot({ path: join(stateDir, 'en-ctxkit-policies-1280.png') })
      await enApply.click()
      await waitFor(() => existsSync(ctxHook) && existsSync(ctxJson), 'Context Toolkit (EN): apply wrote the hook binary and context-toolkit.json')
      await waitFor(async () => (await en.locator('main').innerText()).includes('Applied.'), 'Context Toolkit (EN): no “Applied.” caption')
      await enOk('ctxkit: applied')
      await waitFor(async () => (await en.locator('#ctx-policy-hint').innerText()).includes('Currently on: commit_hygiene, stray_files'), 'Context Toolkit (EN): the “Currently on” caption from the doctor')
      await enOk('ctxkit: policies caption')
      await en.getByRole('button', { name: 'Roll back Context Toolkit', exact: true }).click()
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
    // палитра
    await en.keyboard.press('Control+k')
    await en.waitForTimeout(300)
    await enOk('palette')
    await en.keyboard.press('Escape')
    // добавление: ошибка ядра (имя занято) и план ядра — оба на английском
    const enDialog = en.locator('[role=dialog][aria-modal=true]')
    await en.getByRole('button', { name: 'Add MCP', exact: true }).click()
    await enDialog.getByLabel('Client').selectOption({ label: 'Antigravity' })
    await enDialog.getByLabel('Name', { exact: true }).fill('tool-a')
    await enDialog.getByLabel('Command', { exact: true }).fill('npx')
    await enDialog.getByRole('button', { name: 'Preview' }).click()
    await enDialog.locator('[role=alert]').waitFor({ timeout: 8000 })
    await enOk('add: core error')
    await shot(en, 'en-add-error-1280')
    await enDialog.getByRole('button', { name: 'Cancel' }).click()
    await en.getByRole('button', { name: 'Add MCP', exact: true }).click()
    await enDialog.getByLabel('Client').selectOption({ label: 'Antigravity' })
    await enDialog.getByLabel('Name', { exact: true }).fill('en-added')
    await enDialog.getByLabel('Command', { exact: true }).fill('npx')
    await enDialog.getByRole('button', { name: 'Preview' }).click()
    await enDialog.getByText('~/.gemini/config/mcp_config.json').waitFor({ timeout: 8000 })
    await enOk('add: core plan')
    await shot(en, 'en-add-plan-1280')
    await enDialog.getByRole('button', { name: 'Cancel' }).click()
    // установка плагина: предпросмотр
    await en.getByRole('button', { name: 'Install plugin', exact: true }).click()
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
    // установка настоящим запуском (подставной claude): команды те же, окно закрывается, в окне ни слова по-русски
    await enDialog.getByRole('button', { name: 'Install', exact: true }).click()
    const enCalls = () => (existsSync(join(enHome, 'claude-calls.txt')) ? readFileSync(join(enHome, 'claude-calls.txt'), 'utf8').trim().split('\n') : [])
    await waitFor(() => enCalls().join('|') === `plugin marketplace add --scope user ${enMarket}|plugin install hello-plugin@e2e-market --scope user`, 'claude (EN) called with the exact add and install commands')
    await enDialog.waitFor({ state: 'detached', timeout: 8000 })
    await enOk('plugin installed')
    // скил: показ «что будет скачано», загрузка, выбор и план ядра
    await en.getByRole('button', { name: 'Install skill', exact: true }).click()
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
    // установка скила и откат из журнала: запись журнала и всё, что окно показывает при этом, по-английски
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
    await waitFor(() => !existsSync(enSkill), 'skill (EN) rolled back from the journal')
    await enOk('journal after the skill rollback')
    await en.keyboard.press('1')
    await en.waitForSelector('#grid', { timeout: 15000 })
    // запись из матрицы: корзина, правка и копирование (диалоги и планы ядра)
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
    // журнал после записи на английском: сама запись и откат
    await enCell('tool-a', 3)
    await en.getByRole('button', { name: 'Disable (move to trash)' }).click()
    await enDialog.getByRole('button', { name: 'Move to trash' }).click()
    await enDialog.waitFor({ state: 'detached', timeout: 8000 })
    await en.keyboard.press('5')
    await en.getByRole('row').filter({ hasText: 'Loadout trash' }).first().waitFor({ timeout: 8000 })
    await enOk('journal row')
    await shot(en, 'en-journal-1280')
    // переключатель языка: на русский и обратно
    await en.getByLabel('Language').selectOption('ru')
    await en.getByRole('button', { name: 'Матрица' }).waitFor({ timeout: 10000 })
    must((await en.evaluate(() => document.documentElement.lang)) === 'ru', 'после переключения на RU lang не ru')
    await en.getByLabel('Язык').selectOption('en')
    await en.getByRole('button', { name: 'Matrix' }).waitFor({ timeout: 10000 })
    // после RU→EN: уровень записи пережил сохранение языка, перезапущенное ядро говорит по-английски и принимает запись
    must((await en.getByLabel('Write').inputValue()) === 'R2', 'смена языка стёрла уровень записи')
    must(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')).lang === 'en', 'язык не сохранён в settings.json')
    await en.waitForSelector('#grid', { timeout: 15000 })
    await enCell('tool-b', 3)
    await en.getByRole('button', { name: 'Disable (move to trash)' }).click()
    await enDialog.getByText('Loadout trash').first().waitFor({ timeout: 8000 })
    await enOk('plan after the switch')
    await enDialog.getByRole('button', { name: 'Move to trash' }).click()
    await enDialog.waitFor({ state: 'detached', timeout: 8000 })
    await en.keyboard.press('5')
    await en.getByRole('row').filter({ hasText: 'Loadout trash' }).first().getByRole('button', { name: 'Roll back', exact: true }).click()
    await en.waitForTimeout(800)
    await enOk('journal after rollback')
    must(enErrors.length === 0, `ошибки страницы (EN): ${enErrors.join(' | ')}`)
  }
  await close(session)
  session = undefined

  log('OK: все сценарии прошли')
} catch (e) {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  if (session) await close(session).catch(() => {})
  process.exitCode = 1
} finally {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
  const core = coreLeftovers()
  log('оставшихся процессов ядра этого прогона (loadout*.exe с профилем проверок):', core.length)
  for (const id of core) {
    try {
      execFileSync('taskkill', ['/PID', id, '/F'], { stdio: 'ignore' })
    } catch {
      /* уже закрыт */
    }
  }
  if (core.length) process.exitCode = 1
  const left = leftovers()
  log('оставшихся процессов electron проверочного профиля:', left.length)
  if (left.length) {
    for (const id of left) {
      try {
        execFileSync('taskkill', ['/PID', id, '/T', '/F'], { stdio: 'ignore' })
      } catch {
        /* уже закрыт */
      }
    }
    process.exitCode = 1
  }
}
