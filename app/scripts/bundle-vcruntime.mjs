// Puts the Visual C++ runtime DLLs loadout-ml.exe needs into app/build/vcruntime/: electron-builder ships them next to it
// (extraResources), so it starts on a Windows without the VC++ Redistributable (app-local deployment, the files of VC\Redist are
// redistributable). Its linked ONNX Runtime is built for the DLL runtime (vcruntime140, vcruntime140_1, msvcp140, msvcp140_1);
// loadout.exe and context-toolkit.exe link vcruntime statically (their build.rs) and need none of these.
// Source: the VCRUNTIME_DIR variable, otherwise the newest VC\Redist\MSVC\*\x64\Microsoft.VC*.CRT of the Visual Studio vswhere finds.
// Run: `node scripts/bundle-vcruntime.mjs` (also called by `npm run pack` and `npm run dist`).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DLLS = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll']
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dst = join(appDir, 'build', 'vcruntime')

function crtDir() {
  if (process.env.VCRUNTIME_DIR) return process.env.VCRUNTIME_DIR
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  must(existsSync(vswhere), `vswhere not found (${vswhere}): install Visual Studio Build Tools or set VCRUNTIME_DIR`)
  const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' }).trim()
  const redist = join(vs, 'VC', 'Redist', 'MSVC')
  const versions = readdirSync(redist).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  must(versions.length > 0, `no VC++ redistributable under ${redist}`)
  const x64 = join(redist, versions.at(-1), 'x64')
  const crt = readdirSync(x64).find((d) => /^Microsoft\.VC\d+\.CRT$/.test(d))
  must(crt, `no Microsoft.VC*.CRT under ${x64}`)
  return join(x64, crt)
}

const src = crtDir()
mkdirSync(dst, { recursive: true })
for (const f of DLLS) {
  must(existsSync(join(src, f)), `not found: ${join(src, f)}`)
  copyFileSync(join(src, f), join(dst, f))
}
console.log(`VC++ runtime: ${src} → ${dst} (${DLLS.join(', ')})`)

function must(cond, msg) {
  if (!cond) {
    console.error(`FAILED: ${msg}`)
    process.exit(1)
  }
}
