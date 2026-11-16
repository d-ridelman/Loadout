// Installing from marketplaces and skills: input validation at the main boundary and reading catalogs. No electron, so vitest can test it.
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'
import { t } from '../shared/i18n'
import type { CatalogPlugin, Marketplace, SkillCandidate } from '../shared/model'

/** Part of a plugin id (`name@marketplace`) per the Claude Code docs: letters, digits, `.`, `_`, `-`, starting with a letter or digit. */
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

/** A git commit hash: 7-40 hex characters. */
export const isCommitRef = (r: string | undefined): boolean => r !== undefined && /^[0-9a-fA-F]{7,40}$/.test(r)

/** Branch or tag name: safe characters, no `..`, `//`, `.lock` or slash at the edges (the `git check-ref-format` rules, the part we need). */
const refOk = (r: string): boolean => REF.test(r) && !r.includes('..') && !r.includes('//') && !r.endsWith('/') && !r.endsWith('.') && !r.endsWith('.lock')

const repoOk = (owner: string, repo: string): boolean => GH_OWNER.test(owner) && GH_REPO.test(repo) && repo !== '.' && repo !== '..' && !repo.endsWith('.')

/** Common string check before parsing: the input can never become a flag or a second command. */
function base(raw: unknown): string {
  if (typeof raw !== 'string') return fail()
  const s = raw.trim()
  if (s === '' || s.length > 400 || s.startsWith('-') || CONTROL.test(s)) return fail()
  return s
}

/** Local path: only a full path with a drive letter, no network `\\server\…` and no `..`. Spaces are allowed (`execFile` without a shell). */
function localPath(s: string): string | undefined {
  if (!/^[A-Za-z]:[\\/]/.test(s) || !win32.isAbsolute(s) || s.split(/[\\/]/).includes('..')) return undefined
  return win32.normalize(s)
}

/** An https URL without a login or password in it. Other schemes (`ext::`, `file://`, `ssh`) git would handle in its own way. */
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
/** Repository path on an SSH host: segments of safe characters, no leading or trailing `/`, no `.` or `..`. */
const gitPathOk = (p: string): boolean => p.length <= 200 && p.split('/').length <= 6 && p.split('/').every((x) => SUB_PART.test(x) && x !== '.' && x !== '..' && !x.startsWith('-'))

/**
 * An SSH address in the form `user@host:path` or `ssh://[user@]host[:port]/path`. Every part is checked strictly: no spaces,
 * quotes or control characters, and no `-` at the start of the user, host or path (otherwise the address would become an `ssh`/`git` flag).
 * Returns the address in normal form or `undefined`.
 */
function sshUrl(s: string): string | undefined {
  const scp = /^([^@:/\s]+)@([^:/\s]+):([^\s]+)$/.exec(s)
  if (scp) {
    const [, user, host, path] = scp
    return SSH_USER.test(user!) && HOST.test(host!) && gitPathOk(path!) ? `${user}@${host}:${path}` : undefined
  }
  // parsed by hand, not with `new URL`: it silently collapses `a/../b` and `%2e%2e`, but what the person typed is what must be checked
  const m = /^ssh:\/\/(?:([^@:/\s]+)@)?([^@:/\s]+)(?::(\d{1,5}))?\/([^\s]+)$/.exec(s)
  if (!m) return undefined
  const [, user, host, port, path] = m
  const ok = (user === undefined || SSH_USER.test(user)) && HOST.test(host!) && gitPathOk(path!)
  return ok ? `ssh://${user ? `${user}@` : ''}${host}${port ? `:${port}` : ''}/${path}` : undefined
}

/**
 * Source for `claude plugin marketplace add`. Forms per the Claude Code docs (install → "Add a marketplace"):
 * `owner/repo`, a full clone URL (`https://…`, `git@host:path`), a path to a folder or file; after the repository address
 * `#branch` or `#tag`. The docs do not name a commit hash as a ref ("pin a branch or tag"), so it is rejected.
 * The caller checks that a local path exists.
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

/** Local marketplace: a directory with `.claude-plugin/marketplace.json` or that file itself. */
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
      /** Only for a `tree/…` or `blob/…` address: all segments after it. `ref` and `sub` are a guess "the first segment is the branch"; a branch containing `/` is refined from the branch list (`pickTreeRef`). */
      treePath?: string[]
      /** Whether the ref is a commit hash (`true`) or a branch or tag name (`false`), once established from the branch list; without it the shape of the string decides. */
      commit?: boolean
    }
  | { kind: 'path'; path: string }

/**
 * Skill source: `owner/repo[/path]`, `https://github.com/owner/repo[.git][/tree/<branch or commit hash>/<path>]` or a folder.
 * In a `tree/…` address the branch may contain `/`: before downloading, main checks the segments against the repository's branch and tag list.
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
  // a link to SKILL.md itself means its directory
  if (sub.at(-1) === 'SKILL.md') sub.pop()
  if (!sub.every((x) => SUB_PART.test(x) && x !== '.' && x !== '..' && x !== '.git')) return fail()
  return { kind: 'github', owner, repo, ref, sub: sub.join('/'), ...(treePath ? { treePath } : {}) }
}

/** Repository address for `git ls-remote`: built the same way as in `cloneArgs`. */
export const remoteUrl = (src: { owner: string; repo: string }, base: string): string => `${base}${src.owner}/${src.repo}.git`

/** Branch and tag names from the output of `git ls-remote --heads --tags` (lines `<sha>\trefs/heads/<name>`, annotated tags also have `^{}`). */
export function parseRefs(out: string): Set<string> {
  const names = new Set<string>()
  for (const line of out.split(/\r?\n/)) {
    const m = /^[0-9a-f]{40,64}\trefs\/(?:heads|tags)\/(.+?)(?:\^\{\})?$/.exec(line)
    if (m?.[1] !== undefined) names.add(m[1])
  }
  return names
}

/**
 * A branch containing `/` in a `tree/…` address: the segments after `tree` are the branch, then the path. The longest prefix
 * that is among the branches and tags is taken (branches `a` and `a/b` cannot coexist in git, so there is one match). If none
 * fits and the first segment is a commit hash, that is it; otherwise `undefined` (the caller keeps "the first segment is the branch").
 */
export function pickTreeRef(segments: string[], refs: Set<string>): { ref: string; sub: string; commit: boolean } | undefined {
  const sub = (from: number): string | undefined => {
    const rest = segments.slice(from)
    if (rest.at(-1) === 'SKILL.md') rest.pop()
    return rest.every((x) => SUB_PART.test(x) && x !== '.' && x !== '..' && x !== '.git') ? rest.join('/') : undefined
  }
  // a prefix equal to all the segments is an address of the branch itself with no path (`tree/feature/x`)
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
 * Arguments of `git clone`: the address is built from validated parts, preceded by `--`, the flags are fixed. For a commit hash
 * `--branch` is not accepted: a clone without checkout and without blob history, and `checkoutArgs` selects the commit.
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

/** Second step for a commit hash: check that commit out in the clone made by `cloneArgs`. */
export function checkoutArgs(ref: string, dest: string): string[] {
  return [...GIT_SAFE, '-C', dest, 'checkout', '--detach', ref, '--']
}

/**
 * Removes the staging directory. A git clone puts `.git/objects/pack/*` files with the read-only attribute, and `rmSync` in Node
 * of Electron on Windows fails on them with EPERM (checked on `anthropics/skills`): without clearing the attribute the staging
 * was not removed after an install was declined, the next download failed, and so did the app start. Links are not followed.
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

/** Skill directory name, as the core validates it. */
export function skillNameOk(n: string): boolean {
  return ID_PART.test(n) && !n.includes('..') && n.toLowerCase() !== 'synced' && !n.toLowerCase().startsWith('anthropic-skills')
}

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(CONTROL, ' ').trim().slice(0, max) : '')

/** `name` and `description` from the head of SKILL.md (flat `key: value`). */
function frontmatter(file: string): Record<string, string> {
  const head = readFileSync(file, 'utf8').slice(0, 4096)
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)
  const out: Record<string, string> = {}
  const lines = (m?.[1] ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([a-z_-]+):\s*(.*)$/.exec(lines[i]!)
    if (!kv) continue
    let v = kv[2]!
    // YAML block scalar (`description: >` or `|-`, as in the anthropics/skills skills): the value is the indented lines below
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
 * How many files and bytes are in a folder (without links, `.git` and `node_modules`); over the core's limit it refuses at once,
 * before copying: otherwise the input `C:\` would copy the whole disk into the staging directory.
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

/** Skills in a staged source: the root or directories with `SKILL.md` up to three levels deep. Links are not followed. */
export function findSkills(root: string, only = '', rootName = ''): SkillCandidate[] {
  const out: SkillCandidate[] = []
  const visit = (sub: string, depth: number) => {
    const dir = sub ? join(root, ...sub.split('/')) : root
    if (existsSync(join(dir, 'SKILL.md'))) {
      const fm = frontmatter(join(dir, 'SKILL.md'))
      // for a skill at the source root, the directory name is the repository or folder name
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

/** Where the marketplace was added from, for display. */
function sourceText(src: unknown, tidy: (s: string) => string): string {
  if (!isObj(src)) return ''
  const v = src['repo'] ?? src['url'] ?? src['path'] ?? src['package'] ?? ''
  return tidy(clean(v, 300))
}

/**
 * Added Claude Code marketplaces and their catalogs: `known_marketplaces.json` → `installLocation` → `marketplace.json`.
 * Read-only. Names that Claude Code would not install are skipped; texts are cleaned and truncated.
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
    // no file means nothing is installed
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
