import { describe, expect, it } from 'vitest'
import { welcomeDue } from './welcome'

describe('first-run welcome card', () => {
  it('shows until it is dismissed once, also for a profile that already has other settings', () => {
    expect(welcomeDue({})).toBe(true)
    expect(welcomeDue({ writeLevel: 'R2', lang: 'en' })).toBe(true)
    expect(welcomeDue({ welcomed: true })).toBe(false)
    expect(welcomeDue({ welcomed: 'yes' })).toBe(true)
  })
})
