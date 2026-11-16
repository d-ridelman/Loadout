// Установка из маркетплейсов и скилов: проверка ввода на границе main и чтение каталогов. Без electron, чтобы тестировалось vitest.
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
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

const failMarketplace = (): never => {
  throw new Error(
    t(
      'источник: owner/repo с GitHub, адрес https://, SSH-адрес (git@хост:путь или ssh://хост/путь) или полный путь к папке; после адреса можно добавить #ветка или #тег',
      'source: a GitHub owner/repo, an https:// address, an SSH address (git@host:path or ssh://host/path) or a full path to a folder; a #branch or #tag may follow the address',
    ),
  )
}

/** Хеш коммита git: 7–40 шестнадцатеричных знаков. */
export const isCommitRef = (r: string | undefined): boolean => r !== undefined && /^[0-9a-fA-F]{7,40}$/.test(r)

/** Имя ветки или тега: безопасные знаки, без `..`, `//`, `.lock` и слэша на краях (правила `git check-ref-format` в нужной нам части). */
const refOk = (r: string): boolean => REF.test(r) && !r.includes('..') && !r.includes('//') && !r.endsWith('/') && !r.endsWith('.') && !r.endsWith('.lock')

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

export type MarketplaceSource = { kind: 'github' | 'url' | 'ssh' | 'path'; value: string }

const SSH_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
/** Путь репозитория на SSH-хосте: сегменты из безопасных знаков без начального и конечного `/`, `.` и `..`. */
const gitPathOk = (p: string): boolean => p.length <= 200 && p.split('/').length <= 6 && p.split('/').every((x) => SUB_PART.test(x) && x !== '.' && x !== '..' && !x.startsWith('-'))

/**
 * SSH-адрес в форме `user@host:path` или `ssh://[user@]host[:порт]/path`. Строгая проверка каждой части: ни пробелов,
 * кавычек и управляющих знаков, ни `-` в начале имени, хоста и пути (иначе адрес стал бы флагом `ssh`/`git`).
 * Возвращает адрес в нормальной форме либо `undefined`.
 */
function sshUrl(s: string): string | undefined {
  const scp = /^([^@:/\s]+)@([^:/\s]+):([^\s]+)$/.exec(s)
  if (scp) {
    const [, user, host, path] = scp
    return SSH_USER.test(user!) && HOST.test(host!) && gitPathOk(path!) ? `${user}@${host}:${path}` : undefined
  }
  // разбор вручную, а не `new URL`: он молча сворачивает `a/../b` и `%2e%2e`, а проверять надо то, что ввёл человек
  const m = /^ssh:\/\/(?:([^@:/\s]+)@)?([^@:/\s]+)(?::(\d{1,5}))?\/([^\s]+)$/.exec(s)
  if (!m) return undefined
  const [, user, host, port, path] = m
  const ok = (user === undefined || SSH_USER.test(user)) && HOST.test(host!) && gitPathOk(path!)
  return ok ? `ssh://${user ? `${user}@` : ''}${host}${port ? `:${port}` : ''}/${path}` : undefined
}

/**
 * Источник для `claude plugin marketplace add`. Формы по документации Claude Code (install → «Add a marketplace»):
 * `owner/repo`, полный адрес клона (`https://…`, `git@host:path`), путь к папке или файлу; после адреса репозитория
 * `#ветка` или `#тег`. Хеш коммита документация как ссылку не называет («pin a branch or tag»), поэтому он отклоняется.
 * Существование локального пути проверяет вызывающий.
 */
export function parseMarketplaceSource(raw: unknown): MarketplaceSource {
  const s = base(raw)
  const p = localPath(s)
  if (p) return { kind: 'path', value: p }
  const hash = s.indexOf('#')
  const addr = hash < 0 ? s : s.slice(0, hash)
  const ref = hash < 0 ? undefined : s.slice(hash + 1)
  if (ref !== undefined) {
    if (isCommitRef(ref)) {
      throw new Error(t('маркетплейс: после # документация Claude Code называет ветку или тег; имя из 7–40 шестнадцатеричных знаков не отличить от хеша коммита (его документация не называет), поэтому оно не принимается', 'marketplace: the Claude Code docs name a branch or a tag after #; a name of 7–40 hex characters cannot be told from a commit hash (which the docs do not name), so it is not accepted'))
    }
    if (!refOk(ref)) return failMarketplace()
  }
  const suffix = ref === undefined ? '' : `#${ref}`
  const gh = /^([^/]+)\/([^/]+)$/.exec(addr)
  if (gh && repoOk(gh[1]!, gh[2]!)) return { kind: 'github', value: `${addr}${suffix}` }
  const ssh = sshUrl(addr)
  if (ssh) return { kind: 'ssh', value: `${ssh}${suffix}` }
  const u = httpsUrl(addr)
  if (u && u.hash === '') return { kind: 'url', value: `${u.href}${suffix}` }
  return failMarketplace()
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
  | {
      kind: 'github'
      owner: string
      repo: string
      ref: string | undefined
      sub: string
      /** Только адрес `tree/…` или `blob/…`: все сегменты после него. `ref` и `sub` — прикидка «первый сегмент — ветка»; ветка со `/` уточняется по списку веток (`pickTreeRef`). */
      treePath?: string[]
      /** Ссылка — хеш коммита (`true`) или имя ветки или тега (`false`), когда это установлено по списку веток; без него решает форма строки. */
      commit?: boolean
    }
  | { kind: 'path'; path: string }

/**
 * Источник скила: `owner/repo[/путь]`, `https://github.com/owner/repo[.git][/tree/<ветка или хеш коммита>/<путь>]` или папка.
 * В адресе `tree/…` ветка может содержать `/`: перед загрузкой main сверяет сегменты со списком веток и тегов репозитория.
 */
export function parseSkillSource(raw: unknown): SkillSource {
  const s = base(raw)
  const p = localPath(s)
  if (p) return { kind: 'path', path: p }
  let rest: string[]
  let ref: string | undefined
  let treePath: string[] | undefined
  const u = httpsUrl(s)
  if (u) {
    if (u.hostname !== 'github.com' || u.search !== '' || u.hash !== '') return fail()
    rest = u.pathname.split('/').filter(Boolean)
    if (rest[1]?.endsWith('.git')) rest[1] = rest[1].slice(0, -4)
    if (rest[2] === 'tree' || rest[2] === 'blob') {
      ref = rest[3]
      if (ref === undefined || !REF.test(ref)) return fail()
      if (rest.length > 4) treePath = rest.slice(3)
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
  return { kind: 'github', owner, repo, ref, sub: sub.join('/'), ...(treePath ? { treePath } : {}) }
}

/** Адрес репозитория для `git ls-remote`: собирается так же, как в `cloneArgs`. */
export const remoteUrl = (src: { owner: string; repo: string }, base: string): string => `${base}${src.owner}/${src.repo}.git`

/** Имена веток и тегов из вывода `git ls-remote --heads --tags` (строки `<sha>\trefs/heads/<имя>`, у аннотированных тегов ещё `^{}`). */
export function parseRefs(out: string): Set<string> {
  const names = new Set<string>()
  for (const line of out.split(/\r?\n/)) {
    const m = /^[0-9a-f]{40,64}\trefs\/(?:heads|tags)\/(.+?)(?:\^\{\})?$/.exec(line)
    if (m?.[1] !== undefined) names.add(m[1])
  }
  return names
}

/**
 * Ветка со `/` в адресе `tree/…`: сегменты после `tree` — это ветка, а затем путь. Берётся самое длинное начало, которое
 * есть среди веток и тегов (ветки `a` и `a/b` в git сосуществовать не могут, так что совпадение одно). Если ни одно не
 * подошло, а первый сегмент — хеш коммита, это он; иначе `undefined` (вызывающий оставляет «первый сегмент — ветка»).
 */
export function pickTreeRef(segments: string[], refs: Set<string>): { ref: string; sub: string; commit: boolean } | undefined {
  const sub = (from: number): string | undefined => {
    const rest = segments.slice(from)
    if (rest.at(-1) === 'SKILL.md') rest.pop()
    return rest.every((x) => SUB_PART.test(x) && x !== '.' && x !== '..' && x !== '.git') ? rest.join('/') : undefined
  }
  // начало, равное всем сегментам, — адрес на саму ветку без пути (`tree/feature/x`)
  for (let k = segments.length; k >= 1; k--) {
    const ref = segments.slice(0, k).join('/')
    const rest = sub(k)
    if (refs.has(ref) && refOk(ref) && rest !== undefined) return { ref, sub: rest, commit: false }
  }
  const first = segments[0]
  const rest = sub(1)
  if (!isCommitRef(first) || rest === undefined) return undefined
  return { ref: first!, sub: rest, commit: true }
}

const GIT_SAFE = ['-c', 'protocol.ext.allow=never', '-c', 'core.symlinks=false']

/**
 * Аргументы `git clone`: адрес собирается из проверенных частей, перед ним `--`, флаги фиксированы. Для хеша коммита
 * `--branch` не принимается: клон без выгрузки и без истории блобов, коммит выбирает `checkoutArgs`.
 */
export function cloneArgs(src: { owner: string; repo: string; ref: string | undefined; commit?: boolean }, base: string, dest: string): string[] {
  if (src.commit ?? isCommitRef(src.ref)) return [...GIT_SAFE, 'clone', '--no-checkout', '--filter=blob:none', '--no-recurse-submodules', '--', remoteUrl(src, base), dest]
  return [
    ...GIT_SAFE,
    'clone', '--depth', '1', '--no-recurse-submodules',
    ...(src.ref ? ['--branch', src.ref] : []),
    '--', remoteUrl(src, base), dest,
  ]
}

/** Второй шаг для хеша коммита: выгрузка этого коммита в клон, сделанный `cloneArgs`. */
export function checkoutArgs(ref: string, dest: string): string[] {
  return [...GIT_SAFE, '-C', dest, 'checkout', '--detach', ref, '--']
}

/**
 * Удаляет каталог подготовки. Клон git кладёт пакеты `.git/objects/pack/*` с признаком «только чтение», и `rmSync` в Node
 * Electron на Windows отказывает на них с EPERM (проверено на `anthropics/skills`): без снятия признака подготовка после
 * отказа от установки не удалялась, следующая загрузка падала, а запуск приложения — вместе с ней. Ссылки не обходим.
 */
export function rmTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (first) {
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) walk(p)
        else chmodSync(p, 0o666)
      }
    }
    try {
      walk(dir)
    } catch {
      throw first
    }
    rmSync(dir, { recursive: true, force: true })
  }
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
  const lines = (m?.[1] ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([a-z_-]+):\s*(.*)$/.exec(lines[i]!)
    if (!kv) continue
    let v = kv[2]!
    // блочный скаляр YAML (`description: >` или `|-`, как у скилов anthropics/skills): значение — строки с отступом ниже
    if (/^[>|][+-]?$/.test(v)) {
      const body: string[] = []
      while (i + 1 < lines.length && /^(\s|$)/.test(lines[i + 1]!)) body.push(lines[++i]!.trim())
      v = body.filter(Boolean).join(' ')
    }
    out[kv[1]!] = v.replace(/^["']|["']$/g, '')
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
