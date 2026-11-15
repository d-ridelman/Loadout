// Подставной `claude` для e2e: ничего не скачивает. Записывает свои аргументы в FAKE_CLAUDE_CALLS, а `plugin marketplace add <папка>`
// повторяет то, что делает настоящий CLI с локальным маркетплейсом: запись в known_marketplaces.json (каталог читается на месте).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_CLAUDE_CALLS, args.join(' ') + '\n')
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  const src = args.at(-1)
  const { name } = JSON.parse(readFileSync(join(src, '.claude-plugin', 'marketplace.json'), 'utf8'))
  const file = join(process.env.USERPROFILE, '.claude', 'plugins', 'known_marketplaces.json')
  const known = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  known[name] = { source: { source: 'directory', path: src }, installLocation: src }
  writeFileSync(file, JSON.stringify(known, null, 2))
}
console.log('ok')
