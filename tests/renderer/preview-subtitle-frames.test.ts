import { describe, expect, it } from 'vitest'
import { planSubtitleWork, subtitleFrameKey } from '../../src/renderer/src/preview-subtitle-frames'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types'
import type { ProjectFile } from '../../src/shared/types'

const project = (cues: Array<{ id: string; startUs: number; durationUs: number; animation?: 'none' | 'fade' | 'pop' }>): ProjectFile => ({
  sequence: { width: 1280, height: 720, frameRate: { numerator: 30, denominator: 1 }, sampleRate: 48000, backgroundColor: '#000000' },
  media: [],
  tracks: [{
    id: 's', name: 'C1', kind: 'subtitle', locked: false, muted: false, hidden: false,
    clips: cues.map((cue) => ({ id: cue.id, name: cue.id, kind: 'subtitle', text: cue.id, startUs: cue.startUs, durationUs: cue.durationUs, sourceInUs: 0, enabled: true, style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), animation: cue.animation ?? 'none', animationDurationUs: cue.animation ? 500_000 : 0 } }))
  }]
}) as unknown as ProjectFile

describe('subtitle frame planning', () => {
  it('shares one image per static state and one per frame while animating', () => {
    const p = project([{ id: 'a', startUs: 0, durationUs: 3_000_000, animation: 'fade' }])
    expect(subtitleFrameKey(p, 3)).not.toBe(subtitleFrameKey(p, 4))
    expect(subtitleFrameKey(p, 40)).toBe(subtitleFrameKey(p, 41))
  })

  it('requests the exact animated run plus the un-animated base for the same cue', () => {
    const p = project([{ id: 'a', startUs: 0, durationUs: 3_000_000, animation: 'fade' }])
    const [current, base] = planSubtitleWork(p, 2)
    expect(current).toMatchObject({ kind: 'sequence', frameIndex: 2 })
    expect(current?.kind === 'sequence' && current.frameCount).toBe(13)
    expect(base?.kind).toBe('base')
  })

  it('prefetches the next cue before it starts and never plans a gap', () => {
    const p = project([{ id: 'a', startUs: 0, durationUs: 1_000_000 }, { id: 'b', startUs: 2_000_000, durationUs: 1_000_000, animation: 'pop' }])
    const gap = planSubtitleWork(p, 45)
    expect(gap.some((work) => work.kind === 'sequence' && work.frameIndex === 60)).toBe(true)
    expect(gap.every((work) => work.frameIndex >= 60)).toBe(true)
  })
})
