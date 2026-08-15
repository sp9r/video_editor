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
    const generateCaptions = vi.fn().mockResolvedValue({
      kind: 'transcript',
      language: 'ja',
      segments: [{
        startUs: 0,
        endUs: 1_000_000,
        text: '字幕テスト',
        words: [
          { id: 'source-word:0', text: '字幕', startUs: 0, endUs: 500_000 },
          { id: 'source-word:1', text: 'テスト', startUs: 500_000, endUs: 1_000_000 }
        ]
      }]
    })
    window.spectra = { generateCaptions } as unknown as DesktopApi

    await useEditorStore.getState().autoCaptionSelected()

    const captions = useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips
    expect(captions).toHaveLength(1)
    expect(captions[0]?.kind === 'subtitle' ? captions[0].text : undefined).toBe('字幕テスト')
    expect(captions[0]?.kind === 'subtitle' ? captions[0].words?.[0]?.id : undefined).toBe('source-word:0')
    expect(captions[0]?.kind === 'subtitle' ? captions[0].editUnits?.map((unit) => unit.parentSourceWordId) : []).toEqual(['source-word:0', 'source-word:1'])
    expect(useEditorStore.getState().past).toHaveLength(1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips).toHaveLength(0)
    expect(generateCaptions).toHaveBeenCalledWith(expect.anything(), 'auto-caption-video')
  })
})
