/** Форма вывода `loadout scan --json` (crates/loadout-core/src/model.rs). Менять только вместе с ядром. */

export type ClientId = 'claude-code' | 'claude-desktop' | 'codex' | 'antigravity' | 'deepseek'

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
  /** Запись переключается (флагом или через корзину); иначе `toggleWhy` объясняет почему нет. */
  canToggle: boolean
  toggleWhy?: string
  /** Какой уровень нужен для переключения: флаг — R1, корзина — R2. */
  toggleLevel?: Level
  /** MCP в файле клиента: можно править команду и копировать в другой клиент (R2). */
  canEdit: boolean
}

/** Что сделать с записью. Путей и значений секретов в нём нет: ядро находит цель само. */
export type Intent =
  | { op: 'toggle'; entity: string; enable: boolean }
  | { op: 'edit'; entity: string; command: string; args: string[] }
  | { op: 'copy'; entity: string; to: ClientId }
  /** Новый MCP-сервер: локальный (`command`) или удалённый (`url`). Значения env уходят только в ядро. */
  | { op: 'add'; to: ClientId; name: string; command: string; args: string[]; url: string; env: { key: string; value: string }[] }

export type OpKind = 'toggle' | 'edit' | 'copy' | 'add'
export type Level = 'R1' | 'R2'

/** Предпросмотр: ключ и старое/новое значение (команды замаскированы), содержимого файла в нём нет. */
export interface Plan {
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
  /** Другие записи, которые меняет тот же ключ. */
  affects: string[]
  /** Что стоит знать до подтверждения (что не переносится, какие ключи env копируются). */
  notes: string[]
  baseSha: string
}

/** План пакета (профиль): один предпросмотр на все записи. */
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
}

/** R0 — только чтение, R1 — флаги, R2 — корзина, правка, копирование, профили. Каждый уровень включает прежние. */
/** Встроенный ctxkit (CONCEPT.md §13): состояние установки, диагностика и счётчики эффективности. */
export interface CtxkitStatus {
  /** Бинарь ctxkit есть в составе приложения. */
  available: boolean
  version: string | null
  /** Копия в `~/.claude/hooks` (её вызывают хуки) и в `~/.local/bin` (PATH): совпадает со встроенной, отличается или нет. */
  hook: 'same' | 'different' | 'missing'
  bin: 'same' | 'different' | 'missing'
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

/** Счётчики одного дня (UTC) из транскриптов Claude Code: только числа, текста и путей в них нет. */
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
  lang: 'en' | 'ru'
  advisor: 'fable' | 'opus' | 'none'
}

export interface SetupResult {
  dryRun: boolean
  /** Код выхода ctxkit: 0 — готово. */
  code: number
  /** Вывод ctxkit (stdout и stderr), путь домашнего каталога заменён на `~`. */
  output: string
}

/** R0 — только чтение, R1 — флаги, R2 — корзина, правка, копирование, профили, применение ctxkit. */
export type WriteLevel = 'R0' | 'R1' | 'R2'
export const LEVEL_RANK: Record<WriteLevel, number> = { R0: 0, R1: 1, R2: 2 }

export type Result<T> = ({ ok: true; data: T } | { ok: false; error: string })

/** Ответ на `plan`: кроме плана — какие процессы клиента сейчас запущены (они могут перезаписать файл). */
export type PlanResponse = Result<Plan & { running: string[] }>

/** Счётчики по каталогам клиентов; выводы делает Доктор (doctor.ts). */
export interface Facts {
  backups: { client: ClientId; dir: string; count: number }[]
  brokenLinks: { client: ClientId; dir: string; broken: number; total: number }[]
}

export interface ScanResult {
  entities: Entity[]
  warnings: string[]
  facts: Facts
}

/** Что изменилось между сканами: только id записей, пути и значения в событии не передаются. */
export interface ScanDiff {
  added: string[]
  removed: string[]
  changed: string[]
  warningsChanged: boolean
  factsChanged: boolean
}

/** Push из main-процесса: уже проверенные данные и различия с прошлым сканом. */
export interface ChangedEvent {
  data: ScanResult
  diff: ScanDiff
}

/** Ответ main-процесса на запрос скана: либо данные, либо понятная ошибка. */
export type ScanResponse =
  | { ok: true; data: ScanResult; ms: number }
  | { ok: false; error: string }

/** Мост preload → renderer. Больше у окна нет ничего. */
export interface LoadoutApi {
  scan: () => Promise<ScanResponse>
  copyText: (text: string) => Promise<void>
  /** Уровень записи хранит main; страница может его только прочитать и попросить сменить. */
  getWriteLevel: () => Promise<WriteLevel>
  setWriteLevel: (level: WriteLevel) => Promise<WriteLevel>
  plan: (intent: Intent) => Promise<PlanResponse>
  apply: (intent: Intent, baseSha: string) => Promise<Result<Applied>>
  journal: () => Promise<Result<JournalEntry[]>>
  rollback: (op: string) => Promise<Result<Applied>>
  rollbackBatch: (batch: string) => Promise<Result<Applied[]>>
  profiles: () => Promise<Result<Profile[]>>
  /** Без `items` профиль снимается с текущего состояния. */
  saveProfile: (name: string, items?: ProfileItem[]) => Promise<Result<Profile[]>>
  deleteProfile: (name: string) => Promise<Result<Profile[]>>
  planProfile: (name: string) => Promise<Result<BatchPlan & { running: string[] }>>
  applyProfile: (name: string, batchSha: string) => Promise<Result<BatchApplied>>
  ctxkitStatus: () => Promise<Result<CtxkitStatus>>
  ctxkitDoctor: () => Promise<Result<CtxkitDoctor>>
  ctxkitReport: (days: 7 | 14 | 30) => Promise<Result<CtxkitReport>>
  /** `dryRun` — предпросмотр (любой уровень); применение требует R2 и совпадающего предпросмотра. */
  ctxkitSetup: (options: SetupOptions, dryRun: boolean) => Promise<Result<SetupResult>>
  /** Установка плагина Claude Code через его CLI (`имя@маркетплейс`). `dryRun` — показать команду; установка требует R2 и такого же предпросмотра. */
  pluginInstall: (spec: string, dryRun: boolean) => Promise<Result<SetupResult>>
  /** Подписка на изменения конфигов; возвращает отписку. */
  onChanged: (cb: (e: ChangedEvent) => void) => () => void
}

export const CLIENTS: readonly { id: ClientId; name: string }[] = [
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'claude-desktop', name: 'Claude Desktop' },
  { id: 'codex', name: 'ChatGPT / Codex' },
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'deepseek', name: 'DeepSeek' },
]
