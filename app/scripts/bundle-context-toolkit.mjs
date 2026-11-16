// Кладёт context-toolkit.exe (Инструменты контекста) в app/build/context-toolkit.exe: оттуда его берёт electron-builder
// (extraResources) и разработка. Источник: переменная CONTEXT_TOOLKIT_BIN (старое имя CTXKIT_BIN тоже принимается), иначе
// крейт crates/context-toolkit этого же воркспейса (собирается cargo в target корня).
// Запуск: `node scripts/bundle-context-toolkit.mjs` (его же вызывают `npm run pack` и `npm run dist`).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(appDir, '..')
const dst = join(appDir, 'build', 'context-toolkit.exe')

let src = process.env.CONTEXT_TOOLKIT_BIN || process.env.CTXKIT_BIN
if (!src) {
  const crate = join(repo, 'crates', 'context-toolkit')
  must(existsSync(join(crate, 'Cargo.toml')), `нет крейта context-toolkit: ${crate}`)
  // offline нельзя навязывать: зависимости могли не скачаться
  execFileSync('cargo', ['build', '--release', '-p', 'context-toolkit', '--manifest-path', join(repo, 'Cargo.toml')], { stdio: 'inherit' })
  src = join(repo, 'target', 'release', 'context-toolkit.exe')
}
must(existsSync(src), `нет ${src}`)
mkdirSync(dirname(dst), { recursive: true })
copyFileSync(src, dst)
console.log(`context-toolkit.exe: ${src} → ${dst} (${(statSync(dst).size / 1048576).toFixed(1)} МБ)`)

function must(cond, msg) {
  if (!cond) {
    console.error(`FAILED: ${msg}`)
    process.exit(1)
  }
}
