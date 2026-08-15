import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClipForAsset, createEmptyProject, addClipToTrack } from '../../src/shared/project'
import { DEFAULT_SUBTITLE_STYLE, type DesktopApi, type MediaAsset } from '../../src/shared/types'
import type { UserSubtitleTemplate } from '../../src/shared/subtitle-templates'
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
    const template: UserSubtitleTemplate = {
      version: 'spectra.subtitle-template.v1', id: 'user-template', name: '配信用',
      style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), fontSize: 88, outlineWidth: 6 }, maxChars: 40, maxLines: 3,
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z'
    }
    useEditorStore.getState().setUserSubtitleTemplates([template])
    const before = structuredClone(useEditorStore.getState().project)
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
    const startFullCorrectionSession = vi.fn().mockResolvedValue({ sessionId: 'full-correction-after-auto', status: 'active' })
    window.spectra = {
      autoCaptionHealth: vi.fn().mockResolvedValue({ available: true, checkedAt: new Date().toISOString(), provider: 'clip_automation' }),
      startAutoCaption,
      onAutoCaptionProgress: vi.fn((callback) => { progress = callback; return () => { progress = undefined } }),
      startFullCorrectionSession
    } as unknown as DesktopApi

    await useEditorStore.getState().autoCaptionSelected({ language: 'ja', maxChars: 40, maxLines: 3, segmentationMode: 'rule', subtitleTemplate: template.id })

    const subtitleTracks = useEditorStore.getState().project.tracks.filter((track) => track.kind === 'subtitle')
    const generatedTrack = subtitleTracks.find((track) => track.name === '自動字幕')!
    const captions = generatedTrack.clips
    expect(captions).toHaveLength(1)
    expect(captions[0]?.kind === 'subtitle' ? captions[0].text : undefined).toBe('字幕テスト')
    expect(captions[0]?.kind === 'subtitle' ? captions[0].words?.[0]?.id : undefined).toBe('source-word:0')
    expect(captions[0]?.kind === 'subtitle' ? captions[0].editUnits?.map((unit) => unit.parentSourceWordId) : []).toEqual(['source-word:0', 'source-word:1'])
    expect(captions[0]?.kind === 'subtitle' ? captions[0].maxLines : undefined).toBe(3)
    expect(captions[0]?.kind === 'subtitle' ? captions[0].style.fontSize : undefined).toBe(88)
    expect(captions[0]?.kind === 'subtitle' ? captions[0].style.outlineWidth : undefined).toBe(6)
    const after = structuredClone(useEditorStore.getState().project)
    expect(useEditorStore.getState().past).toHaveLength(1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project).toEqual(before)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().project).toEqual(after)
    useEditorStore.getState().selectClip(captions[0]!.id)
    expect(await useEditorStore.getState().startFullCorrection()).toBe(true)
    expect(startFullCorrectionSession).toHaveBeenCalledWith(after, generatedTrack.id)
    expect(startAutoCaption).toHaveBeenCalledWith(expect.anything(), ['auto-caption-video'], { language: 'ja', maxChars: 40, maxLines: 3, segmentationMode: 'rule', subtitleTemplate: template.id })
  })

  it('reconciles a completed result from main-process status when the push event was missed', async () => {
    let project = { ...createEmptyProject('auto caption status recovery'), media: [asset] }
    const video = { ...createClipForAsset(asset, 0, 4_000_000), id: 'auto-caption-status-video' }
    project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, video)
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip(video.id)
    const jobId = 'caption-job-status-recovery'
    const result = {
      version: 'spectra.auto-caption.result.v1' as const, jobId, sourceStartUs: 0, sourceEndUs: 4_000_000,
      language: 'ja', provider: 'test', model: 'test',
      rawWords: [{ id: 'status-word', text: '復旧', startUs: 500_000, endUs: 1_000_000 }],
      captions: [{ id: 'status-caption', text: '復旧', sourceWordIds: ['status-word'], startUs: 500_000, endUs: 1_000_000, textStatus: 'as_transcribed' as const, provenance: 'caption_algorithm' as const }],
      diagnostics: [], fallback: { used: false }
    }
    const startAutoCaption = vi.fn().mockResolvedValue({ jobId, clipId: video.id })
    const getAutoCaptionStatus = vi.fn().mockResolvedValue({
      jobId, clipId: video.id,
      progress: { version: 'spectra.auto-caption.progress.v1' as const, jobId, state: 'completed' as const, ratio: 1, message: '完了', result }
    })
    window.spectra = {
      autoCaptionHealth: vi.fn().mockResolvedValue({ available: true, checkedAt: new Date().toISOString(), provider: 'clip_automation' }),
      startAutoCaption, getAutoCaptionStatus, onAutoCaptionProgress: vi.fn(() => () => undefined)
    } as unknown as DesktopApi

    await useEditorStore.getState().autoCaptionSelected()
    expect(getAutoCaptionStatus).toHaveBeenCalledWith(jobId)
    expect(useEditorStore.getState().project.tracks.flatMap((track) => track.clips).some((clip) => clip.kind === 'subtitle' && clip.sourceJobId === jobId)).toBe(true)
  })

  it('protects existing captions and names reruns independently', async () => {
    let project = { ...createEmptyProject('auto caption rerun'), media: [asset] }
    const video = { ...createClipForAsset(asset, 0, 4_000_000), id: 'auto-caption-video-rerun' }
    project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, video)
    const existing = project.tracks.find((track) => track.kind === 'subtitle')!
    existing.clips.push({ id: 'manual-caption', name: '手修正', kind: 'subtitle', startUs: 0, durationUs: 1_000_000, sourceInUs: 0, enabled: true, text: '手修正', style: structuredClone((await import('../../src/shared/types')).DEFAULT_SUBTITLE_STYLE) })
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('auto-caption-video-rerun')
    let progress: ((value: any) => void) | undefined
    const startAutoCaption = vi.fn(async (_project: unknown, _ids: string[]) => {
      progress?.({ version: 'spectra.auto-caption.progress.v1', jobId: `job-${startAutoCaption.mock.calls.length}`, state: 'completed', ratio: 1, message: '完了', result: {
        version: 'spectra.auto-caption.result.v1', jobId: `job-${startAutoCaption.mock.calls.length}`, sourceStartUs: 0, sourceEndUs: 4_000_000, language: 'ja', provider: 'test', model: 'test',
        rawWords: [{ id: `word-${startAutoCaption.mock.calls.length}`, text: '字幕', startUs: 0, endUs: 500_000 }],
        captions: [{ id: `caption-${startAutoCaption.mock.calls.length}`, text: '字幕', sourceWordIds: [`word-${startAutoCaption.mock.calls.length}`], startUs: 0, endUs: 500_000, textStatus: 'as_transcribed', provenance: 'caption_algorithm' }], diagnostics: [], fallback: { used: false }
      } })
      return { jobId: `job-${startAutoCaption.mock.calls.length}`, clipId: 'auto-caption-video-rerun' }
    })
    window.spectra = {
      autoCaptionHealth: vi.fn().mockResolvedValue({ available: true, checkedAt: new Date().toISOString(), provider: 'clip_automation' }), startAutoCaption,
      onAutoCaptionProgress: vi.fn((callback) => { progress = callback; return () => { progress = undefined } })
    } as unknown as DesktopApi
    await useEditorStore.getState().autoCaptionSelected()
    useEditorStore.getState().selectClip('auto-caption-video-rerun')
    await useEditorStore.getState().autoCaptionSelected()
    const tracks = useEditorStore.getState().project.tracks.filter((track) => track.kind === 'subtitle')
    expect(tracks.map((track) => track.name)).toEqual(['C1', '自動字幕', '自動字幕 2'])
    expect(tracks[0]?.clips[0]?.id).toBe('manual-caption')
    expect(useEditorStore.getState().past).toHaveLength(2)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.filter((track) => track.name === '自動字幕')).toHaveLength(1)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().project.tracks.filter((track) => track.name === '自動字幕 2')).toHaveLength(1)
  })

  it('applies keep ranges with captions as one undoable linked timeline change', async () => {
    let project = { ...createEmptyProject('auto caption silence'), media: [asset] }
    const video = { ...createClipForAsset(asset, 0, 4_000_000), id: 'auto-caption-video-silence' }
    project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, video)
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip(video.id)
    let progress: ((value: any) => void) | undefined
    const startAutoCaption = vi.fn(async () => {
      progress?.({
        version: 'spectra.auto-caption.progress.v1', jobId: 'caption-job-silence', state: 'completed', ratio: 1, message: '完了',
        silenceAnalysis: {
          silences: [], keepRanges: [{ startUs: 0, endUs: 1_000_000, durationUs: 1_000_000 }, { startUs: 2_000_000, endUs: 4_000_000, durationUs: 2_000_000 }],
          removedDurationUs: 1_000_000,
          settings: { profile: 'natural', minSilenceUs: 600_000, retainPauseUs: 180_000, noiseDb: -35, speechProtectionUs: 120_000, fillerRemoval: false }, diagnostics: []
        },
        result: {
          version: 'spectra.auto-caption.result.v1', jobId: 'caption-job-silence', sourceStartUs: 0, sourceEndUs: 4_000_000,
          language: 'ja', provider: 'test', model: 'test', rawWords: [{ id: 'word-silence', text: '後半', startUs: 2_000_000, endUs: 2_500_000 }],
          captions: [{ id: 'caption-silence', text: '後半', sourceWordIds: ['word-silence'], startUs: 2_000_000, endUs: 2_500_000, textStatus: 'as_transcribed', provenance: 'caption_algorithm' }], diagnostics: [], fallback: { used: false }
        }
      })
      return { jobId: 'caption-job-silence', clipId: video.id }
    })
    window.spectra = {
      autoCaptionHealth: vi.fn().mockResolvedValue({ available: true, checkedAt: new Date().toISOString(), provider: 'clip_automation' }),
      startAutoCaption, onAutoCaptionProgress: vi.fn((callback) => { progress = callback; return () => { progress = undefined } })
    } as unknown as DesktopApi

    await useEditorStore.getState().autoCaptionSelected()
    const state = useEditorStore.getState()
    const mediaClips = state.project.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === 'video')
    expect(mediaClips.map((clip) => [clip.sourceInUs, clip.durationUs, clip.startUs])).toEqual([[0, 1_000_000, 0], [2_000_000, 2_000_000, 1_000_000]])
    const caption = state.project.tracks.flatMap((track) => track.clips).find((clip) => clip.kind === 'subtitle' && clip.sourceJobId)
    expect(caption?.kind === 'subtitle' ? [caption.startUs, caption.durationUs] : undefined).toEqual([1_000_000, 500_000])
    expect(state.past).toHaveLength(1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === 'video')).toHaveLength(1)
    expect(useEditorStore.getState().project.tracks.some((track) => track.clips.some((clip) => clip.kind === 'subtitle' && clip.sourceJobId))).toBe(false)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().project.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === 'video')).toHaveLength(2)
  })

  it('keeps the project unchanged when the worker fails before apply', async () => {
    let project = { ...createEmptyProject('auto caption failure'), media: [asset] }
    const video = { ...createClipForAsset(asset, 0, 4_000_000), id: 'auto-caption-video-failure' }
    project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, video)
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('auto-caption-video-failure')
    let progress: ((value: any) => void) | undefined
    window.spectra = {
      autoCaptionHealth: vi.fn().mockResolvedValue({ available: true, checkedAt: new Date().toISOString(), provider: 'clip_automation' }),
      startAutoCaption: vi.fn(async () => {
        progress?.({ version: 'spectra.auto-caption.progress.v1', jobId: 'caption-job-failure', state: 'failed', ratio: 0, message: 'failed', errorCode: 'WORKER_FAILED' })
        return { jobId: 'caption-job-failure', clipId: 'auto-caption-video-failure' }
      }),
      onAutoCaptionProgress: vi.fn((callback) => { progress = callback; return () => { progress = undefined } })
    } as unknown as DesktopApi
    const before = structuredClone(useEditorStore.getState().project)
    await useEditorStore.getState().autoCaptionSelected()
    expect(useEditorStore.getState().project).toEqual(before)
    expect(useEditorStore.getState().past).toHaveLength(0)
    expect(useEditorStore.getState().notice?.message).toContain('WORKER_FAILED')
  })

  it('keeps the project unchanged when a started job is cancelled', async () => {
    let project = { ...createEmptyProject('auto caption cancellation'), media: [asset] }
    const video = { ...createClipForAsset(asset, 0, 4_000_000), id: 'auto-caption-video-cancel' }
    project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, video)
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip(video.id)
    let progress: ((value: any) => void) | undefined
    let resolveStart: ((value: { jobId: string; clipId: string }) => void) | undefined
    const startAutoCaption = vi.fn(() => new Promise<{ jobId: string; clipId: string }>((resolve) => { resolveStart = resolve }))
    const cancelAutoCaption = vi.fn().mockResolvedValue(true)
    window.spectra = {
      autoCaptionHealth: vi.fn().mockResolvedValue({ available: true, checkedAt: new Date().toISOString(), provider: 'clip_automation' }),
      startAutoCaption,
      cancelAutoCaption,
      onAutoCaptionProgress: vi.fn((callback) => { progress = callback; return () => { progress = undefined } })
    } as unknown as DesktopApi
    const before = structuredClone(useEditorStore.getState().project)
    const run = useEditorStore.getState().autoCaptionSelected()
    await vi.waitFor(() => expect(startAutoCaption).toHaveBeenCalled())
    resolveStart!({ jobId: 'caption-job-cancel', clipId: video.id })
    await vi.waitFor(() => expect(useEditorStore.getState().autoCaptionJobId).toBe('caption-job-cancel'))
    await useEditorStore.getState().cancelAutoCaption()
    progress?.({ version: 'spectra.auto-caption.progress.v1', jobId: 'caption-job-cancel', state: 'failed', ratio: 0, message: 'キャンセル', errorCode: 'CANCELLED' })
    expect(await run).toBeNull()
    expect(cancelAutoCaption).toHaveBeenCalledWith('caption-job-cancel')
    expect(useEditorStore.getState().project).toEqual(before)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })
})
