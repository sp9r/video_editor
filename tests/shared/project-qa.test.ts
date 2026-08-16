import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../../src/shared/project'
import { runProjectQa } from '../../src/shared/project-qa'
import { DEFAULT_AUDIO, DEFAULT_SUBTITLE_STYLE, DEFAULT_TRANSFORM } from '../../src/shared/types'

const baseProject = () => {
  const project = createEmptyProject('QA fixture')
  project.media = [{ id: 'asset-1', name: 'source', path: 'source.mp4', kind: 'video', durationUs: 10_000_000, width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, hasAudio: true, fileSize: 100, modifiedAt: '2026-08-17T00:00:00.000Z', offline: false }]
  project.tracks[0]!.clips = [{ id: 'video-1', name: 'source', kind: 'video', startUs: 0, durationUs: 10_000_000, sourceInUs: 0, enabled: true, assetId: 'asset-1', transform: structuredClone(DEFAULT_TRANSFORM), audio: structuredClone(DEFAULT_AUDIO) }]
  return project
}

describe('project QA', () => {
  it('reports media, timeline, subtitle, silence, and export issues without mutating the project', () => {
    const project = baseProject()
    const subtitleTrack = project.tracks[1]!
    subtitleTrack.hidden = true
    subtitleTrack.clips = [{ id: 'caption-1', name: 'empty', kind: 'subtitle', startUs: 11_000_000, durationUs: 1_000_000, sourceInUs: 0, enabled: true, text: '', style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), maxWidthPercent: 301 }, words: [{ id: 'word-1', text: '不一致', startUs: 11_000_000, endUs: 13_000_000 }] }]
    project.media[0]!.offline = true
    project.tracks[0]!.clips[0]!.sourceInUs = 9_000_000
    project.tracks[0]!.clips[0]!.durationUs = 2_000_000
    const before = structuredClone(project)
    const report = runProjectQa(project, { encoderReport: { capabilities: [] } as never, autoCaptionBaselines: [] })
    expect(report.errorCount).toBeGreaterThan(0)
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['MEDIA_OFFLINE', 'TIMELINE_SOURCE_RANGE_OUTSIDE_ASSET', 'SUBTITLE_EMPTY_TEXT', 'SUBTITLE_MAX_WIDTH_OUT_OF_RANGE', 'SUBTITLE_WORD_TIMING_INVALID', 'EXPORT_ENCODER_UNAVAILABLE']))
    expect(project).toEqual(before)
  })

  it('keeps a valid baseline quiet apart from encoder detection being informational', () => {
    const report = runProjectQa(baseProject())
    expect(report.errorCount).toBe(0)
    expect(report.warningCount).toBe(0)
    expect(report.issues.map((issue) => issue.code)).toEqual(['EXPORT_ENCODER_NOT_CHECKED'])
    expect(report.canExport).toBe(true)
  })

  it('detects linked A/V mismatch and preserves related navigation data', () => {
    const project = baseProject()
    const audioTrack = { id: 'audio-track', name: 'A1', kind: 'media' as const, clips: [{ id: 'audio-1', name: 'source', kind: 'audio' as const, startUs: 100_000, durationUs: 9_900_000, sourceInUs: 0, enabled: true, assetId: 'asset-1', audio: structuredClone(DEFAULT_AUDIO), linkGroupId: 'link-1' }], locked: false, muted: false, hidden: false }
    const video = project.tracks[0]!.clips[0]!
    video.linkGroupId = 'link-1'
    project.tracks.push(audioTrack)
    const issue = runProjectQa(project, { encoderReport: { capabilities: [{ available: true }] } as never }).issues.find((candidate) => candidate.code === 'TIMELINE_LINKED_AV_MAPPING_INVALID')
    expect(issue).toMatchObject({ relatedClipId: 'video-1', timelineUs: 0 })
  })

  it('detects non-blocking media, gap, fallback, metadata, and output diagnostics', () => {
    const project = baseProject()
    project.media[0]!.path = ''
    project.media[0]!.hasAudio = false
    project.tracks[0]!.clips.push({ ...structuredClone(project.tracks[0]!.clips[0]!), id: 'video-2', startUs: 12_000_000, durationUs: 1_000_000, sourceInUs: 0 })
    const subtitleTrack = project.tracks[1]!
    subtitleTrack.hidden = true
    subtitleTrack.clips = [{ id: 'caption-1', name: 'caption', kind: 'subtitle', startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0, enabled: true, text: '字幕', style: structuredClone(DEFAULT_SUBTITLE_STYLE), sourceJobId: 'job-1' }]
    project.editorMetadata = { schemaVersion: 1, silenceCutOperations: [{ schemaVersion: 1, operationId: 'op-1', originalStartUs: 0, originalDurationUs: 1_000_000, keepRanges: [{ startUs: 0, endUs: 500_000 }], removedRanges: [{ startUs: 500_000, endUs: 1_000_000 }], targets: [{ clipId: 'video-1', trackId: 'V1', kind: 'video', assetId: 'asset-1', name: 'source', sourceInUs: 0, durationUs: 1_000_000, generatedClipIds: ['missing-generated'] }], generatedClipSignatures: {} }] }
    const report = runProjectQa(project, { outputSettings: { width: 15, height: 1080, frameRate: { numerator: 0, denominator: 1 } }, autoCaptionBaselines: [{ jobId: 'job-1', fallback: { used: true, reason: '' }, diagnostics: [] }] })
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'MEDIA_UNREADABLE', 'MEDIA_VIDEO_AUDIO_MISSING', 'TIMELINE_VISUAL_GAP', 'SUBTITLE_DISABLED_HIDDEN',
      'AUTO_CAPTION_FALLBACK_DIAGNOSTIC_MISSING', 'AUTO_SILENCE_METADATA_STALE', 'EXPORT_DIMENSIONS_INVALID', 'EXPORT_FRAMERATE_INVALID'
    ]))
  })

  it('detects missing references, invalid durations, and subtitle constraints', () => {
    const project = baseProject()
    const video = project.tracks[0]!.clips[0]!
    if (video.kind !== 'video') throw new Error('fixture video missing')
    video.durationUs = 0
    video.assetId = 'missing-asset'
    project.tracks[0]!.clips.push({ ...structuredClone(video), id: 'video-valid', assetId: 'asset-1', durationUs: 10_000_000 })
    const subtitleTrack = project.tracks[1]!
    subtitleTrack.clips = [{ id: 'caption-1', name: 'caption', kind: 'subtitle', startUs: 20_000_000, durationUs: 1_000_000, sourceInUs: 0, enabled: true, text: '字幕', style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), maxWidthPercent: Number.NaN }, maxLines: 0 }]
    const report = runProjectQa(project, { encoderReport: { capabilities: [{ available: true }] } as never })
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'MEDIA_ASSET_MISSING', 'TIMELINE_INVALID_DURATION', 'SUBTITLE_MAX_LINES_INVALID', 'SUBTITLE_MAX_WIDTH_INVALID', 'SUBTITLE_OUTSIDE_SEQUENCE'
    ]))
  })
})
