import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkoutArgs, checkTreeSize, cloneArgs, findSkills, isCommitRef, parseMarketplaceSource, parseRefs, parseSkillSource, pickTreeRef, readCatalog, rmTree, skillNameOk } from './install'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'loadout-inst-'))
  dirs.push(d)
  return d
}
const put = (file: string, text: string) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('parseMarketplaceSource', () => {
  it('accepts owner/repo, https and a full path', () => {
    expect(parseMarketplaceSource(' anthropics/claude-code ')).toEqual({ kind: 'github', value: 'anthropics/claude-code' })
    expect(parseMarketplaceSource('https://git.example.com/team/mp.git')).toEqual({ kind: 'url', value: 'https://git.example.com/team/mp.git' })
    expect(parseMarketplaceSource('C:\\Users\\My Name\\mp')).toEqual({ kind: 'path', value: 'C:\\Users\\My Name\\mp' })
  })
  it('accepts #branch and #tag on owner/repo, https and SSH', () => {
    expect(parseMarketplaceSource('your-org/plugins#v1.2.0')).toEqual({ kind: 'github', value: 'your-org/plugins#v1.2.0' })
    expect(parseMarketplaceSource('https://gitlab.example.com/g/mp.git#release/2025')).toEqual({ kind: 'url', value: 'https://gitlab.example.com/g/mp.git#release/2025' })
    expect(parseMarketplaceSource('git@github.com:a/b.git#main')).toEqual({ kind: 'ssh', value: 'git@github.com:a/b.git#main' })
  })
  it('accepts SSH addresses: git@host:path and ssh://', () => {
    expect(parseMarketplaceSource('git@github.com:owner/repo')).toEqual({ kind: 'ssh', value: 'git@github.com:owner/repo' })
    expect(parseMarketplaceSource('git@gitlab.example.com:group/sub/mp.git')).toEqual({ kind: 'ssh', value: 'git@gitlab.example.com:group/sub/mp.git' })
    expect(parseMarketplaceSource('org-123@ghe.corp.example:team/mp.git')).toEqual({ kind: 'ssh', value: 'org-123@ghe.corp.example:team/mp.git' })
    expect(parseMarketplaceSource('ssh://git@host.example.com/owner/repo.git')).toEqual({ kind: 'ssh', value: 'ssh://git@host.example.com/owner/repo.git' })
    expect(parseMarketplaceSource('ssh://host.example.com:2222/owner/repo')).toEqual({ kind: 'ssh', value: 'ssh://host.example.com:2222/owner/repo' })
  })
  it('a name of 7-40 hex characters after # is rejected with a clear message: it cannot be told from a commit hash, and the docs name only a branch or a tag', () => {
    for (const s of ['a/b#0123abc', 'a/b#' + 'f'.repeat(40), 'git@github.com:a/b.git#deadbeef']) {
      expect(() => parseMarketplaceSource(s)).toThrow(/шестнадцатеричных/)
    }
    // a branch that looks like a hash by length but not by characters is an ordinary branch
    expect(parseMarketplaceSource('a/b#release-1')).toMatchObject({ value: 'a/b#release-1' })
  })
  it.each([
    '', '-x', '--scope=local', 'a/b --scope local', 'a/b\n--x', '../x', 'a/../b', 'C:\\a\\..\\b', '\\\\server\\share',
    'http://x.test/mp', 'https://user:pw@x.test/mp', 'ext::sh -c evil', 'file:///C:/x', 'a/b/c', 'a/.', 'relative\\dir',
    'a\u202eb/c', 42, null,
    // ref: empty, flag, `..`, space, quotes, a second hash sign
    'a/b#', 'a/b#-x', 'a/b#x..y', 'a/b#x y', 'a/b#"x"', "a/b#'x'", 'a/b#x#y', 'a/b#x/', 'a/b#x.lock', 'a/b#/x',
    // SSH: flags, spaces, quotes, control characters, `..`, password, leading `/`, empty parts
    '-oProxyCommand=x@h:a/b', 'git@-host:a/b', 'git@host:-a/b', 'git@host:/abs/path', 'git@host:a/../b', 'git@host:a b', 'git@host:"a"/b',
    "git@host:'a'", 'git@host:a\u0000b', 'git@host:a\nb', 'git@host:', 'git@:a/b', '@host:a/b', 'git@host:a//b', 'git@host:a/b/', 'git@ho st:a/b', 'git@host:a;b', 'git@host:a$(x)', 'git@host:a`x`',
    'git@host:%2e%2e/x', 'git@host:a\\b', 'user:pw@host:a/b', 'git@[::1]:a/b',
    'ssh://-oProxyCommand=x/a', 'ssh://git@-host/a/b', 'ssh://git:pw@host/a/b', 'ssh://host/', 'ssh://host', 'ssh://host/a b', 'ssh://host/a/../b', 'ssh://host:99999x/a', 'ssh://host/-a/b', 'ssh://host/a?x=1', 'ssh://host/%2e%2e/b', "ssh://host/a'b", 'ssh:///a/b', 'ssh://git@host/a\u0001',
  ])('rejects %j', (s) => {
    expect(() => parseMarketplaceSource(s)).toThrow()
  })
})

describe('parseSkillSource', () => {
  it('parses the short form, a tree URL and a folder', () => {
    expect(parseSkillSource('acme/skills/web/search')).toEqual({ kind: 'github', owner: 'acme', repo: 'skills', ref: undefined, sub: 'web/search' })
    // branch and path: "the first segment is the branch" as a guess, the full segments are kept to refine against the branch list
    expect(parseSkillSource('https://github.com/acme/skills/tree/main/web')).toEqual({ kind: 'github', owner: 'acme', repo: 'skills', ref: 'main', sub: 'web', treePath: ['main', 'web'] })
    expect(parseSkillSource('https://github.com/acme/skills/tree/main')).toEqual({ kind: 'github', owner: 'acme', repo: 'skills', ref: 'main', sub: '' })
    expect(parseSkillSource('https://github.com/acme/skills/tree/feature/x/web/a')).toMatchObject({ ref: 'feature', sub: 'x/web/a', treePath: ['feature', 'x', 'web', 'a'] })
    expect(parseSkillSource('https://github.com/acme/skills/tree/0123abc/web')).toMatchObject({ ref: '0123abc', sub: 'web' })
    expect(parseSkillSource('https://github.com/acme/skills.git')).toEqual({ kind: 'github', owner: 'acme', repo: 'skills', ref: undefined, sub: '' })
    expect(parseSkillSource('acme/skills.git')).toMatchObject({ repo: 'skills' })
    expect(parseSkillSource('https://github.com/acme/skills/blob/v1/web/SKILL.md')).toMatchObject({ ref: 'v1', sub: 'web', treePath: ['v1', 'web', 'SKILL.md'] })
    expect(parseSkillSource('D:\\src\\my skill')).toEqual({ kind: 'path', path: 'D:\\src\\my skill' })
  })
  it.each(['acme', '-acme/x', 'acme/x/../y', 'acme/x/.git', 'https://gitlab.com/a/b', 'https://github.com/a/b?x=1', 'https://github.com/a/b/tree/-x', 'a/b c', 'a:b/c'])(
    'rejects %j',
    (s) => {
      expect(() => parseSkillSource(s)).toThrow()
    },
  )
})

it('parseRefs: branches and tags from ls-remote output, annotated tags without ^{}', () => {
  const sha = 'a'.repeat(40)
  const out = [`${sha}\trefs/heads/main`, `${sha}\trefs/heads/feature/x`, `${sha}\trefs/tags/v1`, `${sha}\trefs/tags/v1^{}`, `${sha}\tHEAD`, `${sha}\trefs/pull/1/head`, 'мусор'].join('\r\n')
  expect([...parseRefs(out)].sort()).toEqual(['feature/x', 'main', 'v1'])
})

describe('pickTreeRef: a branch containing / in a tree/... URL', () => {
  const refs = new Set(['main', 'feature/x', 'release/2025/q1', 'v1'])
  it('takes the longest prefix that exists among branches and tags', () => {
    expect(pickTreeRef(['main', 'web', 'a'], refs)).toEqual({ ref: 'main', sub: 'web/a', commit: false })
    expect(pickTreeRef(['feature', 'x', 'skills', 'demo'], refs)).toEqual({ ref: 'feature/x', sub: 'skills/demo', commit: false })
    expect(pickTreeRef(['release', '2025', 'q1', 'SKILL.md'], refs)).toEqual({ ref: 'release/2025/q1', sub: '', commit: false })
    expect(pickTreeRef(['v1', 'web', 'SKILL.md'], refs)).toEqual({ ref: 'v1', sub: 'web', commit: false })
  })
  it('a URL pointing at a branch with / and no path: the whole tail is the branch', () => {
    expect(pickTreeRef(['feature', 'x'], refs)).toEqual({ ref: 'feature/x', sub: '', commit: false })
    expect(pickTreeRef(['release', '2025', 'q1'], refs)).toEqual({ ref: 'release/2025/q1', sub: '', commit: false })
    // a single segment (URL `tree/main`)
    expect(pickTreeRef(['main'], refs)).toEqual({ ref: 'main', sub: '', commit: false })
  })
  it('a commit hash in the first segment is a ref if no such branch or tag exists; if one does, it is a name, not a commit', () => {
    expect(pickTreeRef(['0123abc', 'web'], refs)).toEqual({ ref: '0123abc', sub: 'web', commit: true })
    expect(pickTreeRef(['0123abc'], refs)).toEqual({ ref: '0123abc', sub: '', commit: true })
    expect(pickTreeRef(['0123abc', 'web'], new Set(['0123abc']))).toEqual({ ref: '0123abc', sub: 'web', commit: false })
    expect(pickTreeRef(['20240101'], new Set(['20240101']))).toEqual({ ref: '20240101', sub: '', commit: false })
  })
  it('not found gives undefined (the "first segment is the branch" guess stays); the path is validated', () => {
    expect(pickTreeRef(['nope', 'web'], refs)).toBeUndefined()
    expect(pickTreeRef(['feature', 'y', 'web'], refs)).toBeUndefined()
    expect(pickTreeRef(['main', '..', 'x'], refs)).toBeUndefined()
    expect(pickTreeRef(['main', '.git', 'x'], refs)).toBeUndefined()
    expect(pickTreeRef(['0123abc', 'a b'], refs)).toBeUndefined()
  })
  it('a branch name from a foreign list goes through the same checks', () => {
    expect(pickTreeRef(['-x', 'a'], new Set(['-x']))).toBeUndefined()
    expect(pickTreeRef(['a', 'b'], new Set(['a..b']))).toBeUndefined()
  })
})

it('isCommitRef: 7-40 hex characters', () => {
  for (const ok of ['0123abc', 'DEADBEEF', 'a'.repeat(40)]) expect(isCommitRef(ok), ok).toBe(true)
  for (const no of [undefined, '', '012345', 'a'.repeat(41), 'ghijklm', 'v1.0.0', 'main', '0123abc;x', '-0123abc']) expect(isCommitRef(no), String(no)).toBe(false)
})

it('cloneArgs: a branch that looks like a hash and is confirmed by the branch list goes through --branch', () => {
  const a = cloneArgs({ owner: 'a', repo: 'b', ref: '0123abc', commit: false }, 'https://github.com/', 'x')
  expect(a[a.indexOf('--branch') + 1]).toBe('0123abc')
  expect(a).toContain('--depth')
  expect(cloneArgs({ owner: 'a', repo: 'b', ref: '0123abc', commit: true }, 'https://github.com/', 'x')).not.toContain('--branch')
})

it('cloneArgs for a commit hash: no --branch and no --depth, checkout as a second step', () => {
  const a = cloneArgs({ owner: 'acme', repo: 'skills', ref: '0123abcd' }, 'https://github.com/', 'D:\\st')
  expect(a).not.toContain('--branch')
  expect(a).not.toContain('--depth')
  expect(a).toContain('--no-checkout')
  expect(a.slice(-3)).toEqual(['--', 'https://github.com/acme/skills.git', 'D:\\st'])
  expect(a).toContain('protocol.ext.allow=never')
  const c = checkoutArgs('0123abcd', 'D:\\st')
  expect(c.slice(-4)).toEqual(['checkout', '--detach', '0123abcd', '--'])
  expect(c[c.indexOf('-C') + 1]).toBe('D:\\st')
  expect(c).toContain('protocol.ext.allow=never')
})

it('cloneArgs: the URL after --, the branch as a separate argument', () => {
  const a = cloneArgs({ owner: 'acme', repo: 'skills', ref: 'v1' }, 'https://github.com/', 'D:\\st')
  expect(a.slice(-3)).toEqual(['--', 'https://github.com/acme/skills.git', 'D:\\st'])
  expect(a).toContain('protocol.ext.allow=never')
  expect(a[a.indexOf('--branch') + 1]).toBe('v1')
  expect(cloneArgs({ owner: 'a', repo: 'b', ref: undefined }, 'https://github.com/', 'x')).not.toContain('--branch')
})

it('skillNameOk: taken and dangerous names', () => {
  expect(skillNameOk('web-search')).toBe(true)
  for (const n of ['synced', 'SYNCED', 'anthropic-skills-x', '../x', 'a b', '.x', 'a..b']) expect(skillNameOk(n), n).toBe(false)
})

it('findSkills: root, nested directories and the name from frontmatter', () => {
  const root = tmp()
  put(join(root, 'skills', 'web', 'SKILL.md'), '---\nname: web-search\ndescription: "Ищет"\n---\n')
  put(join(root, 'skills', 'bad name', 'SKILL.md'), '---\n---\n')
  put(join(root, 'other', 'SKILL.md'), '---\nname: ../evil\n---\n')
  put(join(root, '.git', 'x', 'SKILL.md'), '---\n---\n')
  expect(findSkills(root)).toEqual([
    { sub: 'other', name: 'other', description: '' },
    { sub: 'skills/web', name: 'web-search', description: 'Ищет' },
  ])
  expect(findSkills(root, 'skills/web').map((s) => s.sub)).toEqual(['skills/web'])
  expect(findSkills(root, 'nope')).toEqual([])
  // a skill at the root without `name:` gets the folder or repository name
  const single = tmp()
  put(join(single, 'SKILL.md'), '---\n---\n')
  expect(findSkills(single, '', 'my-skill')).toEqual([{ sub: '', name: 'my-skill', description: '' }])
})

it('findSkills: a YAML block-scalar description (`>`, `|-`) is read, not shown as ">"', () => {
  const root = tmp()
  put(join(root, 'a', 'SKILL.md'), '---\nname: a\ndescription: >\n  Первая строка\n  вторая строка\nlicense: MIT\n---\n')
  put(join(root, 'b', 'SKILL.md'), '---\r\nname: b\r\ndescription: |-\r\n  Один\r\n\r\n  Два\r\n---\r\n')
  expect(findSkills(root).map((s) => s.description)).toEqual(['Первая строка вторая строка', 'Один Два'])
})

it('checkTreeSize: refuses before copying a large folder', () => {
  const root = tmp()
  for (let i = 0; i < 4; i++) put(join(root, 'd', `f${i}.md`), 'x')
  put(join(root, 'node_modules', 'big.js'), 'x'.repeat(100))
  expect(() => checkTreeSize(root, 4, 1000)).not.toThrow()
  expect(() => checkTreeSize(root, 3, 1000)).toThrow()
  expect(() => checkTreeSize(root, 10, 3)).toThrow()
})

it('readCatalog: the marketplace catalog, installed and non-installable entries', () => {
  const home = tmp()
  const mp = join(home, 'mp')
  put(join(mp, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'local', owner: { name: 'x' },
    plugins: [
      { name: 'demo', source: './plugins/demo', description: 'Пример\u0007', version: '1.0.0' },
      { name: 'cmd', source: { source: 'command', command: 'x' } },
      { name: '../bad', source: './x' },
    ],
  }))
  put(join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({
    local: { source: { source: 'directory', path: mp }, installLocation: mp },
    gone: { source: { source: 'github', repo: 'a/b' } },
    'bad name': {},
  }))
  put(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'demo@local': [] } }))
  const [local, gone, ...rest] = readCatalog(home)
  expect(rest).toEqual([])
  expect(local!.plugins.map((p) => p.name)).toEqual(['demo', 'cmd'])
  expect(local!.plugins[0]).toEqual({ name: 'demo', description: 'Пример', version: '1.0.0', installed: true })
  expect(local!.plugins[1]!.why).toBeTruthy()
  expect(gone!.error).toBeTruthy()
  expect(readCatalog(tmp())).toEqual([])
})

describe('rmTree', () => {
  it('removes a git clone with read-only packs (Electron on Windows failed on them with EPERM)', () => {
    const d = tmp()
    const pack = join(d, '.git', 'objects', 'pack', 'pack-1.pack')
    put(pack, 'x')
    put(join(d, 'skills', 'a', 'SKILL.md'), '---\nname: a\n---\n')
    chmodSync(pack, 0o444)
    rmTree(d)
    expect(existsSync(d)).toBe(false)
  })
  it('a nonexistent directory is not an error', () => {
    expect(() => rmTree(join(tmp(), 'нет'))).not.toThrow()
  })
})
