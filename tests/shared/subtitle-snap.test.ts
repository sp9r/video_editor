import { describe, expect, it } from 'vitest'
import { createEmptyProject, validateProject } from '../../src/shared/project'
import { deriveSubtitleEditUnits } from '../../src/shared/editing/edit-units'
import { nearestSubtitleSnapTarget, snapSubtitleTimelinePosition, subtitleSnapTargets } from '../../src/shared/editing/subtitle-snap'
import { DEFAULT_SUBTITLE_STYLE, type ProjectFile } from '../../src/shared/types'

const fixture = (): ProjectFile => {
  const project = createEmptyProject('subtitle snap')
  const track = project.tracks.find((item) => item.kind === 'subtitle')!
  const word = { id: 'source-word:1', text: '皆さんこんばんはアルマジロウです', startUs: 1_000_000, endUs: 2_000_000 }
  track.clips = [{
    id: 'caption-1', name: 'caption-1', kind: 'subtitle', startUs: 1_000_000, durationUs: 1_500_000, sourceInUs: 0,
    enabled: true, text: word.text, style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [word], editUnits: deriveSubtitleEditUnits([word])
  }]
  return validateProject(project)
}

describe('subtitle snap helper', () => {
  it('collects caption edges and derived edit-unit boundaries', () => {
    const targets = subtitleSnapTargets(fixture(), ['caption-1'])
    expect(targets.map((target) => target.timeUs)).toEqual([1_000_000, 1_187_500, 1_500_000, 1_875_000, 2_500_000])
  })

  it('snaps only when subtitle editing context is active, with left tie break', () => {
    const project = fixture()
    expect(snapSubtitleTimelinePosition({ project, atUs: 1_190_000, selectedClipIds: ['caption-1'], snapping: true })).toBe(1_187_500)
    expect(snapSubtitleTimelinePosition({ project, atUs: 1_325_000, selectedClipIds: ['caption-1'], snapping: true })).toBe(1_187_500)
    expect(snapSubtitleTimelinePosition({ project, atUs: 1_190_000, selectedClipIds: [], snapping: true })).toBe(1_190_000)
    expect(snapSubtitleTimelinePosition({ project, atUs: 1_190_000, selectedClipIds: ['caption-1'], snapping: false })).toBe(1_190_000)
    expect(snapSubtitleTimelinePosition({ project, atUs: 1_190_000, selectedClipIds: ['caption-1'], snapping: true, bypass: true })).toBe(1_190_000)
  })

  it('activates in review mode and returns deterministic nearest target', () => {
    const targets = subtitleSnapTargets(fixture(), [], 'caption-1')
    expect(nearestSubtitleSnapTarget(targets, 1_343_750)?.timeUs).toBe(1_187_500)
    expect(snapSubtitleTimelinePosition({ project: fixture(), atUs: 1_190_000, reviewEnabled: true, reviewTargetId: 'caption-1', snapping: true })).toBe(1_187_500)
  })
})
