import { describe, expect, it } from 'vitest'
import { peakCountForPixelWidth } from '../../src/renderer/src/components/Waveform'

describe('adaptive waveform resolution', () => {
  it('tracks visible width, clamps small clips, and caps large clips', () => {
    expect(peakCountForPixelWidth(8)).toBe(16)
    expect(peakCountForPixelWidth(100)).toBe(50)
    expect(peakCountForPixelWidth(10_000)).toBe(4096)
    expect(peakCountForPixelWidth(200)).toBeGreaterThan(peakCountForPixelWidth(100))
  })
})
