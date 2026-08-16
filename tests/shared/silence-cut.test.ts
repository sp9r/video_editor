import { describe, expect, it } from 'vitest'
import { createClipForAsset, createEmptyProject, createTrack, validateProject } from '../../src/shared/project'
import { applySilenceCutToProject, buildSilenceReapplyTarget, canRestoreSilenceCut, createSilenceCutTimeMapper, restoreSilenceCutToProject, SilenceCutError, mapSourceTimeThroughSilenceCut } from '../../src/shared/silence-cut'
import { deleteLinkedClips, splitLinkedClip, trimLinkedClip } from '../../src/shared/editing/operations'
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
  it('uses current sourceInUs/durationUs and raw Whisper words, never SubtitleEditUnit, as reapply input', () => {
    const before = fixture()
    for (const track of before.tracks) for (const clip of track.clips) {
      if (clip.id === 'video' || clip.id === 'audio') clip.sourceInUs = 1_000_000
    }
    const subtitleTrack = before.tracks.find((track) => track.kind === 'subtitle')!
    subtitleTrack.clips.push({
      id: 'raw-caption', name: 'raw caption', kind: 'subtitle', startUs: 1_000_000, durationUs: 4_000_000, sourceInUs: 0,
      enabled: true, text: '発話', sourceJobId: 'whisper-job', style: structuredClone(DEFAULT_SUBTITLE_STYLE),
      words: [{ id: 'raw-word', text: '発話', startUs: 2_500_000, endUs: 2_700_000 }],
      editUnits: [{ id: 'derived-unit', text: '発話', parentSourceWordId: 'raw-word', startUs: 1_000_000, endUs: 4_000_000, timingProvenance: 'estimated' }]
    })
    const target = buildSilenceReapplyTarget(before, 'video')
    expect(target.sourceInUs).toBe(1_000_000)
    expect(target.durationUs).toBe(4_000_000)
    expect(target.protectedIntervals).toEqual([{ id: 'raw-word', startUs: 2_500_000, endUs: 2_700_000 }])
  })

  it('uses the right source range after linked split and trim', () => {
    const split = splitLinkedClip(fixture(), 'video', 3_000_000)
    const right = split.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'video:right:3000000')
    expect(right?.kind).toBe('video')
    expect(right && buildSilenceReapplyTarget(split, right.id)).toMatchObject({ sourceInUs: 2_000_000, durationUs: 2_000_000 })

    const trimmed = trimLinkedClip(fixture(), 'video', 'start', 2_000_000)
    expect(buildSilenceReapplyTarget(trimmed, 'video')).toMatchObject({ sourceInUs: 1_000_000, durationUs: 3_000_000 })
  })

  it('rejects a deleted clip and records an already-cut source gap for a prior cut family', () => {
    const deleted = deleteLinkedClips(fixture(), ['video'])
    expect(() => buildSilenceReapplyTarget(deleted, 'video')).toThrow(SilenceCutError)

    const cut = applySilenceCutToProject(fixture(), 'video', { keepRanges: ranges }).project
    const first = cut.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'video:silence:1')
    expect(first?.kind).toBe('video')
    expect(first && buildSilenceReapplyTarget(cut, first.id).alreadyRemovedSourceRanges).toEqual([{ startUs: 1_000_000, endUs: 2_000_000 }])
  })

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

  it('treats a full keep range as a no-op even when existing subtitles overlap', () => {
    const before = fixture()
    before.tracks[2]!.clips.push({
      id: 'existing-caption', name: 'existing caption', kind: 'subtitle', startUs: 1_500_000, durationUs: 500_000, sourceInUs: 0,
      enabled: true, text: '既存字幕', style: structuredClone(DEFAULT_SUBTITLE_STYLE)
    })
    const snapshot = structuredClone(before)
    const result = applySilenceCutToProject(before, 'video', { keepRanges: [{ startUs: 0, endUs: 4_000_000, durationUs: 4_000_000 }] })
    expect(result.summary.removedDurationUs).toBe(0)
    expect(result.summary.segmentCount).toBe(1)
    expect(result.sourceClip).toEqual({ startUs: 1_000_000, sourceInUs: 0, durationUs: 4_000_000 })
    expect(result.project).toEqual(snapshot)
  })

  it('maps source timestamps through compacted keep ranges', () => {
    const clip = { startUs: 10_000_000, sourceInUs: 20_000_000, durationUs: 4_000_000 }
    expect(mapSourceTimeThroughSilenceCut(clip, [{ startUs: 20_000_000, endUs: 21_000_000 }, { startUs: 22_000_000, endUs: 24_000_000 }], 22_500_000)).toBe(11_500_000)
    expect(mapSourceTimeThroughSilenceCut(clip, [{ startUs: 20_000_000, endUs: 21_000_000 }, { startUs: 22_000_000, endUs: 24_000_000 }], 21_500_000)).toBe(11_000_000)
  })

  it('rejects a raw speech word that falls inside a removed source range before mutation', () => {
    const before = fixture()
    const snapshot = structuredClone(before)
    expect(() => applySilenceCutToProject(before, 'video', { keepRanges: ranges }, {
      protectedIntervals: [{ id: 'raw-word-in-silence', startUs: 1_500_000, endUs: 1_600_000 }]
    })).toThrow(/CUT PLAN INVALID/)
    expect(before).toEqual(snapshot)
  })

  it('maps source points and intervals with one canonical mapper', () => {
    const mapper = createSilenceCutTimeMapper(
      { startUs: 0, sourceInUs: 0, durationUs: 15_000_000 },
      [{ startUs: 0, endUs: 5_000_000 }, { startUs: 8_000_000, endUs: 15_000_000 }]
    )
    expect(mapper.mapPoint(10_000_000)).toBe(7_000_000)
    expect(mapper.mapInterval({ id: 'word', startUs: 10_000_000, endUs: 11_000_000 })).toEqual({ id: 'word', startUs: 7_000_000, endUs: 8_000_000 })
    expect(mapper.removedRanges).toEqual([{ startUs: 5_000_000, endUs: 8_000_000 }])
  })

  it('records source-range metadata and restores an untouched linked cut after JSON reload', () => {
    const before = fixture()
    const cut = applySilenceCutToProject(before, 'video', { keepRanges: ranges }).project
    const reloaded = validateProject(JSON.parse(JSON.stringify(cut)))
    const generated = reloaded.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'video:silence:1')
    expect(generated).toBeDefined()
    expect(canRestoreSilenceCut(reloaded, 'video:silence:1')).toBe(true)
    expect(reloaded.editorMetadata?.silenceCutOperations).toHaveLength(1)

    const restored = restoreSilenceCutToProject(reloaded, 'video:silence:1')
    const media = restored.project.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === 'video' || clip.kind === 'audio')
    expect(media.map((clip) => [clip.id, clip.startUs, clip.sourceInUs, clip.durationUs, clip.linkGroupId])).toEqual([
      ['video', 1_000_000, 0, 4_000_000, 'av'],
      ['tail', 5_000_000, 0, 1_000_000, undefined],
      ['audio', 1_000_000, 0, 4_000_000, 'av']
    ])
    expect(restored.restoredDurationUs).toBe(1_000_000)
    expect(restored.restoredClipId).toBe('video')
    expect(restored.project.editorMetadata).toBeUndefined()
  })

  it('fails closed when a generated segment was edited after the cut', () => {
    const cut = applySilenceCutToProject(fixture(), 'video', { keepRanges: ranges }).project
    const changed = structuredClone(cut)
    const generated = changed.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'video:silence:1')
    if (!generated) throw new Error('generated clip missing')
    generated.durationUs += 1
    const snapshot = structuredClone(changed)
    expect(canRestoreSilenceCut(changed, generated.id)).toBe(false)
    expect(() => restoreSilenceCutToProject(changed, generated.id)).toThrow(SilenceCutError)
    expect(changed).toEqual(snapshot)
  })
})
