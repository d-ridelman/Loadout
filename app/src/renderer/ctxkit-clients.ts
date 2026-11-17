import { t } from '../shared/i18n'
import type { CtxClient, CtxkitStatus } from '../shared/model'

/** One client of the Context Toolkit section: what it gets and what it does not (CONCEPT.md §10.8, the support table). */
export interface CtxClientRow {
  id: CtxClient
  name: string
  /** The form checkbox; `null`: Claude Code is always set up, OpenCode is not supported. */
  flag: 'codex' | 'antigravity' | 'dsh' | null
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
      'Проверка команд оболочки (cat большого файла, рекурсивный grep, код с обратными слешами) и защиты.',
      'Checks shell commands (cat of a large file, recursive grep, code with backslashes) and safeguards.',
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
    flag: null,
    gets: t('Пока не поддерживается.', 'Not supported yet.'),
    lacks: t(
      'У OpenCode нет хуков-команд, только плагины на JavaScript, а их устройство как раз меняется (OpenCode 1 → 2). Правила: пока у OpenCode нет своего ~/.config/opencode/AGENTS.md, он читает ~/.claude/CLAUDE.md, и блок правил Claude Code попадает и к нему.',
      'OpenCode has no command hooks, only JavaScript plugins, and their design is changing right now (OpenCode 1 → 2). Rules: while OpenCode has no ~/.config/opencode/AGENTS.md of its own, it reads ~/.claude/CLAUDE.md, so the Claude Code rules block reaches it too.',
    ),
  },
]

/** The "Now" cell: our hooks are there, not there, or the client is not on this computer. */
export function clientNow(id: CtxClient, s: CtxkitStatus['clients'] | undefined): { text: string; cls: string } {
  const v = s?.[id]
  if (v === undefined) return { text: '…', cls: 'mute' }
  if (v === 'absent') return { text: t('не найден на этом компьютере', 'not on this computer'), cls: 'mute' }
  if (id === 'opencode') return { text: t('○ не поддерживается', '○ not supported'), cls: 's-off' }
  return v === 'on' ? { text: t('● стоят', '● installed'), cls: 's-on' } : { text: t('○ не стоят', '○ not installed'), cls: 's-off' }
}
