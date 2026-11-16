import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_NAME = process.platform === 'win32' ? 'context-toolkit.exe' : 'context-toolkit';
const OLD_BIN_NAME = process.platform === 'win32' ? 'ctxkit.exe' : 'ctxkit';
// Context Toolkit lives in the Loadout workspace (crates/context-toolkit): the build is in the repository root target
const exe = process.env.CONTEXT_TOOLKIT_BIN || process.env.CTXKIT_BIN || join(ROOT, '..', '..', 'target', 'release', BIN_NAME);
// Our variables (either name) from the session that runs the tests must reach no child: a case sets its own.
for (const k of Object.keys(process.env)) if (/^(CONTEXT_TOOLKIT|CTXKIT)_/i.test(k)) delete process.env[k];

if (!existsSync(exe)) {
  console.error(`Binary not found: ${exe}. Run \`cargo build --release\` first.`);
  process.exit(2);
}

// Hooks and `context-toolkit check` read <profile>/context-toolkit.json: no run may reach the real ~/.claude, so every child
// gets an empty profile (a case that needs policies passes its own CLAUDE_CONFIG_DIR).
const isoProfile = mkdtempSync(join(tmpdir(), 'cg-prof-'));
process.env.CLAUDE_CONFIG_DIR = isoProfile;

const B = '\\';
const runHook = (payload, extraArgs = [], extraEnv = {}) => {
  const env = { ...process.env, ...extraEnv };
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

// Policies (context-toolkit.json): a profile with the given config; `pol` runs a hook against it and returns the decision
const polProfile = (name, cfg) => {
  const p = join(dir, `pol-${name}`);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'context-toolkit.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
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
  const out = runHook({ hook_event_name: 'PreToolUse', tool_name, tool_input, ...(extra.cwd ? { cwd: extra.cwd } : {}) }, extra.args ?? [], { CLAUDE_CONFIG_DIR: profile, ...(extra.env ?? {}) });
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
    if (!polReason(on, 'Bash', { command: COAUTH }, { env: { CONTEXT_TOOLKIT_LANG: 'ru' } }).includes('Убери эти строки из сообщения коммита')) return 'ru text';
    // the other clients: DeepSeek Harness tool names, Antigravity run_command
    if (pol(on, 'bash', { command: COAUTH }, { args: ['--dsh'] }) !== 'deny') return 'dsh';
    const agy = JSON.parse(runHook({ toolCall: { name: 'run_command', args: { CommandLine: COAUTH } }, stepIdx: 1 }, ['--agy'], { CLAUDE_CONFIG_DIR: on }));
    if (agy.decision !== 'deny' || !agy.reason.includes('Remove those lines')) return 'agy';
    return true;
  }],
  // The policy file of the old name (ctxkit.json) is read while context-toolkit.json does not exist; the new file wins
  [true, () => {
    const p = join(dir, 'pol-oldname');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'ctxkit.json'), JSON.stringify({ policies: { commit_hygiene: true } }));
    if (pol(p, 'Bash', { command: COAUTH }) !== 'deny') return 'the old file is not read';
    writeFileSync(join(p, 'context-toolkit.json'), JSON.stringify({ policies: {} }));
    return pol(p, 'Bash', { command: COAUTH }) === '' || 'the new file must win';
  }],
  // ...off by default, and a missing or broken context-toolkit.json also means off
  [true, () => {
    if (pol(isoProfile, 'Bash', { command: COAUTH }) !== '') return 'no file';
    if (pol(P('commit-off', { commit_hygiene: false }), 'Bash', { command: COAUTH }) !== '') return 'off';
    if (pol(polProfile('commit-broken', '{"policies":'), 'Bash', { command: COAUTH }) !== '') return 'broken json';
    if (pol(P('commit-badtype', { commit_hygiene: 'yes' }), 'Bash', { command: COAUTH }) !== '') return 'bad type';
    if (pol(P('commit', { commit_hygiene: true }), 'Bash', { command: COAUTH }, { env: { CONTEXT_TOOLKIT_GUARD: '0' } }) !== '') return 'CONTEXT_TOOLKIT_GUARD=0';
    if (pol(P('commit', { commit_hygiene: true }), 'Bash', { command: COAUTH }, { env: { CTXKIT_GUARD: '0' } }) !== '') return 'old name CTXKIT_GUARD=0';
    const agyOff = JSON.parse(runHook({ toolCall: { name: 'run_command', args: { CommandLine: COAUTH } }, stepIdx: 1 }, ['--agy'], { CLAUDE_CONFIG_DIR: isoProfile }));
    return agyOff.decision === 'ask' && agyOff.reason === undefined;
  }],

  // Policy confirm_irreversible: "ask" for every client, a deny from commit_hygiene wins, one JSON on stdout
  [true, () => {
    const on = P('irrev', { confirm_irreversible: true });
    const ask = (tool, command, o = {}) => pol(on, tool, { command }, o);
    for (const c of ['git push', 'git push --force origin main', 'git reset --hard', 'git clean -fd', 'git branch -D x', 'git checkout -- .', 'git restore .', 'rm -rf build', 'rm -r -f build', 'cd a && git push']) {
      if (ask('Bash', c) !== 'ask') return `bash ask: ${c}`;
    }
    for (const c of ['Remove-Item C:\\x -Recurse -Force', 'Remove-Item C:\\', 'git push -f']) {
      if (ask('PowerShell', c) !== 'ask') return `ps ask: ${c}`;
    }
    for (const c of ['git status', 'git push --dry-run', 'git stash push', 'git restore --staged .', 'rm -r dir', 'echo "git push"', 'git commit -m "git push --force"']) {
      if (ask('Bash', c) !== '') return `bash quiet: ${c}`;
    }
    // cmd switches (`/q`, `/s`) are not drive roots in PowerShell, nor through Antigravity's both-shells pass
    for (const c of ['del /q file.txt', 'rd /s /q build', 'Remove-Item /f x']) {
      if (ask('PowerShell', c) !== '') return `ps quiet: ${c}`;
    }
    const agyQuiet = (CommandLine) => JSON.parse(runHook({ toolCall: { name: 'run_command', args: { CommandLine } }, stepIdx: 1 }, ['--agy'], { CLAUDE_CONFIG_DIR: on })).reason === undefined;
    if (!agyQuiet('del /q file.txt') || !agyQuiet('rd /s /q build') || !agyQuiet('Remove-Item /f x')) return 'agy quiet';
    const raw = JSON.parse(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force' } }, [], { CLAUDE_CONFIG_DIR: on }));
    if (raw.hookSpecificOutput.hookEventName !== 'PreToolUse' || raw.hookSpecificOutput.permissionDecision !== 'ask' || !raw.hookSpecificOutput.permissionDecisionReason.includes('git push --force')) return 'ask format';
    if (!polReason(on, 'Bash', { command: 'git reset --hard' }, { env: { CTXKIT_LANG: 'ru' } }).includes('Подтверди запуск')) return 'ru';
    if (ask('bash', 'git push', { args: ['--dsh'] }) !== 'ask' || ask('pwsh', 'Remove-Item x -Recurse -Force', { args: ['--dsh'] }) !== 'ask') return 'dsh';
    const agy = (CommandLine) => JSON.parse(runHook({ toolCall: { name: 'run_command', args: { CommandLine } }, stepIdx: 1 }, ['--agy'], { CLAUDE_CONFIG_DIR: on }));
    const a = agy('git push');
    if (a.decision !== 'ask' || !a.reason?.includes('git push') || agy('Remove-Item x -Recurse -Force').decision !== 'ask' || agy('ls').reason !== undefined) return 'agy';
    // deny (commit hygiene) beats ask, and only one answer is printed
    const both = P('both', { confirm_irreversible: true, commit_hygiene: true });
    if (pol(both, 'Bash', { command: 'git commit -m "Co-Authored-By: x" && git push' }) !== 'deny') return 'deny beats ask';
    // off by default; broken file; the emergency switch
    return pol(isoProfile, 'Bash', { command: 'git push' }) === '' && pol(polProfile('irrev-broken', '{'), 'Bash', { command: 'git push' }) === '' && pol(on, 'Bash', { command: 'git push' }, { env: { CTXKIT_GUARD: 'off' } }) === '';
  }],

  // Policy build_slots: three parallel `ctxkit check` runs, two slots; a killed holder frees its slot
  [true, () => {
    const root = join(dir, 'slots-test');
    const tmp = join(root, 'tmp');
    mkdirSync(tmp, { recursive: true });
    const worker = join(root, 'worker.mjs');
    writeFileSync(worker, [
      "import { writeFileSync, readdirSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const d = process.env.SLOT_TEST_DIR; mkdirSync(d, { recursive: true });',
      "const me = join(d, `run-${process.pid}`); writeFileSync(me, '');",
      "appendFileSync(join(d, 'seen.txt'), readdirSync(d).filter((f) => f.startsWith('run-')).length + '\\n');",
      'await new Promise((r) => setTimeout(r, Number(process.env.SLOT_HOLD_MS ?? 800)));',
      'rmSync(me, { force: true });',
    ].join('\n'));
    const driver = join(root, 'driver.mjs');
    writeFileSync(driver, [
      "import { spawn } from 'node:child_process';",
      'const [exe, worker, n] = process.argv.slice(2);',
      "const runs = Array.from({ length: +n }, () => new Promise((res) => { const c = spawn(exe, ['check', 'node', worker], { stdio: ['ignore', 'pipe', 'pipe'] }); let err = ''; let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d)); c.on('close', (code) => res({ code, err, out })); }));",
      'console.log(JSON.stringify(await Promise.all(runs)));',
    ].join('\n'));
    const env = (profile, extra = {}) => ({ ...process.env, CTXKIT_LANG: 'en', CLAUDE_CONFIG_DIR: profile, TMP: tmp, TEMP: tmp, TMPDIR: tmp, SLOT_TEST_DIR: join(root, 'seen'), ...extra });
    const slotsProfile = P('slots', { build_slots: 2 });
    const r = spawnSync('node', [driver, exe, worker, '3'], { encoding: 'utf8', env: env(slotsProfile) });
    if (r.status !== 0) return `driver: ${r.stderr}`;
    const runs = JSON.parse(r.stdout);
    if (!runs.every((x) => x.code === 0 && x.out.startsWith('OK'))) return `runs failed: ${r.stdout}`;
    const seen = readFileSync(join(root, 'seen', 'seen.txt'), 'utf8').trim().split('\n').map(Number);
    if (Math.max(...seen) !== 2) return `limit 2, saw ${seen}`;
    if (!runs.some((x) => x.err.includes('waiting for a build slot (2 busy)'))) return `no wait message: ${r.stdout}`;
    // the policy off: all three run together
    rmSync(join(root, 'seen'), { recursive: true, force: true });
    const free = spawnSync('node', [driver, exe, worker, '3'], { encoding: 'utf8', env: env(isoProfile) });
    const seenFree = readFileSync(join(root, 'seen', 'seen.txt'), 'utf8').trim().split('\n').map(Number);
    if (free.status !== 0 || Math.max(...seenFree) !== 3 || free.stdout.includes('waiting for a build slot')) return `off must not limit: ${seenFree}`;
    // a killed holder frees its slot: limit 1, the first run is killed while it holds it
    const one = P('slots-one', { build_slots: 1 });
    const killer = join(root, 'killer.mjs');
    writeFileSync(killer, [
      "import { spawn } from 'node:child_process'; import { existsSync, readdirSync } from 'node:fs'; import { join } from 'node:path';",
      'const [exe, worker, seen] = process.argv.slice(2);',
      "const first = spawn(exe, ['check', 'node', worker], { stdio: 'ignore', env: { ...process.env, SLOT_HOLD_MS: '6000' } });",
      "for (let i = 0; i < 100 && !(existsSync(seen) && readdirSync(seen).some((f) => f.startsWith('run-'))); i++) await new Promise((r) => setTimeout(r, 100));",
      'first.kill();',
      'const t0 = Date.now();',
      "const second = spawn(exe, ['check', 'node', worker], { stdio: 'ignore', env: { ...process.env, SLOT_HOLD_MS: '10' } });",
      "const code = await new Promise((res) => second.on('close', res));",
      'console.log(JSON.stringify({ code, ms: Date.now() - t0 }));',
    ].join('\n'));
    rmSync(join(root, 'seen'), { recursive: true, force: true });
    const k = spawnSync('node', [killer, exe, worker, join(root, 'seen')], { encoding: 'utf8', env: env(one), timeout: 60000 });
    if (!k.stdout) return `killed holder kept the slot (no answer in 60 s): ${k.stderr}`;
    const kr = JSON.parse(k.stdout);
    if (kr.code !== 0 || kr.ms > 5000) return `killed holder kept the slot: ${k.stdout}`;
    return true;
  }],

  // Policy stray_files: report-like files at the project root or the profile root are asked about
  [true, () => {
    const proj = join(dir, 'stray-proj');
    mkdirSync(join(proj, 'docs'), { recursive: true });
    const on = P('stray', { stray_files: true }, { stray_patterns: ['draft*.md'] });
    const w = (file_path, o = {}) => pol(on, o.tool ?? 'Write', { file_path, content: 'x' }, { cwd: proj, ...o });
    for (const f of ['report.md', 'Report-final.md', 'perf-analysis.md', 'summary.md', 'notes-1.md', 'x.tmp', 'cfg.bak', 'draft-1.md']) {
      if (w(join(proj, f)) !== 'ask') return `ask: ${f}`;
    }
    if (w('notes.md') !== 'ask') return 'relative path against cwd';
    if (w(join(on, 'summary.md')) !== 'ask') return 'profile root';
    for (const f of [join('docs', 'report.md'), 'README.md', 'src.rs', join('docs', '..', 'docs', 'notes.md')]) {
      if (w(join(proj, f)) !== '') return `quiet: ${f}`;
    }
    if (pol(on, 'Edit', { file_path: join(proj, 'report.md'), new_string: 'x' }, { cwd: proj }) !== '') return 'only Write';
    if (!polReason(on, 'Write', { file_path: join(proj, 'report.md'), content: 'x' }, { cwd: proj, env: { CTXKIT_LANG: 'ru' } }).includes('отчёты в чат')) return 'ru';
    if (w(join(proj, 'report.md'), { tool: 'write', args: ['--dsh'] }) !== 'ask') return 'dsh';
    const agy = JSON.parse(runHook({ cwd: proj, toolCall: { name: 'write_file', args: { Path: join(proj, 'report.md'), Content: 'x' } }, stepIdx: 1 }, ['--agy'], { CLAUDE_CONFIG_DIR: on }));
    if (agy.decision !== 'ask' || !agy.reason?.includes('reports in the chat')) return 'agy';
    // off by default and for a broken file
    return pol(isoProfile, 'Write', { file_path: join(proj, 'report.md'), content: 'x' }, { cwd: proj }) === '' && pol(polProfile('stray-broken', '{"policies":[]}'), 'Write', { file_path: join(proj, 'report.md'), content: 'x' }, { cwd: proj }) === '';
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
    if (JSON.parse(readFileSync(agyFile, 'utf8'))['context-toolkit']) return false;
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
    if (!claudeMd1.includes('# Existing Profile Rules') || !claudeMd1.includes('<!-- context-toolkit:start -->') || claudeMd1.includes('<!-- claude-guard:start -->')) return false;

    const desk1 = JSON.parse(readFileSync(desktopFile, 'utf8'));
    const p1 = desk1.byAccount.acct1.presets[0].settings;
    if (p1.modelId !== 'claude-sonnet-5-5' || p1.effort !== 'high' || p1.cwd !== '/proj' || p1.worktree !== true) return false;
    if (desk1.byAccount.acct1.builtIns.local.settings.modelId !== 'claude-sonnet-5-5') return false;

    const agy1 = JSON.parse(readFileSync(agyFile, 'utf8'));
    if (!agy1['other-hook'] || agy1['claude-guard'] || agy1['ctxkit'] || agy1['context-toolkit']?.PreToolUse?.[0]?.hooks?.[0]?.command !== 'test-ctxkit --agy') return false; // a custom --hook-cmd gets --agy appended

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
    if (s1.env?.CONTEXT_TOOLKIT_LANG !== undefined || s1.env?.CTXKIT_LANG !== undefined) return false;

    // 4) --lang ru sets CONTEXT_TOOLKIT_LANG=ru, switches templates, and appends --lang ru to default Antigravity hook
    const runRu = spawnSync(exe, [...commonArgs, '--lang', 'ru', '--force-agents'], { encoding: 'utf8' });
    if (runRu.status !== 0) return false;
    const sRu = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'));
    if (sRu.env?.CONTEXT_TOOLKIT_LANG !== 'ru' || sRu.env?.CTXKIT_LANG !== undefined) return false;
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
    const agyRuCmd = agyRu['context-toolkit']?.PreToolUse?.[0]?.hooks?.[0]?.command || '';
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
    if (!afterSetup.md.includes('<!-- context-toolkit:start -->') || !afterSetup.patch.includes('context-toolkit-hooks') || !existsSync(join(dshHome, 'context-toolkit-hooks.json'))) return false;
    const state = () => [join(profile, 'settings.json'), join(profile, 'CLAUDE.md'), agyFile, join(dshHome, 'AGENTS.md'), join(dshHome, 'context-toolkit-hooks.json'), join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), hookBin]
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
    if (s.KEEP_ME?.a !== 1 || s.env?.KEEP_ME !== '42' || s.env?.CONTEXT_TOOLKIT_LANG !== undefined || s.env?.CTXKIT_LANG !== undefined) return false;
    if (JSON.stringify(cmds('PreToolUse')) !== '["custom-other-hook","C:/tools/logger.exe ctxkit"]' || cmds('PostToolUse').length !== 0) return false;
    if (JSON.stringify(cmds('Stop')) !== JSON.stringify([foreignStop.command]) || cmds('SessionStart')[0] !== 'echo start') return false;
    // setup without model flags kept the user's own 'opus'; uninstall does not touch it either and only prints it
    // (this block runs with --lang ru, so the lines are the Russian ones)
    if (s.model !== 'opus' || !run.stdout.includes('model: "opus"') || !run.stdout.includes('последняя:')) return false;
    if (!setupRun.stdout.includes('  model: opus (оставлено; чтобы задать, передайте --main-model sonnet)') || s.advisorModel !== undefined || s.effortLevel !== undefined) return false;
    if (!run.stdout.includes('пресет Desktop dev: model "claude-sonnet-5-5", effort "low"')) return false; // preset effort kept without --effort
    if (readFileSync(join(profile, 'CLAUDE.md'), 'utf8') !== origMd) return false;
    if (existsSync(hookBin) || !existsSync(join(profile, 'agents', 'checker.md'))) return false; // binary gone, agents stay
    const agy = JSON.parse(readFileSync(agyFile, 'utf8'));
    if (agy.ctxkit || agy['context-toolkit'] || !agy['other-hook']) return false;
    if (existsSync(join(dshHome, 'context-toolkit-hooks.json'))) return false;
    if (readFileSync(join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8') !== origPatch) return false;
    if (readFileSync(join(dshHome, 'AGENTS.md'), 'utf8') !== '# dsh rules\n') return false;

    // a second uninstall changes nothing and makes no backup
    const after = state();
    const nb1 = nBackups();
    const again = spawnSync(exe, ['setup', '--uninstall', ...common], { encoding: 'utf8' });
    return again.status === 0 && state() === after && nBackups() === nb1;
  }],

  // Migration from the old name ctxkit. A profile set up by the old binary (hooks on hooks/ctxkit.exe, the old rules
  // markers, ctxkit.json made by setup, env.CTXKIT_LANG, the Antigravity key and the DSH block and file of the old name)
  // ends up like a fresh profile set up by the new one; foreign hooks, keys and text stay; a repeat changes nothing;
  // the rollback removes the new and the old, also from a profile that was never migrated
  [true, () => {
    const root = join(dir, 'migrate-test');
    const fwd = (p) => p.replace(/\\/g, '/');
    const make = (name, old) => {
      const p = join(root, name);
      const profile = join(p, 'profile');
      const agyFile = join(p, 'agy', 'hooks.json');
      const dshHome = join(p, 'dsh');
      const cj = join(p, 'claude.json');
      mkdirSync(join(profile, 'hooks'), { recursive: true });
      mkdirSync(join(p, 'agy'), { recursive: true });
      mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true });
      writeFileSync(cj, '{}');
      const foreignPre = { matcher: 'Edit', hooks: [{ type: 'command', command: 'node C:/tools/ctxkit-helper/x.js' }] };
      const settings = { KEEP: 1, env: { KEEP_ME: '42' }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }], PreToolUse: [foreignPre] } };
      let md = '# Mine\n\nmy text\n';
      const agy = { 'other-hook': { a: 1 } };
      let patch = '- id: ui-chat\n';
      const oldBin = join(profile, 'hooks', OLD_BIN_NAME);
      if (old) {
        copyFileSync(exe, oldBin);
        const cmd = `"${fwd(oldBin)}"`;
        const ours = (matcher, onFailure = true) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd, timeout: 10, ...(onFailure ? { onFailure: 'continue' } : {}) }] });
        settings.env.CTXKIT_LANG = 'ru';
        settings.hooks.PreToolUse = [ours('Bash|PowerShell|Write|Read|Edit|MultiEdit'), foreignPre];
        settings.hooks.PostToolUse = [ours('Edit|Write|MultiEdit')];
        settings.hooks.Stop = [ours(null, false)];
        md += '\n<!-- ctxkit:start -->\n## Команда моделей и экономия контекста (ctxkit)\n\n- old rule\n<!-- ctxkit:end -->\n';
        writeFileSync(join(profile, 'ctxkit.json'), JSON.stringify({ created_by: 'ctxkit setup', policies: { stray_files: true } }));
        agy.ctxkit = { PreToolUse: [{ matcher: 'read_file', hooks: [{ type: 'command', command: `${fwd(oldBin)} --agy --lang ru`, timeout: 10 }] }] };
        writeFileSync(join(dshHome, 'ctxkit-hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'read', hooks: [{ type: 'command', command: `& '${fwd(oldBin)}' --dsh --lang ru` }] }] } }));
        patch += `\n# >>> ctxkit (managed by \`ctxkit setup --dsh\`; do not edit) >>>\n- insert:\n    - id: ctxkit-hooks\n      name: '@deepseek-ai/dsh-hooks-claude-code'\n      config:\n        configPath: '${join(dshHome, 'ctxkit-hooks.json')}'\n# <<< ctxkit <<<\n`;
      }
      writeFileSync(join(profile, 'settings.json'), JSON.stringify(settings, null, 2));
      writeFileSync(join(profile, 'CLAUDE.md'), md);
      writeFileSync(agyFile, JSON.stringify(agy, null, 2));
      writeFileSync(join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), patch);
      const paths = ['--profile', profile, '--claude-json', cj, '--antigravity', '--agy-file', agyFile, '--dsh', '--dsh-home', dshHome, '--lang', 'ru'];
      const setup = (...a) => spawnSync(exe, ['setup', '--with-rules', '--no-agents', '--skip-version-check', '--policy', 'stray-files', ...paths, ...a], { encoding: 'utf8' });
      const undo = () => spawnSync(exe, ['setup', '--uninstall', ...paths], { encoding: 'utf8' });
      const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
      // the profile's files with its own path cut out (both profiles must give the same text)
      const files = () => {
        const cut = (t) => t === null ? null : [p, fwd(p), JSON.stringify(p).slice(1, -1), p.replace(/'/g, "''")].reduce((s, x) => s.split(x).join('<p>'), t);
        const pol = (f) => { const v = read(f); if (v === null) return null; const j = JSON.parse(v); return { mark: j.created_by === 'ctxkit setup' || j.created_by === 'context-toolkit setup', policies: j.policies }; };
        return {
          settings: cut(read(join(profile, 'settings.json'))), md: read(join(profile, 'CLAUDE.md')),
          policy: pol(join(profile, 'context-toolkit.json')), oldPolicy: read(join(profile, 'ctxkit.json')),
          agy: cut(read(agyFile)), dsh: cut(read(join(dshHome, 'context-toolkit-hooks.json'))), oldDsh: read(join(dshHome, 'ctxkit-hooks.json')),
          patch: cut(read(join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'))),
          hooksDir: existsSync(join(profile, 'hooks')) ? readdirSync(join(profile, 'hooks')).sort() : null,
        };
      };
      const backups = () => [join(profile, 'backups'), join(dshHome, 'backups'), join(dshHome, 'profiles', 'desktop')].map((d) => (existsSync(d) ? readdirSync(d).length : 0)).join(',');
      return { setup, undo, files, backups, oldBin, profile };
    };
    const fresh = make('fresh', false);
    const migrated = make('old', true);
    // the preview writes nothing and promises what the run does (the old binary goes: this run moves every client)
    const untouched = JSON.stringify(migrated.files());
    const pv = migrated.setup('--dry-run');
    if (pv.status !== 0 || JSON.stringify(migrated.files()) !== untouched || pv.stdout.includes('старый бинарь оставлен') || !pv.stdout.includes('[dry-run] удаление bin') || !pv.stdout.includes('[dry-run] старое имя: удаление')) return `preview: ${pv.stdout}`;
    const r1 = fresh.setup();
    const r2 = migrated.setup();
    if (r1.status !== 0 || r2.status !== 0) return `setup: ${r1.stderr} ${r2.stderr}`;
    const a = fresh.files();
    const b = migrated.files();
    if (JSON.stringify(a) !== JSON.stringify(b)) return `the migrated profile differs from a fresh one:\n${JSON.stringify(a)}\n${JSON.stringify(b)}`;
    if (existsSync(migrated.oldBin) || b.oldPolicy !== null || b.oldDsh !== null) return 'old files left';
    if (b.hooksDir.join() !== BIN_NAME || !b.md.includes('<!-- context-toolkit:start -->') || /ctxkit:/.test(b.md)) return `hooks dir / rules: ${b.hooksDir} ${b.md}`;
    const s = JSON.parse(readFileSync(join(migrated.profile, 'settings.json'), 'utf8'));
    if (s.env.CONTEXT_TOOLKIT_LANG !== 'ru' || 'CTXKIT_LANG' in s.env || s.env.KEEP_ME !== '42' || s.KEEP !== 1) return `env: ${JSON.stringify(s.env)}`;
    if (!s.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command === 'node C:/tools/ctxkit-helper/x.js')) || s.hooks.SessionStart[0].hooks[0].command !== 'echo start') return 'foreign hooks lost';
    if (!/старое имя: хуки на ctxkit/.test(r2.stdout) || !r2.stdout.includes('старое имя: env.CTXKIT_LANG -> env.CONTEXT_TOOLKIT_LANG') || !r2.stdout.includes('удалён bin')) return `the migration is not named: ${r2.stdout}`;
    // a repeat changes nothing and makes no backup
    const before = [JSON.stringify(migrated.files()), migrated.backups()];
    if (migrated.setup().status !== 0 || JSON.stringify([JSON.stringify(migrated.files()), migrated.backups()]) !== JSON.stringify(before)) return 'the repeat changed something';
    // the rollback: nothing of ours under either name, the owner's things stay
    const gone = (x) => x.policy === null && x.oldPolicy === null && x.dsh === null && x.oldDsh === null && x.hooksDir === null
      && x.md === '# Mine\n\nmy text\n' && x.patch === '- id: ui-chat\n' && JSON.parse(x.agy)['other-hook']?.a === 1 && Object.keys(JSON.parse(x.agy)).length === 1
      && !/ctxkit\.exe|context-toolkit|CTXKIT|CONTEXT_TOOLKIT/.test(x.settings) && x.settings.includes('ctxkit-helper') && x.settings.includes('KEEP_ME');
    if (migrated.undo().status !== 0 || !gone(migrated.files())) return `rollback of the migrated profile: ${JSON.stringify(migrated.files())}`;
    const never = make('never', true);
    const u = never.undo();
    if (u.status !== 0 || !gone(never.files())) return `rollback of an old profile: ${u.stdout} ${JSON.stringify(never.files())}`;
    return true;
  }],

  // The old hook binary is kept while a file setup did not rewrite still runs it (Antigravity without --antigravity;
  // the path written another way, `/./`, still counts), and so is the policy file of the old name it reads; the run
  // with --antigravity moves the hook, then both go. A preview of that run says so before anything is written.
  [true, () => {
    const root = join(dir, 'migrate-keep');
    const profile = join(root, 'profile');
    mkdirSync(join(profile, 'hooks'), { recursive: true });
    const oldBin = join(profile, 'hooks', OLD_BIN_NAME);
    copyFileSync(exe, oldBin);
    const agyFile = join(root, 'hooks.json');
    writeFileSync(agyFile, JSON.stringify({ ctxkit: { PreToolUse: [{ hooks: [{ command: `${profile.replace(/\\/g, '/')}/./hooks/${OLD_BIN_NAME} --agy` }] }] } }));
    const ours = '{"created_by":"ctxkit setup","policies":{"commit_hygiene":true}}';
    const oldCfg = join(profile, 'ctxkit.json');
    writeFileSync(oldCfg, ours);
    const cj = join(root, 'c.json');
    writeFileSync(cj, '{}');
    const base = ['setup', '--profile', profile, '--claude-json', cj, '--agy-file', agyFile, '--dsh-home', join(root, 'dsh'), '--skip-version-check', '--no-agents'];
    const r = spawnSync(exe, base, { encoding: 'utf8' });
    if (r.status !== 0 || !existsSync(oldBin) || !r.stdout.includes('old binary kept') || !r.stdout.includes('context-toolkit setup --antigravity')) return `kept: ${r.status} ${r.stdout}`;
    if (readFileSync(oldCfg, 'utf8') !== ours || readFileSync(join(profile, 'context-toolkit.json'), 'utf8') !== ours || !r.stdout.includes('reads only this file')) return `the old policy file must stay for the old binary: ${r.stdout}`;
    const preview = spawnSync(exe, [...base, '--antigravity', '--dry-run'], { encoding: 'utf8' });
    if (preview.status !== 0 || preview.stdout.includes('old binary kept') || !preview.stdout.includes('[dry-run] remove bin') || !preview.stdout.includes('[dry-run] old name: remove')) return `the preview of --antigravity: ${preview.stdout}`;
    const r2 = spawnSync(exe, [...base, '--antigravity'], { encoding: 'utf8' });
    return (r2.status === 0 && !existsSync(oldBin) && !existsSync(oldCfg) && !readFileSync(agyFile, 'utf8').includes('ctxkit')) || `with --antigravity: ${r2.stdout}`;
  }],

  // ~/.local/bin/ctxkit.exe goes only when it is ours: a foreign program of that name (another --version) stays
  [true, () => {
    const runHome = (name, local, md = null, extra = []) => {
      const home = join(dir, `localbin-${name}`);
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
      copyFileSync(exe, join(home, '.claude', 'hooks', OLD_BIN_NAME));
      const localBin = join(home, '.local', 'bin', OLD_BIN_NAME);
      copyFileSync(local, localBin);
      if (md !== null) writeFileSync(join(home, '.claude', 'CLAUDE.md'), md);
      writeFileSync(join(home, 'c.json'), '{}');
      const env = { ...process.env, USERPROFILE: home, HOME: home };
      delete env.CLAUDE_CONFIG_DIR;
      delete env.DSH_HOME;
      const run = (...a) => spawnSync(exe, ['setup', '--claude-json', join(home, 'c.json'), '--skip-version-check', '--no-agents', '--agy-file', join(home, 'none.json'), '--dsh-home', join(home, '.dsh'), ...a], { encoding: 'utf8', env });
      return { r: run(...extra), run, localBin, home };
    };
    const foreign = runHome('foreign', process.execPath);
    if (foreign.r.status !== 0 || !existsSync(foreign.localBin) || !foreign.r.stdout.includes('not this product')) return `foreign: ${foreign.r.stdout} ${foreign.r.stderr}`;
    if (existsSync(join(foreign.home, '.claude', 'hooks', OLD_BIN_NAME)) || !existsSync(join(foreign.home, '.local', 'bin', BIN_NAME))) return 'foreign: the hook copy should move';
    // a preview does not start a program it does not know
    const fp = foreign.run('--dry-run');
    if (fp.status !== 0 || !fp.stdout.includes('only if its --version says')) return `foreign preview: ${fp.stdout}`;
    const ours = runHome('ours', exe);
    if (ours.r.status !== 0 || existsSync(ours.localBin)) return `ours: ${ours.r.stdout}`;
    // the old rules block still says `ctxkit check`: the copy on PATH stays until --with-rules moves the block
    const rules = runHome('rules', exe, '# Mine\n\n<!-- ctxkit:start -->\n- run `ctxkit check <cmd>`\n<!-- ctxkit:end -->\n');
    if (rules.r.status !== 0 || !existsSync(rules.localBin) || !rules.r.stdout.includes('still says `ctxkit check`')) return `rules: ${rules.r.stdout}`;
    const moved = rules.run('--with-rules');
    return (moved.status === 0 && !existsSync(rules.localBin)) || `rules moved: ${moved.stdout}`;
  }],

  // Windows: the old binary runs as a hook right now (Claude Code started it) and cannot be deleted. Setup still
  // finishes (code 0, settings.json on the new binary) and names it for removal by hand; the next run removes it.
  [true, () => {
    if (process.platform !== 'win32') return true;
    const root = join(dir, 'migrate-locked');
    const profile = join(root, 'profile');
    mkdirSync(join(profile, 'hooks'), { recursive: true });
    const oldBin = join(profile, 'hooks', OLD_BIN_NAME);
    copyFileSync(exe, oldBin);
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${oldBin.replace(/\\/g, '/')}"` }] }] } }));
    const cj = join(root, 'c.json');
    writeFileSync(cj, '{}');
    const args = ['setup', '--profile', profile, '--claude-json', cj, '--agy-file', join(root, 'none.json'), '--dsh-home', join(root, 'dsh'), '--skip-version-check', '--no-agents', '--lang', 'ru'];
    const hook = spawn(oldBin, [], { stdio: ['pipe', 'ignore', 'ignore'] }); // waits for the payload on stdin
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      const r = spawnSync(exe, args, { encoding: 'utf8' });
      const s = readFileSync(join(profile, 'settings.json'), 'utf8');
      if (r.status !== 0 || !r.stdout.includes('удалите вручную') || !existsSync(oldBin) || s.includes(OLD_BIN_NAME) || !s.includes(BIN_NAME)) return `locked: ${r.status} ${r.stdout}`;
    } finally {
      hook.kill();
    }
    for (let i = 0; i < 20 && existsSync(oldBin); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      spawnSync(exe, args, { encoding: 'utf8' });
    }
    return !existsSync(oldBin) || 'the next run did not remove the old binary';
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
    if (!once.startsWith(prose.trimEnd()) || !once.includes('\n<!-- context-toolkit:start -->\n')) return false;
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
    if (bomText.split('<!-- context-toolkit:start -->').length !== 2 || !bomText.includes('user tail')) return false;

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
      if (hooksJson !== null) writeFileSync(join(home, 'context-toolkit-hooks.json'), hooksJson);
      const profile = mk(`dsh-${name}-profile`);
      const r = run(profile, '--dsh', '--dsh-home', home);
      const patchAfter = existsSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml')) ? readFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8') : null;
      return { r, profile, patchAfter, hooksAfter: existsSync(join(home, 'context-toolkit-hooks.json')) ? readFileSync(join(home, 'context-toolkit-hooks.json'), 'utf8') : null };
    };
    const half = dshCase('half', '- keep: 1\n# >>> ctxkit (managed by `ctxkit setup --dsh`; do not edit) >>>\n- insert: x\n', null);
    if (half.r.status !== 1 || !untouched(half.profile) || half.hooksAfter !== null || !half.r.stderr.includes('no end marker')) return `half block: ${half.r.status} ${half.r.stderr}`;
    const mapping = dshCase('mapping', 'key: value\n', null);
    if (mapping.r.status !== 1 || !untouched(mapping.profile) || mapping.hooksAfter !== null || mapping.patchAfter !== 'key: value\n') return `mapping: ${mapping.r.status} ${mapping.r.stderr}`;
    const badHooks = dshCase('badhooks', '- keep: 1\n', '[1]');
    if (badHooks.r.status !== 1 || !untouched(badHooks.profile) || badHooks.hooksAfter !== '[1]' || badHooks.patchAfter !== '- keep: 1\n') return `hooks json: ${badHooks.r.status} ${badHooks.r.stderr}`;
    // no patch file yet: setup creates it; a dry run of the same is a preview, not an error
    const fresh = dshCase('fresh', null, null);
    if (fresh.r.status !== 0 || !existsSync(join(fresh.profile, 'hooks')) || fresh.patchAfter === null || !fresh.patchAfter.includes('context-toolkit-hooks')) return `fresh dsh: ${fresh.r.status} ${fresh.r.stderr}`;
    const dryHome = join(root, 'dsh-dry');
    mkdirSync(join(dryHome, 'profiles', 'desktop'), { recursive: true });
    const dryRun = run(mk('dsh-dry-profile'), '--dsh', '--dsh-home', dryHome, '--dry-run');
    if (dryRun.status !== 0 || existsSync(join(dryHome, 'context-toolkit-hooks.json'))) return `dsh dry run: ${dryRun.status} ${dryRun.stderr}`;

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
    return !/(^|[^\r])\n/.test(crlf) && crlf.includes('extra') && !/(context-toolkit|ctxkit):/.test(crlf) || `CRLF lost: ${JSON.stringify(crlf)}`;
  }],

  // Hand edits made after setup survive the rollback: a key and hooks of the user's own (one of them inside the group
  // of ours) in settings.json, lines before and after our block in CLAUDE.md. Only what setup added goes.
  [true, () => {
    const p = join(dir, 'hand-edits-test');
    mkdirSync(p, { recursive: true });
    const cj = join(p, 'c.json');
    writeFileSync(cj, '{}');
    const run = (...a) => spawnSync(exe, ['setup', '--profile', p, '--claude-json', cj, '--skip-version-check', ...a], { encoding: 'utf8' });
    writeFileSync(join(p, 'settings.json'), JSON.stringify({ model: 'opus' }, null, 2));
    writeFileSync(join(p, 'CLAUDE.md'), '# Mine\nkeep\n');
    if (run('--with-rules').status !== 0) return 'setup failed';
    const s = JSON.parse(readFileSync(join(p, 'settings.json'), 'utf8'));
    const ours = (s.hooks?.PreToolUse ?? []).find((g) => g.hooks.some((h) => /context-toolkit/.test(h.command)));
    if (!ours) return `no hook of ours after setup: ${JSON.stringify(s)}`;
    ours.hooks.push({ type: 'command', command: 'my-own-pre-hook' });
    s.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'my-own-start-hook' }] }];
    s.myKey = { a: 1 };
    writeFileSync(join(p, 'settings.json'), JSON.stringify(s, null, 2));
    const md = readFileSync(join(p, 'CLAUDE.md'), 'utf8');
    writeFileSync(join(p, 'CLAUDE.md'), `${md.replace('keep\n', 'keep\nadded before\n')}added after\n`);
    const u = run('--uninstall');
    if (u.status !== 0) return `uninstall: ${u.stderr}`;
    const after = JSON.parse(readFileSync(join(p, 'settings.json'), 'utf8'));
    const cmds = (ev) => (after.hooks?.[ev] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    if (after.myKey?.a !== 1 || after.model !== 'opus') return `own keys lost: ${JSON.stringify(after)}`;
    if (JSON.stringify(cmds('PreToolUse')) !== '["my-own-pre-hook"]' || JSON.stringify(cmds('SessionStart')) !== '["my-own-start-hook"]') return `own hooks lost: ${JSON.stringify(after.hooks)}`;
    if (/context-toolkit|ctxkit/i.test(JSON.stringify(after))) return `ours left in settings.json: ${JSON.stringify(after)}`;
    const mdAfter = readFileSync(join(p, 'CLAUDE.md'), 'utf8');
    if (!mdAfter.includes('added before') || !mdAfter.includes('added after') || !mdAfter.startsWith('# Mine\nkeep\n') || /(context-toolkit|ctxkit):/.test(mdAfter)) return `CLAUDE.md: ${JSON.stringify(mdAfter)}`;
    return true;
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
  // "onFailure": "continue" on our PreToolUse / PostToolUse hooks (a failing hook binary never stops the work), not on Stop
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
    const ours = (ev) => (s.hooks?.[ev] ?? []).flatMap((g) => g.hooks).filter((h) => h.command.includes('context-toolkit'));
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
    const cmd = JSON.parse(readFileSync(agyFile, 'utf8'))['context-toolkit']?.PreToolUse?.[0]?.hooks?.[0]?.command ?? '';
    return r.status === 0 && cmd.endsWith(' --agy') || `command: ${cmd} ${r.stderr}`;
  }],
  // CONTEXT_TOOLKIT_GUARD=0 (old name CTXKIT_GUARD=0) mutes PreToolUse/PostToolUse (and only them)
  [true, () => {
    const bad = join(dir, 'guard-off.json');
    writeFileSync(bad, '{ broken');
    const withGuard = (payload, env) => runHook(payload, [], env);
    const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bigFile } };
    const post = { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: bad } };
    if (!(withGuard(read, {}).includes('"deny"') && withGuard(post, {}).includes('"block"'))) return 'on by default';
    for (const name of ['CONTEXT_TOOLKIT_GUARD', 'CTXKIT_GUARD']) {
      if (withGuard(read, { [name]: '0' }) !== '' || withGuard(post, { [name]: '0' }) !== '') return `${name}=0 did not mute`;
      if (JSON.parse(stopGate({ env: { [name]: '0' } })).decision !== 'block') return `${name}=0 muted the Stop gate`;
    }
    return true;
  }],

  // The switches share one rule under both names: trimmed, case-insensitive 0/off/false/no turn the hook off
  [true, () => {
    const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bigFile } };
    for (const pre of ['CONTEXT_TOOLKIT_', 'CTXKIT_']) {
      for (const v of ['0', ' 0 ', 'off', ' Off ', 'FALSE', 'No']) {
        if (runHook(read, [], { [`${pre}GUARD`]: v }) !== '') return `${pre}GUARD=${JSON.stringify(v)} did not mute`;
        if (stopGate({ env: { [`${pre}GATE`]: v } }) !== '') return `${pre}GATE=${JSON.stringify(v)} did not mute`;
      }
      for (const v of ['', '1', 'on', 'yes', 'of']) {
        if (!runHook(read, [], { [`${pre}GUARD`]: v }).includes('"deny"')) return `${pre}GUARD=${JSON.stringify(v)} muted`;
        if (JSON.parse(stopGate({ env: { [`${pre}GATE`]: v } })).decision !== 'block') return `${pre}GATE=${JSON.stringify(v)} muted`;
      }
    }
    // the new name wins when both are set
    if (!runHook(read, [], { CONTEXT_TOOLKIT_GUARD: '1', CTXKIT_GUARD: '0' }).includes('"deny"')) return 'GUARD: the old name won';
    if (runHook(read, [], { CONTEXT_TOOLKIT_GUARD: '0', CTXKIT_GUARD: '1' }) !== '') return 'GUARD: the new name lost';
    if (JSON.parse(stopGate({ env: { CONTEXT_TOOLKIT_GATE: 'on', CTXKIT_GATE: 'off' } })).decision !== 'block') return 'GATE: the old name won';
    return true;
  }],

  // Localization (default en vs CONTEXT_TOOLKIT_LANG=ru, old name CTXKIT_LANG=ru, / --lang ru; the new name wins)
  [true, () => runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bigFile } }).includes('File is large')],
  [true, () => runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bigFile } }, [], { CTXKIT_LANG: 'ru' }).includes('Файл большой')],
  [true, () => runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bigFile } }, [], { CONTEXT_TOOLKIT_LANG: 'ru' }).includes('Файл большой')],
  [true, () => runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bigFile } }, [], { CONTEXT_TOOLKIT_LANG: 'en', CTXKIT_LANG: 'ru' }).includes('File is large')],
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
    const file = join(profile, 'context-toolkit.json');
    const run = (...a) => spawnSync(exe, [...base, ...a], { encoding: 'utf8' });
    const plain = run();
    if (plain.status !== 0 || existsSync(file) || !plain.stdout.includes('policies: none (kept; pass --policy')) return 'no flag must not create the file';
    if (run('--policy', 'bogus').status !== 2) return 'unknown policy must exit 2';
    const dry = run('--policy', 'commit-hygiene,build-slots=2', '--dry-run');
    if (dry.status !== 0 || existsSync(file) || !dry.stdout.includes('policy commit_hygiene: off -> on') || !dry.stdout.includes('policy build_slots: off -> 2')) return `dry: ${dry.stdout}`;
    const on = run('--policy', 'commit-hygiene,build-slots=2');
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    if (on.status !== 0 || cfg.policies.commit_hygiene !== true || cfg.policies.build_slots !== 2 || cfg.created_by !== 'context-toolkit setup') return `on: ${on.stdout}`;
    const off = run('--policy', 'none');
    if (off.status !== 0 || !off.stdout.includes('policy commit_hygiene: on -> off') || Object.keys(JSON.parse(readFileSync(file, 'utf8')).policies).length !== 0) return `off: ${off.stdout}`;
    // the rules block lists the policies that are on and the owner's own `rules` items; off drops the lines again
    const withRules = JSON.parse(readFileSync(file, 'utf8'));
    withRules.rules = ['My own item for the block, five words'];
    writeFileSync(file, JSON.stringify(withRules));
    run('--policy', 'commit-hygiene,stray-files', '--with-rules');
    const md1 = readFileSync(join(profile, 'CLAUDE.md'), 'utf8');
    if (!md1.includes('`Co-Authored-By`') || !md1.includes('`report*.md`') || !md1.includes('- My own item for the block, five words\n') || md1.includes('git push')) return `rules lines: ${md1}`;
    run('--policy', 'none', '--with-rules');
    const md2 = readFileSync(join(profile, 'CLAUDE.md'), 'utf8');
    if (md2.includes('Co-Authored-By') || !md2.includes('My own item for the block')) return `rules lines off: ${md2}`;
    // a broken file stops setup before anything else is written
    writeFileSync(file, '{"policies":{"commit_hygiene":"yes"}}');
    const settingsBefore = existsSync(join(profile, 'settings.json')) ? readFileSync(join(profile, 'settings.json'), 'utf8') : null;
    const refused = run('--policy', 'none');
    const settingsAfter = existsSync(join(profile, 'settings.json')) ? readFileSync(join(profile, 'settings.json'), 'utf8') : null;
    if (refused.status !== 1 || !refused.stderr.includes('context-toolkit.json') || settingsBefore !== settingsAfter) return 'broken context-toolkit.json must be refused untouched';
    // without --policy / --with-rules the broken file does not stop setup, but the owner is told
    const told = run();
    if (told.status !== 0 || !told.stdout.includes('every policy is off until it is fixed')) return `no warning: ${told.stdout}`;
    // rollback: the file setup made is deleted (the mark of the old name counts too); the owner's keys stay
    writeFileSync(file, JSON.stringify({ created_by: 'ctxkit setup', policies: { stray_files: true } }));
    const un = spawnSync(exe, ['setup', '--uninstall', '--profile', profile, '--claude-json', join(dir, 'policy-claude.json'), '--hook-cmd', 'test-ctxkit'], { encoding: 'utf8' });
    if (un.status !== 0 || existsSync(file)) return `uninstall: ${un.stdout}`;
    writeFileSync(file, JSON.stringify({ created_by: 'ctxkit setup', policies: { stray_files: true }, rules: ['my own rule of five words'] }));
    const un2 = spawnSync(exe, ['setup', '--uninstall', '--profile', profile, '--claude-json', join(dir, 'policy-claude.json'), '--hook-cmd', 'test-ctxkit'], { encoding: 'utf8' });
    const left = JSON.parse(readFileSync(file, 'utf8'));
    if (un2.status !== 0 || left.policies || left.created_by || left.rules?.[0] !== 'my own rule of five words' || !un2.stdout.includes('kept your keys: rules')) return `uninstall keeps: ${un2.stdout}`;
    return spawnSync(exe, ['setup', '--uninstall', '--policy', 'none', '--profile', profile], { encoding: 'utf8' }).status === 2;
  }],

  // Language of the whole output of `setup` and `setup --uninstall` (dry run and real, every integration and policy, the
  // warnings and the errors): --lang en has no Cyrillic; --lang ru has Cyrillic and none of the stock English words of the
  // old output. Markup ([dry-run], [warn], ERR:, ->), `code`, "quoted values", --flags, paths and names are not translated.
  [true, () => {
    const CYR = /[А-Яа-яЁё]/;
    // the English words of the old setup output and of the migration (and the English product name: Russian says
    // «Инструменты контекста»); what a Russian line may keep is cut out by `strip` first
    const EN = /\b(installed|unchanged|skip|skipped|kept|update|updated|remove|removed|removing|backup|backups|created|wrote|written|not found|Setting up|Diagnostics|enabled|global|servers?|skills?|plugins?|policies(?=:)|lines|exceed|trim|restart|Quit|manually|gate|hooks?|rules|block|agent|is|are|the|with|and|not|no|of|in|to|for|or|has|have|run|pass|old name|moved|copied|move|copy|left|still|Context|Toolkit)\b/;
    const strip = (s) => s
      .replace(/\[(dry-run|warn|note|ok|info)\]/g, '')
      .replace(/^ERR:/gm, '')
      .replace(/`[^`]*`/g, '')
      .replace(/"[^"]*"/g, '')
      .replace(/\S*[\\/]\S*/g, '')
      .replace(/\S+\.(json|md|yml|exe|bak)\S*/g, '')
      .replace(/--[\w-]+/g, '')
      .replace(/\b\w+(-\w+)+\b/g, '') // hyphenated names (claude-guard, no-inline-backslash)
      .replace(/\b\w+(\.\w+)+\b/g, ''); // dotted keys (hooks.Stop, env.CLAUDE_CODE_SUBAGENT_MODEL)
    const outputOf = (lang) => {
      const root = join(dir, `lang-${lang}`);
      const profile = join(root, 'profile');
      const agyDir = join(root, 'agy');
      const dshHome = join(root, 'dsh');
      const presets = join(root, 'presets.json');
      const claudeJson = join(root, 'claude.json');
      mkdirSync(profile, { recursive: true });
      mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true });
      mkdirSync(join(dshHome, 'skills'), { recursive: true });
      for (let i = 0; i < 16; i++) mkdirSync(join(dshHome, 'skills', `s${i}`), { recursive: true });
      writeFileSync(join(dshHome, 'cordis.patch.yml'), '- id: mcp-a\n- id: mcp-b\n- id: mcp-c\n- insert:\n    - name: \'@deepseek-ai/dsh-hooks-claude-code\'\n');
      writeFileSync(join(dshHome, 'AGENTS.md'), '# dsh rules\n');
      mkdirSync(join(agyDir, 'plugins'), { recursive: true });
      for (let i = 0; i < 7; i++) {
        mkdirSync(join(agyDir, 'plugins', `p${i}`), { recursive: true });
        writeFileSync(join(agyDir, 'plugins', `p${i}`, 'plugin.json'), '{}');
      }
      writeFileSync(join(agyDir, 'mcp_config.json'), JSON.stringify({ mcpServers: { m1: {}, m2: {}, m3: {}, m4: {}, m5: {} } }));
      writeFileSync(join(agyDir, 'hooks.json'), '{}');
      writeFileSync(presets, JSON.stringify({ byAccount: { a: { presets: [{ name: 'dev', settings: { modelId: 'claude-opus-5-5', effort: 'low' } }], builtIns: { local: { settings: { modelId: 'x' } } } } } }));
      writeFileSync(claudeJson, JSON.stringify({ mcpServers: { a: {}, b: {}, c: {} } }));
      const plugins = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`pl${i}@m`, true]));
      writeFileSync(join(profile, 'settings.json'), JSON.stringify({ enabledPlugins: plugins }));
      writeFileSync(join(profile, 'CLAUDE.md'), `${Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n')}\n`);
      const paths = ['--profile', profile, '--claude-json', claudeJson, '--desktop-file', presets, '--agy-file', join(agyDir, 'hooks.json'), '--dsh-home', dshHome];
      const full = ['setup', '--with-rules', '--desktop', '--antigravity', '--dsh', '--main-model', 'sonnet', '--advisor', 'fable', '--effort', 'high', '--subagent', 'sonnet', '--policy', 'commit-hygiene,confirm-irreversible,stray-files,build-slots=3', '--lang', lang, ...paths];
      const un = ['setup', '--uninstall', '--antigravity', '--dsh', '--lang', lang, ...paths];
      const runs = [
        [...full, '--dry-run'], full, full, // preview (with the claude version check), the real run, the repeat ("unchanged")
        [...full, '--skip-version-check', '--policy', 'none', '--no-stop-gate', '--no-agents'],
        [...un, '--dry-run'], un, un,
        ['setup', '--help', '--lang', lang],
        // errors
        ['setup', '--bogus', '--lang', lang], ['setup', '--lang', lang, '--profile'], ['setup', '--lang', lang, '--lang', 'xx'], ['setup', '--policy', 'bogus', '--lang', lang],
        ['setup', '--policy', 'none,stray-files', '--lang', lang], ['setup', '--uninstall', '--no-agents', '--lang', lang],
      ];
      // the warnings of a profile whose subagent env is Haiku and whose ctxkit.json is broken, and the refusals of odd files
      const odd = (name, files, args) => {
        const p = join(root, name);
        mkdirSync(p, { recursive: true });
        for (const [f, text] of Object.entries(files)) writeFileSync(join(p, f), text);
        runs.push(['setup', '--profile', p, '--claude-json', claudeJson, '--skip-version-check', '--hook-cmd', 'test-ctxkit', '--lang', lang, ...args]);
        return p;
      };
      odd('haiku', { 'settings.json': JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } }), 'ctxkit.json': '{"policies":{"stray_files":"yes"}}' }, ['--no-agents']);
      odd('hooks', { 'settings.json': '{"hooks":{"Stop":1}}' }, []);
      odd('env', { 'settings.json': '{"env":[]}' }, []);
      odd('half', { 'CLAUDE.md': '<!-- ctxkit:start -->\nx\n' }, ['--with-rules']);
      odd('policy', { 'ctxkit.json': '{"policies":{"commit_hygiene":"yes"}}' }, ['--with-rules']);
      odd('brokenjson', { 'settings.json': '{' }, []);
      // the migration from the old name, its notes included: an Antigravity file still on the old binary, the
      // owner's own old policy file, the old DSH file named by the owner's global patch (a dry run, then the real one)
      const legacy = join(root, 'legacy');
      mkdirSync(join(legacy, 'hooks'), { recursive: true });
      const oldBin = join(legacy, 'hooks', OLD_BIN_NAME);
      copyFileSync(exe, oldBin);
      const oldCmd = `"${oldBin.replace(/\\/g, '/')}"`;
      writeFileSync(join(legacy, 'settings.json'), JSON.stringify({ env: { CTXKIT_LANG: 'ru' }, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: oldCmd }] }] } }));
      writeFileSync(join(legacy, 'CLAUDE.md'), '<!-- ctxkit:start -->\nold\n<!-- ctxkit:end -->\n');
      writeFileSync(join(legacy, 'ctxkit.json'), '{"policies":{}}');
      const legacyAgy = join(root, 'legacy-agy.json');
      writeFileSync(legacyAgy, JSON.stringify({ ctxkit: { PreToolUse: [{ hooks: [{ command: `${oldCmd} --agy` }] }] } }));
      const legacyDsh = join(root, 'legacy-dsh');
      mkdirSync(join(legacyDsh, 'profiles', 'desktop'), { recursive: true });
      writeFileSync(join(legacyDsh, 'ctxkit-hooks.json'), '{}');
      writeFileSync(join(legacyDsh, 'cordis.patch.yml'), `- configPath: '${join(legacyDsh, 'ctxkit-hooks.json')}'\n`);
      writeFileSync(join(legacyDsh, 'profiles', 'desktop', 'cordis.patch.yml'), '# >>> ctxkit (managed by `ctxkit setup --dsh`; do not edit) >>>\n- insert: x\n# <<< ctxkit <<<\n');
      const legacyArgs = ['setup', '--profile', legacy, '--claude-json', claudeJson, '--skip-version-check', '--no-agents', '--with-rules', '--agy-file', legacyAgy, '--dsh', '--dsh-home', legacyDsh, '--lang', lang];
      runs.push([...legacyArgs, '--dry-run'], legacyArgs, ['setup', '--uninstall', '--profile', legacy, '--claude-json', claudeJson, '--lang', lang]);
      let all = '';
      for (const a of runs) {
        const r = spawnSync(exe, a, { encoding: 'utf8', timeout: 60000 });
        all += `${r.stdout}${r.stderr}`;
      }
      return all.split(root).join('<root>');
    };
    const en = outputOf('en');
    const ru = outputOf('ru');
    const cyr = en.split('\n').find((l) => CYR.test(l));
    if (cyr) return `Cyrillic in the English output: ${cyr}`;
    if (!/Setting up profile/.test(en) || !en.includes('Removing Context Toolkit') || !en.includes('Diagnostics') || !en.includes('old name: hooks on')) return 'the English output is not the setup output';
    if (!CYR.test(ru) || !ru.includes('Настройка профиля') || !ru.includes('Удаление Инструментов контекста') || !ru.includes('старое имя: хуки на')) return 'the Russian output is not Russian';
    const bad = ru.split('\n').filter((l) => EN.test(strip(l)));
    if (bad.length) return `English words in the Russian output: ${bad.slice(0, 6).join(' // ')}`;
    return true;
  }],

  // The messages of the policies in both languages: the block of commit_hygiene, the questions of confirm_irreversible and
  // stray_files, the wait for a build slot, the doctor findings `policies` and `rules_duplicate`
  [true, () => {
    const CYR = /[А-Яа-яЁё]/;
    const langs = ['en', 'ru'];
    const out = {};
    const on = P('lang-on', { commit_hygiene: true, confirm_irreversible: true, stray_files: true });
    const proj = join(dir, 'lang-proj');
    mkdirSync(proj, { recursive: true });
    for (const l of langs) {
      const env = { CTXKIT_LANG: l };
      out[l] = {
        commit: polReason(on, 'Bash', { command: COAUTH }, { env }),
        irreversible: polReason(on, 'Bash', { command: 'git push --force' }, { env }),
        stray: polReason(on, 'Write', { file_path: join(proj, 'report.md'), content: 'x' }, { cwd: proj, env }),
      };
      // the same through `--lang` (Antigravity hook wiring)
      const agy = JSON.parse(runHook({ toolCall: { name: 'run_command', args: { CommandLine: COAUTH } }, stepIdx: 1 }, ['--agy', '--lang', l], { CLAUDE_CONFIG_DIR: on }));
      out[l].agy = agy.reason;
      // doctor: the policies finding and the repeated rule
      const p = join(dir, `lang-doctor-${l}`);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, 'ctxkit.json'), JSON.stringify({ policies: { commit_hygiene: true } }));
      const rule = 'Always run the full test suite before every commit and read the failures carefully';
      writeFileSync(join(p, 'CLAUDE.md'), `# Mine\n\n- ${rule}\n\n<!-- ctxkit:start -->\n## Rules\n\n- ${rule}\n<!-- ctxkit:end -->\n`);
      const d = JSON.parse(spawnSync(exe, ['doctor', '--json', '--profile', p, '--lang', l], { encoding: 'utf8' }).stdout);
      const text = (id) => { const x = d.findings.find((f) => f.id === id); return x ? [x.message, x.detail ?? '', x.fix ?? ''].join(' | ') : undefined; };
      out[l].policies = text('policies');
      out[l].dupes = text('rules_duplicate');
      writeFileSync(join(p, 'ctxkit.json'), '{"policies":{"commit_hygiene":"yes"}}');
      const d2 = JSON.parse(spawnSync(exe, ['doctor', '--json', '--profile', p, '--lang', l], { encoding: 'utf8' }).stdout);
      const bad = d2.findings.find((f) => f.id === 'policies');
      out[l].badPolicies = bad ? [bad.message, bad.detail ?? '', bad.fix ?? ''].join(' | ') : undefined;
      // the owner's switch off in setup, policies line of the doctor with none on
      writeFileSync(join(p, 'ctxkit.json'), '{"policies":{}}');
      const d3 = JSON.parse(spawnSync(exe, ['doctor', '--json', '--profile', p, '--lang', l], { encoding: 'utf8' }).stdout);
      out[l].nonePolicies = d3.findings.find((f) => f.id === 'policies')?.detail;
    }
    for (const k of Object.keys(out.en)) {
      if (out.en[k] === undefined || out.ru[k] === undefined) return `missing ${k}: ${JSON.stringify([out.en[k], out.ru[k]])}`;
      if (CYR.test(out.en[k])) return `Cyrillic in the English ${k}: ${out.en[k]}`;
      if (!CYR.test(out.ru[k])) return `no Russian in ${k}: ${out.ru[k]}`;
    }
    // the wait for a build slot, in Russian (the English one is checked in the slots case above)
    const root = join(dir, 'slots-test');
    const tmp = join(root, 'tmp');
    const driver = join(root, 'driver.mjs');
    const worker = join(root, 'worker.mjs');
    rmSync(join(root, 'seen'), { recursive: true, force: true });
    const env = { ...process.env, CTXKIT_LANG: 'ru', CLAUDE_CONFIG_DIR: P('lang-slots', { build_slots: 1 }), TMP: tmp, TEMP: tmp, TMPDIR: tmp, SLOT_TEST_DIR: join(root, 'seen') };
    const r = spawnSync('node', [driver, exe, worker, '2'], { encoding: 'utf8', env });
    if (r.status !== 0) return `slots driver: ${r.stderr}`;
    if (!JSON.parse(r.stdout).some((x) => x.err.includes('жду слот сборки (1 занято)'))) return `no Russian wait message: ${r.stdout}`;
    return true;
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
