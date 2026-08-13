import { describe, expect, it } from 'vitest'
import { addClipToTrack, createClipForAsset, createEmptyProject } from '../../src/shared/project'
import type { MediaAsset, ProjectFile } from '../../src/shared/types'
import { useEditorStore } from '../../src/renderer/src/store'

const asset: MediaAsset = {
  id: 'media', name: 'source.mp4', path: 'C:\\source.mp4', kind: 'video', durationUs: 8_000_000,
  width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, hasAudio: true,
  fileSize: 1, modifiedAt: '2026-08-13T00:00:00.000Z', offline: false
}

const fixture = (): ProjectFile => {
  let project = { ...createEmptyProject('history'), media: [asset] }
  const video = { ...createClipForAsset(asset, 0, 4_000_000), id: 'video', linkGroupId: 'linked' }
  const audio = { ...createClipForAsset(asset, 0, 4_000_000), id: 'audio', kind: 'audio' as const, linkGroupId: 'linked', audio: { volumeDb: 0, pan: 0, fadeInUs: 0, fadeOutUs: 0 } }
  project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'video')!.id, video)
  return addClipToTrack(project, project.tracks.find((track) => track.kind === 'audio')!.id, audio)
}

describe('editor history and linked selection', () => {
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
})
