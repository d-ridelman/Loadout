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
}

export interface ScanResult {
  entities: Entity[]
  warnings: string[]
}

/** Ответ main-процесса на запрос скана: либо данные, либо понятная ошибка. */
export type ScanResponse =
  | { ok: true; data: ScanResult; ms: number }
  | { ok: false; error: string }

/** Мост preload → renderer. Больше у окна нет ничего. */
export interface LoadoutApi {
  scan: () => Promise<ScanResponse>
  copyText: (text: string) => Promise<void>
}

export const CLIENTS: readonly { id: ClientId; name: string }[] = [
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'claude-desktop', name: 'Claude Desktop' },
  { id: 'codex', name: 'ChatGPT / Codex' },
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'deepseek', name: 'DeepSeek' },
]
