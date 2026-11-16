import { describe, expect, it } from 'vitest'
import { assertTrusted, grantedOf, isTrustedUrl, parseBatch, parseLevel, parseOp, parseSha, trustedSender, validateIntent, validateName } from './gate'

const INDEX = 'file:///C:/Program%20Files/Loadout/resources/app.asar/out/renderer/index.html'
const DEV = 'http://localhost:5173/'
const ENTITY = '0123456789abcdef'
const SHA = 'a'.repeat(64)

describe('isTrustedUrl / отправитель', () => {
  it('принимает страницу из сборки (в том числе с #) и источник dev-сервера', () => {
    expect(isTrustedUrl(INDEX, INDEX, undefined)).toBe(true)
    expect(isTrustedUrl(`${INDEX}#/journal`, INDEX, undefined)).toBe(true)
    expect(isTrustedUrl('http://localhost:5173/index.html', INDEX, DEV)).toBe(true)
    expect(isTrustedUrl('http://localhost:5173', INDEX, DEV)).toBe(true)
  })
  it.each([
    '',
    'about:blank',
    'https://evil.test/',
    `${INDEX}?x=1`, // другой адрес файла: запрос в строке не даёт доверия
    'file:///C:/evil/index.html',
    'http://localhost:5173.evil.test/',
    'http://localhost:5174/',
    'https://localhost:5173/',
    'not a url',
  ])('отказывает %j', (url) => {
    expect(isTrustedUrl(url, INDEX, DEV)).toBe(false)
  })
  it('в собранном приложении dev-сервера нет: его адрес не принимается', () => {
    expect(isTrustedUrl('http://localhost:5173/', INDEX, undefined)).toBe(false)
  })
  it('событие без кадра отправителя (чужое окно, удалённый кадр) не проходит', () => {
    expect(trustedSender({}, INDEX, DEV)).toBe(false)
    expect(trustedSender({ senderFrame: null }, INDEX, DEV)).toBe(false)
    expect(trustedSender({ senderFrame: { url: INDEX } }, INDEX, DEV)).toBe(true)
    expect(() => assertTrusted({ senderFrame: { url: 'https://evil.test/' } }, INDEX, DEV)).toThrow('untrusted sender')
    expect(() => assertTrusted({ senderFrame: { url: INDEX } }, INDEX, DEV)).not.toThrow()
  })
})

describe('validateIntent', () => {
  it('toggle, edit, copy: остаются только известные поля', () => {
    expect(validateIntent({ op: 'toggle', entity: ENTITY, enable: false, path: 'C:\\x', lvl: 'R2' })).toEqual({ op: 'toggle', entity: ENTITY, enable: false })
    expect(validateIntent({ op: 'edit', entity: `${ENTITY}-2`, command: 'npx', args: ['-y', 'p'], file: 'C:\\x' })).toEqual({ op: 'edit', entity: `${ENTITY}-2`, command: 'npx', args: ['-y', 'p'] })
    expect(validateIntent({ op: 'copy', entity: ENTITY, to: 'codex', extra: 1 })).toEqual({ op: 'copy', entity: ENTITY, to: 'codex' })
  })
  it.each([
    [null],
    ['toggle'],
    [42],
    [{}],
    [{ op: 'toggle', entity: ENTITY }], // нет enable
    [{ op: 'toggle', entity: ENTITY, enable: 'true' }],
    [{ op: 'toggle', entity: 'C:\\Users\\x\\.claude.json', enable: true }], // путь вместо id записи
    [{ op: 'toggle', entity: '../' + ENTITY, enable: true }],
    [{ op: 'toggle', entity: ENTITY.toUpperCase(), enable: true }],
    [{ op: 'toggle', entity: `${ENTITY}-12345`, enable: true }],
    [{ op: 'delete', entity: ENTITY }],
    [{ op: 'edit', entity: ENTITY, command: '   ', args: [] }],
    [{ op: 'edit', entity: ENTITY, command: 'npx', args: 'x' }],
    [{ op: 'edit', entity: ENTITY, command: 'npx', args: [1] }],
    [{ op: 'edit', entity: ENTITY, command: 'np\u0000x', args: [] }],
    [{ op: 'edit', entity: ENTITY, command: 'x'.repeat(501), args: [] }],
    [{ op: 'edit', entity: ENTITY, command: 'npx', args: Array(65).fill('a') }],
    [{ op: 'copy', entity: ENTITY, to: 'chrome' }],
    [{ op: 'copy', entity: ENTITY }],
  ])('отказывает %j', (raw) => {
    expect(() => validateIntent(raw)).toThrow()
  })

  it('add: пересобирает поля и проверяет имена env', () => {
    const ok = { op: 'add', to: 'claude-code', name: 'srv', command: 'npx', args: ['-y', 'p'], url: '', env: [{ key: 'API_KEY', value: 'v', junk: 1 }], path: 'C:\\x' }
    expect(validateIntent(ok)).toEqual({ op: 'add', to: 'claude-code', name: 'srv', command: 'npx', args: ['-y', 'p'], url: '', env: [{ key: 'API_KEY', value: 'v' }] })
    for (const bad of [
      { ...ok, to: 'nowhere' },
      { ...ok, name: 5 },
      { ...ok, args: 'x' },
      { ...ok, env: [{ key: '1BAD', value: 'v' }] },
      { ...ok, env: [{ key: 'A-B', value: 'v' }] },
      { ...ok, env: [{ key: 'K', value: 'a\nb' }] },
      { ...ok, env: Array(31).fill({ key: 'K', value: 'v' }) },
      { ...ok, env: null },
    ]) {
      expect(() => validateIntent(bad)).toThrow()
    }
  })

  it('installSkill: пути внутри клона только из безопасных сегментов, имя как у ядра', () => {
    const stage = 'f'.repeat(32)
    expect(validateIntent({ op: 'installSkill', stage, sub: '', name: 'demo', extra: 1 })).toEqual({ op: 'installSkill', stage, sub: '', name: 'demo' })
    expect(validateIntent({ op: 'installSkill', stage, sub: 'skills/demo-1', name: 'demo' })).toEqual({ op: 'installSkill', stage, sub: 'skills/demo-1', name: 'demo' })
    for (const sub of ['/abs', 'C:\\x', 'a\\b', 'a//b', 'a/', 'a b', 'a:b', 'a/b c', 'x'.repeat(101)]) {
      expect(() => validateIntent({ op: 'installSkill', stage, sub, name: 'demo' })).toThrow()
    }
    // сегменты из одних точек регулярка окна пропускает (поведение не менялось): их отвергает ядро, `valid_sub`
    // (тест `names_and_paths_are_checked` в crates/loadout-core/src/write/skill.rs)
    expect(validateIntent({ op: 'installSkill', stage, sub: '../x', name: 'demo' })).toMatchObject({ sub: '../x' })
    for (const name of ['', '../x', 'a/b', 'synced', 'anthropic-skills-x', '-x']) {
      expect(() => validateIntent({ op: 'installSkill', stage, sub: '', name })).toThrow()
    }
    for (const bad of ['../x', 'g'.repeat(32), 'f'.repeat(31), 'F'.repeat(32).toUpperCase() + 'x']) {
      expect(() => validateIntent({ op: 'installSkill', stage: bad, sub: '', name: 'demo' })).toThrow()
    }
  })
})

describe('идентификаторы, имя профиля и уровень', () => {
  it('parseSha, parseOp, parseBatch принимают только свою форму', () => {
    expect(parseSha(SHA)).toBe(SHA)
    expect(parseOp('1731700000000-00')).toBe('1731700000000-00')
    expect(parseBatch('1731700000000')).toBe('1731700000000')
    for (const v of [undefined, null, 5, '', SHA.slice(1), SHA.toUpperCase(), `${SHA}0`, '../' + SHA]) expect(() => parseSha(v)).toThrow()
    for (const v of ['1731700000000', '1731700000000-0', '..\\1731700000000-00', '1731700000000-00/..', 7]) expect(() => parseOp(v)).toThrow()
    for (const v of ['1731700000000-00', '173170000000', 'x1731700000000', 7, null]) expect(() => parseBatch(v)).toThrow()
  })
  it('validateName: 1-40 знаков, буквы, цифры, пробел, _ - .', () => {
    expect(validateName('рабочий-1.2 b_c')).toBe('рабочий-1.2 b_c')
    for (const v of ['', ' a', 'a ', '../x', 'a/b', 'a\\b', 'x'.repeat(41), 'a\nb', 5, null]) expect(() => validateName(v)).toThrow()
  })
  it('parseLevel: только R0, R1, R2; запись разрешена не ниже R1', () => {
    for (const l of ['R0', 'R1', 'R2'] as const) expect(parseLevel(l)).toBe(l)
    for (const v of ['r2', 'R3', 'R2 ', '', 2, null, undefined, { toString: () => 'R2' }]) expect(() => parseLevel(v)).toThrow()
    expect(grantedOf('R1')).toBe('R1')
    expect(grantedOf('R2')).toBe('R2')
    expect(() => grantedOf('R0')).toThrow(/R0/)
  })
})
