// Stop hook of Claude Code (.claude/settings.json): the turn does not end while a gate of .claude/gates.json that this session touched is
// not passed (tools/gate.mjs). Silent when the session changed nothing of a gate, when its check is running, and on the second stop in a row.
// In observe mode it only logs what it would have blocked.
//   node tools/claude-stop-gate.mjs < hook-input.json   → prints {"decision":"block",…} or nothing
import { readFileSync, statSync } from 'node:fs';
import { load, mode, observe, projectRoot, running, stale, touched, verdict } from './gate.mjs';

/** When the session began: the earliest of the timestamps near the transcript's start and the file's creation time (0 on some Linux
 *  file systems, so it is only taken when set). Earlier is safer: it counts more shell edits as this session's. */
function sessionStart(path, lines) {
  const times = [];
  for (const line of lines.slice(0, 50)) { const m = /"timestamp":"([^"]+)"/.exec(line); const t = m ? Date.parse(m[1]) : NaN; if (t > 0) times.push(t); }
  try { const b = statSync(path).birthtimeMs; if (b > 0) times.push(b); } catch { /* no file: no time */ }
  return times.length ? Math.min(...times) : Infinity;
}

let raw = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; }).on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    // the project of the session's directory (a worktree or a monorepo package too); CLAUDE_PROJECT_DIR is only where the session started
    const root = projectRoot(input.cwd || process.cwd()) ?? (process.env.CLAUDE_PROJECT_DIR ? projectRoot(process.env.CLAUDE_PROJECT_DIR) : null);
    if (!root) return;
    const gates = load(root); if (!gates.length || input.stop_hook_active) return;
    const open = stale(root, gates); if (!open.length) return;
    let lines = []; try { lines = readFileSync(input.transcript_path, 'utf8').split('\n'); } catch { return; }
    const since = sessionStart(input.transcript_path, lines);
    const out = verdict({ stale: open, touched: new Set(open.filter((gate) => touched(lines, gate, root, since)).map((gate) => gate.name)), running: running(root, gates), again: false, root });
    if (mode(root) === 'enforce') { if (out) process.stdout.write(JSON.stringify(out)); } else observe(root, out);
  } catch { /* a broken hook must not hold every turn of every session: it says nothing */ }
});
