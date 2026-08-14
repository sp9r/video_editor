import { describe, expect, it } from 'vitest'
import { addClipToTrack, createClipForAsset, createEmptyProject, createTrack, deleteClips, snapUsToFrame, SubtitleCollisionError, validateProject } from '../../src/shared/project'
import { inferLinkedAudioPairs } from '../../src/shared/editing/links'
import { deleteLinkedClips, EditingOperationError, moveLinkedClip, splitLinkedClip, trimLinkedClip } from '../../src/shared/editing/operations'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types'
import type { MediaAsset, ProjectFile, SubtitleClip } from '../../src/shared/types'

const videoAsset: MediaAsset = {
  id: 'media-main', name: 'source.mp4', path: 'C:\\media\\source.mp4', kind: 'video', durationUs: 10_000_000,
  width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, hasAudio: true,
  fileSize: 1, modifiedAt: '2026-08-13T00:00:00.000Z', offline: false
}
const audioAsset: MediaAsset = { ...videoAsset, id: 'media-audio', name: 'source.wav', kind: 'audio', hasAudio: true }

const clipFrom = (project: ProjectFile, id: string): ProjectFile['tracks'][number]['clips'][number] =>
  project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id)!

const linkedProject = (): ProjectFile => {
  let project = createEmptyProject('linked')
  project = { ...project, tracks: [...project.tracks, createTrack('media', 2)] }
  project = { ...project, media: [videoAsset, audioAsset] }
  const video = { ...createClipForAsset(videoAsset, 0, 4_000_000), id: 'video-1', linkGroupId: 'group-1' }
  const audio = { ...createClipForAsset(audioAsset, 0, 4_000_000), id: 'audio-1', linkGroupId: 'group-1' }
  project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, video)
  return addClipToTrack(project, project.tracks.filter((track) => track.kind === 'media')[1]!.id, audio)
}

const subtitle = (id: string, startUs: number, durationUs: number): SubtitleClip => ({
  id,
  name: id,
  kind: 'subtitle',
  startUs,
  durationUs,
  sourceInUs: startUs,
  enabled: true,
  text: id,
  style: structuredClone(DEFAULT_SUBTITLE_STYLE)
})

const collisionProject = (): ProjectFile => {
  const project = createEmptyProject('subtitle collision')
  const track = project.tracks.find((candidate) => candidate.kind === 'subtitle')!
  track.clips = [
    subtitle('moving', 17_020_000, 1_020_000),
    subtitle('cap_000012', 18_040_000, 2_000_000)
  ]
  return validateProject(project)
}

describe('contract link inference', () => {
  it('links exactly one matching video/audio pair without using IDs', () => {
    let project = createEmptyProject()
    project = { ...project, media: [videoAsset] }
    const video = { ...createClipForAsset(videoAsset, 0, 5_000_000), id: 'vclip_any' }
    const audio = { ...createClipForAsset(videoAsset, 0, 5_000_000), id: 'aclip_other', kind: 'audio' as const, audio: { volumeDb: 0, pan: 0, fadeInUs: 0, fadeOutUs: 0 } }
    project = { ...project, tracks: [...project.tracks, createTrack('media', 2)] }
    project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, video)
    project = addClipToTrack(project, project.tracks.filter((track) => track.kind === 'media')[1]!.id, audio)
    const result = inferLinkedAudioPairs(project)
    expect(clipFrom(result.project, video.id).linkGroupId).toBe(clipFrom(result.project, audio.id).linkGroupId)
    expect(result.diagnostics).toHaveLength(0)
  })

  it('does not link mismatched or ambiguous intervals', () => {
    let project = createEmptyProject()
    project = { ...project, media: [videoAsset] }
    const video = { ...createClipForAsset(videoAsset, 0, 5_000_000), id: 'video' }
    const audioA = { ...createClipForAsset(videoAsset, 0, 5_000_000), id: 'audio-a', kind: 'audio' as const, audio: { volumeDb: 0, pan: 0, fadeInUs: 0, fadeOutUs: 0 } }
    const audioB = { ...audioA, id: 'audio-b' }
    project = { ...project, tracks: [...project.tracks, createTrack('media', 2)] }
    project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, video)
    const audioTrack = project.tracks.filter((track) => track.kind === 'media')[1]!.id
    project = addClipToTrack(project, audioTrack, audioA)
    project = addClipToTrack(project, audioTrack, audioB)
    const result = inferLinkedAudioPairs(project)
    expect(result.project.tracks.flatMap((track) => track.clips).every((clip) => !clip.linkGroupId)).toBe(true)
    expect(result.diagnostics).toHaveLength(1)
  })
})

describe('linked editing operations', () => {
  it('rejects an overlapping subtitle move atomically after frame snapping', () => {
    const project = collisionProject()
    const before = structuredClone(project)
    const requestedAtUs = 17_020_000 + (20 / 72) * 1_000_000
    const snappedStartUs = snapUsToFrame(requestedAtUs, project)
    const moving = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'moving')!
    const neighbor = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'cap_000012')!
    const overlapUs = Math.min(snappedStartUs + moving.durationUs, neighbor.startUs + neighbor.durationUs) - Math.max(snappedStartUs, neighbor.startUs)

    expect(snappedStartUs).toBe(17_300_000)
    expect(overlapUs).toBe(280_000)
    expect(() => moveLinkedClip(project, 'moving', project.tracks.find((track) => track.kind === 'subtitle')!.id, requestedAtUs)).toThrow(SubtitleCollisionError)
    expect(project).toEqual(before)
  })

  it('moves a subtitle into a real gap without collision', () => {
    const project = fixtureForMoveGap()
    const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')!
    const next = moveLinkedClip(project, 'caption-a', subtitleTrack.id, 3_600_000)
    expect(next.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'caption-a')).toMatchObject({ startUs: 3_600_000, durationUs: 1_000_000 })
  })

  it('moves a subtitle across tracks without applying same-track collision rules', () => {
    const project = fixtureForMoveGap()
    const secondTrack = createTrack('subtitle', 2)
    const withSecondTrack = { ...project, tracks: [...project.tracks, secondTrack] }
    const next = moveLinkedClip(withSecondTrack, 'caption-a', secondTrack.id, 3_600_000)
    expect(next.tracks.find((track) => track.id === secondTrack.id)?.clips.map((clip) => clip.id)).toContain('caption-a')
    expect(next.tracks.find((track) => track.kind === 'subtitle' && track.id !== secondTrack.id)?.clips.map((clip) => clip.id)).not.toContain('caption-a')
  })

  it('trims a subtitle in a valid direction without changing its word boundary contract', () => {
    const next = trimLinkedClip(fixtureForMoveGap(), 'caption-a', 'end', 900_000)
    expect(next.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'caption-a')).toMatchObject({ startUs: 0, durationUs: 900_000 })
  })

  it('moves both clips while moving only the selected clip to a compatible track', () => {
    const project = linkedProject()
    const videoTracks = project.tracks.filter((track) => track.kind === 'media')
    const next = moveLinkedClip(project, 'video-1', videoTracks[0]!.id, 2_000_000)
    expect(clipFrom(next, 'video-1').startUs).toBe(2_000_000)
    expect(clipFrom(next, 'audio-1').startUs).toBe(2_000_000)
    const moved = moveLinkedClip(project, 'video-1', videoTracks[1]!.id, 2_000_000)
    expect(moved.tracks.find((track) => track.id === videoTracks[1]!.id)?.clips.map((clip) => clip.id)).toContain('video-1')
    expect(moved.tracks.filter((track) => track.kind === 'media')[1]?.clips[0]?.startUs).toBe(2_000_000)
  })

  it('rejects a linked operation atomically when the counterpart is locked', () => {
    const project = linkedProject()
    const audioTrack = project.tracks.filter((track) => track.kind === 'media')[1]!
    const locked = { ...project, tracks: project.tracks.map((track) => track.id === audioTrack.id ? { ...track, locked: true } : track) }
    expect(() => moveLinkedClip(locked, 'video-1', project.tracks.find((track) => track.kind === 'media')!.id, 2_000_000)).toThrow(EditingOperationError)
    expect(() => deleteLinkedClips(locked, ['video-1'], true)).toThrow(EditingOperationError)
    expect(clipFrom(locked, 'video-1').startUs).toBe(0)
  })

  it('trims, splits, and deletes the pair as one unit', () => {
    const project = linkedProject()
    const trimmed = trimLinkedClip(project, 'video-1', 'start', 1_000_000)
    expect(clipFrom(trimmed, 'video-1')).toMatchObject({ startUs: 1_000_000, sourceInUs: 1_000_000, durationUs: 3_000_000 })
    expect(clipFrom(trimmed, 'audio-1')).toMatchObject({ startUs: 1_000_000, sourceInUs: 1_000_000, durationUs: 3_000_000 })
    const split = splitLinkedClip(project, 'video-1', 2_000_000)
    const splitVideo = split.tracks.filter((track) => track.kind === 'media')[0]!.clips
    const splitAudio = split.tracks.filter((track) => track.kind === 'media')[1]!.clips
    expect(splitVideo).toHaveLength(2)
    expect(splitAudio).toHaveLength(2)
    expect(splitVideo[1]).toMatchObject({ sourceInUs: 2_000_000, startUs: 2_000_000 })
    expect(splitVideo[0]!.linkGroupId).not.toBe(splitVideo[1]!.linkGroupId)
    expect(splitVideo[1]!.linkGroupId).toBe(splitAudio[1]!.linkGroupId)
    const withFollower = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, { ...createClipForAsset(videoAsset, 5_000_000, 1_000_000), id: 'follower' })
    const deleted = deleteLinkedClips(withFollower, ['video-1'], true)
    expect(deleted.tracks.find((track) => track.kind === 'media')!.clips.find((clip) => clip.id === 'follower')?.startUs).toBe(1_000_000)
  })

  it('ripple deletes non-contiguous intervals without deleting the middle gap', () => {
    let project = createEmptyProject()
    project = { ...project, media: [videoAsset] }
    const trackId = project.tracks.find((track) => track.kind === 'media')!.id
    for (const [id, startUs] of [['a', 1_000_000], ['b', 5_000_000], ['keep', 8_000_000]] as const) {
      project = addClipToTrack(project, trackId, { ...createClipForAsset(videoAsset, startUs, 1_000_000), id })
    }
    const deleted = deleteClips(project, ['a', 'b'], true)
    expect(deleted.tracks.find((track) => track.id === trackId)!.clips.find((clip) => clip.id === 'keep')?.startUs).toBe(6_000_000)
  })
})

const fixtureForMoveGap = (): ProjectFile => {
  const project = createEmptyProject('subtitle move gap')
  const track = project.tracks.find((candidate) => candidate.kind === 'subtitle')!
  track.clips = [
    subtitle('caption-a', 0, 1_000_000),
    subtitle('caption-b', 1_200_000, 1_000_000),
    subtitle('caption-c', 2_400_000, 1_000_000)
  ]
  return validateProject(project)
}
