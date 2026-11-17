import type { Filters, Sel } from './views/Matrix'

export type View = 'matrix' | 'radar' | 'hooks' | 'doctor' | 'journal' | 'profiles' | 'ctxkit'

/** What survives a language switch: the window is rebuilt then (`key` in main.tsx), and these would reset. */
export interface Ui {
  view: View
  sel: Sel | null
  filters: Filters
}

export const DEFAULT_FILTERS: Filters = { q: '', group: 'all', state: 'all', hideUnknown: true, client: null }

export const restoreUi = (kept: Ui | undefined): Ui => kept ?? { view: 'matrix', sel: null, filters: DEFAULT_FILTERS }
