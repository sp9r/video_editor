import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveFfmpegPaths } from '../../src/main/ffmpeg/binaries.js'
import { executeProcess } from '../../src/main/ffmpeg/process.js'
import { FfmpegService } from '../../src/main/ffmpeg/service.js'
import { makeExportSettings, makeProject } from './ffmpeg-fixtures.js'

describe('bundled FFmpeg integration', () => {
  it('renders crop, image, audio, subtitle, and CPU H.264 into a validated MP4', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-ffmpeg-integration-'))
    try {
      const paths = await resolveFfmpegPaths()
      const videoPath = join(root, 'ソース動画.mkv')
      const imagePath = join(root, '画像.bmp')
      const outputPath = join(root, '完成.mp4')
      await executeProcess({
        command: paths.ffmpegPath,
        args: [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1',
          '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
          '-c:v', 'ffv1', '-c:a', 'pcm_s16le', videoPath
        ],
        timeoutMs: 30_000
      })
      await executeProcess({
        command: paths.ffmpegPath,
        args: [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', 'color=c=red:s=80x60',
          '-frames:v', '1', imagePath
        ],
        timeoutMs: 30_000
      })

      const project = makeProject()
      project.sequence = {
        width: 320,
        height: 180,
        frameRate: { numerator: 30, denominator: 1 },
        sampleRate: 48_000,
        backgroundColor: '#000000'
      }
      if (project.media[0]) {
        project.media[0].path = videoPath
        project.media[0].durationUs = 1_000_000
        project.media[0].width = 320
        project.media[0].height = 180
      }
      if (project.media[1]) {
        project.media[1].path = imagePath
        project.media[1].name = '画像.bmp'
      }
      const videoClip = project.tracks[1]?.clips[0]
      if (videoClip?.kind === 'video') {
        videoClip.durationUs = 1_000_000
        videoClip.sourceInUs = 0
        videoClip.transform.crop = { left: 0.05, top: 0.05, right: 0.05, bottom: 0.05 }
      }
      const imageClip = project.tracks[0]?.clips[0]
      if (imageClip?.kind === 'image') {
        imageClip.startUs = 200_000
        imageClip.durationUs = 500_000
      }
      const subtitleClip = project.tracks[2]?.clips[0]
      if (subtitleClip?.kind === 'subtitle') {
        subtitleClip.startUs = 200_000
        subtitleClip.durationUs = 500_000
        subtitleClip.style.fontSize = 24
      }
      const settings = {
        ...makeExportSettings(outputPath),
        width: 320,
        height: 180,
        videoBitrate: 500_000,
        audioBitrate: 96_000,
        encoderMode: 'software' as const
      }
      const service = new FfmpegService(paths, {
        // Only CPU is relevant to this deterministic integration test.
        platform: 'darwin',
        workspaceRoot: join(root, 'workspace')
      })
      const job = await service.startExport(project, settings, { jobId: 'integration' })
      const exported = await job.result
      const probe = await service.probeMedia(outputPath)

      expect(exported.encoderId).toBe('libx264')
      expect(probe.kind).toBe('video')
      expect(probe.width).toBe(320)
      expect(probe.height).toBe(180)
      expect(probe.hasAudio).toBe(true)
      expect(probe.durationUs).toBeGreaterThanOrEqual(900_000)
      expect(probe.durationUs).toBeLessThanOrEqual(1_100_000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
