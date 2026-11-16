import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const limit = Number(process.argv[2] || 30);
const roots = [
  process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : join(homedir(), '.claude', 'projects'),
  join(homedir(), '.claude-work', 'projects'),
];

const files = [];
for (const base of new Set(roots)) {
  try {
    for (const proj of readdirSync(base)) {
      const pdir = join(base, proj);
      try {
        for (const f of readdirSync(pdir)) {
          if (f.endsWith('.jsonl')) {
            const full = join(pdir, f);
            files.push({ full, mtime: statSync(full).mtimeMs });
          }
        }
      } catch {}
    }
  } catch {}
}

files.sort((a, b) => b.mtime - a.mtime);
const recent = files.slice(0, limit);
if (!recent.length) {
  console.log('No Claude Code session transcripts found.');
  process.exit(0);
}

const byModel = new Map();
const byTool = new Map();
const shellBuckets = new Map();
let turns = 0;
let textChars = 0;
let thinkingChars = 0;
let toolUseChars = 0;
let totalToolResultChars = 0;
let totalShellChars = 0;

function classifyShell(cmd) {
  const c = (cmd || '').trim();
  if (/\b(npm test|node --test|typecheck|tsc|eslint|cargo\s+(test|check|clippy|build)|pytest)\b/i.test(c)) {
    return 'build/test/lint';
  }
  if (/\bgit\b/i.test(c)) return 'git';
  if (/\b(sed|cat|head|tail|nl|wc|grep|rg|find|ls|dir|stat|Get-Content)\b/i.test(c)) {
    return 'file-inspect-via-shell';
  }
  if (/\b(python|python3|node)\b/i.test(c)) return 'inline-or-script';
  return 'other';
}

for (const f of recent) {
  const lines = readFileSync(f.full, 'utf8').split('\n');
  const toolUseById = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'assistant' && row.message) {
      turns++;
      const model = row.message.model || 'unknown';
      const u = row.message.usage || {};
      const m = byModel.get(model) || { turns: 0, outTok: 0, cacheRead: 0, cacheCreate: 0 };
      m.turns++;
      m.outTok += u.output_tokens || 0;
      m.cacheRead += u.cache_read_input_tokens || 0;
      m.cacheCreate += u.cache_creation_input_tokens || 0;
      byModel.set(model, m);
      for (const b of row.message.content || []) {
        if (b.type === 'text') textChars += (b.text || '').length;
        else if (b.type === 'thinking') thinkingChars += (b.thinking || '').length;
        else if (b.type === 'tool_use') {
          toolUseChars += JSON.stringify(b.input || {}).length;
          toolUseById.set(b.id, { name: b.name, input: b.input });
        }
      }
    } else if (row.type === 'user' && row.message && Array.isArray(row.message.content)) {
      for (const b of row.message.content) {
        if (b.type !== 'tool_result') continue;
        const txt = typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content) ? b.content.map(x => x.text || '').join('\n') : '';
        const len = txt.length;
        totalToolResultChars += len;
        const tu = toolUseById.get(b.tool_use_id);
        const name = tu?.name || 'unknown';
        const t = byTool.get(name) || { calls: 0, chars: 0 };
        t.calls++; t.chars += len;
        byTool.set(name, t);

        if (name === 'Bash' || name === 'PowerShell') {
          totalShellChars += len;
          const bk = classifyShell(tu?.input?.command);
          const cur = shellBuckets.get(bk) || { calls: 0, chars: 0 };
          cur.calls++; cur.chars += len;
          shellBuckets.set(bk, cur);
        }
      }
    }
  }
}

console.log(`Analyzed ${recent.length} sessions (${turns} assistant turns, avg ${(turns / recent.length).toFixed(1)} turns/session)`);
console.log('Output breakdown (chars):', { textChars, thinkingChars, toolUseChars });
console.log('\nBy model:');
for (const [k, v] of byModel.entries()) console.log(`  ${k.padEnd(20)} turns=${String(v.turns).padStart(6)} outTok=${v.outTok} cacheRead=${v.cacheRead}`);
console.log('\nTop tool_result consumers:');
for (const [k, v] of [...byTool.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 12)) {
  const pct = ((v.chars / Math.max(1, totalToolResultChars)) * 100).toFixed(1);
  console.log(`  ${k.padEnd(36)} ${String(v.calls).padStart(5)} calls  ${String(v.chars).padStart(10)} chars (${pct}%)`);
}
console.log('\nShell breakdown:');
for (const [k, v] of [...shellBuckets.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
  const pct = ((v.chars / Math.max(1, totalShellChars)) * 100).toFixed(1);
  console.log(`  ${k.padEnd(26)} ${String(v.calls).padStart(5)} calls  ${String(v.chars).padStart(10)} chars (${pct}% of shell)`);
}
