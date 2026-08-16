import { describe, expect, it, vi } from 'vitest'
import { SilenceAnalysisService, parseSilencedetectOutput } from '../../src/main/silence-analysis-service'
import { createClipForAsset, createEmptyProject, addClipToTrack } from '../../src/shared/project'
import { DEFAULT_SUBTITLE_STYLE, type MediaAsset } from '../../src/shared/types'

const asset: MediaAsset = {
  id: 'analysis-media', name: 'source.mp4', path: 'C:\\source.mp4', kind: 'video', durationUs: 8_000_000,
  width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, hasAudio: true,
  fileSize: 1, modifiedAt: '2026-08-16T00:00:00.000Z', offline: false
}

const projectFixture = () => {
  let project = { ...createEmptyProject('analysis'), media: [asset] }
  const video = { ...createClipForAsset(asset, 2_000_000, 2_000_000), id: 'analysis-video', sourceInUs: 2_000_000 }
  project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, video)
  const subtitle = project.tracks.find((track) => track.kind === 'subtitle')!
  subtitle.clips.push({
    id: 'speech-caption', name: 'speech', kind: 'subtitle', startUs: 2_200_000, durationUs: 500_000, sourceInUs: 0,
    enabled: true, text: '発話', sourceJobId: 'whisper', style: structuredClone(DEFAULT_SUBTITLE_STYLE),
    words: [{ id: 'speech-word', text: '発話', startUs: 2_300_000, endUs: 2_500_000 }],
    editUnits: [{ id: 'edit-unit', text: '発話', parentSourceWordId: 'speech-word', startUs: 2_000_000, endUs: 4_000_000, timingProvenance: 'estimated' }]
  })
  return project
}

describe('explicit FFmpeg silence reapply analysis', () => {
  it('parses relative FFmpeg events into source-absolute silence', () => {
    expect(parseSilencedetectOutput('silence_start: 0.100\nsilence_end: 0.900', 2_000_000, 2_000_000)).toEqual([{ startUs: 2_100_000, endUs: 2_900_000 }])
  })

  it('uses FFmpeg signal output and raw words while keeping edit units out of speech protection', async () => {
    const executor = { run: vi.fn().mockResolvedValue({ command: 'ffmpeg', args: [], exitCode: 0, stdout: '', stderr: 'silence_start: 0.100\nsilence_end: 0.900' }) }
    const service = new SilenceAnalysisService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, { executor })
    const result = await service.start(projectFixture(), 'analysis-video', 'silence-job')
    expect(executor.run).toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(['-ss', '2.000000', '-t', '2.000000', '-map', '0:a:0']) }))
    expect(result.analysis.settings).toMatchObject({ profile: 'natural', noiseDb: -35, fillerRemoval: false })
    expect(result.protectedIntervals).toEqual([{ id: 'speech-word', startUs: 2_300_000, endUs: 2_500_000 }])
    expect(result.analysis.removedDurationUs).toBeGreaterThan(0)
  })

  it('cancels the FFmpeg request without publishing a result', async () => {
    let rejectRun: ((error: Error) => void) | undefined
    const executor = { run: vi.fn().mockImplementation(() => new Promise((_resolve, reject) => { rejectRun = reject })) }
    const service = new SilenceAnalysisService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, { executor })
    const pending = service.start(projectFixture(), 'analysis-video', 'cancel-job')
    expect(service.cancel('cancel-job')).toBe(true)
    rejectRun?.(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
  })
})
