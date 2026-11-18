// Context Toolkit (Loadout) for OpenCode 2: checks reads, shell commands and edits before they run.
// Written by `context-toolkit setup --opencode` and removed by `context-toolkit setup --uninstall --opencode`;
// setup rewrites this file, so change it through setup, not here.
import { spawn } from "node:child_process"

const EXE = "@EXE@"
const ARGS = "@ARGS@"

const RU = ARGS[ARGS.indexOf("--lang") + 1] === "ru"
const say = (en, ru) => (RU ? ru : en)
// The permission action of our prompts; nothing else uses it.
const ACTION = "context-toolkit"
const TOOLS = new Set(["read", "write", "edit", "patch", "apply_patch", "shell", "bash"])
const TIMEOUT_MS = 15000
const NEEDS_HUMAN = say(
  "This call needs a person's confirmation (a Context Toolkit policy), and OpenCode could not ask for it here, so it was not run. Ask the user to run it themselves.",
  "Этому вызову нужно подтверждение человека (политика Инструментов контекста), а спросить его здесь OpenCode не смог, поэтому вызов не выполнен. Попроси пользователя выполнить его самому.",
)
const DECLINED = say("The call was not confirmed, so it was not run.", "Вызов не подтверждён, поэтому не выполнен.")

// The hook's answer (`hookSpecificOutput`), or undefined when the hook fails, hangs or says nothing: a broken hook never blocks a call.
function runHook(payload) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(EXE, ARGS, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] })
    } catch {
      return resolve(undefined)
    }
    let out = ""
    const timer = setTimeout(() => {
      child.kill()
      resolve(undefined)
    }, TIMEOUT_MS)
    child.on("error", () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (d) => (out += d))
    child.on("close", () => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(out).hookSpecificOutput)
      } catch {
        resolve(undefined)
      }
    })
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify(payload))
  })
}

const resource = (input) => [input?.command, input?.path, input?.filePath].find((v) => typeof v === "string") ?? "*"

export default {
  id: "loadout.context-toolkit",
  async setup(ctx) {
    // Calls waiting for a prompt of ours (session/call id -> reason), and those our evaluate hook turned into a prompt.
    const asking = new Map()
    const prompted = new Set()
    const key = (sessionID, callID) => `${sessionID}/${callID}`
    if (typeof ctx.permission?.hook === "function") {
      await ctx.permission.hook("evaluate", (event) => {
        const k = key(event.sessionID, event.source?.id)
        const reason = asking.get(k)
        if (event.action !== ACTION || reason === undefined) return
        // The base policy allows every action ("*"), so ours would pass without asking anyone.
        event.effect = "ask"
        event.message = reason
        prompted.add(k)
      })
    }
    await ctx.tool.hook("execute.before", async (event) => {
      if (!TOOLS.has(event.tool)) return
      const answer = await runHook({
        hook_event_name: "PreToolUse",
        tool_name: event.tool,
        tool_input: event.input,
        cwd: ctx.location?.directory,
      })
      const reason = String(answer?.permissionDecisionReason ?? "")
      // A throw refuses the call: OpenCode gives the model the message and the call does not run.
      if (answer?.permissionDecision === "deny") throw new Error(reason)
      if (answer?.permissionDecision !== "ask") return
      const refuse = (why) => new Error(`${reason}\n${why}`)
      if (typeof ctx.permission?.assert !== "function") throw refuse(NEEDS_HUMAN)
      const k = key(event.sessionID, event.id)
      asking.set(k, reason)
      let shown = false
      try {
        await ctx.permission.assert({
          sessionID: event.sessionID,
          agent: event.agent,
          source: { type: "tool", messageID: event.messageID, id: event.id },
          action: ACTION,
          resources: [resource(event.input)],
          metadata: { reason },
        })
      } catch (e) {
        // A plain "no" goes back as it is: OpenCode recognises it and ends the step, as with its own prompts.
        if (e?._tag === "Permission.DeclinedError") throw e
        // A "no" with feedback, or a deny rule of the agent: the model gets our reason and OpenCode's message.
        throw refuse(`${DECLINED} ${e instanceof Error ? e.message : ""}`.trim())
      } finally {
        asking.delete(k)
        shown = prompted.delete(k)
      }
      // Allowed without a prompt: our evaluate hook did not run, so nobody confirmed the call.
      if (!shown) throw refuse(NEEDS_HUMAN)
    })
  },
}
