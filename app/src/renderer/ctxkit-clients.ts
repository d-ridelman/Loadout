import { t } from '../shared/i18n'
import type { CtxClient, CtxkitStatus } from '../shared/model'

/** One client of the Context Toolkit section: what it gets and what it does not (CONCEPT.md §10.8, the support table). */
export interface CtxClientRow {
  id: CtxClient
  name: string
  /** The form checkbox; `null`: Claude Code is always set up. */
  flag: 'codex' | 'antigravity' | 'dsh' | 'opencode' | null
  gets: string
  /** What it lacks and why, or what the user has to do; empty when nothing. */
  lacks: string
}

// t() only when called: the language is chosen after the module is imported
export const ctxClients = (): CtxClientRow[] => [
  {
    id: 'claude',
    name: t('Claude Code и вкладка Code в Claude Desktop', 'Claude Code and the Code tab of Claude Desktop'),
    flag: null,
    gets: t(
      'Всё: остановка чтения больших файлов целиком и широкого поиска, проверка обратных слешей и синтаксиса после правки, шлюз Stop, агенты Explore и checker, блок правил в CLAUDE.md, защиты.',
      'Everything: stops whole reads of large files and broad searches, checks backslashes and syntax after an edit, the Stop gate, the Explore and checker agents, the rules block in CLAUDE.md, safeguards.',
    ),
    lacks: '',
  },
  {
    id: 'codex',
    name: 'Codex (ChatGPT)',
    flag: 'codex',
    gets: t(
      'Проверка команд оболочки (cat большого файла, рекурсивный grep, код с обратными слешами), проверка правок apply_patch и их синтаксиса, гигиена коммитов, блок правил в ~/.codex/AGENTS.md.',
      'Checks shell commands (cat of a large file, recursive grep, code with backslashes), checks apply_patch edits and their syntax, commit hygiene, the rules block in ~/.codex/AGENTS.md.',
    ),
    lacks: t(
      'После применения откройте Codex, введите /hooks и доверьте хукам: до этого Codex их не запускает. Нет шлюза Stop и защит, которые спрашивают (Codex не умеет «спросить»). Проверено по документации и на тестовых файлах, в живом Codex — нет.',
      'After applying, open Codex, type /hooks and trust the hooks: until then Codex does not run them. No Stop gate and no safeguards that ask (Codex cannot “ask”). Checked against the documentation and on test files, not in a live Codex.',
    ),
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    flag: 'antigravity',
    gets: t(
      'Проверка команд оболочки (cat большого файла, рекурсивный grep, код с обратными слешами) и защиты для команд.',
      'Checks shell commands (cat of a large file, recursive grep, code with backslashes) and the safeguards for commands.',
    ),
    lacks: t(
      'Каждую команду Antigravity будет показывать вам на подтверждение (кроме разрешённых «Always Allow»). В разработке: ограничение чтения файлов и проверка правок — ответ «пропустить» в двух версиях документации Antigravity значит разное. Шлюза Stop и блока правил нет.',
      'Antigravity will show you every command for confirmation (except those under “Always Allow”). In progress: limiting file reads and checking edits, because “pass” means different things in two versions of the Antigravity documentation. No Stop gate and no rules block.',
    ),
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    flag: 'dsh',
    gets: t(
      'Остановка чтения больших файлов целиком, проверка команд, обратных слешей и синтаксиса после правки, защиты, блок правил в ~/.dsh/AGENTS.md.',
      'Stops whole reads of large files, checks commands, backslashes and syntax after an edit, safeguards, the rules block in ~/.dsh/AGENTS.md.',
    ),
    lacks: t(
      'Нужен мост @deepseek-ai/dsh-hooks-claude-code в профиле desktop (команду установки покажет предпросмотр) и перезапуск приложения. Шлюза Stop нет.',
      'Needs the @deepseek-ai/dsh-hooks-claude-code bridge in the desktop profile (the preview shows the install command) and an app restart. No Stop gate.',
    ),
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    flag: 'opencode',
    gets: t(
      'Остановка чтения больших файлов целиком, проверка команд оболочки (cat большого файла, рекурсивный grep, код с обратными слешами) и правок, защиты (то, что нужно подтвердить, OpenCode спросит у вас своим окном разрешения), блок правил в ~/.config/opencode/AGENTS.md, если этот файл уже есть. Ставится плагином ~/.config/opencode/plugins/loadout-context-toolkit.',
      'Stops whole reads of large files, checks shell commands (cat of a large file, recursive grep, code with backslashes) and edits, safeguards (what needs confirming OpenCode asks you in its permission prompt), the rules block in ~/.config/opencode/AGENTS.md if that file already exists. Installed as the plugin ~/.config/opencode/plugins/loadout-context-toolkit.',
    ),
    lacks: t(
      'Только OpenCode 2 (плагины V2). После применения перезапустите OpenCode. Своего AGENTS.md setup не создаёт: пока его нет, OpenCode 2.3.1+ читает ~/.claude/CLAUDE.md вместе с блоком правил Claude Code. Нет шлюза Stop (у OpenCode нет события конца ответа) и проверки синтаксиса после правки. Проверено по исходникам OpenCode и в его среде выполнения на тестовых файлах, в живом OpenCode — нет.',
      'OpenCode 2 only (V2 plugins). Restart OpenCode after applying. Setup does not create an AGENTS.md of its own: while there is none, OpenCode 2.3.1+ reads ~/.claude/CLAUDE.md with the Claude Code rules block. No Stop gate (OpenCode has no end-of-reply event) and no syntax check after an edit. Checked against the OpenCode sources and in its runtime on test files, not in a live OpenCode.',
    ),
  },
]

/** The "Now" cell: our hooks are there, not there, or the client is not on this computer. */
export function clientNow(id: CtxClient, s: CtxkitStatus['clients'] | undefined): { text: string; cls: string } {
  const v = s?.[id]
  if (v === undefined) return { text: '…', cls: 'mute' }
  if (v === 'absent') return { text: t('не найден на этом компьютере', 'not on this computer'), cls: 'mute' }
  if (v === 'off') return { text: t('○ не стоят', '○ not installed'), cls: 's-off' }
  // Codex runs a new hook only after it is trusted: "installed" alone would read as "working"
  if (id === 'codex') return { text: t('● стоят; доверьте им в /hooks', '● installed; trust them in /hooks'), cls: 's-on' }
  if (id === 'opencode') return { text: t('● плагин стоит', '● plugin installed'), cls: 's-on' }
  return { text: t('● стоят', '● installed'), cls: 's-on' }
}
