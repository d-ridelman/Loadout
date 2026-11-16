import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_NAME = process.platform === 'win32' ? 'ctxkit.exe' : 'ctxkit';
// ctxkit лежит в воркспейсе Loadout (crates/ctxkit): сборка — в target корня репозитория
const exe = process.env.CTXKIT_BIN || join(ROOT, '..', '..', 'target', 'release', BIN_NAME);

if (!existsSync(exe)) {
  console.error(`Binary not found: ${exe}. Run \`cargo build --release\` first.`);
  process.exit(2);
}

// Hooks and `ctxkit check` read <profile>/ctxkit.json: no run may reach the real ~/.claude, so every child
// gets an empty profile (a case that needs policies passes its own CLAUDE_CONFIG_DIR).
const isoProfile = mkdtempSync(join(tmpdir(), 'cg-prof-'));
process.env.CLAUDE_CONFIG_DIR = isoProfile;

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

// Stop gate: a transcript whose last turn edits two code files, optionally followed by checker
// ...in a profile that has the checker agent and an advisor, only one of them, or neither
const gateProfile = (kind) => {
  const p = join(dir, `gate-profile-${kind}`);
  if (!existsSync(p)) {
    mkdirSync(join(p, 'agents'), { recursive: true });
    if (kind === 'both' || kind === 'checker') writeFileSync(join(p, 'agents', 'checker.md'), 'x');
    writeFileSync(join(p, 'settings.json'), JSON.stringify(kind === 'both' || kind === 'advisor' ? { advisorModel: 'fable' } : {}));
  }
  return p;
};
const stopGate = ({ checker = false, active = false, env = {}, profile = 'both' } = {}) => {
  const edit = (p) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: p } }] } });
  const rows = [{ type: 'user', message: { content: 'go' } }, edit('/p/a.rs'), edit('/p/b.rs')];
  if (checker) rows.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'checker' } }] } });
  const transcript_path = join(dir, 'turn.jsonl');
  writeFileSync(transcript_path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return runHook({ hook_event_name: 'Stop', transcript_path, stop_hook_active: active }, [], { CLAUDE_CONFIG_DIR: gateProfile(profile), ...env });
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

const fewLongLines = join(dir, 'few-long.txt');
writeFileSync(fewLongLines, Array.from({ length: 10 }, () => 'x'.repeat(30000)).join('\n'));
const midFile = join(dir, 'mid.txt');
writeFileSync(midFile, Array.from({ length: 100 }, () => 'x'.repeat(300)).join('\n'));

// Policies (ctxkit.json): a profile with the given config; `pol` runs a hook against it and returns the decision
const polProfile = (name, cfg) => {
  const p = join(dir, `pol-${name}`);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'ctxkit.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  return p;
};
const decisionOf = (out) => {
  if (out === '') return '';
  const j = JSON.parse(out); // exactly one JSON document on stdout
  return j.hookSpecificOutput?.permissionDecision ?? j.decision;
};
const pol = (profile, tool_name, tool_input, { args = [], env = {}, cwd } = {}) =>
  decisionOf(runHook({ hook_event_name: 'PreToolUse', tool_name, tool_input, ...(cwd ? { cwd } : {}) }, args, { CLAUDE_CONFIG_DIR: profile, ...env }));
const polReason = (profile, tool_name, tool_input, extra = {}) => {
  const out = runHook({ hook_event_name: 'PreToolUse', tool_name, tool_input }, extra.args ?? [], { CLAUDE_CONFIG_DIR: profile, ...(extra.env ?? {}) });
  const j = JSON.parse(out);
  return j.hookSpecificOutput?.permissionDecisionReason ?? j.reason;
};
const P = (name, policies, extra = {}) => polProfile(name, { policies, ...extra });
const COAUTH = 'git commit -m "fix: x" -m "Co-Authored-By: Claude <c@x>"';

const cases = [
  // Policy commit_hygiene
  [true, () => {
    const on = P('commit', { commit_hygiene: true });
    if (pol(on, 'Bash', { command: COAUTH }) !== 'deny') return 'deny expected';
    if (pol(on, 'PowerShell', { command: "git commit -m @'\nfix\n\nCo-Authored-By: x\n'@" }) !== 'deny') return 'ps here-string';
    if (pol(on, 'Bash', { command: "git commit -m \"$(cat <<'EOF'\nfix \"q\"\n\nGenerated with Claude Code\nEOF\n)\"" }) !== 'deny') return 'heredoc';
    if (pol(on, 'Bash', { command: 'git commit -m "fix: clean"' }) !== '') return 'clean commit must pass silently';
    if (pol(on, 'Bash', { command: 'git commit --amend --no-edit' }) !== '') return 'amend --no-edit';
    if (pol(on, 'Bash', { command: 'git log --grep "Co-Authored-By"' }) !== '') return 'git log';
    if (!polReason(on, 'Bash', { command: COAUTH }).includes('Remove those lines')) return 'en text';
    if (!polReason(on, 'Bash', { command: COAUTH }, { env: { CTXKIT_LANG: 'ru' } }).includes('Убери эти строки из сообщения коммита')) return 'ru text';
    // the other clients: DeepSeek Harness tool names, Antigravity run_command
    if (pol(on, 'bash', { command: COAUTH }, { args: ['--dsh'] }) !== 'deny') return 'dsh';
    const agy = JSON.parse(runHook({ toolCall: { name: 'run_command', args: { CommandLine: COAUTH } }, stepIdx: 1 }, ['--agy'], { CLAUDE_CONFIG_DIR: on }));
    if (agy.decision !== 'deny' || !agy.reason.includes('Remove those lines')) return 'agy';
    return true;
  }],
  // ...off by default, and a missing or broken ctxkit.json also means off
  [true, () => {
    if (pol(isoProfile, 'Bash', { command: COAUTH }) !== '') return 'no file';
    if (pol(P('commit-off', { commit_hygiene: false }), 'Bash', { command: COAUTH }) !== '') return 'off';
    if (pol(polProfile('commit-broken', '{"policies":'), 'Bash', { command: COAUTH }) !== '') return 'broken json';
    if (pol(P('commit-badtype', { commit_hygiene: 'yes' }), 'Bash', { command: COAUTH }) !== '') return 'bad type';
    if (pol(P('commit', { commit_hygiene: true }), 'Bash', { command: COAUTH }, { env: { CTXKIT_GUARD: '0' } }) !== '') return 'CTXKIT_GUARD=0';
    const agyOff = JSON.parse(runHook({ toolCall: { name: 'run_command', args: { CommandLine: COAUTH } }, stepIdx: 1 }, ['--agy'], { CLAUDE_CONFIG_DIR: isoProfile }));
    return agyOff.decision === 'ask' && agyOff.reason === undefined;
  }],

  // Second review pass: redirect detection must survive escapes and odd quotes
  [true, () => sh(`echo "C:${B}${B}dir${B}${B}" > f.txt`)],
  [true, () => sh(`printf 'it'${B}''s a${B}n' > f.txt`)],
  [true, () => sh(`echo ${B}"a${B}nb${B}" > f.txt`)],
  [true, () => sh(`echo "a${B}nb" >| f.txt`)],
  [true, () => ps(`@'\nit's C:${B}x\n'@ > f.txt`)],
  [true, () => ps(`$p = "C:${B}dir${B}"; @'\nC:${B}x\n'@ > f.txt`)],
  [true, () => sh(`awk '{print "a${B}tb" > "out.txt"}' in.txt`)],
  // ...recursive grep: flags and paths are tokens, not substrings
  [true, () => sh('grep -r -h foo .')],
  [true, () => sh('rg -tcpp foo')],
  [true, () => sh('rg -thtml foo')],
  [true, () => sh(`grep -rn foo . "${smallFile}"`)],
  [true, () => sh(`rg foo . "${smallFile}"`)],
  [true, () => sh('rg "a -l b" srcdir')],
  [false, () => sh('grep -n "x -r y" srcdir')],
  [false, () => sh(`rg foo "${spacedBig}"`)],
  [false, () => sh('rg -h')],
  // ...inline code after clustered or valued options
  [true, () => sh(`bash -ce "print('a${B}nb')"`)],
  [true, () => sh(`bash -o pipefail -c "printf 'a${B}n'"`)],
  [true, () => sh(`node -r ts-node/register -e "console.log('a${B}n')"`)],
  [true, () => sh(`pwsh -NoProfile -ExecutionPolicy Bypass -Command "Write-Host 'a${B}b'"`)],
  [false, () => sh(`python -O scripts${B}run.py`)],
  // ...heredoc detection: <<<, << inside a heredoc body, << inside quotes
  [false, () => sh(`cat <<< "hello"\nls C:${B}x`)],
  [false, () => sh(`cat > a.cpp <<'EOF'\nint main(){ std::cout << "Hi"; }\nEOF\ng++ a.cpp -o C:${B}tmp${B}a.exe`)],
  [false, () => sh(`node -e 'x = a <<"b"'\nls C:${B}x`)],
  // ...throwaway names, -replace with quoted `;`, sed with an escaped paren
  [true, () => wr(`D:${B}proj${B}scripts${B}replace_paths.py`, `fs.writeFileSync(p, s.replace(/${B}r${B}n/g, '${B}n'))`)],
  [true, () => wr(`D:${B}proj${B}scripts${B}fixPaths.js`, `fs.writeFileSync(p, s.replace(/${B}r${B}n/g, '${B}n'))`)],
  [true, () => wr(`D:${B}proj${B}scripts${B}patches.py`, `fs.writeFileSync(p, s.replace(/${B}r${B}n/g, '${B}n'))`)],
  [false, () => wr(`D:${B}proj${B}src${B}repo.ts`, `fs.writeFileSync(p, s.replace(/${B}r${B}n/g, '${B}n'))`)],
  [true, () => ps(`(gc f) -replace 'a;b','C:${B}x' | Set-Content f`)],
  [true, () => sh(`sed -E s/${B}(a${B})/b/ -i f`)],
  // ...a tail slice is judged by bytes as well as lines
  [true, () => rd(fewLongLines, { offset: 2, limit: 1000 })],
  [true, () => rd(midFile, { offset: 2 })],
  [true, () => rd(midFile)],
  [false, () => rd(midFile, { offset: 50 })],
  ['deny', () => preAgy('read_file', { Path: fewLongLines, StartLine: 2, EndLine: 1000 }).decision],
  [true, () => ps(`Get-Content -Encoding utf8 "${bigFile}"`)],
  [true, () => {
    writeFileSync(join(dir, 'nul.py'), 'x = 1\0\n');
    const out = postPath(join(dir, 'nul.py'));
    return out.includes('"block"') && !out.includes('line None');
  }],

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
  // any other .json is tried as JSONC (comments, trailing commas) before it is blocked
  [false, () => postClaude('turbo.json', `{\n  // tasks\n  "tasks": { "build": {}, },\n  /* end */\n}\n`)],
  [false, () => postClaude('biome.json', `{ "a": [1, 2,], // trailing\n}`)],
  [true, () => postClaude('broken-comments.json', `{ // c\n  "a": 1\n  "b": 2 }`)],
  [true, () => postClaude('bad-escape.json', `{"a": "C:${B}x" // c\n}`)],
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

  // Chained command tests in shell_read_guard
  [true, () => sh(`git status && cat "${bigFile}"`)],
  [true, () => sh(`echo ok; cat "${bigFile}"`)],
  [true, () => sh(`echo ok\ncat "${bigFile}"`)],
  [true, () => sh(`true && rg foo src/`)],
  [true, () => ps(`Write-Host 'hi'; Get-Content "${bigFile}"`)],
  [true, () => ps(`git status && cat "${bigFile}"`)],

  // Antigravity protocol: read_file, write_file, edit_file, run_command & PostToolUse
  ['deny', () => preAgy('read_file', { Path: bigFile }).decision],
  ['ask', () => preAgy('read_file', { Path: bigFile, StartLine: 1, EndLine: 200 }).decision],
  ['ask', () => preAgy('read_file', { Path: smallFile }).decision],
  ['ask', () => preAgy('read_file', { Path: bigImg }).decision],
  ['deny', () => preAgy('read_file', { Path: bigFile, StartLine: 500, EndLine: 100 }).decision],
  ['deny', () => preAgy('run_command', { CommandLine: `cat "${bigFile}"` }).decision],
  ['deny', () => preAgy('run_command', { CommandLine: `Get-Content "${bigFile}"` }).decision],
  ['deny', () => preAgy('run_command', { CommandLine: `rg "foo" src/` }).decision],
  ['deny', () => preAgy('run_command', { CommandLine: `python -c "print('a${B}nb')"` }).decision],
  ['ask', () => preAgy('run_command', { CommandLine: 'git status' }).decision],
  ['deny', () => preAgy('write_file', { Path: `${TMP}patch.py`, Content: `s=open(p).read()\ns=s.replace("a${B}n","b")\nopen(p,'w').write(s)\n` }).decision],
  ['ask', () => preAgy('write_file', { Path: `${TMP}notes.md`, Content: 'ok\n' }).decision],
  ['deny', () => preAgy('edit_file', { Path: `${TMP}patch.py`, Replacement: `s=s.replace("a${B}n","b")\nopen(p,'w').write(s)\n` }).decision],
  ['ask', () => preAgy('edit_file', { Path: `${TMP}notes.md`, Replacement: 'ok\n' }).decision],
  ['{}', () => runHook({ toolCall: { name: 'run_command', args: { CommandLine: 'git status' } }, stepIdx: 2 }, ['--post'])],

  // DeepSeek Harness (dsh-hooks-claude-code bridge): Claude protocol with DSH tool names
  [true, () => preClaude('read', { file_path: bigFile })],
  [false, () => preClaude('read', { file_path: bigFile, offset: 1, limit: 200 })],
  [true, () => preClaude('pwsh', { command: `Get-Content "${bigFile}"` })],
  [true, () => preClaude('bash', { command: `python -c "print('a${B}nb')"` })],
  [true, () => preClaude('write', { file_path: `${TMP}patch.py`, content: `s=open(p).read()\ns=s.replace("a${B}n","b")\nopen(p,'w').write(s)\n` })],
  [true, () => preClaude('apply_patch', { input: `*** Begin Patch\n*** Add File: ${TMP}patch.py\n+s=open(p).read()\n+s=s.replace("a${B}n","b")\n+open(p,'w').write(s)\n` })],
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
  [true, () => {
    const brokenJs = join(dir, 'dsh-patch-broken.js');
    writeFileSync(brokenJs, 'function broken( {');
    const out = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'apply_patch',
      tool_input: { input: `*** Begin Patch\n*** Update File: ${brokenJs}\n` },
    });
    return JSON.parse(out).decision === 'block' && out.includes('with apply_patch:');
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
      '--main-model', 'sonnet', '--advisor', 'fable', '--effort', 'high', // models are written only with explicit flags
      '--skip-version-check',
    ];

    // 1) --dry-run must not mutate any files
    const dry = spawnSync(exe, [...commonArgs, '--dry-run'], { encoding: 'utf8' });
    if (dry.status !== 0) return false;
    if (existsSync(join(profile, 'agents', 'Explore.md'))) return false;
    if (readFileSync(join(profile, 'CLAUDE.md'), 'utf8') !== origClaudeMd) return false;
    if (JSON.parse(readFileSync(desktopFile, 'utf8')).byAccount.acct1.presets[0].settings.modelId !== 'claude-opus-5-5') return false;
    if (JSON.parse(readFileSync(agyFile, 'utf8'))['ctxkit']) return false;
    // the preview says what will change (was -> became), the same lines as the real run
    for (const line of ['  model: (unset) -> sonnet', '  advisorModel: (unset) -> fable', '  effortLevel: (unset) -> high', '  effort modelSettings.claude-sonnet-5-5: (unset) -> high', '  desktop preset dev: model claude-opus-5-5 -> claude-sonnet-5-5, effort max -> high', '  desktop preset built-in local: model claude-opus-5-5 -> claude-sonnet-5-5, effort low -> high']) {
      if (!dry.stdout.includes(line)) return `dry-run lacks: ${line}`;
    }

    // 2) Real run updates configs, creates backups & agents, preserves custom keys
    const run1 = spawnSync(exe, commonArgs, { encoding: 'utf8' });
    if (run1.status !== 0) return false;

    const s1 = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    if (s1.model !== 'sonnet' || s1.advisorModel !== 'fable' || s1.effortLevel !== 'high') return false;
    if (s1.env?.KEEP_ME !== '42' || s1.env?.CLAUDE_CODE_SUBAGENT_MODEL !== undefined) return false; // env only with --subagent
    if (s1.modelSettings?.['claude-sonnet-5-5']?.effortLevel !== 'high') return false;
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
    if (!agy1['other-hook'] || agy1['claude-guard'] || agy1['ctxkit']?.PreToolUse?.[0]?.hooks?.[0]?.command !== 'test-ctxkit --agy') return false; // a custom --hook-cmd gets --agy appended

    if (!run1.stdout.includes('3 global MCP servers')) return false;
    if (!run1.stdout.includes('Antigravity Diagnostics:')) return false;
    if (!run1.stdout.includes('1 global plugin(s) enabled (p1)')) return false;
    if (!run1.stdout.includes('5 active global MCP servers (4 in mcp_config.json [m1, m2, m3, m4], 1 in plugins [p1/ps1])')) return false;

    // 3) Second run must be idempotent (same files, no extra backups)
    const run2 = spawnSync(exe, commonArgs, { encoding: 'utf8' });
    if (run2.status !== 0) return false;
    for (const line of ['  model: sonnet (unchanged)', '  advisorModel: fable (unchanged)', '  desktop preset dev: model claude-sonnet-5-5 (unchanged), effort high (unchanged)']) {
      if (!run2.stdout.includes(line)) return `second run lacks: ${line}`;
    }
    if (!run1.stdout.includes('  desktop preset dev: model claude-opus-5-5 -> claude-sonnet-5-5, effort max -> high')) return false;
    // CLAUDE_CODE_SUBAGENT_MODEL=haiku: a [warn] without --subagent, the value stays; with --subagent it is shown as a change
    const haikuProfile = join(setupRoot, 'haiku-profile');
    mkdirSync(haikuProfile, { recursive: true });
    writeFileSync(join(haikuProfile, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } }));
    const haikuArgs = ['setup', '--profile', haikuProfile, '--no-agents', '--hook-cmd', 'test-ctxkit', '--skip-version-check', '--claude-json', claudeJson];
    const warn = spawnSync(exe, haikuArgs, { encoding: 'utf8' });
    if (!warn.stdout.includes('[warn] env.CLAUDE_CODE_SUBAGENT_MODEL=haiku') || JSON.parse(readFileSync(join(haikuProfile, 'settings.json'), 'utf8')).env.CLAUDE_CODE_SUBAGENT_MODEL !== 'haiku') return false;
    const noWarn = spawnSync(exe, [...haikuArgs, '--subagent', 'sonnet'], { encoding: 'utf8' });
    if (!noWarn.stdout.includes('  env.CLAUDE_CODE_SUBAGENT_MODEL: haiku -> sonnet') || noWarn.stdout.includes('[warn] env.CLAUDE_CODE_SUBAGENT_MODEL')) return false;
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

  // setup --uninstall: only ours goes, foreign hooks/keys/text stay, a second run changes nothing
  [true, () => {
    const root = join(dir, 'uninstall-test');
    const profile = join(root, 'profile');
    const agyFile = join(root, 'agy-hooks.json');
    const dshHome = join(root, 'dsh');
    const claudeJson = join(root, 'claude.json');
    const presets = join(root, 'ccd-session-presets.json');
    mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true });
    mkdirSync(profile, { recursive: true });
    const foreignStop = { type: 'command', command: 'node C:/tools/ctxkit-helper/stop.js' };
    const origSettings = {
      model: 'opus',
      KEEP_ME: { a: 1 },
      env: { KEEP_ME: '42' },
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo start' }] }],
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'custom-other-hook' }, { type: 'command', command: 'C:/tools/logger.exe ctxkit' }] }],
        Stop: [{ hooks: [foreignStop] }],
      },
    };
    const origMd = '# My own rules\nKeep this.\n';
    const origPatch = '- keep: 1\n';
    const origAgy = { 'other-hook': { PreToolUse: [] } };
    writeFileSync(join(profile, 'settings.json'), JSON.stringify(origSettings, null, 2));
    writeFileSync(join(profile, 'CLAUDE.md'), origMd);
    writeFileSync(join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), origPatch);
    writeFileSync(join(dshHome, 'AGENTS.md'), '# dsh rules\n');
    writeFileSync(agyFile, JSON.stringify(origAgy, null, 2));
    writeFileSync(claudeJson, '{}');
    writeFileSync(presets, JSON.stringify({ byAccount: { a: { presets: [{ name: 'dev', settings: { modelId: 'claude-opus-5-5', effort: 'low' } }] } } }));

    const common = ['--profile', profile, '--claude-json', claudeJson, '--antigravity', '--agy-file', agyFile, '--dsh', '--dsh-home', dshHome, '--desktop-file', presets, '--lang', 'ru'];
    const hookBin = join(profile, 'hooks', BIN_NAME);
    const setupRun = spawnSync(exe, ['setup', '--with-rules', '--desktop', '--skip-version-check', ...common], { encoding: 'utf8' });
    if (setupRun.status !== 0 || !existsSync(hookBin)) return false;
    const afterSetup = {
      s: readFileSync(join(profile, 'settings.json'), 'utf8'),
      md: readFileSync(join(profile, 'CLAUDE.md'), 'utf8'),
      patch: readFileSync(join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'),
    };
    if (!afterSetup.md.includes('<!-- ctxkit:start -->') || !afterSetup.patch.includes('ctxkit-hooks') || !existsSync(join(dshHome, 'ctxkit-hooks.json'))) return false;
    const state = () => [join(profile, 'settings.json'), join(profile, 'CLAUDE.md'), agyFile, join(dshHome, 'AGENTS.md'), join(dshHome, 'ctxkit-hooks.json'), join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), hookBin]
      .map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : null)).join('\u0000');
    const before = state();

    // dry-run: nothing changes, no backups appear
    const nBackups = () => (existsSync(join(profile, 'backups')) ? readdirSync(join(profile, 'backups')).length : 0);
    const nb0 = nBackups();
    const dry = spawnSync(exe, ['setup', '--uninstall', '--dry-run', ...common], { encoding: 'utf8' });
    if (dry.status !== 0 || state() !== before || nBackups() !== nb0) return false;

    // setup-only flags are refused, nothing changes
    const bad = spawnSync(exe, ['setup', '--uninstall', '--no-agents', ...common], { encoding: 'utf8' });
    if (bad.status !== 2 || state() !== before) return false;

    const run = spawnSync(exe, ['setup', '--uninstall', ...common], { encoding: 'utf8' });
    if (run.status !== 0) return false;
    const s = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    const cmds = (ev) => (s.hooks?.[ev] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    if (s.KEEP_ME?.a !== 1 || s.env?.KEEP_ME !== '42' || s.env?.CTXKIT_LANG !== undefined) return false;
    if (JSON.stringify(cmds('PreToolUse')) !== '["custom-other-hook","C:/tools/logger.exe ctxkit"]' || cmds('PostToolUse').length !== 0) return false;
    if (JSON.stringify(cmds('Stop')) !== JSON.stringify([foreignStop.command]) || cmds('SessionStart')[0] !== 'echo start') return false;
    // setup without model flags kept the user's own 'opus'; uninstall does not touch it either and only prints it
    if (s.model !== 'opus' || !run.stdout.includes('model: "opus"') || !run.stdout.includes('latest:')) return false;
    if (!setupRun.stdout.includes('  model: opus (kept; pass --main-model sonnet to set)') || s.advisorModel !== undefined || s.effortLevel !== undefined) return false;
    if (!run.stdout.includes('desktop preset dev: model "claude-sonnet-5-5", effort "low"')) return false; // preset effort kept without --effort
    if (readFileSync(join(profile, 'CLAUDE.md'), 'utf8') !== origMd) return false;
    if (existsSync(hookBin) || !existsSync(join(profile, 'agents', 'checker.md'))) return false; // binary gone, agents stay
    const agy = JSON.parse(readFileSync(agyFile, 'utf8'));
    if (agy.ctxkit || !agy['other-hook']) return false;
    if (existsSync(join(dshHome, 'ctxkit-hooks.json'))) return false;
    if (readFileSync(join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8') !== origPatch) return false;
    if (readFileSync(join(dshHome, 'AGENTS.md'), 'utf8') !== '# dsh rules\n') return false;

    // a second uninstall changes nothing and makes no backup
    const after = state();
    const nb1 = nBackups();
    const again = spawnSync(exe, ['setup', '--uninstall', ...common], { encoding: 'utf8' });
    return again.status === 0 && state() === after && nBackups() === nb1;
  }],

  // Data safety: the user's own text that mentions our markers survives, and a settings.json setup cannot
  // handle (or a CLAUDE.md that is not UTF-8) is refused before anything is copied or written
  [true, () => {
    const root = join(dir, 'datasafe-test');
    const mk = (name) => {
      const profile = join(root, name);
      mkdirSync(profile, { recursive: true });
      return profile;
    };
    const run = (profile, ...a) => spawnSync(exe, ['setup', '--profile', profile, '--claude-json', join(root, 'c.json'), '--skip-version-check', ...a], { encoding: 'utf8' });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'c.json'), '{}');
    const hash =(f) => (existsSync(f) ? readFileSync(f).toString('hex') : 'none');
    // a refused setup leaves no copied binary, no settings.json and no backup in the profile
    const untouched = (profile) => !existsSync(join(profile, 'hooks')) && !existsSync(join(profile, 'settings.json')) && !existsSync(join(profile, 'backups'));

    // markers mentioned inside the user's own sentences
    const p1 = mk('prose');
    const prose = '# Rules\nNote: after <!-- ctxkit:start --> marker.\nIMPORTANT 1\nIMPORTANT 2\nMarkers are <!-- ctxkit:start --> and <!-- ctxkit:end -->, do not edit.\n';
    writeFileSync(join(p1, 'CLAUDE.md'), prose);
    if (run(p1, '--with-rules').status !== 0) return false;
    const once = readFileSync(join(p1, 'CLAUDE.md'), 'utf8');
    if (!once.startsWith(prose.trimEnd()) || !once.includes('\n<!-- ctxkit:start -->\n')) return false;
    if (run(p1, '--with-rules').status !== 0 || readFileSync(join(p1, 'CLAUDE.md'), 'utf8') !== once) return false;
    if (run(p1, '--uninstall').status !== 0 || readFileSync(join(p1, 'CLAUDE.md'), 'utf8') !== prose) return false;

    // hooks.<event> that is not an array: setup refuses, nothing is copied or changed
    const p2 = mk('badevent');
    const bad = '{"hooks":{"PreToolUse":{"x":1}},"model":"opus"}';
    writeFileSync(join(p2, 'settings.json'), bad);
    const r2 = run(p2, '--with-rules');
    if (r2.status !== 1 || readFileSync(join(p2, 'settings.json'), 'utf8') !== bad || existsSync(join(p2, 'hooks')) || existsSync(join(p2, 'CLAUDE.md'))) return false;

    // the rollback refuses the same structure and keeps the binary
    const p3 = mk('baduninstall');
    if (run(p3).status !== 0 || !existsSync(join(p3, 'hooks', BIN_NAME))) return false;
    writeFileSync(join(p3, 'settings.json'), '{"hooks":{"Stop":"s"}}');
    const r3 = run(p3, '--uninstall');
    if (r3.status !== 1 || !existsSync(join(p3, 'hooks', BIN_NAME)) || readFileSync(join(p3, 'settings.json'), 'utf8') !== '{"hooks":{"Stop":"s"}}') return false;

    // setup refuses unreadable input before copying the binary or rewriting settings.json
    const p5 = mk('setuprefuse');
    writeFileSync(join(p5, 'CLAUDE.md'), Buffer.from([0xff, 0xfe, 0x41, 0x80]));
    writeFileSync(join(p5, 'settings.json'), '{"model":"opus"}');
    const r5 = run(p5, '--with-rules');
    if (r5.status !== 1 || existsSync(join(p5, 'hooks')) || existsSync(join(p5, 'backups')) || readFileSync(join(p5, 'settings.json'), 'utf8') !== '{"model":"opus"}') return false;
    const p6 = mk('setuprefuse2');
    const agyBad = join(root, 'agy-bad.json');
    writeFileSync(agyBad, '[1]');
    const r6 = run(p6, '--antigravity', '--agy-file', agyBad);
    if (r6.status !== 1 || existsSync(join(p6, 'hooks')) || existsSync(join(p6, 'settings.json'))) return false;
    const p7 = mk('setuprefuse3');
    writeFileSync(join(p7, 'settings.json'), '{"modelSettings":{"claude-sonnet-5-5":"x"}}');
    if (run(p7, '--effort', 'high').status !== 1 || existsSync(join(p7, 'hooks'))) return false;

    // a start marker without an end (or a doubled block, left by an older setup): setup refuses with the file path,
    // before anything is copied or written, instead of adding a second block; the rollback still removes whole blocks
    const p8 = mk('lonemarker');
    const loneText = 'keep1\n<!-- ctxkit:start -->\nkeep2 no end\n';
    writeFileSync(join(p8, 'CLAUDE.md'), loneText);
    const r8 = run(p8, '--with-rules');
    if (r8.status !== 1 || !untouched(p8) || readFileSync(join(p8, 'CLAUDE.md'), 'utf8') !== loneText || !r8.stderr.includes(join(p8, 'CLAUDE.md'))) return `lone marker: ${r8.status} ${r8.stderr}`;
    const p8b = mk('doubledblock');
    const blockText = '<!-- ctxkit:start -->\nrules\n<!-- ctxkit:end -->\n';
    const doubled = `# Mine\n\n${blockText}\n${blockText}`;
    writeFileSync(join(p8b, 'CLAUDE.md'), doubled);
    const r8b = run(p8b, '--with-rules');
    if (r8b.status !== 1 || !untouched(p8b) || readFileSync(join(p8b, 'CLAUDE.md'), 'utf8') !== doubled) return `doubled block: ${r8b.status} ${r8b.stderr}`;
    const u8b = run(p8b, '--uninstall');
    if (u8b.status !== 0 || readFileSync(join(p8b, 'CLAUDE.md'), 'utf8').includes('ctxkit:')) return `uninstall of a doubled block: ${u8b.status} ${u8b.stdout}`;
    const doctor8 = spawnSync(exe, ['doctor', '--profile', p8, '--lang', 'en'], { encoding: 'utf8' });
    if (!doctor8.stdout.includes('rules_markers') || !doctor8.stdout.includes(join(p8, 'CLAUDE.md'))) return `doctor: ${doctor8.stdout}`;
    const p9 = mk('bom');
    run(p9, '--with-rules');
    const withBlock = readFileSync(join(p9, 'CLAUDE.md'), 'utf8');
    writeFileSync(join(p9, 'CLAUDE.md'), '﻿' + withBlock + '\nuser tail\n');
    if (run(p9, '--with-rules').status !== 0) return false;
    const bomText = readFileSync(join(p9, 'CLAUDE.md'), 'utf8');
    if (bomText.split('<!-- ctxkit:start -->').length !== 2 || !bomText.includes('user tail')) return false;

    // the preflight covers the Desktop presets file and the DeepSeek Harness files too: a refusal happens
    // before the binary is copied, settings.json is written or any backup is made
    const p11 = mk('badpresets');
    const badPresets = join(root, 'presets-bad.json');
    writeFileSync(badPresets, '{ broken');
    const r11 = run(p11, '--desktop', '--desktop-file', badPresets);
    if (r11.status !== 1 || !untouched(p11) || readFileSync(badPresets, 'utf8') !== '{ broken') return `presets: ${r11.status} ${r11.stderr}`;
    const dshCase = (name, patch, hooksJson) => {
      const home = join(root, `dsh-${name}`);
      mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true });
      if (patch !== null) writeFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), patch);
      if (hooksJson !== null) writeFileSync(join(home, 'ctxkit-hooks.json'), hooksJson);
      const profile = mk(`dsh-${name}-profile`);
      const r = run(profile, '--dsh', '--dsh-home', home);
      const patchAfter = existsSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml')) ? readFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8') : null;
      return { r, profile, patchAfter, hooksAfter: existsSync(join(home, 'ctxkit-hooks.json')) ? readFileSync(join(home, 'ctxkit-hooks.json'), 'utf8') : null };
    };
    const half = dshCase('half', '- keep: 1\n# >>> ctxkit (managed by `ctxkit setup --dsh`; do not edit) >>>\n- insert: x\n', null);
    if (half.r.status !== 1 || !untouched(half.profile) || half.hooksAfter !== null || !half.r.stderr.includes('no end marker')) return `half block: ${half.r.status} ${half.r.stderr}`;
    const mapping = dshCase('mapping', 'key: value\n', null);
    if (mapping.r.status !== 1 || !untouched(mapping.profile) || mapping.hooksAfter !== null || mapping.patchAfter !== 'key: value\n') return `mapping: ${mapping.r.status} ${mapping.r.stderr}`;
    const badHooks = dshCase('badhooks', '- keep: 1\n', '[1]');
    if (badHooks.r.status !== 1 || !untouched(badHooks.profile) || badHooks.hooksAfter !== '[1]' || badHooks.patchAfter !== '- keep: 1\n') return `hooks json: ${badHooks.r.status} ${badHooks.r.stderr}`;
    // no patch file yet: setup creates it; a dry run of the same is a preview, not an error
    const fresh = dshCase('fresh', null, null);
    if (fresh.r.status !== 0 || !existsSync(join(fresh.profile, 'hooks')) || fresh.patchAfter === null || !fresh.patchAfter.includes('ctxkit-hooks')) return `fresh dsh: ${fresh.r.status} ${fresh.r.stderr}`;
    const dryHome = join(root, 'dsh-dry');
    mkdirSync(join(dryHome, 'profiles', 'desktop'), { recursive: true });
    const dryRun = run(mk('dsh-dry-profile'), '--dsh', '--dsh-home', dryHome, '--dry-run');
    if (dryRun.status !== 0 || existsSync(join(dryHome, 'ctxkit-hooks.json'))) return `dsh dry run: ${dryRun.status} ${dryRun.stderr}`;

    // a rollback that makes the only backup does not also claim there are none
    const p10 = mk('nobackups');
    writeFileSync(join(p10, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '"C:/x/ctxkit.exe"' }] }] } }));
    const r10 = run(p10, '--uninstall');
    if (r10.status !== 0 || !r10.stdout.includes('backup ->') || r10.stdout.includes('no settings.json backups found')) return `uninstall output contradicts itself: ${r10.stdout}`;
    if (!r10.stdout.includes('latest:') || !r10.stdout.includes('made by this run')) return `no latest backup line: ${r10.stdout}`;

    // a CLAUDE.md that is not UTF-8 stops the rollback before settings.json is rewritten
    const p4 = mk('nonutf8');
    if (run(p4, '--with-rules').status !== 0) return false;
    writeFileSync(join(p4, 'CLAUDE.md'), Buffer.from([0xff, 0xfe, 0x41, 0x80]));
    const sBefore = hash(join(p4, 'settings.json'));
    const r4 = run(p4, '--uninstall');
    return r4.status === 1 && hash(join(p4, 'settings.json')) === sBefore && existsSync(join(p4, 'hooks', BIN_NAME));
  }],

  // The rollback gives the user's files back byte for byte (CRLF, a missing final newline, an empty "hooks": {},
  // the key order), and removes the files setup created instead of leaving an empty CLAUDE.md or a `{}`
  [true, () => {
    const root = join(dir, 'bytes-test');
    mkdirSync(root, { recursive: true });
    const cj = join(root, 'c.json');
    writeFileSync(cj, '{}');
    let n = 0;
    const mk = () => {
      const p = join(root, `p${n++}`);
      mkdirSync(p, { recursive: true });
      return p;
    };
    const run = (p, ...a) => spawnSync(exe, ['setup', '--profile', p, '--claude-json', cj, '--skip-version-check', ...a], { encoding: 'utf8' });
    const hex = (f) => (existsSync(f) ? readFileSync(f).toString('hex') : null);
    const hexOf = (s) => Buffer.from(s).toString('hex');

    // 1) odd user files survive a setup and the rollback unchanged
    const settingsOdd = '{\r\n    "zeta": 1,\r\n    "model": "opus",\r\n  "hooks": {}\r\n}';
    for (const md of ['# Mine\r\nkeep\r\n', 'no final newline', 'two blank\r\n\r\n\r\n', '# LF only\n', '', '﻿# bom\r\nx\r\n']) {
      const p = mk();
      writeFileSync(join(p, 'CLAUDE.md'), md);
      writeFileSync(join(p, 'settings.json'), settingsOdd);
      if (run(p, '--with-rules').status !== 0 || readFileSync(join(p, 'CLAUDE.md'), 'utf8') === md) return `setup on ${JSON.stringify(md)}`;
      const u = run(p, '--uninstall');
      if (u.status !== 0) return `uninstall on ${JSON.stringify(md)}: ${u.stderr}`;
      if (hex(join(p, 'CLAUDE.md')) !== hexOf(md)) return `CLAUDE.md not restored byte for byte: ${JSON.stringify(md)} -> ${JSON.stringify(readFileSync(join(p, 'CLAUDE.md'), 'utf8'))}`;
      if (hex(join(p, 'settings.json')) !== hexOf(settingsOdd)) return `settings.json not restored byte for byte: ${JSON.stringify(readFileSync(join(p, 'settings.json'), 'utf8'))}`;
    }
    // a user's own `{}` stays a file with `{}`
    const pe = mk();
    writeFileSync(join(pe, 'settings.json'), '{}');
    run(pe);
    run(pe, '--uninstall');
    if (hex(join(pe, 'settings.json')) !== hexOf('{}')) return 'a user {} was not kept';

    // 2) files setup created are deleted, also when a second setup run backed them up in between
    const pc = mk();
    if (run(pc, '--with-rules').status !== 0 || !existsSync(join(pc, 'settings.json')) || !existsSync(join(pc, 'CLAUDE.md'))) return 'setup made no files';
    if (run(pc, '--with-rules', '--lang', 'ru').status !== 0) return 'second setup';
    const uc = run(pc, '--uninstall');
    if (uc.status !== 0 || existsSync(join(pc, 'settings.json')) || existsSync(join(pc, 'CLAUDE.md'))) return `created files are left: ${uc.stdout}`;
    if (run(pc, '--uninstall').status !== 0) return 'a second rollback failed';

    // 3) when the user changed the file after setup there is nothing exact to restore: what they changed stays
    const pm = mk();
    writeFileSync(join(pm, 'settings.json'), '{"model":"opus"}');
    run(pm);
    const edited = JSON.parse(readFileSync(join(pm, 'settings.json'), 'utf8'));
    edited.model = 'sonnet';
    writeFileSync(join(pm, 'settings.json'), JSON.stringify(edited, null, 2));
    run(pm, '--uninstall');
    const kept = JSON.parse(readFileSync(join(pm, 'settings.json'), 'utf8'));
    if (kept.model !== 'sonnet' || kept.hooks !== undefined) return `edited settings: ${JSON.stringify(kept)}`;
    // ...and a CRLF CLAUDE.md keeps its line breaks all the way
    const pl = mk();
    writeFileSync(join(pl, 'CLAUDE.md'), '# Mine\r\nkeep\r\n');
    run(pl, '--with-rules');
    const withBlock = readFileSync(join(pl, 'CLAUDE.md'), 'utf8');
    if (/(^|[^\r])\n/.test(withBlock)) return `setup wrote a bare LF into a CRLF file: ${JSON.stringify(withBlock)}`;
    writeFileSync(join(pl, 'CLAUDE.md'), withBlock + 'extra\r\n');
    run(pl, '--uninstall');
    const crlf = readFileSync(join(pl, 'CLAUDE.md'), 'utf8');
    return !/(^|[^\r])\n/.test(crlf) && crlf.includes('extra') && !crlf.includes('ctxkit:') || `CRLF lost: ${JSON.stringify(crlf)}`;
  }],

  // Safe failure: broken or odd hook input is a silent pass (exit 0, empty stdout), never a block or a crash
  [true, () => {
    const raw = (input, args = [], env = {}) => {
      const r = spawnSync(exe, args, { input, env: { ...process.env, ...env }, maxBuffer: 1 << 20 });
      return { status: r.status, out: r.stdout?.toString() ?? '' };
    };
    const missing = join(dir, 'no-such-transcript.jsonl');
    const odd = [
      '', ' ', '{', '}', '{}', '[]', 'null', '42', '"str"', '\u0000',
      Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x80]),
      JSON.stringify({ hook_event_name: 'SessionStart' }),
      JSON.stringify({ hook_event_name: 5 }),
      JSON.stringify({ hook_event_name: 'PreToolUse' }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 5, tool_input: 'x' }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 5 } }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 5, offset: 'x', limit: [] } }),
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: null }),
      JSON.stringify({ hook_event_name: 'PostToolUse' }),
      JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 5 } }),
      JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(dir, 'no-such-file.json') } }),
      JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { input: 5 } }),
      JSON.stringify({ hook_event_name: 'Stop' }),
      JSON.stringify({ hook_event_name: 'Stop', transcript_path: 5, stop_hook_active: 'yes' }),
      JSON.stringify({ hook_event_name: 'Stop', transcript_path: missing }),
      JSON.stringify({ hook_event_name: 'Stop', transcript_path: dir }),
      '{"x":"' + 'a'.repeat(64 * 1024 * 1024 + 16) + '"}', // over the 64 MiB cap: passed unchecked
    ];
    for (const input of odd) {
      const r = raw(input);
      if (r.status !== 0 || r.out !== '') return `input ${JSON.stringify(String(input).slice(0, 60))}: status ${r.status} out ${r.out.slice(0, 80)}`;
    }
    // Antigravity form: exit 0 always (its own default is "ask", not a deny)
    for (const input of ['{"toolCall":5}', '{"toolCall":{"name":"read_file","args":5}}', '{"toolCall":{"name":7}}']) {
      const r = raw(input);
      if (r.status !== 0 || r.out.includes('deny')) return `agy ${input}`;
    }
    return true;
  }],
  // Antigravity wants a JSON answer every time (`decision` is required): in --agy mode a failure or the off switch
  // answers {"decision":"ask"} (PostToolUse: {}), never an empty stdout; Claude Code and DSH stay silent
  [true, () => {
    const raw = (input, args = [], env = {}) => {
      const r = spawnSync(exe, args, { input, env: { ...process.env, ...env }, maxBuffer: 1 << 20 });
      return { status: r.status, out: r.stdout?.toString() ?? '' };
    };
    const ASK = '{"decision":"ask"}';
    for (const input of ['', ' ', '{', 'null', '[]', Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x80]), '{"toolCall":5}', '{"toolCall":{"name":7}}']) {
      const r = raw(input, ['--agy']);
      if (r.status !== 0 || r.out !== ASK) return `--agy ${JSON.stringify(String(input).slice(0, 20))}: ${r.status} ${JSON.stringify(r.out)}`;
      const lang = raw(input, ['--agy', '--lang', 'ru']);
      if (lang.out !== ASK) return `--agy --lang ru ${JSON.stringify(String(input).slice(0, 20))}: ${JSON.stringify(lang.out)}`;
    }
    for (const input of ['', '{', Buffer.from([0xff, 0x80])]) {
      const r = raw(input, ['--agy', '--post']);
      if (r.out !== '{}') return `--agy --post ${JSON.stringify(String(input).slice(0, 20))}: ${JSON.stringify(r.out)}`;
      const plain = raw(input);
      if (plain.status !== 0 || plain.out !== '') return `no client flag must stay silent: ${JSON.stringify(plain.out)}`;
    }
    // the off switch: a read the guard would deny becomes "ask", with and without the flag (the payload names Antigravity)
    const read = JSON.stringify({ toolCall: { name: 'read_file', args: { Path: bigFile } }, stepIdx: 1 });
    if (!raw(read).out.includes('"deny"')) return 'the guard does not deny without the switch';
    for (const args of [[], ['--agy']]) {
      const off = raw(read, args, { CTXKIT_GUARD: 'off' });
      if (off.out !== ASK) return `CTXKIT_GUARD=off ${args}: ${JSON.stringify(off.out)}`;
    }
    const post = JSON.stringify({ toolCall: { name: 'run_command', args: {} }, error: 'exit status 1' });
    if (raw(post, [], { CTXKIT_GUARD: '0' }).out !== '{}') return 'post answer with the switch';
    // Claude Code stays silent with the switch
    const claude = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bigFile } });
    return raw(claude, [], { CTXKIT_GUARD: '0' }).out === '';
  }],
  // "onFailure": "continue" on our PreToolUse / PostToolUse hooks (a failing ctxkit never stops the work), not on Stop
  // (the docs: no effect there); the rollback still takes the hooks out, and a second setup does not stack them
  [true, () => {
    const root = join(dir, 'onfailure-test');
    mkdirSync(join(root, 'p'), { recursive: true });
    const cj = join(root, 'c.json');
    writeFileSync(cj, '{}');
    const profile = join(root, 'p');
    const run = (...a) => spawnSync(exe, ['setup', '--profile', profile, '--claude-json', cj, '--skip-version-check', '--no-agents', ...a], { encoding: 'utf8' });
    if (run().status !== 0 || run().status !== 0) return 'setup failed';
    const s = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    const ours = (ev) => (s.hooks?.[ev] ?? []).flatMap((g) => g.hooks).filter((h) => h.command.includes('ctxkit'));
    for (const ev of ['PreToolUse', 'PostToolUse']) {
      if (ours(ev).length !== 1 || ours(ev)[0].onFailure !== 'continue') return `${ev}: ${JSON.stringify(ours(ev))}`;
    }
    if (ours('Stop').length !== 1 || 'onFailure' in ours('Stop')[0]) return `Stop: ${JSON.stringify(ours('Stop'))}`;
    const u = spawnSync(exe, ['setup', '--uninstall', '--profile', profile, '--claude-json', cj], { encoding: 'utf8' });
    // settings.json was created by setup, so the rollback deletes it; either way no hooks are left
    const after = existsSync(join(profile, 'settings.json')) ? JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8')) : {};
    return u.status === 0 && after.hooks === undefined || `uninstall left hooks: ${JSON.stringify(after)}`;
  }],
  // The command setup writes for Antigravity carries the flag
  [true, () => {
    const root = join(dir, 'agy-cmd-test');
    mkdirSync(root, { recursive: true });
    const agyFile = join(root, 'hooks.json');
    const cj = join(root, 'c.json');
    writeFileSync(cj, '{}');
    const profile = join(root, 'p');
    mkdirSync(profile);
    const r = spawnSync(exe, ['setup', '--profile', profile, '--claude-json', cj, '--skip-version-check', '--no-agents', '--antigravity', '--agy-file', agyFile], { encoding: 'utf8' });
    const cmd = JSON.parse(readFileSync(agyFile, 'utf8')).ctxkit?.PreToolUse?.[0]?.hooks?.[0]?.command ?? '';
    return r.status === 0 && cmd.endsWith(' --agy') || `command: ${cmd} ${r.stderr}`;
  }],
  // CTXKIT_GUARD=0 mutes PreToolUse/PostToolUse (and only them)
  [true, () => {
    const bad = join(dir, 'guard-off.json');
    writeFileSync(bad, '{ broken');
    const withGuard = (payload, env) => runHook(payload, [], env);
    const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bigFile } };
    const post = { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: bad } };
    return withGuard(read, {}).includes('"deny"') && withGuard(post, {}).includes('"block"')
      && withGuard(read, { CTXKIT_GUARD: '0' }) === '' && withGuard(post, { CTXKIT_GUARD: '0' }) === ''
      && JSON.parse(stopGate({ env: { CTXKIT_GUARD: '0' } })).decision === 'block';
  }],

  // CTXKIT_GUARD and CTXKIT_GATE share one rule: trimmed, case-insensitive 0/off/false/no turn the hook off
  [true, () => {
    const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bigFile } };
    for (const v of ['0', ' 0 ', 'off', ' Off ', 'FALSE', 'No']) {
      if (runHook(read, [], { CTXKIT_GUARD: v }) !== '') return `GUARD=${JSON.stringify(v)} did not mute`;
      if (stopGate({ env: { CTXKIT_GATE: v } }) !== '') return `GATE=${JSON.stringify(v)} did not mute`;
    }
    for (const v of ['', '1', 'on', 'yes', 'of']) {
      if (!runHook(read, [], { CTXKIT_GUARD: v }).includes('"deny"')) return `GUARD=${JSON.stringify(v)} muted`;
      if (JSON.parse(stopGate({ env: { CTXKIT_GATE: v } })).decision !== 'block') return `GATE=${JSON.stringify(v)} muted`;
    }
    return true;
  }],

  // Localization (default en vs CTXKIT_LANG=ru / --lang ru)
  [true, () => runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bigFile } }).includes('File is large')],
  [true, () => runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bigFile } }, [], { CTXKIT_LANG: 'ru' }).includes('Файл большой')],
  [true, () => runHook({ toolCall: { name: 'run_command', args: { CommandLine: `python -c "print('a${B}nb')"` } }, stepIdx: 1 }, ['--lang', 'ru']).includes('Так обратные слеши теряются')],

  // Stop gate: blocks once, never twice in a row, never after checker, can be muted
  [true, () => JSON.parse(stopGate()).decision === 'block'],
  [true, () => stopGate({ env: { CTXKIT_LANG: 'ru' } }).includes('вызови агента `checker`')],
  [true, () => stopGate({ active: true }) === ''],
  [true, () => stopGate({ checker: true }) === ''],
  [true, () => stopGate({ env: { CTXKIT_GATE: '0' } }) === ''],
  // ...the message follows what is configured (--advisor none, no checker.md): never names a missing helper
  [true, () => {
    const only = (profile) => JSON.parse(stopGate({ profile })).reason;
    const c = only('checker');
    const a = only('advisor');
    if (!c.includes('`checker`') || c.includes('advisor')) return `checker-only: ${c}`;
    if (!a.includes('advisor') || a.includes('checker')) return `advisor-only: ${a}`;
    if (!only('both').includes('neither `checker` nor the advisor')) return 'both';
    return stopGate({ profile: 'none' }) === '' || 'nothing configured must not block';
  }],

  // Policies: `setup --policy` writes <profile>/ctxkit.json, nothing without the flag, rollback, broken file refused
  [true, () => {
    const profile = join(dir, 'policy-profile');
    mkdirSync(profile, { recursive: true });
    const base = ['setup', '--profile', profile, '--claude-json', join(dir, 'policy-claude.json'), '--hook-cmd', 'test-ctxkit', '--no-agents', '--skip-version-check'];
    const file = join(profile, 'ctxkit.json');
    const run = (...a) => spawnSync(exe, [...base, ...a], { encoding: 'utf8' });
    const plain = run();
    if (plain.status !== 0 || existsSync(file) || !plain.stdout.includes('policies: none (kept; pass --policy')) return 'no flag must not create the file';
    if (run('--policy', 'bogus').status !== 2) return 'unknown policy must exit 2';
    const dry = run('--policy', 'commit-hygiene,build-slots=2', '--dry-run');
    if (dry.status !== 0 || existsSync(file) || !dry.stdout.includes('policy commit_hygiene: off -> on') || !dry.stdout.includes('policy build_slots: off -> 2')) return `dry: ${dry.stdout}`;
    const on = run('--policy', 'commit-hygiene,build-slots=2');
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    if (on.status !== 0 || cfg.policies.commit_hygiene !== true || cfg.policies.build_slots !== 2 || cfg.created_by !== 'ctxkit setup') return `on: ${on.stdout}`;
    const off = run('--policy', 'none');
    if (off.status !== 0 || !off.stdout.includes('policy commit_hygiene: on -> off') || Object.keys(JSON.parse(readFileSync(file, 'utf8')).policies).length !== 0) return `off: ${off.stdout}`;
    // a broken file stops setup before anything else is written
    writeFileSync(file, '{"policies":{"commit_hygiene":"yes"}}');
    const settingsBefore = existsSync(join(profile, 'settings.json')) ? readFileSync(join(profile, 'settings.json'), 'utf8') : null;
    const refused = run('--policy', 'none');
    const settingsAfter = existsSync(join(profile, 'settings.json')) ? readFileSync(join(profile, 'settings.json'), 'utf8') : null;
    if (refused.status !== 1 || !refused.stderr.includes('ctxkit.json') || settingsBefore !== settingsAfter) return 'broken ctxkit.json must be refused untouched';
    // rollback: the file setup made is deleted; the owner's keys stay
    writeFileSync(file, JSON.stringify({ created_by: 'ctxkit setup', policies: { stray_files: true } }));
    const un = spawnSync(exe, ['setup', '--uninstall', '--profile', profile, '--claude-json', join(dir, 'policy-claude.json'), '--hook-cmd', 'test-ctxkit'], { encoding: 'utf8' });
    if (un.status !== 0 || existsSync(file)) return `uninstall: ${un.stdout}`;
    writeFileSync(file, JSON.stringify({ created_by: 'ctxkit setup', policies: { stray_files: true }, rules: ['my own rule of five words'] }));
    const un2 = spawnSync(exe, ['setup', '--uninstall', '--profile', profile, '--claude-json', join(dir, 'policy-claude.json'), '--hook-cmd', 'test-ctxkit'], { encoding: 'utf8' });
    const left = JSON.parse(readFileSync(file, 'utf8'));
    if (un2.status !== 0 || left.policies || left.created_by || left.rules?.[0] !== 'my own rule of five words' || !un2.stdout.includes('kept your keys: rules')) return `uninstall keeps: ${un2.stdout}`;
    return spawnSync(exe, ['setup', '--uninstall', '--policy', 'none', '--profile', profile], { encoding: 'utf8' }).status === 2;
  }],
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
  rmSync(isoProfile, { recursive: true, force: true });
}

console.log(failed ? `${failed} of ${cases.length} FAILED` : `ALL ${cases.length} PASSED`);
process.exit(failed ? 1 : 0);
