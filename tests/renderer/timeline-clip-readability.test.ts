import { describe, expect, it } from 'vitest'
import { timelineClipClassName } from '../../src/renderer/src/components/Timeline'

describe('timeline clip readability presentation', () => {
  const clip = (kind: 'video' | 'audio' | 'subtitle', linkGroupId?: string) => ({
    id: `${kind}-1`,
    name: `${kind} clip`,
    kind,
    startUs: 0,
    durationUs: 1_000_000,
    sourceInUs: 0,
    enabled: true,
    assetId: 'asset-1',
    ...(kind === 'subtitle' ? { text: '字幕' } : {}),
    ...(linkGroupId ? { linkGroupId } : {})
  })

  it('keeps kind, selection, and linked state as independent visual classes', () => {
    expect(timelineClipClassName(clip('video'), false)).toBe('timeline-clip clip-video')
    expect(timelineClipClassName(clip('audio', 'group-1'), true)).toBe('timeline-clip clip-audio is-selected is-linked')
    expect(timelineClipClassName(clip('subtitle'), false)).toBe('timeline-clip clip-subtitle')
  })

  it('retains the disabled state without losing kind or link affordance', () => {
    expect(timelineClipClassName({ ...clip('video', 'group-1'), enabled: false }, false))
      .toBe('timeline-clip clip-video is-linked is-disabled')
  })
})
