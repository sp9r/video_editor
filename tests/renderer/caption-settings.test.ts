import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject, createSubtitleClip } from '../../src/shared/project'
import { RESEGMENT_RESULT_VERSION, type ResegmentRequest, type ResegmentResult } from '../../src/shared/auto-caption-contract'
import { DEFAULT_SUBTITLE_STYLE, type DesktopApi, type SubtitleClip } from '../../src/shared/types'
import { useEditorStore } from '../../src/renderer/src/store'

const US = 1_000_000

const captionWithWords = (id: string, startUs: number, wordTexts: string[], firstWord: number): SubtitleClip => {
  const words = wordTexts.map((text, index) => ({ id: `source-word:${firstWord + index}`, text, startUs: startUs + index * US, endUs: startUs + index * US + 900_000 }))
  return {
    ...createSubtitleClip(startUs, wordTexts.length * US),
    id,
    text: wordTexts.join(''),
    style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), fontSize: 100, maxWidthPercent: 80 },
    maxLines: 2,
    sourceJobId: 'caption-job-1',
    sourceWordIds: words.map((word) => word.id),
    words
  }
}

const buildProject = () => {
  const base = createEmptyProject('caption settings')
  const track = base.tracks.find((candidate) => candidate.kind === 'subtitle')!
  const handEdited: SubtitleClip = { ...createSubtitleClip(5 * US, 2 * US), id: 'hand-edited', text: '手で直した字幕', style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), fontSize: 100 }, maxLines: 2 }
  track.clips = [
    captionWithWords('cap-a', 0, ['就職試験の', '面接を', '英語で', '突破する'], 0),
    handEdited,
    captionWithWords('cap-c', 8 * US, ['コツを', '3分で', '解説します'], 4)
  ]
  return { project: base, trackId: track.id }
}

/** A stand-in for the worker: one caption per word (the real segmentation lives in the worker). */
const fakeResegment = vi.fn(async (request: ResegmentRequest): Promise<ResegmentResult> => ({
  version: RESEGMENT_RESULT_VERSION,
  jobId: request.jobId,
  method: 'heuristic',
  captions: request.words.map((word, index) => ({
    id: `${request.jobId}-caption-${index + 1}`,
    text: word.text,
    startUs: word.startUs,
    endUs: Math.max(word.endUs, word.startUs + 1),
    sourceWordIds: [word.id],
    textStatus: 'as_transcribed' as const
  }))
}))

afterEach(() => {
  delete window.spectra
  fakeResegment.mockClear()
})

describe('changing caption settings after the captions exist', () => {
  const settings = { maxChars: 32, maxLines: 1, maxWidthPercent: 60, segmentationMode: 'rule' as const }

  it('re-splits from stored words as one undo step and keeps hand-edited captions', async () => {
    window.spectra = { resegmentCaptions: fakeResegment } as unknown as DesktopApi
    const { project, trackId } = buildProject()
    useEditorStore.getState().loadProject(project)
    const before = structuredClone(useEditorStore.getState().project)
    const pastBefore = useEditorStore.getState().past.length

    const result = await useEditorStore.getState().applyCaptionSettings({ trackId, scope: 'track', settings, language: 'ja' })

    expect(result).toMatchObject({ resegmented: true, keptCount: 1 })
    expect(fakeResegment).toHaveBeenCalledTimes(2) // one run before and one after the hand-edited caption
    const after = useEditorStore.getState().project
    const track = after.tracks.find((candidate) => candidate.id === trackId)!
    const clips = track.clips.filter((clip): clip is SubtitleClip => clip.kind === 'subtitle')
    // The hand-edited caption is untouched except for the new wrap settings.
    const kept = clips.find((clip) => clip.id === 'hand-edited')!
    expect(kept.text).toBe('手で直した字幕')
    expect(kept.startUs).toBe(5 * US)
    expect(kept.durationUs).toBe(2 * US)
    expect(kept.maxLines).toBe(1)
    expect(kept.style.maxWidthPercent).toBe(60)
    // Re-split captions own every source word once, in order, between the kept caption.
    const others = clips.filter((clip) => clip.id !== 'hand-edited')
    expect(others.map((clip) => clip.text).join('')).toBe('就職試験の面接を英語で突破するコツを3分で解説します')
    expect(others.flatMap((clip) => clip.sourceWordIds ?? [])).toEqual(Array.from({ length: 7 }, (_, index) => `source-word:${index}`))
    for (const clip of others) {
      expect(clip.maxLines).toBe(1)
      expect(clip.style.maxWidthPercent).toBe(60)
      expect(clip.style.fontSize).toBe(100)
      expect(clip.editUnits?.map((unit) => unit.text).join('')).toBe(clip.text)
    }
    // No overlaps anywhere in the track.
    for (let index = 1; index < clips.length; index += 1) expect(clips[index - 1]!.startUs + clips[index - 1]!.durationUs).toBeLessThanOrEqual(clips[index]!.startUs)
    expect(track.captionLayout).toMatchObject(settings)
    expect(useEditorStore.getState().captionLayoutDefaults).toMatchObject(settings)
    expect(useEditorStore.getState().notice?.message).toContain('手で編集した（または単語情報のない）字幕1件はそのまま残しました')
    // One undo step restores everything.
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project).toEqual(before)
  })

  it('applies appearance-only changes at once without calling the worker', async () => {
    window.spectra = { resegmentCaptions: fakeResegment } as unknown as DesktopApi
    const { project, trackId } = buildProject()
    useEditorStore.getState().loadProject(project)
    const same = { maxChars: 32, maxLines: 2, maxWidthPercent: 80, segmentationMode: 'rule' as const }
    // First apply records the track settings; the second changes only colours.
    await useEditorStore.getState().applyCaptionSettings({ trackId, scope: 'track', settings: same, language: 'ja' })
    fakeResegment.mockClear()
    const pastBefore = useEditorStore.getState().past.length
    const result = await useEditorStore.getState().applyCaptionSettings({ trackId, scope: 'track', settings: same, language: 'ja', stylePatch: { color: '#ffcc00' } })
    expect(result).toMatchObject({ resegmented: false })
    expect(fakeResegment).not.toHaveBeenCalled()
    const track = useEditorStore.getState().project.tracks.find((candidate) => candidate.id === trackId)!
    expect(track.clips.every((clip) => clip.kind === 'subtitle' && clip.style.color === '#ffcc00')).toBe(true)
    expect(useEditorStore.getState().past.length).toBe(pastBefore + 1)
  })

  it('limits the change to the selected captions', async () => {
    window.spectra = { resegmentCaptions: fakeResegment } as unknown as DesktopApi
    const { project, trackId } = buildProject()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('cap-c')
    const result = await useEditorStore.getState().applyCaptionSettings({ trackId, scope: 'selection', settings, language: 'ja' })
    expect(result).toMatchObject({ resegmented: true, keptCount: 0 })
    const clips = useEditorStore.getState().project.tracks.find((candidate) => candidate.id === trackId)!.clips as SubtitleClip[]
    expect(clips.find((clip) => clip.id === 'cap-a')).toMatchObject({ maxLines: 2, text: '就職試験の面接を英語で突破する' })
    expect(clips.find((clip) => clip.id === 'hand-edited')?.maxLines).toBe(2)
    expect(clips.filter((clip) => clip.startUs >= 8 * US).map((clip) => clip.text)).toEqual(['コツを', '3分で', '解説します'])
  })

  it('does not change the project when the worker fails', async () => {
    window.spectra = { resegmentCaptions: vi.fn(async () => { throw new Error('boom') }) } as unknown as DesktopApi
    const { project, trackId } = buildProject()
    useEditorStore.getState().loadProject(project)
    const before = structuredClone(useEditorStore.getState().project)
    const result = await useEditorStore.getState().applyCaptionSettings({ trackId, scope: 'track', settings, language: 'ja' })
    expect(result).toBeNull()
    expect(useEditorStore.getState().project).toEqual(before)
    expect(useEditorStore.getState().notice?.tone).toBe('error')
  })
})
