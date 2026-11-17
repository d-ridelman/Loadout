// No electron here, so vitest can check it (welcome.test.ts).

/** The first-run card shows until the person closes it once; `welcomed` is then saved with the other settings. */
export const welcomeDue = (settings: Record<string, unknown>): boolean => settings['welcomed'] !== true
