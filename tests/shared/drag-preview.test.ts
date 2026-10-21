import { describe, expect, it } from 'vitest'
import { addClipToTrack, createClipForAsset, createEmptyProject, createTrack } from '../../src/shared/project'
import { computeClipDragPreview } from '../../src/shared/editing/drag-preview'
import { moveLinkedClip, trimLinkedClip } from '../../src/shared/editing/operations'
import type { MediaAsset, ProjectFile } from '../../src/shared/types'

const videoAsset: MediaAsset = {
  id: 'media-main', name: 'source.mp4', path: 'C:\media\source.mp4', kind: 'video', durationUs: 10_000_000,
  width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, hasAudio: true,
  fileSize: 1, modifiedAt: '2026-08-13T00:00:00.000Z', offline: false
}
const audioAsset: MediaAsset = { ...videoAsset, id: 'media-audio', name: 'source.wav', kind: 'audio' }

const linkedProject = (): ProjectFile => {
  let project = createEmptyProject('linked')
  project = { ...project, tracks: [...project.tracks, createTrack('media', 2)], media: [videoAsset, audioAsset] }
  const mediaTracks = () => project.tracks.filter((track) => track.kind === 'media')
  project = addClipToTrack(project, mediaTracks()[0]!.id, { ...createClipForAsset(videoAsset, 1_000_000, 4_000_000), id: 'v', linkGroupId: 'g' })
  return addClipToTrack(project, mediaTracks()[1]!.id, { ...createClipForAsset(audioAsset, 1_000_000, 4_000_000), id: 'a', linkGroupId: 'g' })
}

const base = { clipId: 'v', initialStartUs: 1_000_000, initialDurationUs: 4_000_000, exact: true }

describe('computeClipDragPreview', () => {
  it('moves linked partners with the grabbed clip and matches the committed result', () => {
    const project = linkedProject()
    const trackId = project.tracks.find((track) => track.kind === 'media')!.id
    const preview = computeClipDragPreview(project, { ...base, mode: 'move', targetTrackId: trackId, deltaUs: 500_000 })
    expect(preview.get('v')).toEqual({ startUs: 1_500_000, durationUs: 4_000_000 })
    expect(preview.get('a')).toEqual({ startUs: 1_500_000, durationUs: 4_000_000 })
    const committed = moveLinkedClip(project, 'v', trackId, 1_500_000, true).tracks.flatMap((track) => track.clips)
    for (const clip of committed) expect(preview.get(clip.id)).toEqual({ startUs: clip.startUs, durationUs: clip.durationUs })
  })

  it('keeps partners on their own tracks for a cross-track move', () => {
    const project = linkedProject()
    const media = project.tracks.filter((track) => track.kind === 'media')
    const preview = computeClipDragPreview(project, { ...base, mode: 'move', targetTrackId: media[1]!.id, deltaUs: 250_000 })
    expect(preview.get('a')?.startUs).toBe(1_250_000)
    expect(preview.get('v')?.startUs).toBe(1_250_000)
  })

  it('shrinks the linked partner when trimming the end', () => {
    const project = linkedProject()
    const preview = computeClipDragPreview(project, { ...base, mode: 'trim-end', targetTrackId: 'x', deltaUs: -1_000_000 })
    expect(preview.get('v')?.durationUs).toBe(3_000_000)
    expect(preview.get('a')?.durationUs).toBe(3_000_000)
    const committed = trimLinkedClip(project, 'v', 'end', 4_000_000, true).tracks.flatMap((track) => track.clips)
    for (const clip of committed) expect(preview.get(clip.id)?.durationUs).toBe(clip.durationUs)
  })

  it('mirrors start-trim clamping for partners', () => {
    const project = linkedProject()
    const preview = computeClipDragPreview(project, { ...base, mode: 'trim-start', targetTrackId: 'x', deltaUs: 1_000_000 })
    expect(preview.get('v')).toEqual({ startUs: 2_000_000, durationUs: 3_000_000 })
    expect(preview.get('a')).toEqual({ startUs: 2_000_000, durationUs: 3_000_000 })
  })

  it('falls back to the grabbed clip when the move is rejected', () => {
    const project = linkedProject()
    const preview = computeClipDragPreview(project, { ...base, mode: 'move', targetTrackId: project.tracks.find((t) => t.kind === 'subtitle')!.id, deltaUs: 500_000 })
    expect([...preview.keys()]).toEqual(['v'])
    expect(preview.get('v')?.startUs).toBe(1_500_000)
  })
})
