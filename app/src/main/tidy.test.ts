import { describe, expect, it } from 'vitest'
import { tidyHome } from './tidy'

const HOME = 'C:\\Users\\имя'

describe('tidyHome', () => {
  it('collapses the home directory and keeps the rest of the path', () => {
    expect(tidyHome('не найден C:\\Users\\имя\\.claude\\x.json', HOME)).toBe('не найден ~\\.claude\\x.json')
    expect(tidyHome('C:/Users/имя/.claude/x.json', HOME)).toBe('~/.claude/x.json')
    expect(tidyHome('C:\\\\Users\\\\имя\\\\x', HOME)).toBe('~\\\\x')
    expect(tidyHome('смешано C:/Users\\имя/x', HOME)).toBe('смешано ~/x')
  })
  it('letter case does not matter', () => {
    expect(tidyHome('c:\\users\\имя\\x', HOME)).toBe('~\\x')
    expect(tidyHome('C:\\USERS\\ИМЯ\\x', HOME)).toBe('~\\x')
    expect(tidyHome('c:\\users\\имя\\x', 'C:\\Users\\ИМЯ')).toBe('~\\x')
  })
  it('a foreign directory with the same name prefix is not collapsed', () => {
    for (const t of ['C:\\Users\\имя2\\x', 'C:\\Users\\имяя\\x', 'C:\\Users\\имя_old', 'C:\\Users\\имя-x\\y', 'C:\\Users\\имя.old\\x', 'C:\\Users\\Имя2']) {
      expect(tidyHome(t, HOME)).toBe(t)
    }
  })
  it('boundary: end of text, separator, quote, colon, space and a period at the end of a sentence', () => {
    expect(tidyHome('C:\\Users\\имя', HOME)).toBe('~')
    expect(tidyHome('«C:\\Users\\имя»', HOME)).toBe('«~»')
    expect(tidyHome('"C:\\Users\\имя": нет доступа', HOME)).toBe('"~": нет доступа')
    expect(tidyHome('в C:\\Users\\имя нет файла', HOME)).toBe('в ~ нет файла')
    expect(tidyHome('см. C:\\Users\\имя.', HOME)).toBe('см. ~.')
    expect(tidyHome('(C:\\Users\\имя)', HOME)).toBe('(~)')
  })
  it('several occurrences and an error with two paths', () => {
    expect(tidyHome('из C:\\Users\\имя\\a в c:/users/имя/b, но не C:\\Users\\имя2\\c', HOME)).toBe('из ~\\a в ~/b, но не C:\\Users\\имя2\\c')
  })
  it('regex characters in the user name, a trailing slash and spaces at the end of home', () => {
    expect(tidyHome('C:\\Users\\a+b(1)\\x и C:\\Users\\aab(1)\\x', 'C:\\Users\\a+b(1)\\')).toBe('~\\x и C:\\Users\\aab(1)\\x')
    expect(tidyHome('C:\\Users\\My Name\\x', 'C:\\Users\\My Name')).toBe('~\\x')
    expect(tidyHome('/home/user/x', '/home/user')).toBe('~/x')
  })
  it('an empty home changes nothing', () => {
    expect(tidyHome('C:\\x', '')).toBe('C:\\x')
    expect(tidyHome('C:\\x', '\\')).toBe('C:\\x')
  })
})
