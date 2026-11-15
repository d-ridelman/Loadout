import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkTreeSize, cloneArgs, findSkills, parseMarketplaceSource, parseSkillSource, readCatalog, skillNameOk } from './install'

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
  it('принимает owner/repo, https и полный путь', () => {
    expect(parseMarketplaceSource(' anthropics/claude-code ')).toEqual({ kind: 'github', value: 'anthropics/claude-code' })
    expect(parseMarketplaceSource('https://git.example.com/team/mp.git')).toEqual({ kind: 'url', value: 'https://git.example.com/team/mp.git' })
    expect(parseMarketplaceSource('C:\\Users\\My Name\\mp')).toEqual({ kind: 'path', value: 'C:\\Users\\My Name\\mp' })
  })
  it.each([
    '', '-x', '--scope=local', 'a/b --scope local', 'a/b\n--x', '../x', 'a/../b', 'C:\\a\\..\\b', '\\\\server\\share',
    'http://x.test/mp', 'https://user:pw@x.test/mp', 'ext::sh -c evil', 'file:///C:/x', 'git@github.com:a/b.git', 'a/b/c', 'a/.', 'relative\\dir',
    'a\u202eb/c', 42, null,
  ])('отвергает %j', (s) => {
    expect(() => parseMarketplaceSource(s)).toThrow()
  })
})

describe('parseSkillSource', () => {
  it('разбирает короткую запись, адрес tree и папку', () => {
    expect(parseSkillSource('acme/skills/web/search')).toEqual({ kind: 'github', owner: 'acme', repo: 'skills', ref: undefined, sub: 'web/search' })
    expect(parseSkillSource('https://github.com/acme/skills/tree/main/web')).toEqual({ kind: 'github', owner: 'acme', repo: 'skills', ref: 'main', sub: 'web' })
    expect(parseSkillSource('https://github.com/acme/skills.git')).toEqual({ kind: 'github', owner: 'acme', repo: 'skills', ref: undefined, sub: '' })
    expect(parseSkillSource('acme/skills.git')).toMatchObject({ repo: 'skills' })
    expect(parseSkillSource('https://github.com/acme/skills/blob/v1/web/SKILL.md')).toMatchObject({ ref: 'v1', sub: 'web' })
    expect(parseSkillSource('D:\\src\\my skill')).toEqual({ kind: 'path', path: 'D:\\src\\my skill' })
  })
  it.each(['acme', '-acme/x', 'acme/x/../y', 'acme/x/.git', 'https://gitlab.com/a/b', 'https://github.com/a/b?x=1', 'https://github.com/a/b/tree/-x', 'a/b c', 'a:b/c'])(
    'отвергает %j',
    (s) => {
      expect(() => parseSkillSource(s)).toThrow()
    },
  )
})

it('cloneArgs: адрес после --, ветка отдельным аргументом', () => {
  const a = cloneArgs({ owner: 'acme', repo: 'skills', ref: 'v1' }, 'https://github.com/', 'D:\\st')
  expect(a.slice(-3)).toEqual(['--', 'https://github.com/acme/skills.git', 'D:\\st'])
  expect(a).toContain('protocol.ext.allow=never')
  expect(a[a.indexOf('--branch') + 1]).toBe('v1')
  expect(cloneArgs({ owner: 'a', repo: 'b', ref: undefined }, 'https://github.com/', 'x')).not.toContain('--branch')
})

it('skillNameOk: занятые и опасные имена', () => {
  expect(skillNameOk('web-search')).toBe(true)
  for (const n of ['synced', 'SYNCED', 'anthropic-skills-x', '../x', 'a b', '.x', 'a..b']) expect(skillNameOk(n), n).toBe(false)
})

it('findSkills: корень, вложенные каталоги и имя из frontmatter', () => {
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
  // скил в корне без `name:` получает имя папки или репозитория
  const single = tmp()
  put(join(single, 'SKILL.md'), '---\n---\n')
  expect(findSkills(single, '', 'my-skill')).toEqual([{ sub: '', name: 'my-skill', description: '' }])
})

it('checkTreeSize: отказ до копирования большой папки', () => {
  const root = tmp()
  for (let i = 0; i < 4; i++) put(join(root, 'd', `f${i}.md`), 'x')
  put(join(root, 'node_modules', 'big.js'), 'x'.repeat(100))
  expect(() => checkTreeSize(root, 4, 1000)).not.toThrow()
  expect(() => checkTreeSize(root, 3, 1000)).toThrow()
  expect(() => checkTreeSize(root, 10, 3)).toThrow()
})

it('readCatalog: каталог маркетплейса, установленные и неустанавливаемые', () => {
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
