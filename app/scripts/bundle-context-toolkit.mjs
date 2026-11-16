// Puts context-toolkit.exe (Context Toolkit) into app/build/context-toolkit.exe: electron-builder picks it up from there
// (extraResources), and so does development. Source: the CONTEXT_TOOLKIT_BIN variable (the old name CTXKIT_BIN is also accepted), otherwise
// the crates/context-toolkit crate of this same workspace (built by cargo into the root target).
// Run: `node scripts/bundle-context-toolkit.mjs` (it is also called by `npm run pack` and `npm run dist`).
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
  must(existsSync(join(crate, 'Cargo.toml')), `context-toolkit crate not found: ${crate}`)
  // offline cannot be forced: dependencies may not have been downloaded
  execFileSync('cargo', ['build', '--release', '-p', 'context-toolkit', '--manifest-path', join(repo, 'Cargo.toml')], { stdio: 'inherit' })
  src = join(repo, 'target', 'release', 'context-toolkit.exe')
}
must(existsSync(src), `not found: ${src}`)
mkdirSync(dirname(dst), { recursive: true })
copyFileSync(src, dst)
console.log(`context-toolkit.exe: ${src} → ${dst} (${(statSync(dst).size / 1048576).toFixed(1)} MB)`)

function must(cond, msg) {
  if (!cond) {
    console.error(`FAILED: ${msg}`)
    process.exit(1)
  }
}
