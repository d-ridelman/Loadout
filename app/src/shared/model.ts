/** Shape of the `loadout scan --json` output (crates/loadout-core/src/model.rs). Change only together with the core. */
import type { Lang } from './i18n'

export type ClientId = 'claude-code' | 'claude-desktop' | 'codex' | 'antigravity' | 'deepseek' | 'opencode'

export type Kind =
  | 'plugin'
  | 'mcp'
  | 'skill'
  | 'hook'
  | 'agent'
  | 'command'
  | 'marketplace'
  | 'connector'

export type EntityState = 'on' | 'off' | 'broken' | 'stale' | 'cloud' | 'unknown'

export interface Entity {
  id: string
  logicalKey: string
  kind: Kind
  client: ClientId
  scope: string
  name: string
  state: EntityState
  version?: string
  origin: { file: string; pointer: string }
  note?: string
  detail: Record<string, unknown>
  /** The entry can be toggled (by a flag or via the trash); otherwise `toggleWhy` explains why not. */
  canToggle: boolean
  toggleWhy?: string
  /** Level needed to toggle: flag is R1, trash is R2. */
  toggleLevel?: Level
  /** Where toggling writes, when that is not `origin` (a Claude Code plugin is switched in `settings.json`). */
  toggleAt?: { file: string; pointer: string }
  /** MCP in a client file: its command can be edited and it can be copied to another client (R2). */
  canEdit: boolean
}

/** What to do with an entry. It carries no paths or secret values: the core finds the target itself. */
export type Intent =
  | { op: 'toggle'; entity: string; enable: boolean }
  | { op: 'edit'; entity: string; command: string; args: string[] }
  | { op: 'copy'; entity: string; to: ClientId }
  /** New MCP server: local (`command`) or remote (`url`). The env values go only to the core. */
  | { op: 'add'; to: ClientId; name: string; command: string; args: string[]; url: string; env: { key: string; value: string }[] }
  /** Skill from the staging directory filled by main (`stage` is its number, `sub` is the skill's path inside). */
  | { op: 'installSkill'; stage: string; sub: string; name: string }

export type OpKind = 'toggle' | 'edit' | 'copy' | 'add' | 'installSkill'

/** Plugin from the catalog of an added marketplace (`marketplace.json`). */
export interface CatalogPlugin {
  name: string
  description: string
  version?: string
  installed: boolean
  /** Empty means it can be installed from here; otherwise why not (for example, a `command` source). */
  why?: string
}

export interface Marketplace {
  name: string
  /** Where it was added from, for display (`owner/repo`, URL, path with `~`). */
  source: string
  plugins: CatalogPlugin[]
  /** The catalog could not be read (not downloaded yet, corrupted): why. */
  error?: string
}

/** Skill found in a staged source. */
export interface SkillCandidate {
  sub: string
  name: string
  description: string
}

export interface SkillFetch {
  dryRun: boolean
  /** For a preview, what will be run; empty after it has run. */
  command: string
  stage: string
  skills: SkillCandidate[]
}
export type Level = 'R1' | 'R2'

/** Preview: the key and the old/new value (commands are masked); it has no file contents. */
export interface Plan {
  /** Loadout trash: `out` moves the entry into it, `in` restores it, empty means untouched (the button label is chosen by it). */
  trash: '' | 'out' | 'in'
  op: OpKind
  level: Level
  entity: string
  client: ClientId
  kind: Kind
  name: string
  file: string
  pointer: string
  enable: boolean
  from: string
  to: string
  noop: boolean
  /** Other entries changed by the same key. */
  affects: string[]
  /** What to know before confirming (what is not carried over, which env keys are copied). */
  notes: string[]
  baseSha: string
}

/** Batch plan (profile): one preview for all entries. */
export interface BatchPlan {
  plans: Plan[]
  skipped: string[]
  level: Level
  batchSha: string
}

export interface ProfileItem {
  client: ClientId
  kind: Kind
  scope: string
  name: string
  enable: boolean
}

export interface Profile {
  name: string
  items: ProfileItem[]
}

export interface BatchApplied {
  batch: string
  applied: Applied[]
}

export interface Applied {
  op: string
  entity: string
  from: string
  to: string
}

/** Result of cleaning up old operation backups. */
export interface Pruned {
  removed: number
  kept: number
}

export interface JournalEntry {
  id: string
  time: number
  op: OpKind | 'rollback'
  of: string | null
  batch: string | null
  level: Level
  client: ClientId
  kind: Kind
  name: string
  pointer: string
  file: string
  from: string
  to: string
  rolledBack: boolean
  canRollback: boolean
  /** Why it cannot be rolled back (the file changed, already rolled back…), shown as text in the row. */
  why?: string
  /** What the rollback leaves when that is not `from` (a return from the owner's stash over a changed file goes to the trash). */
  rollbackTo?: string
}

/** R0 is read-only, R1 is flags, R2 is trash, edit, copy, profiles. Each level includes the previous ones. */
/** Built-in Context Toolkit (CONCEPT.md §13): install state, diagnostics and efficiency counters. */
export interface CtxkitStatus {
  /** The context-toolkit binary is bundled with the app. */
  available: boolean
  version: string | null
  /** The copy in `~/.claude/hooks` (called by hooks) and in `~/.local/bin` (PATH): same as the bundled one, different, or missing. */
  hook: 'same' | 'different' | 'missing'
  bin: 'same' | 'different' | 'missing'
  /** `~/.claude/hooks` contains `ctxkit.exe`, the binary under the former name: "Apply" moves the install to the new one. */
  legacy: boolean
}

export type FindingSeverity = 'ok' | 'info' | 'warn' | 'error'

export interface DoctorFinding {
  id: string
  severity: FindingSeverity
  message: string
  detail: string | null
  fix: string | null
}

export interface CtxkitDoctor {
  findings: DoctorFinding[]
  version: string
}

/** Counters for one day (UTC) from Claude Code transcripts: numbers only, no text or paths. */
export interface DayStats {
  mainTurns: { sonnet: number; haiku: number; opusFable: number; other: number }
  subTurns: number
  advisorCalls: number
  agentCalls: Record<string, number>
  toolResultChars: number
  readChars: number
  readBlocked: number
  shellInspectChars: number
  buildChars: number
  checkCalls: number
  checkChars: number
}

export interface CtxkitReport {
  days: Record<string, DayStats>
}

export interface SetupOptions {
  withRules: boolean
  desktop: boolean
  antigravity: boolean
  dsh: boolean
  /** true: do not install the Stop hook (the gate) and remove ours if present */
  noStopGate: boolean
  lang: 'en' | 'ru'
  /** 'keep': `--advisor` is not passed, advisorModel stays as it is (the default value is not a user choice) */
  advisor: 'keep' | 'fable' | 'opus' | 'none'
  /** 'keep': `--main-model` is not passed, `model` stays as it is */
  mainModel: 'keep' | 'sonnet' | 'opus' | 'haiku'
  /** 'keep': `--effort` is not passed, effort stays as it is */
  effort: 'keep' | 'low' | 'medium' | 'high' | 'xhigh'
  /** 'keep': `--policy` is not passed (context-toolkit.json is left alone); 'on': exactly the policies ticked below are enabled; 'off': `--policy none` */
  policyMode: 'keep' | 'on' | 'off'
  /** "Protection" policies (used when policyMode is 'on'): commit hygiene, confirming irreversible actions, unexpected report files, build limit */
  commitHygiene: boolean
  confirmIrreversible: boolean
  strayFiles: boolean
  buildSlots: boolean
  /** Limit of parallel builds, 1-8 (when buildSlots is on) */
  buildSlotsN: number
}

/** Upper bound of the build limit in the window. Context Toolkit itself accepts up to 64 (`MAX_SLOTS`): the window limits itself, and a value above 8 already written in ctxkit.json it only lowers. */
export const MAX_BUILD_SLOTS = 8

/** What the window asks to remove along with the Claude Code settings: integrations that `setup` installed by checkbox. */
export interface UninstallOptions {
  antigravity: boolean
  dsh: boolean
}

export interface SetupResult {
  dryRun: boolean
  /** Exit code of context-toolkit: 0 means done. */
  code: number
  /** Output of context-toolkit (stdout and stderr), with the home directory path replaced by `~`. */
  output: string
}

/** R0 is read-only, R1 is flags, R2 is trash, edit, copy, profiles, applying Context Toolkit. */
export type WriteLevel = 'R0' | 'R1' | 'R2'
export const LEVEL_RANK: Record<WriteLevel, number> = { R0: 0, R1: 1, R2: 2 }

export type Result<T> = ({ ok: true; data: T } | { ok: false; error: string })

/** Reply to `plan`: besides the plan, which client processes are running now (they may overwrite the file). */
export type PlanResponse = Result<Plan & { running: string[] }>

/** Counters per client directory; conclusions are drawn by the Doctor (doctor.ts). */
export interface Facts {
  backups: { client: ClientId; dir: string; count: number }[]
  brokenLinks: { client: ClientId; dir: string; broken: number; total: number }[]
}

export interface ScanResult {
  entities: Entity[]
  warnings: string[]
  facts: Facts
}

/** What changed between scans: only entry ids; paths and values are not sent in the event. */
export interface ScanDiff {
  added: string[]
  removed: string[]
  changed: string[]
  warningsChanged: boolean
  factsChanged: boolean
}

/** Push from the main process: already validated data and the differences from the previous scan. */
export interface ChangedEvent {
  data: ScanResult
  diff: ScanDiff
}

/** Main process reply to a scan request: either data or a readable error. */
export type ScanResponse =
  | { ok: true; data: ScanResult; ms: number }
  | { ok: false; error: string }

/** Why an update step failed; the window turns it into a fixed line in its own language (no raw messages from the network). */
export type UpdateErrorReason = 'offline' | 'missing' | 'corrupt' | 'check' | 'download' | 'install'

/**
 * App update state, as main sends it to the window: only a checked version, a percent and an error reason
 * (no release notes or raw error messages from the network). `quiet`: an error of a background check, shown only in the panel.
 */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking'; manual: boolean }
  | { status: 'latest'; checkedAt: number }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; reason: UpdateErrorReason; quiet: boolean }

export interface UpdatesInfo {
  /** The installed version. */
  version: string
  /** "Check for updates automatically" (on by default). */
  auto: boolean
  /** false in a development run: electron-updater works only in an installed build. */
  supported: boolean
  state: UpdateState
}

/** The preload → renderer bridge. The window has nothing else. */
export interface LoadoutApi {
  scan: () => Promise<ScanResponse>
  copyText: (text: string) => Promise<void>
  /** The write level is kept by main; the page can only read it and ask to change it. */
  /** Interface language (saved or from the system locale) and changing it: the core restarts with the new message language. */
  getLang: () => Promise<Lang>
  setLang: (lang: Lang) => Promise<Lang>
  /** Whether to show the first-run card; `welcomeDone` saves that it was closed. */
  welcome: () => Promise<boolean>
  welcomeDone: () => Promise<void>
  getWriteLevel: () => Promise<WriteLevel>
  setWriteLevel: (level: WriteLevel) => Promise<WriteLevel>
  plan: (intent: Intent) => Promise<PlanResponse>
  apply: (intent: Intent, baseSha: string) => Promise<Result<Applied>>
  journal: () => Promise<Result<JournalEntry[]>>
  /** Delete old operation backups (the last 100 and those not older than 90 days stay); main asks for confirmation in its own separate window. */
  pruneBackups: () => Promise<Result<Pruned>>
  rollback: (op: string) => Promise<Result<Applied>>
  rollbackBatch: (batch: string) => Promise<Result<Applied[]>>
  profiles: () => Promise<Result<Profile[]>>
  /** Without `items` the profile is captured from the current state. */
  saveProfile: (name: string, items?: ProfileItem[]) => Promise<Result<Profile[]>>
  deleteProfile: (name: string) => Promise<Result<Profile[]>>
  /** A corrupted `profiles.json` is set aside as `profiles.json.broken-<time>`; returns the file name. Only on explicit action. */
  quarantineProfiles: () => Promise<Result<string>>
  planProfile: (name: string) => Promise<Result<BatchPlan & { running: string[] }>>
  applyProfile: (name: string, batchSha: string) => Promise<Result<BatchApplied>>
  ctxkitStatus: () => Promise<Result<CtxkitStatus>>
  ctxkitDoctor: () => Promise<Result<CtxkitDoctor>>
  ctxkitReport: (days: 7 | 14 | 30) => Promise<Result<CtxkitReport>>
  /** `dryRun` is a preview (any level); applying requires R2 and a matching preview. */
  ctxkitSetup: (options: SetupOptions, dryRun: boolean) => Promise<Result<SetupResult>>
  /** Rollback via `context-toolkit setup --uninstall`: `dryRun` is a preview; the rollback requires R2 and the same preview. */
  ctxkitUninstall: (options: UninstallOptions, dryRun: boolean) => Promise<Result<SetupResult>>
  /** Install a Claude Code plugin through its CLI (`name@marketplace`). `dryRun` shows the command; the install requires R2 and the same preview. */
  pluginInstall: (spec: string, dryRun: boolean) => Promise<Result<SetupResult>>
  /** Add a Claude Code marketplace (`owner/repo`, https URL, local path): the same flow as the install. */
  marketplaceAdd: (source: string, dryRun: boolean) => Promise<Result<SetupResult>>
  /** Added marketplaces and their catalogs (read-only). */
  marketplaces: () => Promise<Result<Marketplace[]>>
  /** Download (GitHub) or copy (folder) a skill source into the Loadout staging directory. `dryRun` only shows what and where. */
  skillFetch: (source: string, dryRun: boolean) => Promise<Result<SkillFetch>>
  /** Subscribe to config changes; returns the unsubscribe function. */
  onChanged: (cb: (e: ChangedEvent) => void) => () => void
  /** App updates: the page only asks; main decides what is allowed in the current state. */
  updates: () => Promise<UpdatesInfo>
  setAutoUpdate: (on: boolean) => Promise<UpdatesInfo>
  checkUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  /** Quits and installs the downloaded update; main refuses while a write or an install is in progress. */
  installUpdate: () => Promise<Result<boolean>>
  /** Opens the release notes of the offered version in the browser (main builds the address). */
  openReleaseNotes: () => Promise<void>
  onUpdates: (cb: (info: UpdatesInfo) => void) => () => void
  /** "Similar to this": whether the model is on this computer, its download size. */
  similar: () => Promise<SimilarInfo>
  /** Downloads the model (main shows the progress through `onSimilar`); only on the person's click. */
  similarDownload: () => Promise<void>
  /** Up to three skills closest to this one (other logical keys), best first. */
  similarFind: (id: string) => Promise<Result<SimilarItem[]>>
  onSimilar: (cb: (info: SimilarInfo) => void) => () => void
}

/** The state of the "similar to this" model; an error is a fixed reason, the window words it. */
export type SimilarState =
  | { status: 'absent' }
  | { status: 'downloading'; percent: number }
  | { status: 'ready' }
  | { status: 'error'; reason: 'download' | 'corrupt' }

export interface SimilarInfo {
  state: SimilarState
  /** The download size in MB. */
  mb: number
}

export interface SimilarItem {
  id: string
  /** Cosine of the two texts, 1 is the same meaning. */
  score: number
}

export const CLIENTS: readonly { id: ClientId; name: string }[] = [
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'claude-desktop', name: 'Claude Desktop' },
  { id: 'codex', name: 'ChatGPT / Codex' },
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'opencode', name: 'OpenCode' },
]
