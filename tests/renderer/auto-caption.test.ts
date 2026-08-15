import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClipForAsset, createEmptyProject, addClipToTrack } from '../../src/shared/project'
import type { DesktopApi, MediaAsset } from '../../src/shared/types'
import { useEditorStore } from '../../src/renderer/src/store'

const asset: MediaAsset = {
  id: 'auto-caption-media', name: 'generated.mp4', path: 'C:\\generated.mp4', kind: 'video', durationUs: 4_000_000,
  width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, hasAudio: true,
  fileSize: 1, modifiedAt: '2026-08-15T00:00:00.000Z', offline: false
}

afterEach(() => {
  delete window.spectra
})

describe('automatic caption insertion', () => {
  it('creates editable word-bearing subtitle clips in one undoable project change', async () => {
    let project = { ...createEmptyProject('auto caption'), media: [asset] }
    const video = { ...createClipForAsset(asset, 0, 4_000_000), id: 'auto-caption-video' }
    project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, video)
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('auto-caption-video')
    let progress: ((value: any) => void) | undefined
    const startAutoCaption = vi.fn(async () => {
      progress?.({
        version: 'spectra.auto-caption.progress.v1',
        jobId: 'caption-job-test',
        state: 'completed',
        ratio: 1,
        message: '完了',
        result: {
          version: 'spectra.auto-caption.result.v1',
          jobId: 'caption-job-test',
          sourceStartUs: 0,
          sourceEndUs: 4_000_000,
          language: 'ja',
          provider: 'faster-whisper+caption.py',
          model: 'test',
          rawWords: [
            { id: 'source-word:0', text: '字幕', startUs: 0, endUs: 500_000 },
            { id: 'source-word:1', text: 'テスト', startUs: 500_000, endUs: 1_000_000 }
          ],
          captions: [{ id: 'caption:0', text: '字幕テスト', sourceWordIds: ['source-word:0', 'source-word:1'], startUs: 0, endUs: 1_000_000, textStatus: 'as_transcribed', provenance: 'caption_algorithm' }],
          diagnostics: [],
          fallback: { used: false }
        }
      })
      return { jobId: 'caption-job-test', clipId: 'auto-caption-video' }
    })
    window.spectra = {
      autoCaptionHealth: vi.fn().mockResolvedValue({ available: true, checkedAt: new Date().toISOString(), provider: 'clip_automation' }),
      startAutoCaption,
      onAutoCaptionProgress: vi.fn((callback) => { progress = callback; return () => { progress = undefined } })
    } as unknown as DesktopApi

    await useEditorStore.getState().autoCaptionSelected()

    const captions = useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips
    expect(captions).toHaveLength(1)
    expect(captions[0]?.kind === 'subtitle' ? captions[0].text : undefined).toBe('字幕テスト')
    expect(captions[0]?.kind === 'subtitle' ? captions[0].words?.[0]?.id : undefined).toBe('source-word:0')
    expect(captions[0]?.kind === 'subtitle' ? captions[0].editUnits?.map((unit) => unit.parentSourceWordId) : []).toEqual(['source-word:0', 'source-word:1'])
    expect(useEditorStore.getState().past).toHaveLength(1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips).toHaveLength(0)
    expect(startAutoCaption).toHaveBeenCalledWith(expect.anything(), ['auto-caption-video'])
  })
})
