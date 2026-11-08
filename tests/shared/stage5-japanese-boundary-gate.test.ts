import { describe, expect, it } from 'vitest'
import { createEmptyProject, validateProject } from '../../src/shared/project'
import { deriveSubtitleEditUnits } from '../../src/shared/editing/edit-units'
import { mergeSubtitleWithNext, splitSubtitleAtWordBoundary } from '../../src/shared/editing/operations'
import { snapSubtitleTimelinePosition, subtitleSnapTargets } from '../../src/shared/editing/subtitle-snap'
import { DEFAULT_SUBTITLE_STYLE, type ProjectFile, type SubtitleClip, type SubtitleWord } from '../../src/shared/types'

const sourceWord: SubtitleWord = {
  id: 'source-word:pathological-ja',
  text: '皆さんこんばんはアルマジロウです',
  startUs: 1_000_000,
  endUs: 5_000_000
}

const fixture = (): ProjectFile => {
  const project = createEmptyProject('Stage 5 Japanese boundary gate')
  const track = project.tracks.find((item) => item.kind === 'subtitle')!
  const clip: SubtitleClip = {
    id: 'caption-pathological-ja',
    name: '病理的日本語raw word',
    kind: 'subtitle',
    startUs: 1_000_000,
    durationUs: 4_500_000,
    sourceInUs: 0,
    enabled: true,
    text: sourceWord.text,
    style: structuredClone(DEFAULT_SUBTITLE_STYLE),
    words: [sourceWord],
    editUnits: deriveSubtitleEditUnits([sourceWord])
  }
  track.clips = [clip]
  return validateProject(project)
}

describe('Stage 5 Japanese edit-boundary readiness gate', () => {
  it('keeps multiple derived units faithful, monotonic, parent-linked, and explicitly estimated', () => {
    const clip = fixture().tracks.find((track) => track.kind === 'subtitle')!.clips[0] as SubtitleClip
    expect(clip.editUnits?.map((unit) => unit.text)).toEqual(['皆さん', 'こんばんは', 'アルマジロウ', 'です'])
    expect(clip.editUnits?.map((unit) => unit.parentSourceWordId)).toEqual(Array(4).fill(sourceWord.id))
    expect(clip.editUnits?.map((unit) => unit.timingProvenance)).toEqual(['estimated', 'estimated', 'estimated', 'estimated'])
    expect(clip.editUnits?.map((unit) => unit.text).join('')).toBe(clip.text)
    expect(clip.editUnits?.every((unit, index, units) => index === 0 || unit.startUs >= units[index - 1]!.endUs)).toBe(true)
    expect(clip.editUnits?.[0]?.startUs).toBe(sourceWord.startUs)
    expect(clip.editUnits?.at(-1)?.endUs).toBe(sourceWord.endUs)
  })

  it('supports internal Razor split and merge without inventing raw-word ownership', () => {
    const project = fixture()
    const split = splitSubtitleAtWordBoundary(project, 'caption-pathological-ja', 1)
    const track = split.tracks.find((item) => item.kind === 'subtitle')!
    const [left, right] = track.clips as [SubtitleClip, SubtitleClip]
    expect([left.text, right.text]).toEqual(['皆さんこんばんは', 'アルマジロウです'])
    expect(left.editUnits?.every((unit) => unit.parentSourceWordId === sourceWord.id)).toBe(true)
    expect(right.editUnits?.every((unit) => unit.parentSourceWordId === sourceWord.id)).toBe(true)
    expect(left.words).toBeUndefined()
    expect(right.words).toBeUndefined()

    const merged = mergeSubtitleWithNext(split, left.id)
    const mergedClip = merged.tracks.find((item) => item.kind === 'subtitle')!.clips[0] as SubtitleClip
    expect(mergedClip.text).toBe(sourceWord.text)
    expect(mergedClip.editUnits?.map((unit) => unit.parentSourceWordId)).toEqual(Array(4).fill(sourceWord.id))
    expect(mergedClip.words).toBeUndefined()
    expect(validateProject(JSON.parse(JSON.stringify(merged)))).toEqual(merged)
  })

  it('uses the same derived boundaries for snap and supports Alt bypass', () => {
    const project = fixture()
    const targets = subtitleSnapTargets(project, ['caption-pathological-ja'])
    expect(targets.filter((target) => target.kind === 'edit-unit-boundary').map((target) => target.timeUs)).toEqual([1_750_000, 3_000_000, 4_500_000])
    expect(snapSubtitleTimelinePosition({ project, atUs: 1_760_000, selectedClipIds: ['caption-pathological-ja'], snapping: true })).toBe(1_750_000)
    expect(snapSubtitleTimelinePosition({ project, atUs: 1_760_000, selectedClipIds: ['caption-pathological-ja'], snapping: true, bypass: true })).toBe(1_760_000)
  })
})
