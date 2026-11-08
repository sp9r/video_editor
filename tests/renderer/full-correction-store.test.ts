import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureFullCorrectionTrack, type FullCorrectionSession } from '../../src/shared/full-correction'
import { createEmptyProject } from '../../src/shared/project'
import { DEFAULT_SUBTITLE_STYLE, type DesktopApi, type ProjectFile } from '../../src/shared/types'
import { useEditorStore } from '../../src/renderer/src/store'

const projectWithAutoTrack = (): ProjectFile => {
  const project = createEmptyProject('full correction')
  const track = project.tracks.find((item) => item.kind === 'subtitle')!
  track.name = '自動字幕'
  track.clips = [{
    id: 'caption-1', name: 'caption', kind: 'subtitle', startUs: 0, durationUs: 1_000_000, sourceInUs: 0, enabled: true,
    text: '元字幕', style: structuredClone(DEFAULT_SUBTITLE_STYLE), sourceCaptionId: 'source-caption-1', sourceJobId: 'job-1',
    words: [{ id: 'word-1', text: '元字幕', startUs: 0, endUs: 1_000_000 }], editUnits: [{ id: 'unit-1', text: '元字幕', parentSourceWordId: 'word-1', startUs: 0, endUs: 1_000_000, timingProvenance: 'estimated' }]
  }]
  return project
}

const sessionFor = (project: ProjectFile): FullCorrectionSession => {
  const track = project.tracks.find((item) => item.kind === 'subtitle')!
  const before = captureFullCorrectionTrack(project, track.id)
  return {
    version: 'experimental.full-correction.v1', status: 'active', sessionId: 'session-1', projectId: project.id, projectFingerprint: 'fingerprint', autoCaptionJobId: 'job-1',
    track: { id: track.id, name: track.name }, before,
    eligibility: { eligible: true, wordsAvailable: true, sourceIdentityAvailable: true },
    statistics: { beforeCaptionCount: 1, afterCaptionCount: 1, unchanged: 0, split: 0, merge: 0, move: 0, text: 0, timing: 0, delete: 0, mixed: 0 }, createdAt: '2026-08-15T00:00:00.000Z'
  }
}

afterEach(() => {
  delete window.spectra
  useEditorStore.getState().loadProject(createEmptyProject('reset'))
})

describe('full correction renderer session', () => {
  it('starts without changing Project, supports undo before finish, and shows the finished diff', async () => {
    const project = projectWithAutoTrack()
    const active = sessionFor(project)
    const finished = { ...active, status: 'finished' as const, after: active.before, derivedCorrections: [{ correctionId: 'correction-1', type: 'unchanged' as const, beforeCaptionIds: ['caption-1'], afterCaptionIds: ['caption-1'], sourceWordIds: ['word-1'], sourceEditUnitIds: ['unit-1'] }], finishedAt: '2026-08-15T00:01:00.000Z' }
    window.spectra = {
      startFullCorrectionSession: vi.fn().mockResolvedValue(active),
      finishFullCorrectionSession: vi.fn().mockResolvedValue(finished)
    } as unknown as DesktopApi
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('caption-1')
    expect(await useEditorStore.getState().startFullCorrection()).toBe(true)
    expect(useEditorStore.getState().project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'caption-1')?.kind).toBe('subtitle')
    useEditorStore.getState().patchClip('caption-1', (clip) => clip.kind === 'subtitle' ? { ...clip, text: '修正中', words: undefined, editUnits: undefined } : clip)
    expect(useEditorStore.getState().past).toHaveLength(1)
    useEditorStore.getState().undo()
    expect((useEditorStore.getState().project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'caption-1') as any).text).toBe('元字幕')
    expect(await useEditorStore.getState().finishFullCorrection()).toEqual(finished)
    expect(useEditorStore.getState().fullCorrectionSession).toBeNull()
    expect(useEditorStore.getState().fullCorrectionResult?.status).toBe('finished')
    expect((window.spectra.finishFullCorrectionSession as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.anything(), 'session-1')
  })

  it('hydrates an active session after project save/reload', () => {
    const project = projectWithAutoTrack()
    const active = sessionFor(project)
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().hydrateFullCorrectionSessions([active])
    expect(useEditorStore.getState().fullCorrectionSession?.sessionId).toBe('session-1')
    useEditorStore.getState().loadProject(structuredClone(project))
    useEditorStore.getState().hydrateFullCorrectionSessions([active])
    expect(useEditorStore.getState().fullCorrectionSession?.track.id).toBe(active.track.id)
  })
})
