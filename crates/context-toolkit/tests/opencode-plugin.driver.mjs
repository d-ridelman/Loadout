// Runs the OpenCode plugin that `setup --opencode` wrote against a stand-in for OpenCode's plugin context and prints
// what each call did as JSON. Used by guard.test.mjs under Node; the same file runs under Bun, the runtime of OpenCode
// (`BUN_BE_BUN=1 opencode-cli.exe opencode-plugin.driver.mjs <plugin> <big file>`).
// Usage: node opencode-plugin.driver.mjs <plugin index.js> <big file>
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [plugin, bigFile] = process.argv.slice(2)

/** Loads a plugin file and returns its `execute.before` callback; `permission` is the stand-in `ctx.permission`. */
async function load(file, permission) {
  const mod = await import(pathToFileURL(file).href + `?v=${Math.random()}`)
  let before
  const ctx = { location: { directory: process.cwd() }, tool: { hook: async (name, cb) => { if (name === 'execute.before') before = cb } }, permission }
  await mod.default.setup(ctx)
  return { id: mod.default.id, before }
}

/** A permission API that evaluates like OpenCode's (the base policy allows every action) and answers a prompt with `reply`. */
function permissionApi(reply, prompts) {
  const hooks = {}
  return {
    hook: async (name, cb) => { hooks[name] = cb },
    assert: async (input) => {
      const event = { sessionID: input.sessionID, action: input.action, resources: input.resources, source: input.source, effect: 'allow' }
      if (hooks.evaluate) await hooks.evaluate(event)
      if (event.effect !== 'ask') return
      prompts.push({ message: event.message, resources: input.resources, source: input.source })
      // a plain "no" is OpenCode's Permission.DeclinedError (a tagged error); a "no" with feedback carries the feedback
      if (reply === 'reject') throw Object.assign(new Error(''), { _tag: 'Permission.DeclinedError' })
      if (reply === 'feedback') throw new Error('try a dry run first')
    },
  }
}

const call = async (before, tool, input) => {
  try {
    await before({ tool, sessionID: 'ses_1', agent: 'build', messageID: 'msg_1', id: `call_${Math.random()}`, input })
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), tag: e?._tag }
  }
}

const out = {}
const prompts = []
const plain = await load(plugin, undefined)
out.id = plain.id
out.readWhole = await call(plain.before, 'read', { path: bigFile })
out.readSlice = await call(plain.before, 'read', { path: bigFile, offset: 1, limit: 50 })
out.clean = await call(plain.before, 'shell', { command: 'git status' })
out.otherTool = await call(plain.before, 'grep', { pattern: 'x' })
out.askNoApi = await call(plain.before, 'shell', { command: 'git push' })
out.askApproved = await call((await load(plugin, permissionApi('once', prompts))).before, 'shell', { command: 'git push' })
out.askRejected = await call((await load(plugin, permissionApi('reject', prompts))).before, 'shell', { command: 'git push' })
out.askFeedback = await call((await load(plugin, permissionApi('feedback', prompts))).before, 'shell', { command: 'git push' })
// an assert that allows without running the evaluate hook (an older OpenCode, a policy that skipped it): nobody was asked
out.askUnprompted = await call((await load(plugin, { assert: async () => {} })).before, 'shell', { command: 'git push' })
out.prompts = prompts

// A broken hook passes the call: a missing program, and a program that prints no JSON.
const text = readFileSync(plugin, 'utf8')
const variant = (name, exe, args) => {
  const f = plugin.replace(/index\.js$/, `${name}.mjs`)
  writeFileSync(f, text.replace(/^const EXE = .*$/m, `const EXE = ${JSON.stringify(exe)}`).replace(/^const ARGS = .*$/m, `const ARGS = ${JSON.stringify(args)}`))
  return f
}
out.missingExe = await call((await load(variant('missing', plugin + '.nope.exe', []), undefined)).before, 'read', { path: bigFile })
out.garbage = await call((await load(variant('garbage', process.execPath, ['-e', 'console.log("not json")']), undefined)).before, 'read', { path: bigFile })
console.log(JSON.stringify(out))
