import { describe, expect, it } from 'vitest'
import { createClipForAsset, createEmptyProject, createTrack, validateProject } from '../../src/shared/project'
import { applySilenceCutToProject, SilenceCutError, mapSourceTimeThroughSilenceCut } from '../../src/shared/silence-cut'
import { DEFAULT_AUDIO, DEFAULT_SUBTITLE_STYLE, type MediaAsset, type ProjectFile } from '../../src/shared/types'

const asset: MediaAsset = {
  id: 'silence-media', name: 'generated.mp4', path: 'C:\\generated.mp4', kind: 'video', durationUs: 10_000_000,
  width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, hasAudio: true,
  fileSize: 1, modifiedAt: '2026-08-16T00:00:00.000Z', offline: false
}

const ranges = [
  { startUs: 0, endUs: 1_000_000, durationUs: 1_000_000 },
  { startUs: 2_000_000, endUs: 4_000_000, durationUs: 2_000_000 }
]

const fixture = (): ProjectFile => {
  const base = createEmptyProject('silence cut')
  let project = { ...base, media: [asset], tracks: [...base.tracks, createTrack('media', 2)] }
  const video = { ...createClipForAsset(asset, 1_000_000, 4_000_000), id: 'video', linkGroupId: 'av' }
  const audio = { ...createClipForAsset(asset, 1_000_000, 4_000_000), id: 'audio', kind: 'audio' as const, linkGroupId: 'av', audio: structuredClone(DEFAULT_AUDIO) }
  const tail = { ...createClipForAsset(asset, 5_000_000, 1_000_000), id: 'tail' }
  project.tracks[0]!.clips = [video, tail]
  project.tracks[2]!.clips = [audio]
  return validateProject(project)
}

describe('non-destructive silence cut', () => {
  it('splits linked A/V with one source plan and ripples the timeline gaplessly', () => {
    const before = fixture()
    const result = applySilenceCutToProject(before, 'video', { keepRanges: ranges })
    const video = result.project.tracks[0]!.clips.filter((clip) => clip.kind === 'video' && clip.id.startsWith('video:silence'))
    const audio = result.project.tracks[2]!.clips.filter((clip) => clip.kind === 'audio' && clip.id.startsWith('audio:silence'))
    expect(video.map((clip) => [clip.startUs, clip.sourceInUs, clip.durationUs])).toEqual([[1_000_000, 0, 1_000_000], [2_000_000, 2_000_000, 2_000_000]])
    expect(audio.map((clip) => [clip.startUs, clip.sourceInUs, clip.durationUs])).toEqual([[1_000_000, 0, 1_000_000], [2_000_000, 2_000_000, 2_000_000]])
    expect(video.map((clip) => clip.linkGroupId)).toEqual(audio.map((clip) => clip.linkGroupId))
    expect(result.project.tracks[0]!.clips.find((clip) => clip.id === 'tail')?.startUs).toBe(4_000_000)
    expect(result.summary.removedDurationUs).toBe(1_000_000)
    expect(before.media[0]?.path).toBe('C:\\generated.mp4')
    expect(result.project.media).toEqual(before.media)
  })

  it('rejects an unsafe overlapping track without changing the input project', () => {
    const before = fixture()
    before.tracks[2]!.clips.push({
      id: 'caption', name: 'existing', kind: 'subtitle', startUs: 1_500_000, durationUs: 500_000, sourceInUs: 0,
      enabled: true, text: '既存字幕', style: structuredClone(DEFAULT_SUBTITLE_STYLE)
    })
    const snapshot = structuredClone(before)
    expect(() => applySilenceCutToProject(before, 'video', { keepRanges: ranges })).toThrow(SilenceCutError)
    expect(before).toEqual(snapshot)
  })

  it('maps source timestamps through compacted keep ranges', () => {
    const clip = { startUs: 10_000_000, sourceInUs: 20_000_000, durationUs: 4_000_000 }
    expect(mapSourceTimeThroughSilenceCut(clip, [{ startUs: 20_000_000, endUs: 21_000_000 }, { startUs: 22_000_000, endUs: 24_000_000 }], 22_500_000)).toBe(11_500_000)
    expect(mapSourceTimeThroughSilenceCut(clip, [{ startUs: 20_000_000, endUs: 21_000_000 }, { startUs: 22_000_000, endUs: 24_000_000 }], 21_500_000)).toBe(11_000_000)
  })
})
