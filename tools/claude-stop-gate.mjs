// Stop hook of Claude Code (.claude/settings.json): the turn does not end while a gate of .claude/gates.json that this session touched is
// not passed (tools/gate.mjs). Silent when the session changed nothing of a gate, when its check is running, and on the second stop in a row.
// In observe mode it only logs what it would have blocked.
//   node tools/claude-stop-gate.mjs < hook-input.json   → prints {"decision":"block",…} or nothing
import { readFileSync, statSync } from 'node:fs';
import { load, mode, observe, running, stale, touched, verdict } from './gate.mjs';

let raw = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; }).on('end', () => {
  try {
    const input = JSON.parse(raw || '{}'); const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const gates = load(root); if (!gates.length || input.stop_hook_active) return;
    const open = stale(root, gates); if (!open.length) return;
    let lines = []; let since = Infinity;
    try { lines = readFileSync(input.transcript_path, 'utf8').split('\n'); since = statSync(input.transcript_path).birthtimeMs || Infinity; } catch { return; }
    const out = verdict({ stale: open, touched: new Set(open.filter((gate) => touched(lines, gate, root, since)).map((gate) => gate.name)), running: running(root, gates), again: false });
    if (mode(root) === 'enforce') { if (out) process.stdout.write(JSON.stringify(out)); } else observe(root, out);
  } catch { /* a broken hook must not hold every turn of every session: it says nothing */ }
});
