import { describe, expect, it } from 'vitest'
import { canonicalShadowBlurRadius } from '../../src/shared/subtitle-shadow'

describe('canonical subtitle shadow blur', () => {
  it('maps CSS shadow softness to the shared effective radius', () => {
    expect(canonicalShadowBlurRadius(0)).toBe(0)
    expect(canonicalShadowBlurRadius(24)).toBe(12)
    expect(canonicalShadowBlurRadius(1)).toBe(1)
    expect(canonicalShadowBlurRadius(100)).toBe(20)
    expect(canonicalShadowBlurRadius(Number.NaN)).toBe(0)
  })
})
