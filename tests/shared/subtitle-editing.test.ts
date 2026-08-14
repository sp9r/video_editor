import { describe, expect, it } from 'vitest'
import { createEmptyProject, validateProject } from '../../src/shared/project'
import { isSubtitleWordBoundarySplitAvailable, mergeSubtitleWithNext, mergeSubtitleWithPrevious, nearestSubtitleWordBoundaryIndex, splitSubtitleAtWordBoundary, EditingOperationError } from '../../src/shared/editing/operations'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types'
import type { ProjectFile, SubtitleClip, SubtitleWord } from '../../src/shared/types'

const caption = (id: string, startUs: number, text: string, words: SubtitleWord[]): SubtitleClip => ({
  id,
  name: id,
  kind: 'subtitle',
  startUs,
  durationUs: 1_000_000,
  sourceInUs: startUs,
  enabled: true,
  text,
  words,
  style: structuredClone(DEFAULT_SUBTITLE_STYLE)
})

const fixture = (): ProjectFile => {
  const project = createEmptyProject('字幕編集fixture')
  const track = project.tracks.find((item) => item.kind === 'subtitle')!
  track.clips = [
    caption('caption-a', 0, '字幕を入力', [
      { id: 'word-a-1', text: '字幕', startUs: 0, endUs: 300_000 },
      { id: 'word-a-2', text: 'を', startUs: 300_000, endUs: 500_000 },
      { id: 'word-a-3', text: '入力', startUs: 500_000, endUs: 800_000 }
    ]),
    caption('caption-b', 1_200_000, '次の字幕', [
      { id: 'word-b-1', text: '次の', startUs: 1_200_000, endUs: 1_500_000 },
      { id: 'word-b-2', text: '字幕', startUs: 1_500_000, endUs: 1_800_000 }
    ]),
    caption('caption-c', 2_400_000, '最後', [
      { id: 'word-c-1', text: '最後', startUs: 2_400_000, endUs: 2_700_000 }
    ])
  ]
  return validateProject(project)
}

const captions = (project: ProjectFile): SubtitleClip[] => project.tracks.flatMap((track) => track.clips).filter((clip): clip is SubtitleClip => clip.kind === 'subtitle')

describe('subtitle editing foundation', () => {
  it('finds the nearest boundary, treats gaps as boundary regions, and breaks ties to the left', () => {
    const project = fixture()
    const track = project.tracks.find((item) => item.kind === 'subtitle')!
    const clip = track.clips[0]
    if (clip?.kind !== 'subtitle') throw new Error('subtitle fixture missing')
    expect(nearestSubtitleWordBoundaryIndex(clip, 450_000)).toBe(1)
    expect(nearestSubtitleWordBoundaryIndex(clip, 650_000)).toBe(1)
    expect(nearestSubtitleWordBoundaryIndex(clip, 400_000)).toBe(0)
    expect(nearestSubtitleWordBoundaryIndex(clip, 0)).toBe(0)
    expect(nearestSubtitleWordBoundaryIndex(clip, 1_000_000)).toBe(null)
  })

  it('selects a gap as zero-distance and rejects invalid split metadata', () => {
    const project = fixture()
    const track = project.tracks.find((item) => item.kind === 'subtitle')!
    const clip = track.clips[0]
    if (clip?.kind !== 'subtitle' || !clip.words) throw new Error('subtitle fixture missing')
    clip.words[1]!.startUs = 600_000
    expect(nearestSubtitleWordBoundaryIndex(clip, 550_000)).toBe(0)
    const mismatch = structuredClone(clip)
    mismatch.text = '別の本文'
    expect(isSubtitleWordBoundarySplitAvailable(mismatch)).toBe(false)
    expect(nearestSubtitleWordBoundaryIndex(mismatch, 500_000)).toBe(null)
    expect(nearestSubtitleWordBoundaryIndex({ ...clip, words: [clip.words[0]!] }, 500_000)).toBe(null)
  })
  it('splits at a word boundary with exact text and timestamps', () => {
    const next = splitSubtitleAtWordBoundary(fixture(), 'caption-a', 1)
    const result = captions(next)
    expect(result).toHaveLength(4)
    expect(result[0]).toMatchObject({ id: 'caption-a', text: '字幕を', startUs: 0, durationUs: 500_000 })
    expect(result[1]).toMatchObject({ text: '入力', startUs: 500_000, durationUs: 500_000, sourceInUs: 500_000 })
    expect(result[0]!.words?.map((word) => word.id)).toEqual(['word-a-1', 'word-a-2'])
    expect(result[1]!.words?.map((word) => word.id)).toEqual(['word-a-3'])
    expect(result.map((clip) => clip.text).join('')).toContain('字幕を入力')
  })

  it('rejects a boundary without word metadata and keeps the source project unchanged', () => {
    const project = fixture()
    const withoutWords = structuredClone(project)
    const first = withoutWords.tracks[1]!.clips[0]!
    if (first.kind === 'subtitle') first.words = undefined
    expect(() => splitSubtitleAtWordBoundary(withoutWords, first.id, 0)).toThrow(EditingOperationError)
    expect(withoutWords.tracks[1]!.clips).toHaveLength(3)
  })

  it('does not allow an out-of-range boundary', () => {
    expect(() => splitSubtitleAtWordBoundary(fixture(), 'caption-a', 99)).toThrow('分割できません')
  })

  it('merges previous and next captions in timeline order', () => {
    const project = fixture()
    const mergedPrevious = mergeSubtitleWithPrevious(project, 'caption-b')
    const previousResult = captions(mergedPrevious)
    expect(previousResult.map((clip) => clip.id)).toEqual(['caption-a', 'caption-c'])
    expect(previousResult[0]).toMatchObject({ text: '字幕を入力次の字幕', startUs: 0, durationUs: 2_200_000 })
    expect(previousResult[0]!.words?.map((word) => word.id)).toEqual(['word-a-1', 'word-a-2', 'word-a-3', 'word-b-1', 'word-b-2'])

    const mergedNext = mergeSubtitleWithNext(project, 'caption-b')
    const nextResult = captions(mergedNext)
    expect(nextResult.map((clip) => clip.id)).toEqual(['caption-a', 'caption-b'])
    expect(nextResult[1]).toMatchObject({ text: '次の字幕最後', startUs: 1_200_000, durationUs: 2_200_000 })
  })

  it('rejects a non-adjacent merge and preserves IDs without collisions', () => {
    expect(() => mergeSubtitleWithPrevious(fixture(), 'caption-a')).toThrow('前に結合できる字幕がありません')
    const split = splitSubtitleAtWordBoundary(fixture(), 'caption-a', 0)
    const ids = captions(split).map((clip) => clip.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(validateProject(JSON.parse(JSON.stringify(split)))).toEqual(split)
  })
})
