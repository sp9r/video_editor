import { describe, expect, it } from 'vitest'
import { previewAudioIsActive, previewAudioSourceTimeUs, previewAudioVolume } from '../../src/renderer/src/preview-audio'
import type { PreviewPlanClip } from '../../src/shared/types'

const clip = (overrides: Partial<PreviewPlanClip> = {}): PreviewPlanClip => ({
  clipId: 'audio-1',
  kind: 'audio',
  startUs: 10_000_000,
  durationUs: 5_000_000,
  sourceInUs: 20_000_000,
  enabled: true,
  sourceMediaId: 'asset-1',
  volumeDb: -6,
  pan: 0,
  ...overrides
})

describe('Preview audio timeline mapping', () => {
  it('maps play/pause seek and clip boundaries to the source interval', () => {
    const item = clip()
    expect(previewAudioIsActive(item, 9_999_999)).toBe(false)
    expect(previewAudioIsActive(item, 10_000_000)).toBe(true)
    expect(previewAudioSourceTimeUs(item, 10_000_000)).toBe(20_000_000)
    expect(previewAudioSourceTimeUs(item, 12_500_000)).toBe(22_500_000)
    expect(previewAudioIsActive(item, 15_000_000)).toBe(false)
  })

  it('preserves source mapping after split and trim', () => {
    const left = clip({ clipId: 'left', durationUs: 2_000_000 })
    const right = clip({ clipId: 'right', startUs: 12_000_000, sourceInUs: 22_000_000, durationUs: 3_000_000 })
    const trimmed = clip({ startUs: 11_000_000, sourceInUs: 21_000_000, durationUs: 2_000_000 })
    expect(previewAudioSourceTimeUs(left, 11_500_000)).toBe(21_500_000)
    expect(previewAudioSourceTimeUs(right, 12_000_000)).toBe(22_000_000)
    expect(previewAudioSourceTimeUs(trimmed, 12_000_000)).toBe(22_000_000)
  })

  it('clamps volume consistently with the editor audio model', () => {
    expect(previewAudioVolume(0)).toBe(1)
    expect(previewAudioVolume(-6)).toBeCloseTo(0.501187)
    expect(previewAudioVolume(-120)).toBeCloseTo(10 ** (-96 / 20))
    expect(previewAudioVolume(30)).toBeCloseTo(10 ** (24 / 20))
  })

  it('does not activate disabled clips', () => {
    expect(previewAudioIsActive(clip({ enabled: false }), 12_000_000)).toBe(false)
  })
})
