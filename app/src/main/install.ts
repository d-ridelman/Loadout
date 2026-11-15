// Установка из маркетплейсов и скилов: проверка ввода на границе main и чтение каталогов. Без electron, чтобы тестировалось vitest.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'
import { t } from '../shared/i18n'
import type { CatalogPlugin, Marketplace, SkillCandidate } from '../shared/model'

/** Часть id плагина (`имя@маркетплейс`) по документации Claude Code: буквы, цифры, `.`, `_`, `-`, с буквы или цифры. */
export const ID_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const GH_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
const SUB_PART = /^[A-Za-z0-9._-]{1,100}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/

const fail = (): never => {
  throw new Error(
    t(
      'источник: owner/repo с GitHub, адрес https:// или полный путь к папке на этом компьютере',
      'source: a GitHub owner/repo, an https:// address or a full path to a folder on this computer',
    ),
  )
}

const repoOk = (owner: string, repo: string): boolean => GH_OWNER.test(owner) && GH_REPO.test(repo) && repo !== '.' && repo !== '..' && !repo.endsWith('.')

/** Общая проверка строки до разбора: ввод никогда не станет флагом или второй командой. */
function base(raw: unknown): string {
  if (typeof raw !== 'string') return fail()
  const s = raw.trim()
  if (s === '' || s.length > 400 || s.startsWith('-') || CONTROL.test(s)) return fail()
  return s
}

/** Локальный путь: только полный путь с буквой диска, без сетевых `\\сервер\…` и без `..`. Пробелы допустимы (`execFile` без оболочки). */
function localPath(s: string): string | undefined {
  if (!/^[A-Za-z]:[\\/]/.test(s) || !win32.isAbsolute(s) || s.split(/[\\/]/).includes('..')) return undefined
  return win32.normalize(s)
}

/** https-адрес без логина и пароля в нём. Другие схемы (`ext::`, `file://`, `ssh`) git выполнил бы по-своему. */
function httpsUrl(s: string): URL | undefined {
  if (!s.startsWith('https://') || /\s/.test(s)) return undefined
  try {
    const u = new URL(s)
    return u.protocol === 'https:' && u.hostname !== '' && u.username === '' && u.password === '' ? u : undefined
  } catch {
    return undefined
  }
}

export type MarketplaceSource = { kind: 'github' | 'url' | 'path'; value: string }

/** Источник для `claude plugin marketplace add`. Существование локального пути проверяет вызывающий. */
export function parseMarketplaceSource(raw: unknown): MarketplaceSource {
  const s = base(raw)
  const gh = /^([^/]+)\/([^/]+)$/.exec(s)
  if (gh && repoOk(gh[1]!, gh[2]!)) return { kind: 'github', value: s }
  const u = httpsUrl(s)
  if (u) return { kind: 'url', value: u.href }
  const p = localPath(s)
  if (p) return { kind: 'path', value: p }
  return fail()
}

/** Локальный маркетплейс: каталог с `.claude-plugin/marketplace.json` или сам этот файл. */
export function localMarketplaceOk(p: string): boolean {
  try {
    if (statSync(p).isDirectory()) return existsSync(join(p, '.claude-plugin', 'marketplace.json'))
    return p.toLowerCase().endsWith('.json')
  } catch {
    return false
  }
}

export type SkillSource =
  | { kind: 'github'; owner: string; repo: string; ref: string | undefined; sub: string }
  | { kind: 'path'; path: string }

/**
 * Источник скила: `owner/repo[/путь]`, `https://github.com/owner/repo[.git][/tree/<ветка>/<путь>]` или папка.
 * Ветка в адресе `tree/…` — один сегмент (ветки со `/` указывайте без пути).
 */
export function parseSkillSource(raw: unknown): SkillSource {
  const s = base(raw)
  const p = localPath(s)
  if (p) return { kind: 'path', path: p }
  let rest: string[]
  let ref: string | undefined
  const u = httpsUrl(s)
  if (u) {
    if (u.hostname !== 'github.com' || u.search !== '' || u.hash !== '') return fail()
    rest = u.pathname.split('/').filter(Boolean)
    if (rest[1]?.endsWith('.git')) rest[1] = rest[1].slice(0, -4)
    if (rest[2] === 'tree' || rest[2] === 'blob') {
      ref = rest[3]
      if (ref === undefined || !REF.test(ref)) return fail()
      rest = [rest[0]!, rest[1]!, ...rest.slice(4)]
    }
  } else {
    if (s.includes('\\') || s.includes(':')) return fail()
    rest = s.split('/')
    if (rest[1]?.endsWith('.git')) rest[1] = rest[1].slice(0, -4)
  }
  const [owner, repo, ...sub] = rest
  if (owner === undefined || repo === undefined || !repoOk(owner, repo)) return fail()
  // ссылка на сам SKILL.md — это его каталог
  if (sub.at(-1) === 'SKILL.md') sub.pop()
  if (!sub.every((x) => SUB_PART.test(x) && x !== '.' && x !== '..' && x !== '.git')) return fail()
  return { kind: 'github', owner, repo, ref, sub: sub.join('/') }
}

/** Аргументы `git clone`: адрес собирается из проверенных частей, перед ним `--`, флаги фиксированы. */
export function cloneArgs(src: { owner: string; repo: string; ref: string | undefined }, base: string, dest: string): string[] {
  return [
    '-c', 'protocol.ext.allow=never',
    '-c', 'core.symlinks=false',
    'clone', '--depth', '1', '--no-recurse-submodules',
    ...(src.ref ? ['--branch', src.ref] : []),
    '--', `${base}${src.owner}/${src.repo}.git`, dest,
  ]
}

/** Имя каталога скила, как его проверяет ядро. */
export function skillNameOk(n: string): boolean {
  return ID_PART.test(n) && !n.includes('..') && n.toLowerCase() !== 'synced' && !n.toLowerCase().startsWith('anthropic-skills')
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(CONTROL, ' ').trim().slice(0, max) : '')

/** `name` и `description` из головы SKILL.md (плоские `ключ: значение`). */
function frontmatter(file: string): Record<string, string> {
  const head = readFileSync(file, 'utf8').slice(0, 4096)
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)
  const out: Record<string, string> = {}
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
    const kv = /^([a-z_-]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '')
  }
  return out
}

/**
 * Сколько файлов и байт в папке (без ссылок, `.git` и `node_modules`); на превышении лимита ядра — отказ сразу,
 * до копирования: иначе ввод `C:\` скопировал бы весь диск в каталог подготовки.
 */
export function checkTreeSize(dir: string, maxFiles = 1000, maxBytes = 50 << 20): void {
  let files = 0
  let bytes = 0
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink() || e.name === '.git' || e.name === 'node_modules') continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        files++
        bytes += statSync(p).size
        if (files > maxFiles || bytes > maxBytes) {
          throw new Error(t('папка слишком большая для скила: больше 1000 файлов или 50 МБ', 'the folder is too large for a skill: more than 1000 files or 50 MB'))
        }
      }
    }
  }
  walk(dir)
}

/** Скилы в подготовленном источнике: корень или каталоги со `SKILL.md` до трёх уровней вглубь. Ссылки не обходим. */
export function findSkills(root: string, only = '', rootName = ''): SkillCandidate[] {
  const out: SkillCandidate[] = []
  const visit = (sub: string, depth: number) => {
    const dir = sub ? join(root, ...sub.split('/')) : root
    if (existsSync(join(dir, 'SKILL.md'))) {
      const fm = frontmatter(join(dir, 'SKILL.md'))
      // у скила в корне источника имя каталога — имя репозитория или папки
      const leaf = sub.split('/').at(-1) || rootName
      const name = [fm['name'], leaf].find((n): n is string => n !== undefined && skillNameOk(n)) ?? ''
      out.push({ sub, name, description: clean(fm['description'], 300) })
      return
    }
    if (depth >= 3 || out.length >= 200) return
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && !d.isSymbolicLink() && d.name !== '.git' && d.name !== 'node_modules' && SUB_PART.test(d.name)) visit(sub ? `${sub}/${d.name}` : d.name, depth + 1)
    }
  }
  if (only) {
    if (existsSync(join(root, ...only.split('/')))) visit(only, 3)
  } else visit('', 0)
  return out.sort((a, b) => a.sub.localeCompare(b.sub))
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Откуда добавлен маркетплейс, для показа. */
function sourceText(src: unknown, tidy: (s: string) => string): string {
  if (!isObj(src)) return ''
  const v = src['repo'] ?? src['url'] ?? src['path'] ?? src['package'] ?? ''
  return tidy(clean(v, 300))
}

/**
 * Добавленные маркетплейсы Claude Code и их каталоги: `known_marketplaces.json` → `installLocation` → `marketplace.json`.
 * Только чтение. Имена, которые Claude Code не установит, пропускаются; тексты очищаются и обрезаются.
 */
export function readCatalog(home: string, tidy: (s: string) => string = (s) => s): Marketplace[] {
  const plugins = join(home, '.claude', 'plugins')
  let known: unknown
  try {
    known = readJson(join(plugins, 'known_marketplaces.json'))
  } catch {
    return []
  }
  if (!isObj(known)) return []
  let installed = new Set<string>()
  try {
    const ip = readJson(join(plugins, 'installed_plugins.json'))
    if (isObj(ip) && isObj(ip['plugins'])) installed = new Set(Object.keys(ip['plugins']))
  } catch {
    // нет файла — ничего не установлено
  }
  const out: Marketplace[] = []
  for (const [name, entry] of Object.entries(known).slice(0, 200)) {
    if (!ID_PART.test(name) || !isObj(entry)) continue
    const m: Marketplace = { name, source: sourceText(entry['source'], tidy), plugins: [] }
    out.push(m)
    const loc = entry['installLocation']
    const files = typeof loc === 'string' && isAbsolute(loc)
      ? loc.toLowerCase().endsWith('.json') ? [loc] : [join(loc, '.claude-plugin', 'marketplace.json'), join(loc, 'marketplace.json')]
      : []
    const file = files.find((f) => existsSync(f))
    if (!file) {
      m.error = t('каталог ещё не скачан: обновите маркетплейс в Claude Code', 'the catalog is not downloaded yet: update the marketplace in Claude Code')
      continue
    }
    let doc: unknown
    try {
      doc = readJson(file)
    } catch {
      m.error = t('marketplace.json не прочитан', 'could not read marketplace.json')
      continue
    }
    const list = isObj(doc) && Array.isArray(doc['plugins']) ? doc['plugins'] : []
    for (const p of list.slice(0, 2000)) {
      if (!isObj(p) || typeof p['name'] !== 'string' || !ID_PART.test(p['name'])) continue
      const src = p['source']
      const item: CatalogPlugin = {
        name: p['name'],
        description: clean(p['description'], 300),
        installed: installed.has(`${p['name']}@${name}`),
      }
      const version = clean(p['version'], 40)
      if (version) item.version = version
      if (isObj(src) && src['source'] === 'command') {
        item.why = t('ставится запуском команды маркетплейса: только из Claude Code, с её показом', 'installed by running a marketplace command: only from Claude Code, which shows it')
      }
      m.plugins.push(item)
    }
  }
  return out
}
