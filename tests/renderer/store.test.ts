import { describe, expect, it, vi } from 'vitest'
import { addClipToTrack, createClipForAsset, createEmptyProject, createTrack, validateProject } from '../../src/shared/project'
import { deriveSubtitleEditUnits } from '../../src/shared/editing/edit-units'
import { applySilenceCutToProject } from '../../src/shared/silence-cut'
import { DEFAULT_SUBTITLE_STYLE, type DesktopApi, type MediaAsset, type ProjectFile, type SubtitleClip, type TimelineClip } from '../../src/shared/types'
import { useEditorStore } from '../../src/renderer/src/store'

const asset: MediaAsset = {
  id: 'media', name: 'source.mp4', path: 'C:\\source.mp4', kind: 'video', durationUs: 8_000_000,
  width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, hasAudio: true,
  fileSize: 1, modifiedAt: '2026-08-13T00:00:00.000Z', offline: false
}

const fixture = (): ProjectFile => {
  let project = { ...createEmptyProject('history'), media: [asset] }
  project = { ...project, tracks: [...project.tracks, createTrack('media', 2)] }
  const video = { ...createClipForAsset(asset, 0, 4_000_000), id: 'video', linkGroupId: 'linked' }
  const audio = { ...createClipForAsset(asset, 0, 4_000_000), id: 'audio', kind: 'audio' as const, linkGroupId: 'linked', audio: { volumeDb: 0, pan: 0, fadeInUs: 0, fadeOutUs: 0 } }
  project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, video)
  return addClipToTrack(project, project.tracks.filter((track) => track.kind === 'media')[1]!.id, audio)
}

const collisionFixture = (): ProjectFile => {
  const project = createEmptyProject('collision warning')
  const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')!
  subtitleTrack.clips = [
    { id: 'moving', name: 'moving', kind: 'subtitle', startUs: 17_020_000, durationUs: 1_020_000, sourceInUs: 17_020_000, enabled: true, text: 'moving', style: structuredClone(DEFAULT_SUBTITLE_STYLE) },
    { id: 'neighbor', name: 'neighbor', kind: 'subtitle', startUs: 18_040_000, durationUs: 2_000_000, sourceInUs: 18_040_000, enabled: true, text: 'neighbor', style: structuredClone(DEFAULT_SUBTITLE_STYLE) }
  ]
  return project
}

describe('editor history and linked selection', () => {
  it('applies explicit silence reapply as one undo/redo transaction', async () => {
    const project = fixture()
    const before = structuredClone(project)
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    const start = vi.fn(async (_project, selectedClipId, jobId, _profile) => ({
        jobId, selectedClipId,
        analysis: {
          silences: [{ startUs: 1_500_000, endUs: 2_500_000, durationUs: 1_000_000 }],
          keepRanges: [{ startUs: 0, endUs: 1_400_000, durationUs: 1_400_000 }, { startUs: 1_600_000, endUs: 4_000_000, durationUs: 2_400_000 }],
          removedDurationUs: 200_000,
          settings: { profile: 'natural', minSilenceUs: 600_000, retainPauseUs: 180_000, noiseDb: -35, speechProtectionUs: 80_000, fillerRemoval: false },
          diagnostics: []
        }, protectedIntervals: [], alreadyRemovedSourceRanges: []
      }))
    window.spectra = { startSilenceCutReapply: start } as unknown as DesktopApi
    expect(await useEditorStore.getState().reapplySilenceCut()).toBe(true)
    expect(start).toHaveBeenCalledWith(project, 'video', expect.any(String), 'youtube')
    const after = structuredClone(useEditorStore.getState().project)
    expect(useEditorStore.getState().past).toHaveLength(1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project).toEqual(before)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().project).toEqual(after)
  })

  it('commits an open manual transaction before applying an async silence operation', async () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    useEditorStore.getState().beginEditTransaction()
    useEditorStore.getState().patchClip('video', (clip) => clip.kind === 'video' ? { ...clip, audio: { ...clip.audio, volumeDb: -3 } } : clip)
    const manual = structuredClone(useEditorStore.getState().project)
    window.spectra = {
      startSilenceCutReapply: vi.fn(async (_project, selectedClipId, jobId, _profile) => ({
        jobId, selectedClipId,
        analysis: {
          silences: [{ startUs: 1_500_000, endUs: 2_500_000, durationUs: 1_000_000 }],
          keepRanges: [{ startUs: 0, endUs: 1_400_000, durationUs: 1_400_000 }, { startUs: 1_600_000, endUs: 4_000_000, durationUs: 2_400_000 }],
          removedDurationUs: 200_000,
          settings: { profile: 'natural', minSilenceUs: 600_000, retainPauseUs: 180_000, noiseDb: -35, speechProtectionUs: 80_000, fillerRemoval: false },
          diagnostics: []
        }, protectedIntervals: [], alreadyRemovedSourceRanges: []
      }))
    } as unknown as DesktopApi
    expect(await useEditorStore.getState().reapplySilenceCut()).toBe(true)
    expect(useEditorStore.getState().transactionBase).toBeNull()
    expect(useEditorStore.getState().past).toHaveLength(2)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project).toEqual(manual)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project).toEqual(project)
  })

  it('conflicts immediately on the first change inside an open transaction', async () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    let resolveWorker: ((value: any) => void) | undefined
    const cancel = vi.fn(async () => undefined)
    window.spectra = {
      startSilenceCutReapply: vi.fn(() => new Promise((resolve) => { resolveWorker = resolve })),
      cancelSilenceCutReapply: cancel
    } as unknown as DesktopApi
    const running = useEditorStore.getState().reapplySilenceCut()
    await Promise.resolve()
    await Promise.resolve()
    expect(useEditorStore.getState().pendingAsyncMutation?.state).toBe('running')
    useEditorStore.getState().beginEditTransaction()
    useEditorStore.getState().patchClip('video', (clip) => clip.kind === 'video' ? { ...clip, enabled: false } : clip)
    expect(useEditorStore.getState().pendingAsyncMutation?.state).toBe('conflicted')
    expect(cancel).toHaveBeenCalled()
    resolveWorker?.({ jobId: useEditorStore.getState().silenceCutReapplyJobId, selectedClipId: 'video', analysis: { removedDurationUs: 0 } })
    expect(await running).toBe(false)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('turns an open manual transaction into history before save', () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().beginEditTransaction()
    useEditorStore.getState().patchClip('video', (clip) => clip.kind === 'video' ? { ...clip, audio: { ...clip.audio, volumeDb: -6 } } : clip)
    useEditorStore.getState().markSaved()
    expect(useEditorStore.getState().transactionBase).toBeNull()
    expect(useEditorStore.getState().past).toHaveLength(1)
    expect(useEditorStore.getState().dirty).toBe(false)
  })

  it('keeps Project and history unchanged on silence reapply failure', async () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    window.spectra = { startSilenceCutReapply: vi.fn().mockRejectedValue(new Error('FFmpeg failed')) } as unknown as DesktopApi
    const before = structuredClone(useEditorStore.getState().project)
    expect(await useEditorStore.getState().reapplySilenceCut()).toBe(false)
    expect(useEditorStore.getState().project).toEqual(before)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('treats a full keep analysis as a no-op without creating history', async () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    const before = structuredClone(useEditorStore.getState().project)
    window.spectra = {
      startSilenceCutReapply: vi.fn(async (_project, selectedClipId, jobId) => ({
        jobId, selectedClipId,
        analysis: {
          silences: [], keepRanges: [{ startUs: 0, endUs: 4_000_000, durationUs: 4_000_000 }], removedDurationUs: 0,
          settings: { profile: 'natural', minSilenceUs: 600_000, retainPauseUs: 180_000, noiseDb: -35, speechProtectionUs: 80_000, fillerRemoval: false }, diagnostics: []
        }, protectedIntervals: [], alreadyRemovedSourceRanges: []
      }))
    } as unknown as DesktopApi
    expect(await useEditorStore.getState().reapplySilenceCut()).toBe(true)
    expect(useEditorStore.getState().project).toEqual(before)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('restores a silence-cut family in one undo/redo transaction', () => {
    const original = fixture()
    const cut = applySilenceCutToProject(original, 'video', {
      keepRanges: [{ startUs: 0, endUs: 1_000_000, durationUs: 1_000_000 }, { startUs: 2_000_000, endUs: 4_000_000, durationUs: 2_000_000 }]
    }).project
    useEditorStore.getState().loadProject(cut)
    useEditorStore.getState().selectClip('video:silence:1')
    expect(useEditorStore.getState().restoreSilenceCut()).toBe(true)
    expect(useEditorStore.getState().project.tracks.flatMap((track) => track.clips).some((clip) => clip.id === 'video')).toBe(true)
    const restored = structuredClone(useEditorStore.getState().project)
    expect(useEditorStore.getState().past).toHaveLength(1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project).toEqual(cut)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().project).toEqual(restored)
  })

  it('keeps Project and history unchanged when explicit reapply is cancelled', async () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    const before = structuredClone(useEditorStore.getState().project)
    let rejectStart: ((reason?: unknown) => void) | undefined
    const cancel = vi.fn(async () => {
      rejectStart?.(new Error('無音再適用をキャンセルしました。'))
      return true
    })
    window.spectra = {
      startSilenceCutReapply: vi.fn((_project, _selectedClipId, _jobId) => new Promise((_resolve, reject) => { rejectStart = reject })),
      cancelSilenceCutReapply: cancel
    } as unknown as DesktopApi
    const pending = useEditorStore.getState().reapplySilenceCut()
    await Promise.resolve()
    await useEditorStore.getState().cancelSilenceCutReapply()
    expect(await pending).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(useEditorStore.getState().project).toEqual(before)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('does not apply a late reapply result after cancellation', async () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    const before = structuredClone(useEditorStore.getState().project)
    let resolveStart: ((value: Awaited<ReturnType<NonNullable<DesktopApi['startSilenceCutReapply']>>>) => void) | undefined
    const start = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<DesktopApi['startSilenceCutReapply']>>>>((resolve) => { resolveStart = resolve }))
    const cancel = vi.fn(async () => true)
    window.spectra = { startSilenceCutReapply: start, cancelSilenceCutReapply: cancel } as unknown as DesktopApi
    const pending = useEditorStore.getState().reapplySilenceCut()
    await Promise.resolve()
    const jobId = useEditorStore.getState().silenceCutReapplyJobId
    await useEditorStore.getState().cancelSilenceCutReapply()
    resolveStart?.({
      jobId: jobId ?? 'silence-reapply-late',
      selectedClipId: 'video',
      analysis: {
        silences: [{ startUs: 1_500_000, endUs: 2_500_000, durationUs: 1_000_000 }],
        keepRanges: [{ startUs: 0, endUs: 1_400_000, durationUs: 1_400_000 }, { startUs: 1_600_000, endUs: 4_000_000, durationUs: 2_400_000 }],
        removedDurationUs: 200_000,
        settings: { profile: 'natural', minSilenceUs: 600_000, retainPauseUs: 180_000, noiseDb: -35, speechProtectionUs: 80_000, fillerRemoval: false },
        diagnostics: []
      },
      protectedIntervals: [],
      alreadyRemovedSourceRanges: []
    })
    expect(await pending).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(useEditorStore.getState().project).toEqual(before)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('rejects a late reapply result after an accepted manual edit', async () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    let resolveStart: ((value: Awaited<ReturnType<NonNullable<DesktopApi['startSilenceCutReapply']>>>) => void) | undefined
    const start = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<DesktopApi['startSilenceCutReapply']>>>>((resolve) => { resolveStart = resolve }))
    const cancel = vi.fn(async () => true)
    window.spectra = { startSilenceCutReapply: start, cancelSilenceCutReapply: cancel } as unknown as DesktopApi
    const pending = useEditorStore.getState().reapplySilenceCut()
    await Promise.resolve()
    useEditorStore.getState().patchClip('video', (clip) => clip.kind === 'video' ? { ...clip, audio: { ...clip.audio, volumeDb: -3 } } : clip)
    const edited = structuredClone(useEditorStore.getState().project)
    const jobId = useEditorStore.getState().silenceCutReapplyJobId ?? 'silence-reapply-conflict'
    resolveStart?.({
      jobId, selectedClipId: 'video',
      analysis: {
        silences: [{ startUs: 1_500_000, endUs: 2_500_000, durationUs: 1_000_000 }],
        keepRanges: [{ startUs: 0, endUs: 1_400_000, durationUs: 1_400_000 }, { startUs: 1_600_000, endUs: 4_000_000, durationUs: 2_400_000 }],
        removedDurationUs: 200_000,
        settings: { profile: 'natural', minSilenceUs: 600_000, retainPauseUs: 180_000, noiseDb: -35, speechProtectionUs: 80_000, fillerRemoval: false },
        diagnostics: []
      }, protectedIntervals: [], alreadyRemovedSourceRanges: []
    })
    expect(await pending).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(useEditorStore.getState().project).toEqual(edited)
    expect(useEditorStore.getState().past).toHaveLength(1)
    expect(useEditorStore.getState().notice?.message).toBe('プロジェクトが変更されたため、自動処理結果を適用しませんでした。')
  })

  it('does not conflict on save and marks the project dirty when the valid result later applies', async () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    let resolveStart: ((value: Awaited<ReturnType<NonNullable<DesktopApi['startSilenceCutReapply']>>>) => void) | undefined
    window.spectra = {
      startSilenceCutReapply: vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<DesktopApi['startSilenceCutReapply']>>>>((resolve) => { resolveStart = resolve }))
    } as unknown as DesktopApi
    const pending = useEditorStore.getState().reapplySilenceCut()
    await Promise.resolve()
    useEditorStore.getState().markSaved()
    const jobId = useEditorStore.getState().silenceCutReapplyJobId ?? 'silence-reapply-save'
    resolveStart?.({
      jobId, selectedClipId: 'video',
      analysis: {
        silences: [{ startUs: 1_500_000, endUs: 2_500_000, durationUs: 1_000_000 }],
        keepRanges: [{ startUs: 0, endUs: 1_400_000, durationUs: 1_400_000 }, { startUs: 1_600_000, endUs: 4_000_000, durationUs: 2_400_000 }],
        removedDurationUs: 200_000,
        settings: { profile: 'natural', minSilenceUs: 600_000, retainPauseUs: 180_000, noiseDb: -35, speechProtectionUs: 80_000, fillerRemoval: false },
        diagnostics: []
      }, protectedIntervals: [], alreadyRemovedSourceRanges: []
    })
    expect(await pending).toBe(true)
    expect(useEditorStore.getState().past).toHaveLength(1)
    expect(useEditorStore.getState().dirty).toBe(true)
  })

  it('applies a valid silence threshold update as one independent history entry', async () => {
    const original = fixture()
    const cut = applySilenceCutToProject(original, 'video', {
      keepRanges: [{ startUs: 0, endUs: 1_000_000, durationUs: 1_000_000 }, { startUs: 2_000_000, endUs: 4_000_000, durationUs: 2_000_000 }]
    }).project
    useEditorStore.getState().loadProject(cut)
    useEditorStore.getState().selectClip('video:silence:1')
    const start = vi.fn(async (_project, selectedClipId, jobId, _profile, _minSilenceUs) => ({
      jobId, selectedClipId,
      analysis: {
        silences: [{ startUs: 1_500_000, endUs: 2_500_000, durationUs: 1_000_000 }],
        keepRanges: [{ startUs: 0, endUs: 1_200_000, durationUs: 1_200_000 }, { startUs: 1_800_000, endUs: 4_000_000, durationUs: 2_200_000 }],
        removedDurationUs: 600_000,
        settings: { profile: 'natural', minSilenceUs: 700_000, retainPauseUs: 180_000, noiseDb: -35, speechProtectionUs: 80_000, fillerRemoval: false },
        diagnostics: []
      }, protectedIntervals: [], alreadyRemovedSourceRanges: []
    }))
    window.spectra = { startSilenceCutReapply: start } as unknown as DesktopApi
    expect(await useEditorStore.getState().updateSilenceCutThreshold(700_000)).toBe(true)
    expect(start).toHaveBeenCalledWith(expect.anything(), 'video', expect.any(String), 'youtube', 700_000)
    expect(useEditorStore.getState().past).toHaveLength(1)
    const after = structuredClone(useEditorStore.getState().project)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project).toEqual(cut)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().project).toEqual(after)
  })

  it('turns an intentional subtitle collision into a warning without mutating editor state', () => {
    useEditorStore.getState().loadProject(collisionFixture())
    useEditorStore.getState().clearNotice()
    useEditorStore.getState().selectClip('moving')
    const before = structuredClone(useEditorStore.getState().project)
    useEditorStore.getState().moveSelected('moving', useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.id, 17_297_777.777777776)
    const state = useEditorStore.getState()
    expect(state.project).toEqual(before)
    expect(state.past).toHaveLength(0)
    expect(state.future).toHaveLength(0)
    expect(state.dirty).toBe(false)
    expect(state.selectedClipIds).toEqual(['moving'])
    expect(state.notice).toMatchObject({ tone: 'warning', message: '字幕クリップ neighbor が同じ字幕トラック上の別クリップと重なっています。' })
  })

  it('selects a linked pair and coalesces an inspector session into one undo step', () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    expect(useEditorStore.getState().selectedClipIds).toEqual(['video', 'audio'])
    useEditorStore.getState().beginEditTransaction()
    useEditorStore.getState().patchClip('video', (clip) => clip.kind === 'video' ? { ...clip, transform: { ...clip.transform, positionX: 10 } } : clip)
    useEditorStore.getState().patchClip('video', (clip) => clip.kind === 'video' ? { ...clip, transform: { ...clip.transform, positionX: 20 } } : clip)
    useEditorStore.getState().commitEditTransaction()
    expect(useEditorStore.getState().past).toHaveLength(1)
    const currentVideo = useEditorStore.getState().project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'video')
    expect(currentVideo?.kind === 'video' ? currentVideo.transform.positionX : undefined).toBe(20)
    useEditorStore.getState().undo()
    const undoneVideo = useEditorStore.getState().project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'video')
    expect(undoneVideo?.kind === 'video' ? undoneVideo.transform.positionX : undefined).toBe(0)
  })

  it('restores split IDs and link groups exactly through undo and redo', () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    useEditorStore.getState().setPlayhead(2_000_000)
    useEditorStore.getState().splitSelected()
    const afterSplit = useEditorStore.getState().project
    const splitShape = afterSplit.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip.linkGroupId, clip.startUs, clip.sourceInUs, clip.durationUs])
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.flatMap((track) => track.clips)).toHaveLength(2)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().project.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip.linkGroupId, clip.startUs, clip.sourceInUs, clip.durationUs])).toEqual(splitShape)
  })

  it('tracks dirty state against the saved fingerprint and clears redo after a new edit', () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    expect(useEditorStore.getState().dirty).toBe(false)
    useEditorStore.getState().patchClip('video', (clip) => clip.kind === 'video' ? { ...clip, enabled: false } : clip)
    expect(useEditorStore.getState().dirty).toBe(true)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().dirty).toBe(false)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().dirty).toBe(true)
    useEditorStore.getState().undo()
    useEditorStore.getState().patchClip('video', (clip) => clip.kind === 'video' ? { ...clip, enabled: true } : clip)
    expect(useEditorStore.getState().future).toHaveLength(0)
  })

  it('clears subtitle timing metadata when inspector text diverges from source text', () => {
    const project = createEmptyProject('subtitle text edit')
    const track = project.tracks.find((item) => item.kind === 'subtitle')!
    track.clips.push({
      id: 'editable-caption', name: '編集可能字幕', kind: 'subtitle', startUs: 0, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: '元字幕', style: structuredClone(DEFAULT_SUBTITLE_STYLE),
      words: [{ id: 'source-word', text: '元字幕', startUs: 0, endUs: 1_000_000 }],
      editUnits: [{ id: 'source-unit', text: '元字幕', parentSourceWordId: 'source-word', startUs: 0, endUs: 1_000_000, timingProvenance: 'source' }]
    })
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().beginEditTransaction()
    useEditorStore.getState().patchClip('editable-caption', (clip) => clip.kind === 'subtitle'
      ? { ...clip, text: '修正字幕', words: undefined, editUnits: undefined }
      : clip)
    useEditorStore.getState().commitEditTransaction()
    const edited = useEditorStore.getState().project.tracks.flatMap((item) => item.clips).find((item) => item.id === 'editable-caption')
    expect(edited?.kind === 'subtitle' ? edited : undefined).toMatchObject({ text: '修正字幕', words: undefined, editUnits: undefined })
    expect(() => validateProject(useEditorStore.getState().project)).not.toThrow()
  })

  it('copies and pastes linked A/V as one unit with fresh IDs and link group', () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    useEditorStore.getState().copySelected()
    useEditorStore.getState().pasteClipboard(6_000_000)
    const clips = useEditorStore.getState().project.tracks.flatMap((track) => track.clips)
    const pasted = clips.filter((clip) => clip.startUs === 6_000_000)
    expect(pasted).toHaveLength(2)
    expect(pasted.map((clip) => clip.id)).not.toEqual(['video', 'audio'])
    expect(new Set(pasted.map((clip) => clip.linkGroupId)).size).toBe(1)
    expect(useEditorStore.getState().past).toHaveLength(1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.flatMap((track) => track.clips)).toHaveLength(2)
  })

  it('copies and pastes word-timed subtitles with the same timeline delta', () => {
    const project = createEmptyProject('subtitle-paste')
    const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')!
    subtitleTrack.clips.push({
      id: 'caption-copy', name: 'コピー字幕', kind: 'subtitle', startUs: 10_000_000, durationUs: 2_000_000, sourceInUs: 0,
      enabled: true, text: '字幕を入力', style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [
        { id: 'copy-word-1', text: '字幕', startUs: 10_100_000, endUs: 10_500_000 },
        { id: 'copy-word-2', text: 'を', startUs: 10_500_000, endUs: 10_800_000 },
        { id: 'copy-word-3', text: '入力', startUs: 11_000_000, endUs: 11_600_000 }
      ]
    })
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('caption-copy')
    useEditorStore.getState().copySelected()
    useEditorStore.getState().pasteClipboard(20_000_000)
    const pasted = useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips.find((item) => item.id !== 'caption-copy')
    expect(pasted).toMatchObject({ startUs: 20_000_000 })
    expect(pasted?.kind === 'subtitle' ? pasted.words?.map((word) => [word.startUs, word.endUs]) : undefined).toEqual([
      [20_100_000, 20_500_000], [20_500_000, 20_800_000], [21_000_000, 21_600_000]
    ])
    expect(pasted?.kind === 'subtitle' ? pasted.words?.map((word) => word.id) : undefined).toEqual([
      'copy-word-1', 'copy-word-2', 'copy-word-3'
    ])
  })

  it('applies subtitle style to every caption as one undoable operation', () => {
    const project = fixture()
    const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')!
    subtitleTrack.clips.push({
      id: 'caption-1', name: '字幕1', kind: 'subtitle', startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: '一つ目', style: structuredClone(DEFAULT_SUBTITLE_STYLE)
    })
    subtitleTrack.clips.push({
      id: 'caption-2', name: '字幕2', kind: 'subtitle', startUs: 5_000_000, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: '二つ目', style: structuredClone(DEFAULT_SUBTITLE_STYLE)
    })
    const caption = subtitleTrack.clips[0]
    if (!caption || caption.kind !== 'subtitle') throw new Error('subtitle fixture missing')
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().patchClip(caption.id, (clip) => clip.kind === 'subtitle' ? { ...clip, style: { ...clip.style, fontFamily: 'Custom Font', maxWidthPercent: 85 } } : clip)
    useEditorStore.getState().applySubtitleStyleToAll(caption.id)
    const subtitles = useEditorStore.getState().project.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === 'subtitle')
    expect(subtitles).toHaveLength(2)
    expect(subtitles.every((clip) => clip.kind === 'subtitle' && clip.style.fontFamily === 'Custom Font' && clip.style.maxWidthPercent === 85)).toBe(true)
  })

  it('applies a template style to only the selected subtitle track in one undoable operation', () => {
    const project = fixture()
    const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')!
    const first: SubtitleClip = {
      id: 'caption-track-1', name: '字幕track 1', kind: 'subtitle', startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: 'track 1', style: structuredClone(DEFAULT_SUBTITLE_STYLE)
    }
    subtitleTrack.clips.push(first)
    const secondTrack = { ...subtitleTrack, id: 'subtitle-2', name: '字幕track 2', clips: [{ ...first, id: 'caption-track-2', text: 'track 2' }] }
    project.tracks.push(secondTrack)
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().applySubtitleStyleToTrack('caption-track-1', { ...DEFAULT_SUBTITLE_STYLE, fontFamily: 'Template Font' })
    const tracks = useEditorStore.getState().project.tracks.filter((track) => track.kind === 'subtitle')
    expect(tracks[0]?.clips[0]?.kind === 'subtitle' ? tracks[0].clips[0].style.fontFamily : undefined).toBe('Template Font')
    expect(tracks[1]?.clips[0]?.kind === 'subtitle' ? tracks[1].clips[0].style.fontFamily : undefined).toBe(DEFAULT_SUBTITLE_STYLE.fontFamily)
    expect(useEditorStore.getState().past).toHaveLength(1)
  })

  it('updates subtitle split and merge immediately and keeps them undoable', () => {
    const project = createEmptyProject('subtitle-edit')
    const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')!
    subtitleTrack.clips.push({
      id: 'caption-edit', name: '編集字幕', kind: 'subtitle', startUs: 0, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: '字幕を入力', style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [
        { id: 'edit-word-1', text: '字幕', startUs: 0, endUs: 300_000 },
        { id: 'edit-word-2', text: 'を', startUs: 300_000, endUs: 500_000 },
        { id: 'edit-word-3', text: '入力', startUs: 500_000, endUs: 800_000 }
      ]
    })
    subtitleTrack.clips.push({
      id: 'caption-next', name: '次字幕', kind: 'subtitle', startUs: 1_200_000, durationUs: 800_000, sourceInUs: 1_200_000,
      enabled: true, text: '次', style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [{ id: 'next-word', text: '次', startUs: 1_200_000, endUs: 1_400_000 }]
    })
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('caption-edit')
    useEditorStore.getState().splitSubtitleAtWordBoundary('caption-edit', 1)
    expect(useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips).toHaveLength(3)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips).toHaveLength(2)
    useEditorStore.getState().redo()
    const right = useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips.find((clip) => clip.id !== 'caption-edit' && clip.id !== 'caption-next')
    expect(right?.kind === 'subtitle' ? right.text : undefined).toBe('入力')
    useEditorStore.getState().mergeSubtitleWithNext('caption-edit')
    expect(useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips).toHaveLength(2)
    expect(useEditorStore.getState().project.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === 'subtitle').map((clip) => clip.text)).toEqual(['字幕を入力', '次'])
  })

  it('splits a selected subtitle at the nearest word boundary and restores it through undo/redo', () => {
    const project = createEmptyProject('timeline subtitle split')
    const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')!
    subtitleTrack.clips.push({
      id: 'timeline-caption', name: 'タイムライン字幕', kind: 'subtitle', startUs: 10_000_000, durationUs: 2_000_000, sourceInUs: 0,
      enabled: true, text: '字幕を入力', style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [
        { id: 'timeline-word-1', text: '字幕', startUs: 10_100_000, endUs: 10_400_000 },
        { id: 'timeline-word-2', text: 'を', startUs: 10_600_000, endUs: 10_800_000 },
        { id: 'timeline-word-3', text: '入力', startUs: 11_000_000, endUs: 11_500_000 }
      ]
    })
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('timeline-caption')
    useEditorStore.getState().setPlayhead(10_550_000)
    useEditorStore.getState().splitSelected()
    const split = useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips
    expect(split.map((clip) => clip.kind === 'subtitle' ? [clip.text, clip.startUs, clip.durationUs, clip.words?.map((word) => word.id)] : [])).toEqual([
      ['字幕', 10_000_000, 400_000, ['timeline-word-1']],
      ['を入力', 10_600_000, 1_400_000, ['timeline-word-2', 'timeline-word-3']]
    ])
    expect(useEditorStore.getState().selectedClipIds).toHaveLength(2)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips).toHaveLength(1)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips).toHaveLength(2)
  })

  it('keeps derived edit units and source identity through split, merge, undo, redo, and JSON reload', () => {
    const project = createEmptyProject('derived subtitle edit units')
    const track = project.tracks.find((item) => item.kind === 'subtitle')!
    const sourceWord = { id: 'raw-long', text: '皆さんこんばんはアルマジロウです', startUs: 0, endUs: 1_000_000 }
    track.clips.push({
      id: 'derived-caption', name: 'derived', kind: 'subtitle', startUs: 0, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: sourceWord.text, style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [sourceWord],
      editUnits: deriveSubtitleEditUnits([sourceWord])
    })
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('derived-caption')
    useEditorStore.getState().splitSubtitleAtWordBoundary('derived-caption', 1)
    const splitClips = useEditorStore.getState().project.tracks.find((item) => item.kind === 'subtitle')!.clips.filter((item) => item.kind === 'subtitle')
    expect(splitClips.map((item) => item.kind === 'subtitle' ? item.text : '')).toEqual(['皆さんこんばんは', 'アルマジロウです'])
    expect(splitClips.flatMap((item) => item.kind === 'subtitle' ? item.editUnits!.map((unit) => unit.parentSourceWordId) : [])).toEqual(['raw-long', 'raw-long', 'raw-long', 'raw-long'])
    expect(splitClips.every((item) => item.kind === 'subtitle' && !item.words)).toBe(true)
    useEditorStore.getState().mergeSubtitleWithNext('derived-caption')
    const merged = useEditorStore.getState().project.tracks.find((item) => item.kind === 'subtitle')!.clips.find((item) => item.id === 'derived-caption')
    expect(merged?.kind === 'subtitle' ? merged.editUnits?.map((unit) => unit.text).join('') : undefined).toBe(sourceWord.text)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.find((item) => item.kind === 'subtitle')!.clips.filter((item) => item.kind === 'subtitle')).toHaveLength(2)
    useEditorStore.getState().redo()
    const roundTrip = validateProject(JSON.parse(JSON.stringify(useEditorStore.getState().project)))
    expect(roundTrip.tracks.find((item) => item.kind === 'subtitle')!.clips.filter((item) => item.kind === 'subtitle')).toHaveLength(1)
    expect(roundTrip.tracks.find((item) => item.kind === 'subtitle')!.clips[0]).toEqual(merged)
  })

  it.each([
    ['words-none', (clip: Extract<TimelineClip, { kind: 'subtitle' }>) => { clip.words = undefined }],
    ['text-mismatch', (clip: Extract<TimelineClip, { kind: 'subtitle' }>) => { clip.text = '不一致' }],
    ['one-word', (clip: Extract<TimelineClip, { kind: 'subtitle' }>) => { clip.words = [{ id: 'only', text: clip.text, startUs: clip.startUs, endUs: clip.startUs + 500_000 }] }]
  ])('rejects %s subtitle split without mutating project or history', (_name, mutate) => {
    const project = createEmptyProject('invalid timeline subtitle split')
    const track = project.tracks.find((item) => item.kind === 'subtitle')!
    track.clips.push({
      id: 'invalid-caption', name: 'invalid', kind: 'subtitle', startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: '字幕を入力', style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [
        { id: 'one', text: '字幕', startUs: 1_000_000, endUs: 1_300_000 },
        { id: 'two', text: 'を入力', startUs: 1_400_000, endUs: 1_800_000 }
      ]
    })
    const clip = track.clips[0]
    if (!clip || clip.kind !== 'subtitle') throw new Error('subtitle fixture missing')
    mutate(clip)
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('invalid-caption')
    const before = structuredClone(useEditorStore.getState().project)
    useEditorStore.getState().setPlayhead(1_500_000)
    useEditorStore.getState().splitSelected()
    const state = useEditorStore.getState()
    expect(state.project).toEqual(before)
    expect(state.past).toHaveLength(0)
    expect(state.future).toHaveLength(0)
    expect(state.dirty).toBe(false)
    expect(state.selectedClipIds).toEqual(['invalid-caption'])
  })

  it('rejects a playhead outside a valid subtitle without mutating the project', () => {
    const project = createEmptyProject('outside timeline subtitle split')
    const track = project.tracks.find((item) => item.kind === 'subtitle')!
    track.clips.push({
      id: 'outside-caption', name: 'outside', kind: 'subtitle', startUs: 2_000_000, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: '字幕を入力', style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [
        { id: 'outside-1', text: '字幕', startUs: 2_000_000, endUs: 2_300_000 },
        { id: 'outside-2', text: 'を入力', startUs: 2_400_000, endUs: 2_800_000 }
      ]
    })
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('outside-caption')
    const before = structuredClone(useEditorStore.getState().project)
    useEditorStore.getState().setPlayhead(1_000_000)
    useEditorStore.getState().splitSelected()
    expect(useEditorStore.getState().project).toEqual(before)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('rejects a multi-selection containing a subtitle without partially splitting media', () => {
    const project = fixture()
    const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')!
    subtitleTrack.clips.push({
      id: 'multi-caption', name: 'multi', kind: 'subtitle', startUs: 0, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: '字幕を入力', style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [
        { id: 'multi-1', text: '字幕', startUs: 0, endUs: 300_000 },
        { id: 'multi-2', text: 'を入力', startUs: 400_000, endUs: 800_000 }
      ]
    })
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    useEditorStore.getState().selectClip('multi-caption', true)
    const before = structuredClone(useEditorStore.getState().project)
    useEditorStore.getState().setPlayhead(500_000)
    useEditorStore.getState().splitSelected()
    expect(useEditorStore.getState().project).toEqual(before)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('moves subtitle ownership in one undoable operation and preserves a no-op boundary', () => {
    const project = createEmptyProject('ownership store')
    const track = project.tracks.find((item) => item.kind === 'subtitle')!
    track.clips.push(
      { id: 'ownership-left', name: '左', kind: 'subtitle', startUs: 0, durationUs: 1_000_000, sourceInUs: 0, enabled: true, text: 'AB', style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [{ id: 'a', text: 'A', startUs: 100_000, endUs: 300_000 }, { id: 'b', text: 'B', startUs: 400_000, endUs: 600_000 }] },
      { id: 'ownership-right', name: '右', kind: 'subtitle', startUs: 1_200_000, durationUs: 1_000_000, sourceInUs: 1_200_000, enabled: true, text: 'CD', style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [{ id: 'c', text: 'C', startUs: 1_300_000, endUs: 1_500_000 }, { id: 'd', text: 'D', startUs: 1_600_000, endUs: 1_800_000 }] }
    )
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('ownership-left')
    useEditorStore.getState().moveSubtitleBoundary('ownership-left', 'ownership-right', 2)
    const moved = useEditorStore.getState().project.tracks.find((item) => item.kind === 'subtitle')!.clips
    expect(moved.find((clip) => clip.id === 'ownership-left')).toMatchObject({ text: 'ABC', durationUs: 1_500_000 })
    expect(moved.find((clip) => clip.id === 'ownership-right')).toMatchObject({ text: 'D', startUs: 1_600_000, sourceInUs: 1_600_000 })
    expect(useEditorStore.getState().past).toHaveLength(1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.find((item) => item.kind === 'subtitle')!.clips.find((clip) => clip.id === 'ownership-left')).toMatchObject({ text: 'AB' })
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().project.tracks.find((item) => item.kind === 'subtitle')!.clips.find((clip) => clip.id === 'ownership-right')).toMatchObject({ text: 'D' })
    const historyLength = useEditorStore.getState().past.length
    useEditorStore.getState().moveSubtitleBoundary('ownership-left', 'ownership-right', 2)
    expect(useEditorStore.getState().past).toHaveLength(historyLength)
  })

  it('adds, renames, reorders, and undoes empty track operations', () => {
    const project = createEmptyProject('tracks')
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().addMediaTrack()
    expect(useEditorStore.getState().project.tracks.filter((track) => track.kind === 'media')).toHaveLength(2)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.filter((track) => track.kind === 'media')).toHaveLength(1)
    useEditorStore.getState().redo()
    const extra = useEditorStore.getState().project.tracks.find((track) => track.kind === 'media' && track.name === 'V2')!
    useEditorStore.getState().renameTrack(extra.id, 'Overlay')
    expect(useEditorStore.getState().project.tracks.find((track) => track.id === extra.id)?.name).toBe('Overlay')
    useEditorStore.getState().deleteTrack(extra.id)
    expect(useEditorStore.getState().project.tracks.some((track) => track.id === extra.id)).toBe(false)
  })

  it('supports ten or more media and subtitle tracks without fixed-count assumptions', () => {
    useEditorStore.getState().loadProject(createEmptyProject('many-tracks'))
    for (let index = 0; index < 10; index += 1) useEditorStore.getState().addMediaTrack()
    for (let index = 0; index < 10; index += 1) useEditorStore.getState().addSubtitleTrack()
    const tracks = useEditorStore.getState().project.tracks
    expect(tracks.filter((track) => track.kind === 'media')).toHaveLength(11)
    expect(tracks.filter((track) => track.kind === 'subtitle')).toHaveLength(11)
  })
})
