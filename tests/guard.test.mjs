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

// Fixtures for the review-regression block below
const hugeFile = join(dir, 'huge.ts');
writeFileSync(hugeFile, Array.from({ length: 20000 }, (_, i) => `export const y${i} = ${i}; // pad`).join('\n'));
const wideFile = join(dir, 'wide.txt');
writeFileSync(wideFile, Array.from({ length: 400 }, () => 'x'.repeat(500)).join('\n'));
mkdirSync(join(dir, 'sp ace'));
const spacedBig = join(dir, 'sp ace', 'big file.ts');
writeFileSync(spacedBig, readFileSync(bigFile));
mkdirSync(join(dir, '.vscode'));
writeFileSync(join(dir, '.vscode', 'settings.json'), '{ // comment\n "a": 1 }');
mkdirSync(join(dir, '.devcontainer'));
writeFileSync(join(dir, '.devcontainer', 'devcontainer.json'), '// comment\n{ "a": 1 }');
const postPath = (file_path, cwd = dir) =>
  spawnSync(exe, [], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path } }),
    encoding: 'utf8',
    cwd,
  }).stdout;

const cases = [
  // Regressions from the independent review: read-guard bounds
  [true, () => rd(hugeFile, { offset: 6000, limit: 100000 })],
  [false, () => rd(hugeFile, { offset: 6000, limit: 400 })],
  [false, () => rd(hugeFile, { offset: 19800, limit: 5000 })],
  [true, () => rd(hugeFile, { offset: 19000, limit: 5000 })],
  [true, () => rd(hugeFile, { offset: 19800 })],
  [true, () => rd(wideFile)],
  [true, () => rd(wideFile, { offset: 1 })],
  ['deny', () => preAgy('read_file', { Path: hugeFile, StartLine: 6000, EndLine: 20000 }).decision],
  // ...shell inspection
  [false, () => sh('grep foo docs/user-manager.txt')],
  [false, () => sh('grep -n error src/foo-parser.ts')],
  [false, () => sh('grep --color=auto foo file.txt')],
  [false, () => sh('rg --version')],
  [false, () => sh('rg --files')],
  [true, () => sh('grep -R foo .')],
  [true, () => sh('grep -rn foo .')],
  [false, () => sh('rg -m5 foo src/')],
  [false, () => sh(`rg foo "${smallFile}"`)],
  ['ask', () => preAgy('run_command', { CommandLine: `rg foo "${smallFile}"` }).decision],
  [true, () => ps('rg foo src/')],
  [true, () => ps(`cat "${bigFile}"`)],
  [true, () => ps(`Get-Content -Raw "${bigFile}"`)],
  [false, () => ps(`Get-Content "${bigFile}" -TotalCount 20`)],
  [true, () => sh(`cat "${spacedBig}"`)],
  // ...interpreter flags that are not inline code
  [false, () => sh(`node -c C:${B}proj${B}a.js`)],
  [false, () => sh(`perl -c C:${B}x${B}s.pl`)],
  [false, () => sh(`ruby -c C:${B}x${B}s.rb`)],
  [false, () => sh(`python -E C:${B}x${B}run.py`)],
  [false, () => sh(`bash -e C:${B}x${B}s.sh`)],
  [true, () => sh(`node --eval='console.log("a${B}nb")'`)],
  [true, () => sh(`python -W ignore -c 'print("a${B}nb")'`)],
  [true, () => sh(`php -r 'echo "a${B}n";'`)],
  [true, () => sh(`perl -ne 'print if /a${B}d/' f.txt`)],
  // ...throwaway-script names need a word end
  [false, () => wr(`D:${B}proj${B}src${B}report.js`, `fs.writeFileSync(p, s.replace(/${B}r${B}n/g, '${B}n'))`)],
  [false, () => wr(`D:${B}proj${B}src${B}fixtures.js`, `fs.writeFileSync(p, s.replace(/${B}r${B}n/g, '${B}n'))`)],
  [true, () => wr(`D:${B}proj${B}src${B}fix-2.js`, `fs.writeFileSync(p, s.replace(/${B}r${B}n/g, '${B}n'))`)],
  // ...redirects: quotes, descriptors
  [false, () => sh(`printf "a -> b${B}n"`)],
  [false, () => sh(`echo "Done => C:${B}out${B}file.txt"`)],
  [false, () => sh(`awk -F'${B}t' '$3 > 100 {print $1}' data.tsv`)],
  [true, () => sh(`echo 'a${B}nb' 1> out.txt`)],
  [true, () => sh(`echo 'a${B}nb' &> out.txt`)],
  [false, () => sh(`echo 'a${B}nb' 2> err.txt`)],
  // ...heredoc tags, sed -i forms, $(...) boundaries, -creplace
  [true, () => sh(`cat > f.py <<'END-TAG'\nx='${B}n'\nEND-TAG`)],
  [true, () => sh(`cat > f.py <<${B}EOF\nx='${B}n'\nEOF`)],
  [true, () => sh(`python - <<'EOF'\nprint('a${B}nb')`)],
  [true, () => sh(`sed -ie 's/a${B}.b/c/' f.txt`)],
  [false, () => sh(`echo $(sed -n 's/${B}./,/p' a.txt) $(grep -i foo b.txt)`)],
  [true, () => ps(`(gc f.txt) -creplace '${B}s+',' ' | Set-Content f.txt`)],
  [false, () => ps(`$c = (Get-Content C:${B}a.txt) -replace 'x','y'; Set-Content C:${B}a.txt $c`)],
  // ...PostToolUse: missing files, JSONC locations, readable Python error
  ['', () => postPath(join(dir, 'missing.py'))],
  ['', () => postPath(join(dir, 'missing.js'))],
  ['', () => postPath(join(dir, '.devcontainer', 'devcontainer.json'))],
  ['', () => postPath('.vscode/settings.json')],
  [true, () => {
    writeFileSync(join(dir, 'syntax.py'), 'def f(:\n    pass\n');
    const out = postPath(join(dir, 'syntax.py'));
    return out.includes('"block"') && out.includes('line 1') && !out.includes('Traceback');
  }],
  // ...a UTF-8 BOM before the payload must not bypass the hook
  [true, () => spawnSync(exe, [], {
    input: '﻿' + JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `python -c "print('a${B}nb')"` } }),
    encoding: 'utf8',
  }).stdout.includes('"deny"')],


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
  // -i of a later command in the chain is not sed's flag
  [false, () => sh(`sed -n 1,5p a.md; grep -n -i -B2 "a${B}|b" c.md`)],
  [false, () => sh(`sed -n 1,5p a.md | grep -i "a${B}|b"`)],
  [true, () => sh(`sed 's|a${B}.b;c|d|' -i f.txt`)],
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

  // DeepSeek Harness (dsh-hooks-claude-code bridge): Claude protocol with DSH tool names
  [true, () => preClaude('read', { file_path: bigFile })],
  [false, () => preClaude('read', { file_path: bigFile, offset: 1, limit: 200 })],
  [true, () => preClaude('pwsh', { command: `Get-Content "${bigFile}"` })],
  [true, () => preClaude('bash', { command: `python -c "print('a${B}nb')"` })],
  [true, () => preClaude('write', { file_path: `${TMP}patch.py`, content: `s=open(p).read()\ns=s.replace("a${B}n","b")\nopen(p,'w').write(s)\n` })],
  ['', () => runHook({ hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'git status' } }, ['--dsh'])],
  [true, () => {
    const out = runHook({ hook_event_name: 'PreToolUse', tool_name: 'read', tool_input: { file_path: bigFile } }, ['--dsh', '--lang', 'ru']);
    const reason = JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
    return reason.includes('через read с offset и limit') && !reason.includes('Explore');
  }],
  [true, () => {
    const file_path = join(dir, 'dsh-broken.json');
    writeFileSync(file_path, '{"a": }');
    const out = runHook({ hook_event_name: 'PostToolUse', tool_name: 'edit', tool_input: { file_path } });
    return JSON.parse(out).decision === 'block' && out.includes('with edit:');
  }],

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
    const origAgyMcp = { mcpServers: { m1: {}, m2: {}, m3: {}, m4: {}, off: { disabled: true } } };
    mkdirSync(join(setupRoot, 'plugins', 'p1', 'rules'), { recursive: true });
    mkdirSync(join(setupRoot, 'plugins', 'p2'), { recursive: true });
    writeFileSync(join(setupRoot, 'plugins', 'p1', 'plugin.json'), '{}');
    writeFileSync(join(setupRoot, 'plugins', 'p1', 'mcp_config.json'), JSON.stringify({ mcpServers: { ps1: {} } }));
    writeFileSync(join(setupRoot, 'plugins', 'p1', 'rules', 'AGENTS.md'), '# p1 rules\n');
    writeFileSync(join(setupRoot, 'plugins', 'p2', 'plugin.json'), '{}');
    writeFileSync(join(setupRoot, 'config.json'), JSON.stringify({ plugins: { p2: { enabled: false } } }));

    writeFileSync(join(profile, 'settings.json'), JSON.stringify(origSettings, null, 2));
    writeFileSync(join(profile, 'CLAUDE.md'), origClaudeMd);
    writeFileSync(desktopFile, JSON.stringify(origDesktop, null, 2));
    writeFileSync(agyFile, JSON.stringify(origAgy, null, 2));
    writeFileSync(join(setupRoot, 'mcp_config.json'), JSON.stringify(origAgyMcp, null, 2));
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
    if (!run1.stdout.includes('Antigravity Diagnostics:')) return false;
    if (!run1.stdout.includes('1 global plugin(s) enabled (p1)')) return false;
    if (!run1.stdout.includes('5 active global MCP servers (4 in mcp_config.json [m1, m2, m3, m4], 1 in plugins [p1/ps1])')) return false;

    // 3) Second run must be idempotent (same files, no extra backups)
    const run2 = spawnSync(exe, commonArgs, { encoding: 'utf8' });
    if (run2.status !== 0) return false;
    if (readFileSync(join(profile, 'CLAUDE.md'), 'utf8') !== claudeMd1) return false;
    if (readdirSync(join(profile, 'backups')).length !== backups1.length) return false;
    if (s1.env?.CTXKIT_LANG !== undefined) return false;

    // 4) --lang ru sets CTXKIT_LANG=ru, switches templates, and appends --lang ru to default Antigravity hook
    const runRu = spawnSync(exe, [...commonArgs, '--lang', 'ru', '--force-agents'], { encoding: 'utf8' });
    if (runRu.status !== 0) return false;
    const sRu = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    if (sRu.env?.CTXKIT_LANG !== 'ru') return false;
    if (!readFileSync(join(profile, 'CLAUDE.md'), 'utf8').includes('Команда моделей')) return false;
    if (!readFileSync(join(profile, 'agents', 'Explore.md'), 'utf8').includes('исследователь')) return false;

    const agyRuDir = join(setupRoot, 'agy-ru');
    mkdirSync(agyRuDir, { recursive: true });
    const agyRuFile = join(agyRuDir, 'hooks.json');
    writeFileSync(agyRuFile, '{}');
    const runAgyRu = spawnSync(exe, [
      'setup',
      '--profile', profile,
      '--no-agents',
      '--antigravity', '--agy-file', agyRuFile,
      '--claude-json', claudeJson,
      '--skip-version-check',
      '--lang', 'ru',
    ], { encoding: 'utf8' });
    if (runAgyRu.status !== 0) return false;
    const agyRu = JSON.parse(readFileSync(agyRuFile, 'utf8'));
    const agyRuCmd = agyRu['ctxkit']?.PreToolUse?.[0]?.hooks?.[0]?.command || '';
    if (!agyRuCmd.endsWith(' --lang ru')) return false;
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
