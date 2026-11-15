// Проверка окна: Playwright `_electron`, свой профиль, фикстурный домашний каталог. Запуск: `npm run e2e`.
// Профиль владельца не трогается: APP_QA=1 + LOADOUT_USER_DATA=state/loadout-qa.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  mkdirSync(stateDir, { recursive: true })
  // чистый проверочный профиль каждый раз: настройки окна (FX) не должны переходить между прогонами
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })

  // длинное имя скила для проверки переноса текста
  const home = materialize((h) => {
    const dir = join(h, '.claude', 'skills', 'very-long-skill-name-that-should-wrap-inside-the-name-column-without-clipping-anything')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: Длинное имя для проверки переноса\n---\n')
  })
  homes.push(home)

  // ---- основной сценарий ----
  session = await launch({ LOADOUT_HOME: home })
  let { app, page } = session
  await page.waitForSelector('#grid', { timeout: 20000 })
  must((await page.title()) === 'Loadout', 'заголовок окна не Loadout')

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
      await shot(page, `m1-${name}-${w}`)
    }
    await page.keyboard.press('1')
  }

  // reduced motion → «FX: выкл» по умолчанию применяется при загрузке; здесь проверяем переключатель
  await page.getByLabel('Уровень эффектов').selectOption('off')
  must((await page.evaluate(() => document.documentElement.dataset.fx)) === 'off', 'FX не выключился')

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
