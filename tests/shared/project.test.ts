import { describe, expect, it } from 'vitest'
import {
  addClipToTrack,
  addMediaAssets,
  createClipForAsset,
  createEmptyProject,
  deleteClips,
  framesToUs,
  layoutSubtitleTracks,
  moveClip,
  projectFingerprint,
  projectDurationUs,
  relinkMediaAsset,
  splitClip,
  trimClip,
  usToFrames,
  validateProject
} from '../../src/shared/project'
import { DEFAULT_SUBTITLE_STYLE, type MediaAsset } from '../../src/shared/types'

const asset: MediaAsset = {
  id: 'asset-1',
  name: '日本語 sample.mp4',
  path: 'C:\\素材 フォルダー\\sample.mp4',
  kind: 'video',
  durationUs: 10_000_000,
  width: 1920,
  height: 1080,
  frameRate: { numerator: 30, denominator: 1 },
  hasAudio: true,
  fileSize: 100,
  modifiedAt: '2026-08-12T00:00:00.000Z',
  offline: false
}

describe('project timebase', () => {
  it('keeps the async preview identity stable across timestamp-only saves', () => {
    const project = createEmptyProject('fingerprint')
    const saved = structuredClone(project)
    saved.updatedAt = '2026-08-17T00:00:00.000Z'
    expect(projectFingerprint(saved)).toBe(projectFingerprint(project))
    saved.name = 'changed'
    expect(projectFingerprint(saved)).not.toBe(projectFingerprint(project))
  })

  it('round-trips frames with an integer microsecond timeline', () => {
    const timeUs = framesToUs(300, 30)
    expect(timeUs).toBe(10_000_000)
    expect(usToFrames(timeUs, 30)).toBe(300)
  })

  it('supports fractional frame rates', () => {
    const timeUs = framesToUs(30_000, 30_000, 1_001)
    expect(Math.abs(timeUs - 1_001_000_000)).toBeLessThanOrEqual(1)
    expect(usToFrames(timeUs, 30_000, 1_001)).toBe(30_000)
  })
})

describe('timeline operations', () => {
  it('splits a clip without changing total duration or source continuity', () => {
    let project = createEmptyProject('Test')
    const track = project.tracks.find((item) => item.name.startsWith('V1'))!
    const clip = createClipForAsset(asset, 0)
    project = addClipToTrack(project, track.id, clip)
    project = splitClip(project, clip.id, 4_000_000)

    const clips = project.tracks.find((item) => item.id === track.id)!.clips
    expect(clips).toHaveLength(2)
    expect(clips[0]?.durationUs).toBe(4_000_000)
    expect(clips[1]?.sourceInUs).toBe(4_000_000)
    expect(projectDurationUs(project)).toBe(10_000_000)
  })

  it('trims the start while preserving the represented source position', () => {
    let project = createEmptyProject('Test')
    const track = project.tracks.find((item) => item.name.startsWith('V1'))!
    const clip = createClipForAsset(asset, 0)
    project = addClipToTrack(project, track.id, clip)
    project = trimClip(project, clip.id, 'start', 2_000_000)
    const trimmed = project.tracks.find((item) => item.id === track.id)!.clips[0]!
    expect(trimmed.startUs).toBe(2_000_000)
    expect(trimmed.sourceInUs).toBe(2_000_000)
    expect(trimmed.durationUs).toBe(8_000_000)
  })

  it('ripple deletes and closes the removed interval', () => {
    let project = createEmptyProject('Test')
    const track = project.tracks.find((item) => item.name.startsWith('V1'))!
    const first = createClipForAsset({ ...asset, id: 'a' }, 0, 3_000_000)
    const second = createClipForAsset({ ...asset, id: 'b' }, 3_000_000, 2_000_000)
    project = addClipToTrack(project, track.id, first)
    project = addClipToTrack(project, track.id, second)
    project = deleteClips(project, [first.id], true)
    expect(project.tracks.find((item) => item.id === track.id)!.clips[0]?.startUs).toBe(0)
  })
})

describe('project validation', () => {
  it('accepts a valid project and rejects unsupported schemas', () => {
    const valid = createEmptyProject('Valid')
    expect(validateProject(valid).name).toBe('Valid')
    expect(() => validateProject({ ...valid, schemaVersion: 999 })).toThrow(/未対応/)
  })

  it('starts with exactly one media track and one subtitle track', () => {
    const project = createEmptyProject('new')
    expect(project.tracks.map((track) => [track.kind, track.name])).toEqual([['media', 'V1'], ['subtitle', 'C1']])
    expect(DEFAULT_SUBTITLE_STYLE.animation).toBe('none')
    expect(DEFAULT_SUBTITLE_STYLE.animationDurationUs).toBe(0)
  })

  it('rejects overlapping captions on one track and accepts them after partitioning', () => {
    const project = createEmptyProject('captions')
    const track = project.tracks.find((candidate) => candidate.kind === 'subtitle')!
    const first = { id: 'caption-a', name: 'A', kind: 'subtitle' as const, startUs: 0, durationUs: 2_000_000, sourceInUs: 0, enabled: true, text: 'A', style: structuredClone(DEFAULT_SUBTITLE_STYLE) }
    const second = { ...first, id: 'caption-b', startUs: 1_000_000 }
    expect(() => addClipToTrack(project, track.id, first)).not.toThrow()
    expect(() => addClipToTrack(addClipToTrack(project, track.id, first), track.id, second)).toThrow(/重な/u)
    const partitioned = layoutSubtitleTracks(addClipToTrack(project, track.id, first))
    partitioned.tracks.find((candidate) => candidate.kind === 'subtitle')!.clips.push(second)
    const laidOut = layoutSubtitleTracks(partitioned)
    expect(laidOut.tracks.filter((candidate) => candidate.kind === 'subtitle')).toHaveLength(2)
  })

  it('rejects subtitle move and trim operations that create overlap', () => {
    let project = createEmptyProject('caption-edit')
    const track = project.tracks.find((candidate) => candidate.kind === 'subtitle')!
    const first = { id: 'caption-first', name: 'first', kind: 'subtitle' as const, startUs: 0, durationUs: 2_000_000, sourceInUs: 0, enabled: true, text: 'first', style: structuredClone(DEFAULT_SUBTITLE_STYLE) }
    const second = { ...first, id: 'caption-second', startUs: 4_000_000, sourceInUs: 3_000_000, text: 'second' }
    project = addClipToTrack(project, track.id, first)
    project = addClipToTrack(project, track.id, second)
    expect(() => moveClip(project, second.id, 1_000_000)).toThrow(/重な/u)
    expect(() => trimClip(project, second.id, 'start', 1_000_000)).toThrow(/重な/u)
  })
})

describe('media relinking', () => {
  it('preserves the asset ID used by timeline clips while replacing file metadata', () => {
    let project = createEmptyProject('Relink')
    const track = project.tracks.find((item) => item.name.startsWith('V1'))!
    const clip = createClipForAsset({ ...asset, offline: true }, 0)
    project = addClipToTrack({ ...project, media: [{ ...asset, offline: true }] }, track.id, clip)
    const relinked = relinkMediaAsset(project, asset.id, {
      ...asset,
      name: 'moved-video.mp4',
      path: 'D:\\移動先\\moved-video.mp4',
      offline: false
    })
    expect(relinked.media[0]).toMatchObject({ id: asset.id, name: 'moved-video.mp4', path: 'D:\\移動先\\moved-video.mp4', offline: false })
    expect(relinked.tracks.find((item) => item.id === track.id)?.clips[0]).toMatchObject({ assetId: asset.id })
  })
})

describe('media re-import and trim limits', () => {
  it('keeps the asset id when the same file is imported again', () => {
    const base = createEmptyProject('reimport')
    const first = { id: 'asset-1', name: 'a.mp4', path: 'C:\a.mp4', kind: 'video', durationUs: 1_000_000, hasAudio: true, fileSize: 1, modifiedAt: '', offline: false } as never
    const again = { ...(first as object), id: 'asset-2', durationUs: 2_000_000 } as never
    const once = addMediaAssets(base, [first])
    const twice = addMediaAssets(once, [again])
    expect(twice.media).toHaveLength(1)
    expect(twice.media[0]).toMatchObject({ id: 'asset-1', durationUs: 2_000_000 })
  })
})
