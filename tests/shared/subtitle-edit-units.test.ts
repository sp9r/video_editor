import { describe, expect, it } from 'vitest'
import { createEmptyProject, validateProject } from '../../src/shared/project'
import { deriveSubtitleEditUnits, subtitleEditUnits } from '../../src/shared/editing/edit-units'
import { splitSubtitleAtWordBoundary } from '../../src/shared/editing/operations'
import { DEFAULT_SUBTITLE_STYLE, type ProjectFile, type SubtitleClip, type SubtitleWord } from '../../src/shared/types'

const longWord: SubtitleWord = {
  id: 'source-word:42',
  text: '皆さんこんばんはアルマジロウです',
  startUs: 100_000,
  endUs: 1_100_000
}

const projectWithDerivedUnits = (): ProjectFile => {
  const project = createEmptyProject('derived edit units')
  const track = project.tracks.find((item) => item.kind === 'subtitle')!
  const clip: SubtitleClip = {
    id: 'caption-long', name: '長い日本語語塊', kind: 'subtitle', startUs: 100_000, durationUs: 1_500_000,
    sourceInUs: 0, enabled: true, text: longWord.text, style: structuredClone(DEFAULT_SUBTITLE_STYLE),
    words: [longWord], editUnits: deriveSubtitleEditUnits([longWord])
  }
  track.clips = [clip]
  return validateProject(project)
}

describe('subtitle edit units', () => {
  it('segments Japanese source words generally and preserves exact text identity', () => {
    const units = deriveSubtitleEditUnits([longWord])!
    expect(units.map((unit) => unit.text)).toEqual(['皆さん', 'こんばんは', 'アルマジロウ', 'です'])
    expect(units.map((unit) => unit.text).join('')).toBe(longWord.text)
    expect(units.every((unit) => unit.parentSourceWordId === longWord.id)).toBe(true)
    expect(units.every((unit) => unit.timingProvenance === 'estimated')).toBe(true)
    expect(units[0]!.startUs).toBe(longWord.startUs)
    expect(units.at(-1)!.endUs).toBe(longWord.endUs)
    expect(units.every((unit, index) => index === 0 || unit.startUs >= units[index - 1]!.endUs)).toBe(true)
  })

  it('keeps point-word timing explicit and does not invent acoustic precision', () => {
    const units = deriveSubtitleEditUnits([{ ...longWord, startUs: 500_000, endUs: 500_000 }])!
    expect(units.every((unit) => unit.startUs === 500_000 && unit.endUs === 500_000 && unit.timingProvenance === 'point')).toBe(true)
  })

  it('splits a long source word at an editor unit while retaining parent identity', () => {
    const project = projectWithDerivedUnits()
    const original = structuredClone(project)
    const next = splitSubtitleAtWordBoundary(project, 'caption-long', 1)
    const clips = next.tracks.find((track) => track.kind === 'subtitle')!.clips.filter((clip): clip is SubtitleClip => clip.kind === 'subtitle')
    expect(clips.map((clip) => clip.text)).toEqual(['皆さんこんばんは', 'アルマジロウです'])
    expect(clips.every((clip) => clip.editUnits?.length)).toBe(true)
    expect(clips.flatMap((clip) => clip.editUnits!).map((unit) => unit.parentSourceWordId)).toEqual([longWord.id, longWord.id, longWord.id, longWord.id])
    expect(clips.every((clip) => clip.words === undefined)).toBe(true)
    expect(project).toEqual(original)
    expect(validateProject(JSON.parse(JSON.stringify(next)))).toEqual(next)
  })

  it('uses legacy raw words as atomic units until an explicit migration/import supplies editUnits', () => {
    const rawClip: SubtitleClip = {
      id: 'legacy', name: 'legacy', kind: 'subtitle', startUs: 0, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: longWord.text, style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [longWord]
    }
    expect(subtitleEditUnits(rawClip)?.map((unit) => unit.text)).toEqual([longWord.text])
  })
})
