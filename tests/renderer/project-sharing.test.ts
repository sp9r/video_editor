import { describe, expect, it } from 'vitest'
import { addClipToTrack, createClipForAsset, createEmptyProject, createTrack, projectFingerprint } from '../../src/shared/project'
import type { MediaAsset, ProjectFile } from '../../src/shared/types'
import { sameJsonValue, shareUnchangedProjectParts } from '../../src/renderer/src/project-sharing'
import { useEditorStore } from '../../src/renderer/src/store'

const asset: MediaAsset = {
  id: 'media', name: 'source.mp4', path: 'C:\\source.mp4', kind: 'video', durationUs: 60_000_000,
  width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, hasAudio: true,
  fileSize: 1, modifiedAt: '2026-08-13T00:00:00.000Z', offline: false
}

const fixture = (): ProjectFile => {
  let project: ProjectFile = { ...createEmptyProject('sharing'), media: [asset] }
  project = { ...project, tracks: [...project.tracks, createTrack('media', 2)] }
  const [videoTrack, audioTrack] = project.tracks.filter((track) => track.kind === 'media')
  for (let index = 0; index < 4; index += 1) {
    const startUs = index * 2_000_000
    project = addClipToTrack(project, videoTrack!.id, { ...createClipForAsset(asset, startUs, 500_000), id: `v${index}`, linkGroupId: `g${index}` })
    project = addClipToTrack(project, audioTrack!.id, { ...createClipForAsset(asset, startUs, 500_000), id: `a${index}`, kind: 'audio' as const, linkGroupId: `g${index}`, audio: { volumeDb: 0, pan: 0, fadeInUs: 0, fadeOutUs: 0 } })
  }
  return project
}

const clipsById = (project: ProjectFile): Map<string, unknown> => new Map(project.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)))

describe('structural sharing of unchanged project parts', () => {
  it('compares plain data structurally and ignores undefined keys', () => {
    expect(sameJsonValue({ a: [1, { b: 2 }], c: undefined }, { a: [1, { b: 2 }] })).toBe(true)
    expect(sameJsonValue({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false)
    expect(sameJsonValue([1, 2], [1, 2, 3])).toBe(false)
  })

  it('reuses unchanged clips, tracks and media but keeps edited content', () => {
    const previous = fixture()
    const next = structuredClone(previous)
    next.tracks.find((track) => track.clips.some((clip) => clip.id === 'v1'))!.clips.find((clip) => clip.id === 'v1')!.startUs += 100_000
    const shared = shareUnchangedProjectParts(previous, next)
    expect(shared).toEqual(next)
    expect(projectFingerprint(shared)).toBe(projectFingerprint(next))
    const before = clipsById(previous)
    const after = clipsById(shared)
    for (const [id, clip] of after) {
      if (id === 'v1') expect(clip).not.toBe(before.get(id))
      else expect(clip).toBe(before.get(id))
    }
    expect(shared.media).toBe(previous.media)
    expect(shareUnchangedProjectParts(previous, structuredClone(previous)).tracks).toBe(previous.tracks)
  })

  it('keeps untouched clip identities across a store edit, undo and redo without changing content', () => {
    useEditorStore.getState().loadProject(fixture())
    const loaded = useEditorStore.getState().project
    const trackId = loaded.tracks.find((track) => track.clips.some((clip) => clip.id === 'v2'))!.id
    useEditorStore.getState().moveSelected('v2', trackId, 4_500_000, false)
    const edited = useEditorStore.getState().project
    expect(edited).not.toBe(loaded)
    const loadedClips = clipsById(loaded)
    const editedClips = clipsById(edited)
    for (const [id, clip] of editedClips) {
      if (id === 'v2' || id === 'a2') expect(clip).not.toBe(loadedClips.get(id))
      else expect(clip).toBe(loadedClips.get(id))
    }
    const editedCopy = structuredClone(edited)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project).toEqual(loaded)
    for (const [id, clip] of clipsById(useEditorStore.getState().project)) {
      if (id !== 'v2' && id !== 'a2') expect(clip).toBe(editedClips.get(id))
    }
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().project).toEqual(editedCopy)
  })
})
