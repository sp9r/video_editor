import { describe, expect, it } from 'vitest'
import { audioPanFromPercent, audioPanToPercent } from '../../src/renderer/src/components/Inspector'

describe('Inspector audio pan percentage conversion', () => {
  it('displays normalized pan as a percentage and restores the same model value', () => {
    for (const pan of [-1, -0.5, 0, 0.25, 1]) {
      expect(audioPanFromPercent(audioPanToPercent(pan))).toBe(pan)
    }
  })

  it('clamps entered percentages to the audio model range', () => {
    expect(audioPanFromPercent(-100)).toBe(-1)
    expect(audioPanFromPercent(100)).toBe(1)
    expect(audioPanFromPercent(-125)).toBe(-1)
    expect(audioPanFromPercent(125)).toBe(1)
  })
})
