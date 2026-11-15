// Кладёт ctxkit.exe в app/build/ctxkit.exe: оттуда его берёт electron-builder (extraResources) и разработка.
// Источник: переменная CTXKIT_BIN, иначе соседний репозиторий ../../ctxkit (release-сборка; если её нет, собирается cargo).
// Запуск: `node scripts/bundle-ctxkit.mjs` (его же вызывают `npm run pack` и `npm run dist`).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = process.env.CTXKIT_REPO ?? resolve(appDir, '..', '..', 'ctxkit')
const dst = join(appDir, 'build', 'ctxkit.exe')

let src = process.env.CTXKIT_BIN
if (!src) {
  must(existsSync(join(repo, 'Cargo.toml')), `нет репозитория ctxkit: ${repo} (задайте CTXKIT_REPO или CTXKIT_BIN)`)
  // сборка в чужом репозитории меняет только его target/; offline нельзя навязывать: зависимости могли не скачаться
  execFileSync('cargo', ['build', '--release', '--manifest-path', join(repo, 'Cargo.toml')], { stdio: 'inherit' })
  src = join(repo, 'target', 'release', 'ctxkit.exe')
}
must(existsSync(src), `нет ${src}`)
mkdirSync(dirname(dst), { recursive: true })
copyFileSync(src, dst)
console.log(`ctxkit.exe: ${src} → ${dst} (${(statSync(dst).size / 1048576).toFixed(1)} МБ)`)

function must(cond, msg) {
  if (!cond) {
    console.error(`FAILED: ${msg}`)
    process.exit(1)
  }
}
