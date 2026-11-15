// Проверка окна: Playwright `_electron`, свой профиль, фикстурный домашний каталог. Запуск: `npm run e2e`.
// Профиль владельца не трогается: APP_QA=1 + LOADOUT_USER_DATA=state/loadout-qa.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

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
const APPLY = /^(Включить|Выключить|Вынести в корзину|Вернуть из корзины|Записать команду|Скопировать|Применить)/

const log = (...a) => console.log(...a)
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
    env: { ...process.env, APP_QA: '1', LOADOUT_USER_DATA: profile, LOADOUT_BIN: loadoutBin, ...env },
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
  must(m.hscroll <= 0, `${label}: горизонтальная прокрутка страницы (${m.hscroll}px)`)
  must(m.clipped === 0, `${label}: обрезанных имён: ${m.clipped}`)
  must(m.misaligned === 0, `${label}: колонки шапки и ячеек смещены`)
}

/** Процессы ядра (`loadout*.exe`) любого вида: после проверок их остаться не должно. */
function coreLeftovers() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'loadout*.exe' } | Select-Object -ExpandProperty ProcessId`],
      { encoding: 'utf8' },
    )
    return out.split(/\s+/).filter(Boolean)
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
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*loadout-qa*' } | Select-Object -ExpandProperty ProcessId`],
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
  must(existsSync(join(appDir, 'build', 'ctxkit.exe')), 'нет app/build/ctxkit.exe: npm run bundle:ctxkit')
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

  // ---- основной сценарий ----
  session = await launch({ LOADOUT_HOME: home })
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
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: 'Команда' }).waitFor() // Esc обрабатывает поле ввода: ждём, пока оно получит фокус
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Команда')
  await page.keyboard.press('Escape')
  must((await page.locator('[role=dialog][aria-label="Палитра команд"]').count()) === 0, 'Esc не закрыл палитру')

  // разделы по цифрам
  await page.keyboard.press('2')
  must((await page.locator('.node').count()) === 5, 'на радаре должно быть 5 клиентов')
  await page.keyboard.press('3')
  must((await page.locator('.pipe .hk').count()) > 0, 'в конвейере нет хуков')
  await page.keyboard.press('4')
  must((await page.locator('.find').count()) > 0, 'Доктор ничего не нашёл на фикстуре с поломками')
  await page.keyboard.press('1')

  // снимки по размерам и разделам
  for (const [w, h] of SIZES) {
    await resize(app, w, h)
    for (const [key, name] of [['1', 'matrix'], ['2', 'radar'], ['3', 'hooks'], ['4', 'doctor']]) {
      await page.keyboard.press(key)
      await page.waitForTimeout(250)
      if (key === '1') await layout(page, `${name}@${w}`)
      if (w === 1920) {
        const v = await axeCheck(page, name)
        must(v.length === 0, `axe нашёл нарушения на экране «${name}»: ${v.map((x) => x.id).join(', ')}`)
      }
      await shot(page, `m1-${name}-${w}`)
    }
    await page.keyboard.press('1')
  }

  // ---- живое обновление: правка конфига на диске меняет матрицу без кнопки «Скан» и без экрана «загрузка» ----
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
  await shot(page, 'm4-inspector-1280')
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

  // профили: снять состояние, поправить, применить пакетом, откатить пакет целиком
  await page.keyboard.press('6')
  await page.getByLabel('Имя профиля').fill('e2e')
  await page.getByRole('button', { name: 'Снять с текущего состояния' }).click()
  const card = page.getByRole('region', { name: 'Профиль e2e' })
  await card.waitFor({ timeout: 8000 })
  await card.getByText('Записи профиля').click()
  await card.locator('li', { hasText: 'p1@bundled' }).getByRole('checkbox').uncheck()
  await card.getByRole('button', { name: 'Сохранить изменения' }).click()
  await waitFor(async () => !(await card.getByRole('button', { name: 'Сохранить изменения' }).isEnabled()), 'профиль сохранён')
  const profLayout = await page.evaluate(() => ({ hscroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth }))
  must(profLayout.hscroll <= 0 && profLayout.main <= 1, `горизонтальная прокрутка в профилях: ${JSON.stringify(profLayout)}`)
  const v3 = await axeCheck(page, 'профили')
  must(v3.length === 0, `axe: профили: ${v3.map((x) => x.id).join(', ')}`)
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

  // ---- встроенный ctxkit: установить и применить на копии фикстуры, диагностика и эффективность ----
  const claudeDir = join(home, '.claude')
  const hookExe = join(claudeDir, 'hooks', 'ctxkit.exe')
  const settingsFile = join(claudeDir, 'settings.json')
  const opts = { withRules: true, desktop: false, antigravity: false, dsh: false, lang: 'ru', advisor: 'fable' }
  // Настоящий профиль владельца ctxkit трогать не должен: хеши файлов, которые `setup` пишет, до и после всего шага.
  // `~/.claude.json` не сравниваем: его переписывает работающий Claude Code, ctxkit его только читает (в проверках с --claude-json на копию).
  const realHome = homedir()
  const realFiles = ['.claude/settings.json', '.claude/CLAUDE.md', '.claude/hooks/ctxkit.exe', '.claude/agents/Explore.md', '.claude/agents/checker.md', '.local/bin/ctxkit.exe', '.gemini/config/hooks.json', '.dsh/ctxkit-hooks.json', '.dsh/cordis.patch.yml', 'AppData/Roaming/Claude/ccd-session-presets.json'].map((r) => join(realHome, r))
  const realState = () => realFiles.map((f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'нет'))
  const realBefore = realState()
  const realBackups = () => (existsSync(join(realHome, '.claude', 'backups')) ? readdirSync(join(realHome, '.claude', 'backups')).filter((n) => !n.startsWith('.claude.json.backup')).length : 0)
  const realBackupsBefore = realBackups()
  must(!existsSync(hookExe), 'в копии фикстуры уже есть ctxkit')
  await page.keyboard.press('7')
  await page.getByText('ctxkit 0.', { exact: false }).first().waitFor({ timeout: 15000 })
  must((await page.locator('main').innerText()).includes('нет: «Применить» установит'), 'до установки копия ctxkit должна быть «нет»')
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
  must(preview.includes('[dry-run]') && !preview.includes('FAKE-SECRET') && !leaks, `предпросмотр ctxkit: ${preview.slice(0, 300)}`)
  must(readFileSync(settingsFile, 'utf8') === settingsBefore && !existsSync(hookExe), 'предпросмотр изменил файлы')
  await waitFor(() => applyBtn.isEnabled(), 'после предпросмотра применение доступно')
  await page.getByLabel('Язык подсказок и хуков').selectOption('en')
  must(await applyBtn.isDisabled(), 'после смены настроек старый предпросмотр не должен разрешать применение')
  await page.getByLabel('Язык подсказок и хуков').selectOption('ru')
  await page.getByRole('button', { name: /^Предпросмотр/ }).click()
  await waitFor(() => applyBtn.isEnabled(), 'предпросмотр повторён')
  await shot(page, 'm5-ctxkit-1280')
  await resize(app, 1920, 1080)
  await page.waitForTimeout(250)
  await shot(page, 'm5-ctxkit-1920')
  await resize(app, 1280, 800)
  await applyBtn.click()
  await waitFor(() => existsSync(hookExe), 'ctxkit установил бинарь хуков')
  await waitFor(() => readFileSync(settingsFile, 'utf8').includes('ctxkit'), 'ctxkit прописал хуки в settings.json')
  must(existsSync(join(claudeDir, 'backups')), 'ctxkit не сделал бэкап перед записью')
  await waitFor(async () => (await page.locator('main').innerText()).includes('~/.claude/hooks/ctxkit.exe: ● совпадает'), 'статус: копия хуков совпадает со встроенной')
  // диагностика и эффективность по транскриптам фикстуры
  await page.locator('ul[aria-label="Находки диагностики"] li').first().waitFor({ timeout: 15000 })
  await page.locator('table[aria-label="Ходы по дням"] tbody tr').first().waitFor({ timeout: 30000 })
  const eff = await page.locator('main').innerText()
  must(eff.includes('на Sonnet и Haiku') && eff.includes('checker ×'), `нет сводки эффективности: ${eff.slice(-600)}`)
  const ctxLayout = await page.evaluate(() => ({ h: document.documentElement.scrollWidth - document.documentElement.clientWidth, m: document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth }))
  must(ctxLayout.h <= 0 && ctxLayout.m <= 1, `горизонтальная прокрутка в разделе ctxkit: ${JSON.stringify(ctxLayout)}`)
  const v4 = await axeCheck(page, 'ctxkit')
  must(v4.length === 0, `axe: ctxkit: ${v4.map((x) => x.id).join(', ')}`)
  await noSecretOnPage('ctxkit')
  await page.keyboard.press('1')
  await levelSel.selectOption('R0') // понижение подтверждения не требует
  must((await refusal(opts)).includes('R2'), 'при R0 применение ctxkit не отвергнуто в main')
  must(JSON.stringify(realState()) === JSON.stringify(realBefore), 'ctxkit изменил файл настоящего профиля владельца')
  must(realBackups() === realBackupsBefore, 'ctxkit создал бэкап в настоящем профиле владельца')
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

  log('OK: все сценарии прошли')
} catch (e) {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  if (session) await close(session).catch(() => {})
  process.exitCode = 1
} finally {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
  const core = coreLeftovers()
  log('оставшихся процессов ядра (loadout*.exe):', core.length)
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
