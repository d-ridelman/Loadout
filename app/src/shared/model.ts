/** Форма вывода `loadout scan --json` (crates/loadout-core/src/model.rs). Менять только вместе с ядром. */
import type { Lang } from './i18n'

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
  /** Скил из каталога подготовки, который заполнил main (`stage` — его номер, `sub` — путь скила внутри). */
  | { op: 'installSkill'; stage: string; sub: string; name: string }

export type OpKind = 'toggle' | 'edit' | 'copy' | 'add' | 'installSkill'

/** Плагин из каталога добавленного маркетплейса (`marketplace.json`). */
export interface CatalogPlugin {
  name: string
  description: string
  version?: string
  installed: boolean
  /** Пусто — ставится отсюда; иначе почему нет (например, источник `command`). */
  why?: string
}

export interface Marketplace {
  name: string
  /** Откуда добавлен, для показа (`owner/repo`, адрес, путь с `~`). */
  source: string
  plugins: CatalogPlugin[]
  /** Каталог не прочитан (ещё не скачан, повреждён): почему. */
  error?: string
}

/** Скил, найденный в подготовленном источнике. */
export interface SkillCandidate {
  sub: string
  name: string
  description: string
}

export interface SkillFetch {
  dryRun: boolean
  /** Для предпросмотра — что будет выполнено; после выполнения — пусто. */
  command: string
  stage: string
  skills: SkillCandidate[]
}
export type Level = 'R1' | 'R2'

/** Предпросмотр: ключ и старое/новое значение (команды замаскированы), содержимого файла в нём нет. */
export interface Plan {
  /** Корзина Loadout: `out` — вынос в неё, `in` — возврат, пусто — не затрагивается (по нему выбирается название кнопки). */
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

/** Итог очистки старых копий операций. */
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
  /** true — не ставить хук Stop (шлюз) и убрать наш, если он есть */
  noStopGate: boolean
  lang: 'en' | 'ru'
  /** 'keep' — `--advisor` не передаётся: advisorModel остаётся как есть (значение по умолчанию не выбор пользователя) */
  advisor: 'keep' | 'fable' | 'opus' | 'none'
  /** 'keep' — `--main-model` не передаётся: `model` остаётся как есть */
  mainModel: 'keep' | 'sonnet' | 'opus' | 'haiku'
  /** 'keep' — `--effort` не передаётся: effort остаётся как есть */
  effort: 'keep' | 'low' | 'medium' | 'high' | 'xhigh'
  /** 'keep' — `--policy` не передаётся (ctxkit.json не трогается); 'on' — включены ровно отмеченные политики ниже; 'off' — `--policy none` */
  policyMode: 'keep' | 'on' | 'off'
  /** Политики «Защиты» (учитываются при policyMode 'on'): гигиена коммитов, подтверждение необратимого, неожиданные файлы-отчёты, лимит сборок */
  commitHygiene: boolean
  confirmIrreversible: boolean
  strayFiles: boolean
  buildSlots: boolean
  /** Лимит параллельных сборок, 1–8 (при buildSlots) */
  buildSlotsN: number
}

/** Верхняя граница лимита сборок в окне. ctxkit сам принимает до 64 (`MAX_SLOTS`): окно ограничивает себя, и уже записанное в ctxkit.json значение выше 8 оно только понижает. */
export const MAX_BUILD_SLOTS = 8

/** Что окно просит убрать вместе с настройками Claude Code: интеграции, которые `setup` поставил по галочкам. */
export interface UninstallOptions {
  antigravity: boolean
  dsh: boolean
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
  /** Язык интерфейса (сохранённый или по локали системы) и его смена: ядро перезапускается с новым языком сообщений. */
  getLang: () => Promise<Lang>
  setLang: (lang: Lang) => Promise<Lang>
  getWriteLevel: () => Promise<WriteLevel>
  setWriteLevel: (level: WriteLevel) => Promise<WriteLevel>
  plan: (intent: Intent) => Promise<PlanResponse>
  apply: (intent: Intent, baseSha: string) => Promise<Result<Applied>>
  journal: () => Promise<Result<JournalEntry[]>>
  /** Удалить старые копии операций (последние 100 и не старше 90 дней остаются); main спрашивает подтверждение системным окном. */
  pruneBackups: () => Promise<Result<Pruned>>
  rollback: (op: string) => Promise<Result<Applied>>
  rollbackBatch: (batch: string) => Promise<Result<Applied[]>>
  profiles: () => Promise<Result<Profile[]>>
  /** Без `items` профиль снимается с текущего состояния. */
  saveProfile: (name: string, items?: ProfileItem[]) => Promise<Result<Profile[]>>
  deleteProfile: (name: string) => Promise<Result<Profile[]>>
  /** Повреждённый `profiles.json` откладывается в `profiles.json.broken-<время>`; возвращает имя файла. Только по явному действию. */
  quarantineProfiles: () => Promise<Result<string>>
  planProfile: (name: string) => Promise<Result<BatchPlan & { running: string[] }>>
  applyProfile: (name: string, batchSha: string) => Promise<Result<BatchApplied>>
  ctxkitStatus: () => Promise<Result<CtxkitStatus>>
  ctxkitDoctor: () => Promise<Result<CtxkitDoctor>>
  ctxkitReport: (days: 7 | 14 | 30) => Promise<Result<CtxkitReport>>
  /** `dryRun` — предпросмотр (любой уровень); применение требует R2 и совпадающего предпросмотра. */
  ctxkitSetup: (options: SetupOptions, dryRun: boolean) => Promise<Result<SetupResult>>
  /** Откат `ctxkit setup --uninstall`: `dryRun` — предпросмотр; откат требует R2 и такого же предпросмотра. */
  ctxkitUninstall: (options: UninstallOptions, dryRun: boolean) => Promise<Result<SetupResult>>
  /** Установка плагина Claude Code через его CLI (`имя@маркетплейс`). `dryRun` — показать команду; установка требует R2 и такого же предпросмотра. */
  pluginInstall: (spec: string, dryRun: boolean) => Promise<Result<SetupResult>>
  /** Добавление маркетплейса Claude Code (`owner/repo`, https-адрес, локальный путь): тот же порядок, что у установки. */
  marketplaceAdd: (source: string, dryRun: boolean) => Promise<Result<SetupResult>>
  /** Добавленные маркетплейсы и их каталоги (только чтение). */
  marketplaces: () => Promise<Result<Marketplace[]>>
  /** Скачать (GitHub) или скопировать (папка) источник скила в каталог подготовки Loadout. `dryRun` — только показать что и куда. */
  skillFetch: (source: string, dryRun: boolean) => Promise<Result<SkillFetch>>
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
