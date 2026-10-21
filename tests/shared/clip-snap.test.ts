import { describe, expect, it } from 'vitest'
import { clipSnapTargets, clipSnapThresholdUs, snapClipEdge, snapClipMove } from '../../src/shared/editing/clip-snap'
import { moveLinkedClip } from '../../src/shared/editing/operations'
import { createEmptyProject, framesToUs } from '../../src/shared/project'
import type { ProjectFile, TimelineClip } from '../../src/shared/types'

const clip = (id: string, startUs: number, durationUs: number, extra: Partial<TimelineClip> = {}): TimelineClip => ({
  id, name: id, kind: 'image', assetId: 'a', startUs, durationUs, sourceInUs: 0, enabled: true, ...extra
} as unknown as TimelineClip)

const projectWith = (...clips: TimelineClip[]): ProjectFile => {
  const project = createEmptyProject()
  const track = project.tracks.find((item) => item.kind !== 'subtitle')!
  track.clips = clips
  return project
}

describe('clip snapping targets', () => {
  it('excludes the dragged clip and its linked partners, disabled clips, and adds playhead and timeline start', () => {
    const project = projectWith(
      clip('v', 1_000_000, 1_000_000, { linkGroupId: 'g' }),
      clip('a', 1_000_000, 1_000_000, { linkGroupId: 'g' }),
      clip('off', 5_000_000, 1_000_000, { enabled: false }),
      clip('other', 3_000_000, 500_000)
    )
    const targets = clipSnapTargets(project, { excludeClipIds: ['v'], playheadUs: 2_000_000 })
    expect(targets.map((t) => [t.kind, t.timeUs, t.clipId])).toEqual([
      ['timeline-start', 0, undefined],
      ['playhead', 2_000_000, undefined],
      ['clip-start', 3_000_000, 'other'],
      ['clip-end', 3_500_000, 'other']
    ])
  })

  it('converts the 8 px threshold with the zoom', () => {
    expect(clipSnapThresholdUs(100)).toBe(80_000)
    expect(clipSnapThresholdUs(400)).toBe(20_000)
  })
})

describe('snapClipMove', () => {
  const targets = clipSnapTargets(projectWith(clip('x', 2_000_000, 1_000_000)), { excludeClipIds: [], playheadUs: 6_000_000 })
  it('snaps the start edge to a clip end', () => {
    const r = snapClipMove({ startUs: 3_020_000, durationUs: 500_000, targets, thresholdUs: 50_000 })
    expect(r?.timeUs).toBe(3_000_000)
    expect(r?.edge).toBe('start')
  })
  it('snaps the end edge to a clip start / playhead', () => {
    const r = snapClipMove({ startUs: 5_010_000, durationUs: 1_000_000, targets, thresholdUs: 50_000 })
    expect(r).toMatchObject({ timeUs: 5_000_000, edge: 'end' })
    expect(r?.target.kind).toBe('playhead')
  })
  it('respects the threshold boundary (inclusive) and returns null beyond it', () => {
    expect(snapClipMove({ startUs: 3_050_000, durationUs: 100_000, targets, thresholdUs: 50_000 })?.timeUs).toBe(3_000_000)
    expect(snapClipMove({ startUs: 3_050_001, durationUs: 100_000, targets, thresholdUs: 50_000 })).toBeNull()
  })
  it('snaps to the timeline start and never returns a negative start', () => {
    expect(snapClipMove({ startUs: 20_000, durationUs: 1_000_000, targets, thresholdUs: 50_000 })?.timeUs).toBe(0)
    // end edge would need start < 0 to meet the target at 2_000_000 - 3_000_000
    expect(snapClipMove({ startUs: 0, durationUs: 3_000_000, targets: [{ timeUs: 2_900_000, kind: 'playhead' }], thresholdUs: 150_000 })).toBeNull()
  })
  it('prefers the start edge, then the earlier target, on ties', () => {
    // two targets equally far from the start edge: the earlier one wins
    const tie = [{ timeUs: 1_000_000, kind: 'clip-end' as const }, { timeUs: 1_200_000, kind: 'clip-start' as const }]
    expect(snapClipMove({ startUs: 1_100_000, durationUs: 5_000_000, targets: tie, thresholdUs: 200_000 })?.timeUs).toBe(1_000_000)
    // start edge 100k from 1_000_000, end edge 100k from 1_300_000: the start edge wins
    const edges = [{ timeUs: 1_000_000, kind: 'clip-end' as const }, { timeUs: 1_300_000, kind: 'clip-start' as const }]
    expect(snapClipMove({ startUs: 1_100_000, durationUs: 100_000, targets: edges, thresholdUs: 100_000 })).toMatchObject({ edge: 'start', timeUs: 1_000_000 })
  })
})

describe('snapClipEdge', () => {
  it('snaps a trimmed edge and ignores far targets', () => {
    const targets = [{ timeUs: 1_000_000, kind: 'playhead' as const }, { timeUs: 1_100_000, kind: 'clip-start' as const }]
    expect(snapClipEdge({ timeUs: 1_040_000, targets, thresholdUs: 60_000 })?.timeUs).toBe(1_000_000)
    expect(snapClipEdge({ timeUs: 1_050_000, targets, thresholdUs: 60_000 })?.timeUs).toBe(1_000_000)
    expect(snapClipEdge({ timeUs: 2_000_000, targets, thresholdUs: 60_000 })).toBeNull()
  })
})

describe('frame alignment of snapped results', () => {
  it('lands exactly on the neighbour end for fractional frame rates', () => {
    for (const frameRate of [{ numerator: 30000, denominator: 1001 }, { numerator: 60, denominator: 1 }, { numerator: 24000, denominator: 1001 }]) {
      const project = createEmptyProject()
      project.sequence.frameRate = frameRate
      const dur = framesToUs(97, frameRate.numerator, frameRate.denominator)
      const track = project.tracks.find((item) => item.kind !== 'subtitle')!
      track.clips = [clip('A', framesToUs(13, frameRate.numerator, frameRate.denominator), dur), clip('B', framesToUs(400, frameRate.numerator, frameRate.denominator), dur)]
      const aEnd = track.clips[0]!.startUs + dur
      const targets = clipSnapTargets(project, { excludeClipIds: ['B'] })
      const snapped = snapClipMove({ startUs: aEnd + 1_000, durationUs: dur, targets, thresholdUs: 50_000 })!
      const moved = moveLinkedClip(project, 'B', track.id, snapped.timeUs, true)
      const b = moved.tracks.flatMap((t) => t.clips).find((c) => c.id === 'B')!
      expect(b.startUs).toBe(aEnd)
    }
  })
})
