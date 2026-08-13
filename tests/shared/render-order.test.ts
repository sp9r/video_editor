import { describe, expect, it } from 'vitest'
import { addClipToTrack, createClipForAsset, createEmptyProject } from '../../src/shared/project'
import { visualLayerOrder } from '../../src/shared/render-order'
import type { MediaAsset } from '../../src/shared/types'

const video: MediaAsset = {
  id: 'video', name: 'video.mp4', path: 'C:\\video.mp4', kind: 'video', durationUs: 5_000_000,
  width: 1920, height: 1080, hasAudio: true, fileSize: 1, modifiedAt: '2026-08-13T00:00:00.000Z', offline: false
}

describe('shared visual layer order', () => {
  it('returns lower tracks first and the top track last for Preview and Final', () => {
    let project = { ...createEmptyProject(), media: [video] }
    const [foreground, background] = project.tracks.filter((track) => track.kind === 'video')
    if (!foreground || !background) throw new Error('video tracks missing')
    project = addClipToTrack(project, foreground.id, { ...createClipForAsset(video, 0, 2_000_000), id: 'foreground' })
    project = addClipToTrack(project, background.id, { ...createClipForAsset(video, 0, 2_000_000), id: 'background' })
    expect(visualLayerOrder(project).map(({ clip }) => clip.id)).toEqual(['background', 'foreground'])
  })

  it('does not include hidden or disabled visual clips, while mute remains audio-only', () => {
    let project = { ...createEmptyProject(), media: [video] }
    const track = project.tracks.find((candidate) => candidate.kind === 'video')!
    project = addClipToTrack(project, track.id, { ...createClipForAsset(video, 0, 2_000_000), id: 'visible' })
    project = addClipToTrack(project, track.id, { ...createClipForAsset(video, 0, 2_000_000), id: 'disabled', enabled: false })
    project = { ...project, tracks: project.tracks.map((candidate) => candidate.id === track.id ? { ...candidate, muted: true } : candidate) }
    expect(visualLayerOrder(project).map(({ clip }) => clip.id)).toEqual(['visible'])
    project = { ...project, tracks: project.tracks.map((candidate) => candidate.id === track.id ? { ...candidate, hidden: true } : candidate) }
    expect(visualLayerOrder(project)).toEqual([])
  })
})
