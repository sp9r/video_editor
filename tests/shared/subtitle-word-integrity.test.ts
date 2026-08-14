import { describe, expect, it } from 'vitest'
import { createEmptyProject, createTrack, findSubtitleContext, shiftClipTimeline, subtitleWordsMatchText, subtitleTrimKeepsWordTiming, validateProject } from '../../src/shared/project'
import { deleteLinkedClips, EditingOperationError, mergeSubtitleWithNext, moveLinkedClip, splitLinkedClip, trimLinkedClip } from '../../src/shared/editing/operations'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types'
import type { ProjectFile, SubtitleClip } from '../../src/shared/types'

const wordCaption = (id: string, startUs: number, text = '字幕を入力'): SubtitleClip => ({
  id,
  name: id,
  kind: 'subtitle',
  startUs,
  durationUs: 2_000_000,
  sourceInUs: 0,
  enabled: true,
  text,
  style: structuredClone(DEFAULT_SUBTITLE_STYLE),
  words: [
    { id: `${id}-1`, text: '字幕', startUs: startUs + 100_000, endUs: startUs + 500_000 },
    { id: `${id}-2`, text: 'を', startUs: startUs + 500_000, endUs: startUs + 800_000 },
    { id: `${id}-3`, text: '入力', startUs: startUs + 1_000_000, endUs: startUs + 1_600_000 }
  ]
})

const projectWithWords = (): ProjectFile => {
  const project = createEmptyProject('word integrity')
  project.tracks.find((track) => track.kind === 'subtitle')!.clips = [wordCaption('caption', 10_000_000)]
  return validateProject(project)
}

const clip = (project: ProjectFile, id: string): SubtitleClip => {
  const found = project.tracks.flatMap((track) => track.clips).find((item) => item.id === id)
  if (!found || found.kind !== 'subtitle') throw new Error(`missing subtitle ${id}`)
  return found
}

describe('subtitle word metadata integrity', () => {
  it('resolves previous and next only within the selected subtitle track', () => {
    const project = projectWithWords()
    const firstTrack = project.tracks.find((track) => track.kind === 'subtitle')!
    firstTrack.clips = [wordCaption('a', 0), wordCaption('b', 2_500_000)]
    const secondTrack = createTrack('subtitle', 2)
    secondTrack.clips = [wordCaption('x', 1_000_000)]
    project.tracks.push(secondTrack)
    const context = findSubtitleContext(project, 'b')
    expect(context.previous?.id).toBe('a')
    expect(context.next).toBeUndefined()
    const merged = mergeSubtitleWithNext(project, 'a')
    expect(merged.tracks.find((track) => track.id === firstTrack.id)?.clips.map((item) => item.id)).toEqual(['a'])
    expect(merged.tracks.find((track) => track.id === secondTrack.id)?.clips.map((item) => item.id)).toEqual(['x'])
  })

  it('shifts absolute word timestamps with a moved caption', () => {
    const project = projectWithWords()
    const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')!
    const moved = moveLinkedClip(project, 'caption', subtitleTrack.id, 15_000_000)
    expect(clip(moved, 'caption')).toMatchObject({ startUs: 15_000_000 })
    expect(clip(moved, 'caption').words?.map((word) => [word.startUs, word.endUs])).toEqual([
      [15_100_000, 15_500_000], [15_500_000, 15_800_000], [16_000_000, 16_600_000]
    ])
  })

  it('keeps word timing when moving a caption to another subtitle track', () => {
    const project = projectWithWords()
    const sourceTrack = project.tracks.find((track) => track.kind === 'subtitle')!
    const targetTrack = createTrack('subtitle', 2)
    project.tracks.push(targetTrack)
    const moved = moveLinkedClip(project, 'caption', targetTrack.id, 10_000_000)
    expect(moved.tracks.find((track) => track.id === targetTrack.id)?.clips.map((item) => item.id)).toEqual(['caption'])
    expect(clip(moved, 'caption').words).toEqual(clip(project, 'caption').words)
    expect(moved.tracks.find((track) => track.id === sourceTrack.id)?.clips).toHaveLength(0)
  })

  it('preserves word timing when ripple delete shifts later captions', () => {
    const project = projectWithWords()
    const track = project.tracks.find((item) => item.kind === 'subtitle')!
    track.clips = [wordCaption('removed', 0), wordCaption('kept', 4_000_000)]
    const next = deleteLinkedClips(project, ['removed'], true)
    expect(clip(next, 'kept')).toMatchObject({ startUs: 2_000_000 })
    expect(clip(next, 'kept').words?.map((word) => [word.startUs, word.endUs])).toEqual([
      [2_100_000, 2_500_000], [2_500_000, 2_800_000], [3_000_000, 3_600_000]
    ])
  })

  it('allows trim outside the word range and rejects trim inside it', () => {
    const project = projectWithWords()
    const allowedStart = trimLinkedClip(project, 'caption', 'start', 10_000_000)
    expect(clip(allowedStart, 'caption').words).toEqual(clip(project, 'caption').words)
    expect(() => trimLinkedClip(project, 'caption', 'start', 10_200_000)).toThrow(EditingOperationError)
    expect(() => trimLinkedClip(project, 'caption', 'end', 11_500_000)).toThrow(EditingOperationError)
    expect(() => trimLinkedClip(project, 'caption', 'end', 12_500_000)).not.toThrow()
  })

  it('keeps mismatch metadata but disables matching and rejects word split', () => {
    const project = projectWithWords()
    const mismatched = structuredClone(project)
    clip(mismatched, 'caption').text = '編集済み'
    expect(subtitleWordsMatchText(clip(mismatched, 'caption'))).toBe(false)
    expect(() => splitLinkedClip(mismatched, 'caption', 11_000_000)).toThrow(EditingOperationError)
    expect(clip(mismatched, 'caption').words).toHaveLength(3)
  })

  it('merges valid words in order, drops unsafe metadata, and rejects reversed timestamps', () => {
    const valid = projectWithWords()
    const validTrack = valid.tracks.find((track) => track.kind === 'subtitle')!
    validTrack.clips.push(wordCaption('next', 12_000_000))
    const validMerged = mergeSubtitleWithNext(valid, 'caption')
    const validResult = clip(validMerged, 'caption')
    expect(validResult.words?.map((word) => word.id)).toEqual([
      'caption-1', 'caption-2', 'caption-3', 'next-1', 'next-2', 'next-3'
    ])

    const mismatch = projectWithWords()
    const mismatchTrack = mismatch.tracks.find((track) => track.kind === 'subtitle')!
    mismatchTrack.clips.push(wordCaption('next', 12_000_000, '編集済み'))
    expect(clip(mergeSubtitleWithNext(mismatch, 'caption'), 'caption').words).toBeUndefined()

    const reversed = projectWithWords()
    const reversedTrack = reversed.tracks.find((track) => track.kind === 'subtitle')!
    const reversedNext = wordCaption('next', 12_000_000)
    reversedNext.words![0]!.startUs = 10_500_000
    reversedTrack.clips.push(reversedNext)
    expect(() => mergeSubtitleWithNext(reversed, 'caption')).toThrow('順序が逆転')
  })

  it('uses the same pure shift policy and survives JSON save/reload validation', () => {
    const original = clip(projectWithWords(), 'caption')
    const shifted = shiftClipTimeline(original, 5_000_000)
    expect(shifted.startUs).toBe(15_000_000)
    expect(shifted.words?.[0]?.startUs).toBe(15_100_000)
    expect(subtitleTrimKeepsWordTiming(projectWithWords(), original, 'start', 10_000_000)).toBe(true)
    expect(subtitleTrimKeepsWordTiming(projectWithWords(), original, 'start', 10_200_000)).toBe(false)
    const movedBase = projectWithWords()
    const movedProject = moveLinkedClip(movedBase, 'caption', movedBase.tracks.find((track) => track.kind === 'subtitle')!.id, 15_000_000)
    const roundTrip = validateProject(JSON.parse(JSON.stringify(movedProject)))
    expect(roundTrip.tracks.find((track) => track.kind === 'subtitle')?.clips[0]).toMatchObject({ startUs: 15_000_000 })
    expect(roundTrip.tracks.find((track) => track.kind === 'subtitle')?.clips[0]).toEqual(shifted)
  })
})
