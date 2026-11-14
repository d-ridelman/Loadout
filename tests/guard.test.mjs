import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_NAME = process.platform === 'win32' ? 'ctxkit.exe' : 'ctxkit';
const exe = process.env.CTXKIT_BIN || join(ROOT, 'target', 'release', BIN_NAME);

if (!existsSync(exe)) {
  console.error(`Binary not found: ${exe}. Run \`cargo build --release\` first.`);
  process.exit(2);
}

const B = '\\';
const runHook = (payload, extraArgs = [], extraEnv = {}) => {
  const env = { ...process.env, ...extraEnv };
  if (!('CTXKIT_LANG' in extraEnv)) delete env.CTXKIT_LANG;
  const r = spawnSync(exe, extraArgs, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
  if (r.status !== 0) {
    throw new Error(`hook exited ${r.status}: ${r.stderr}`);
  }
  return r.stdout;
};

// Claude Code helpers
const preClaude = (tool_name, tool_input) =>
  runHook({ hook_event_name: 'PreToolUse', tool_name, tool_input }).includes('"deny"');
const sh = (command) => preClaude('Bash', { command });
const ps = (command) => preClaude('PowerShell', { command });
const rd = (file_path, extra = {}) => preClaude('Read', { file_path, ...extra });
const wr = (file_path, content) => preClaude('Write', { file_path, content });

// Antigravity helpers
const preAgy = (name, args) => {
  const out = runHook({ toolCall: { name, args }, stepIdx: 1 });
  return JSON.parse(out);
};

const dir = mkdtempSync(join(tmpdir(), 'cg-test-'));
const postClaude = (name, content) => {
  const file_path = join(dir, name);
  writeFileSync(file_path, content);
  return runHook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path } }).includes('"block"');
};

const TMP = `C:${B}Users${B}u${B}AppData${B}Local${B}Temp${B}agents${B}x${B}`;
const bigFile = join(dir, 'big.ts');
writeFileSync(
  bigFile,
  Array.from({ length: 600 }, (_, i) => `export const x${i} = ${i}; // padding line for size check`).join('\n'),
);
const smallFile = join(dir, 'small.ts');
writeFileSync(smallFile, 'export const a = 1;\n');
const bigImg = join(dir, 'cover.jpg');
writeFileSync(bigImg, Buffer.alloc(300_000, 0x41));

const failScript = join(dir, 'boom.mjs');
writeFileSync(failScript, 'throw new TypeError("boom error here");\n');

const cases = [
  // Claude Code: inline backslash & heredoc guards
  [true, () => sh(`node - <<'EOF'\nrep("a", "x${B}n");\nEOF`)],
  [true, () => sh(`cat > /tmp/edit.mjs <<'EOF'\nconst re = /system_${B}*/;\nEOF\nnode /tmp/edit.mjs`)],
  [true, () => sh(`python - <<EOF\ns = "host${B}${B}pipe"\nEOF`)],
  [true, () => sh(`node -e "s.env.X='D:${B}${B}${B}${B}Data'"`)],
  [true, () => sh(`git status && node --input-type=module -e "\nawait f(['D:${B}${B}Data']);"`)],
  [true, () => sh(`python -c "print('a${B}nb')"`)],
  [true, () => sh(`sed -i 's#^OUT = .*#OUT = r"${B}${B}build"#' resolve_stills.py`)],
  [true, () => sh(`sed -E -i "s/${B}[x${B}]/y/" a.js`)],
  [true, () => sh(`bash -c "node -v; printf 'a${B}n' > x.js"`)],
  [true, () => sh(`"C:/Program Files/Git/usr/bin/bash.exe" -lc 'echo ok ${B}t'`)],
  [true, () => sh(`printf 'const re = /a${B}.b/;\\n' > src/x.js`)],
  [true, () => sh(`echo "s = 'C:${B}x'" >> f.py`)],
  [true, () => sh(`awk '{gsub(/${B}./,"")}1' a.txt > b.txt`)],
  [true, () => sh(`perl -pi -e 's/a${B}d/b/' f.js`)],
  [false, () => sh(`node - <<'EOF'\nconsole.log(1)\nEOF`)],
  [false, () => sh(`node -e "console.log(process.version)"`)],
  [false, () => sh(`grep -n "FIELDS${B}|chat_prompts" tests/a.mjs | head`)],
  [false, () => sh(`sed -n 30,48p a.mjs; grep -n "a${B}|b" c.md`)],
  [false, () => sh(`sed -i 's/a/b/' f.txt`)],
  [false, () => sh(`npm test ${B}\n  --maxWorkers=2`)],
  [false, () => sh(`node scripts/run.mjs "C:${B}Users${B}x"`)],
  [false, () => sh(`python scripts/run.py -c "C:${B}cfg.ini"`)],
  [false, () => sh(`echo "a${B}tb"`)],
  [false, () => sh(`printf '%s${B}n' a b | head 2>/dev/null`)],
  [false, () => sh(`awk -F'${B}t' '{print $1}' f.tsv | sort | head`)],
  [true, () => ps(`node -e "console.log('a${B}nb')"`)],
  [true, () => ps(`& "C:${B}Program Files${B}nodejs${B}node.exe" -e "x('a${B}b')"`)],
  [true, () => ps(`@'\nconst re = /${B}d+/;\n'@ | Set-Content x.js`)],
  [true, () => ps(`@"\nprint('C:${B}x')\n"@ | python -`)],
  [true, () => ps(`(Get-Content a.js) -replace 'a${B}.b','c' | Set-Content a.js`)],
  [false, () => ps(`Get-ChildItem C:${B}Users${B}x`)],
  [false, () => ps(`node tools/qa.mjs 2>&1 | ForEach-Object { $_ -replace ',"urls":${B}[[^${B}]]*${B}]','' }`)],
  [false, () => ps(`pwsh -NoProfile -File 'C:${B}Temp${B}clean.ps1'`)],
  [false, () => ps(`tool.cmd --json | py -c "import sys,json; print(json.load(sys.stdin))"; Get-Item C:${B}x`)],
  [false, () => sh(`node -e "console.log(1)" && ls C:${B}${B}x`)],
  [false, () => ps(`& "C:${B}Program Files${B}nodejs${B}node.exe" scripts${B}a.mjs`)],
  [false, () => ps(`git commit -m @'\nmsg\n'@`)],
  [false, () => ps(`$p = "D:${B}Data"; Set-Content -Path "$p${B}a.txt" -Value 1`)],
  [true, () => wr(`${TMP}patch.py`, `s=open(p).read()\ns=s.replace("a${B}n","b")\nopen(p,'w').write(s)\n`)],
  [true, () => wr('/tmp/edit.mjs', `import { readFileSync, writeFileSync } from 'node:fs';\nlet s = readFileSync(f, 'utf8');\ns = s.replace('a${B}${B}b', 'c');\nwriteFileSync(f, s);\n`)],
  [true, () => wr(`D:${B}p${B}state${B}patch_panel.py`, `s=open(p).read()\ns=s.replace("a${B}d","b")\nopen(p,'w').write(s)\n`)],
  [false, () => wr(`D:${B}p${B}src${B}util.js`, `const s = readFileSync(f, 'utf8').replace(/${B}r/g, '');\nwriteFileSync(f, s);\n`)],
  [false, () => wr(`${TMP}scan.py`, `import re\nPAT = re.compile(r"${B}d+")\nprint(PAT.findall(open(p).read()))\n`)],
  [false, () => wr(`${TMP}patch.py`, `s=open(p).read()\ns=s.replace("a","b")\nopen(p,'w').write(s)\n`)],
  [false, () => wr(`${TMP}notes.md`, `s.replace("a${B}n") writeFileSync`)],

  // Claude Code: PostToolUse syntax checks
  [true, () => postClaude('bad.js', `const s = 'a${B}';\n`)],
  [true, () => postClaude('bad.mjs', `const re = /a(/;\n`)],
  [true, () => postClaude('bad.json', `{"a": "C:${B}x"}`)],
  [true, () => postClaude('bad.py', `s = "a${B}"\n`)],
  [false, () => postClaude('ok.js', `const s = 'a${B}${B}';\n`)],
  [false, () => postClaude('ok.json', `{"a": "C:${B}${B}x"}`)],
  [false, () => postClaude('ok.py', `s = "a${B}${B}"\n`)],
  [false, () => postClaude('tsconfig.json', `{ // comment\n "a": 1 }`)],
  [false, () => postClaude('App.js', `export default () => <div>hi</div>;\n`)],
  [false, () => postClaude('readme.md', `a${B}`)],

  // Claude Code: Read & anti-bloat shell guards
  [true, () => rd(bigFile)],
  [false, () => rd(bigFile, { offset: 1, limit: 200 })],
  [false, () => rd(smallFile)],
  [false, () => rd(bigImg)],
  [true, () => sh(`cat "${bigFile}"`)],
  [false, () => sh(`cat "${smallFile}"`)],
  [true, () => sh(`grep -rn "foo" src/`)],
  [true, () => sh(`rg "foo" src/`)],
  [false, () => sh(`rg -l "foo" src/`)],
  [true, () => ps(`Get-Content "${bigFile}"`)],
  [false, () => ps(`Get-Content "${bigFile}" -TotalCount 20`)],

  // Antigravity protocol: read_file, write_file, run_command & PostToolUse
  ['deny', () => preAgy('read_file', { Path: bigFile }).decision],
  ['ask', () => preAgy('read_file', { Path: bigFile, StartLine: 1, EndLine: 200 }).decision],
  ['ask', () => preAgy('read_file', { Path: smallFile }).decision],
  ['ask', () => preAgy('read_file', { Path: bigImg }).decision],
  ['deny', () => preAgy('run_command', { CommandLine: `cat "${bigFile}"` }).decision],
  ['deny', () => preAgy('run_command', { CommandLine: `Get-Content "${bigFile}"` }).decision],
  ['deny', () => preAgy('run_command', { CommandLine: `rg "foo" src/` }).decision],
  ['deny', () => preAgy('run_command', { CommandLine: `python -c "print('a${B}nb')"` }).decision],
  ['ask', () => preAgy('run_command', { CommandLine: 'git status' }).decision],
  ['deny', () => preAgy('write_file', { Path: `${TMP}patch.py`, Content: `s=open(p).read()\ns=s.replace("a${B}n","b")\nopen(p,'w').write(s)\n` }).decision],
  ['ask', () => preAgy('write_file', { Path: `${TMP}notes.md`, Content: 'ok\n' }).decision],
  ['{}', () => runHook({ toolCall: { name: 'run_command', args: { CommandLine: 'git status' } }, stepIdx: 2 }, ['--post'])],

  // CLI check mode
  [0, () => spawnSync(exe, ['check', 'node', '-v'], { encoding: 'utf8' }).status],
  [true, () => {
    const r = spawnSync(exe, ['check', 'node', failScript], { encoding: 'utf8' });
    return r.status !== 0 && r.stdout.includes('FAIL exit=') && r.stdout.includes('boom error here');
  }],

  // CLI setup mode (isolated temp profile + desktop presets + antigravity hooks)
  [true, () => {
    const h = spawnSync(exe, ['setup', '--help'], { encoding: 'utf8' });
    return h.status === 0 && h.stdout.includes('--dry-run');
  }],
  [true, () => {
    const setupRoot = join(dir, 'setup-test');
    const profile = join(setupRoot, 'claude-profile');
    const desktopFile = join(setupRoot, 'ccd-session-presets.json');
    const agyFile = join(setupRoot, 'agy-hooks.json');
    const claudeJson = join(setupRoot, 'claude.json');
    mkdirSync(profile, { recursive: true });

    const origSettings = {
      env: { KEEP_ME: '42' },
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo start' }] }],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /old/no-inline-backslash.mjs' }] },
          { matcher: 'Read', hooks: [{ type: 'command', command: '"~/.claude/hooks/claude-guard.exe"' }] },
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'custom-other-hook' }] },
        ],
      },
    };
    const origClaudeMd = '# Existing Profile Rules\nKeep this section intact.\n\n<!-- claude-guard:start -->\nold block\n<!-- claude-guard:end -->\n';
    const origDesktop = {
      byAccount: {
        acct1: {
          presets: [{ name: 'dev', settings: { modelId: 'claude-opus-5-5', effort: 'max', cwd: '/proj', worktree: true } }],
          builtIns: { local: { settings: { modelId: 'claude-opus-5-5', effort: 'low' } } },
        },
      },
    };
    const origAgy = { 'other-hook': { PreToolUse: [] }, 'claude-guard': { PreToolUse: [] } };
    const origClaudeJson = { mcpServers: { a: {}, b: {}, c: {} } };

    writeFileSync(join(profile, 'settings.json'), JSON.stringify(origSettings, null, 2));
    writeFileSync(join(profile, 'CLAUDE.md'), origClaudeMd);
    writeFileSync(desktopFile, JSON.stringify(origDesktop, null, 2));
    writeFileSync(agyFile, JSON.stringify(origAgy, null, 2));
    writeFileSync(claudeJson, JSON.stringify(origClaudeJson, null, 2));

    const commonArgs = [
      'setup',
      '--profile', profile,
      '--with-rules',
      '--desktop', '--desktop-file', desktopFile,
      '--antigravity', '--agy-file', agyFile,
      '--claude-json', claudeJson,
      '--hook-cmd', 'test-ctxkit',
      '--skip-version-check',
    ];

    // 1) --dry-run must not mutate any files
    const dry = spawnSync(exe, [...commonArgs, '--dry-run'], { encoding: 'utf8' });
    if (dry.status !== 0) return false;
    if (existsSync(join(profile, 'agents', 'Explore.md'))) return false;
    if (readFileSync(join(profile, 'CLAUDE.md'), 'utf8') !== origClaudeMd) return false;
    if (JSON.parse(readFileSync(desktopFile, 'utf8')).byAccount.acct1.presets[0].settings.modelId !== 'claude-opus-5-5') return false;
    if (JSON.parse(readFileSync(agyFile, 'utf8'))['ctxkit']) return false;

    // 2) Real run updates configs, creates backups & agents, preserves custom keys
    const run1 = spawnSync(exe, commonArgs, { encoding: 'utf8' });
    if (run1.status !== 0) return false;

    const s1 = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    if (s1.model !== 'sonnet' || s1.advisorModel !== 'fable' || s1.effortLevel !== 'high') return false;
    if (s1.env?.KEEP_ME !== '42' || s1.env?.CLAUDE_CODE_SUBAGENT_MODEL !== 'haiku') return false;
    if (!Array.isArray(s1.hooks?.SessionStart) || s1.hooks.SessionStart.length !== 1) return false;
    const preCmds = s1.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    if (!preCmds.includes('test-ctxkit') || !preCmds.includes('custom-other-hook')) return false;
    if (preCmds.some((c) => c.includes('no-inline-backslash') || c.includes('claude-guard'))) return false;

    const backups1 = readdirSync(join(profile, 'backups'));
    if (!backups1.some((f) => f.startsWith('settings.json.') && f.endsWith('.bak'))) return false;
    if (!backups1.some((f) => f.startsWith('CLAUDE.md.') && f.endsWith('.bak'))) return false;

    const exploreMd = readFileSync(join(profile, 'agents', 'Explore.md'), 'utf8');
    const checkerMd = readFileSync(join(profile, 'agents', 'checker.md'), 'utf8');
    if (!exploreMd.includes('model: haiku') || !checkerMd.includes('model: opus')) return false;

    const claudeMd1 = readFileSync(join(profile, 'CLAUDE.md'), 'utf8');
    if (!claudeMd1.includes('# Existing Profile Rules') || !claudeMd1.includes('<!-- ctxkit:start -->') || claudeMd1.includes('<!-- claude-guard:start -->')) return false;

    const desk1 = JSON.parse(readFileSync(desktopFile, 'utf8'));
    const p1 = desk1.byAccount.acct1.presets[0].settings;
    if (p1.modelId !== 'claude-sonnet-5-5' || p1.effort !== 'high' || p1.cwd !== '/proj' || p1.worktree !== true) return false;
    if (desk1.byAccount.acct1.builtIns.local.settings.modelId !== 'claude-sonnet-5-5') return false;

    const agy1 = JSON.parse(readFileSync(agyFile, 'utf8'));
    if (!agy1['other-hook'] || agy1['claude-guard'] || agy1['ctxkit']?.PreToolUse?.[0]?.hooks?.[0]?.command !== 'test-ctxkit') return false;

    if (!run1.stdout.includes('3 global MCP servers')) return false;

    // 3) Second run must be idempotent (same files, no extra backups)
    const run2 = spawnSync(exe, commonArgs, { encoding: 'utf8' });
    if (run2.status !== 0) return false;
    if (readFileSync(join(profile, 'CLAUDE.md'), 'utf8') !== claudeMd1) return false;
    if (readdirSync(join(profile, 'backups')).length !== backups1.length) return false;
    if (s1.env?.CTXKIT_LANG !== undefined) return false;

    // 4) --lang ru sets CTXKIT_LANG=ru and switches templates to Russian
    const runRu = spawnSync(exe, [...commonArgs, '--lang', 'ru', '--force-agents'], { encoding: 'utf8' });
    if (runRu.status !== 0) return false;
    const sRu = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    if (sRu.env?.CTXKIT_LANG !== 'ru') return false;
    if (!readFileSync(join(profile, 'CLAUDE.md'), 'utf8').includes('Команда моделей')) return false;
    if (!readFileSync(join(profile, 'agents', 'Explore.md'), 'utf8').includes('исследователь')) return false;
    return true;
  }],

  // Localization (default en vs CTXKIT_LANG=ru / --lang ru)
  [true, () => runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bigFile } }).includes('File is large')],
  [true, () => runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bigFile } }, [], { CTXKIT_LANG: 'ru' }).includes('Файл большой')],
  [true, () => runHook({ toolCall: { name: 'run_command', args: { CommandLine: `python -c "print('a${B}nb')"` } }, stepIdx: 1 }, ['--lang', 'ru']).includes('Так обратные слеши теряются')],
];

let failed = 0;
try {
  cases.forEach(([want, check], i) => {
    const got = check();
    if (got !== want) {
      failed++;
      console.log(`FAIL #${i + 1} (wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}): ${check.toString().slice(0, 180)}`);
    }
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `${failed} of ${cases.length} FAILED` : `ALL ${cases.length} PASSED`);
process.exit(failed ? 1 : 0);
