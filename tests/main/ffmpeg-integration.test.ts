import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveFfmpegPaths } from '../../src/main/ffmpeg/binaries.js'
import { executeProcess } from '../../src/main/ffmpeg/process.js'
import { FfmpegService } from '../../src/main/ffmpeg/service.js'
import { generateAss } from '../../src/main/ffmpeg/subtitles.js'
import { makeExportSettings, makeProject } from './ffmpeg-fixtures.js'

describe('bundled FFmpeg integration', () => {
  it('matches Accurate Preview with the same canonical frame from Final render', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-accurate-preview-'))
    try {
      const paths = await resolveFfmpegPaths()
      const videoPath = join(root, 'source.mkv')
      const imagePath = join(root, 'overlay.bmp')
      const outputPath = join(root, 'final.mp4')
      const finalFramePath = join(root, 'final-frame.png')
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
        args: ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=80x60', '-frames:v', '1', imagePath],
        timeoutMs: 30_000
      })

      const project = makeProject()
      project.sequence = {
        width: 320,
        height: 180,
        frameRate: { numerator: 30, denominator: 1 },
        sampleRate: 48_000,
        backgroundColor: '#102030'
      }
      const videoAsset = project.media[0]
      const imageAsset = project.media[1]
      if (!videoAsset || !imageAsset) throw new Error('accurate preview fixture assets are missing')
      videoAsset.path = videoPath
      videoAsset.durationUs = 1_000_000
      videoAsset.width = 320
      videoAsset.height = 180
      imageAsset.path = imagePath
      const videoClip = project.tracks[1]?.clips[0]
      if (videoClip?.kind === 'video') {
        videoClip.durationUs = 1_000_000
        videoClip.sourceInUs = 0
        videoClip.transform = {
          ...videoClip.transform,
          crop: { left: 0.04, top: 0.03, right: 0.02, bottom: 0.05 },
          rotation: 2
        }
      }
      const imageClip = project.tracks[0]?.clips[0]
      if (imageClip?.kind === 'image') {
        imageClip.startUs = 200_000
        imageClip.durationUs = 500_000
        imageClip.transform.rotation = -8
      }
      const subtitleClip = project.tracks[2]?.clips[0]
      if (subtitleClip?.kind === 'subtitle') {
        subtitleClip.startUs = 200_000
        subtitleClip.durationUs = 500_000
        subtitleClip.style = { ...subtitleClip.style, animation: 'none', fontSize: 24, outlineWidth: 4, shadowBlur: 8, backgroundOpacity: 0.15 }
      }
      const settings = {
        ...makeExportSettings(outputPath),
        width: 320,
        height: 180,
        videoBitrate: 1_000_000,
        audioBitrate: 96_000,
        encoderMode: 'software' as const
      }
      const service = new FfmpegService(paths, { platform: 'darwin', workspaceRoot: join(root, 'workspace') })
      const accurate = await service.renderAccurateFrame(project, 500_000)
      await (await service.startExport(project, settings, { jobId: 'accurate-parity' })).result
      await executeProcess({
        command: paths.ffmpegPath,
        args: [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', outputPath,
          '-vf', `select=eq(n\\,${accurate.frameIndex})`, '-frames:v', '1', finalFramePath
        ],
        timeoutMs: 30_000
      })
      const accurateProbe = await service.probeMedia(accurate.framePath)
      const finalProbe = await service.probeMedia(finalFramePath)
      expect(accurateProbe.width).toBe(320)
      expect(accurateProbe.height).toBe(180)
      expect(finalProbe.width).toBe(320)
      expect(finalProbe.height).toBe(180)

      const comparison = await executeProcess({
        command: paths.ffmpegPath,
        args: [
          '-hide_banner', '-loglevel', 'info', '-i', accurate.framePath, '-i', finalFramePath,
          '-lavfi', 'ssim=stats_file=-', '-f', 'null', '-'
        ],
        timeoutMs: 30_000
      })
      const report = `${comparison.stdout}\n${comparison.stderr}`
      const all = /All:([0-9.]+)/u.exec(report)?.[1]
      expect(Number(all), report).toBeGreaterThan(0.9)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

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

  it('renders all subtitle style parity matrix cases as final FFmpeg frames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-subtitle-style-matrix-'))
    try {
      const paths = await resolveFfmpegPaths()
      const project = makeProject()
      project.sequence = {
        width: 640,
        height: 360,
        frameRate: { numerator: 30, denominator: 1 },
        sampleRate: 48_000,
        backgroundColor: '#102030'
      }
      const subtitle = project.tracks.find((track) => track.kind === 'subtitle')?.clips[0]
      if (!subtitle || subtitle.kind !== 'subtitle') throw new Error('subtitle fixture missing')
      subtitle.text = '字幕を入力'
      subtitle.startUs = 0
      subtitle.durationUs = 1_000_000
      subtitle.style = {
        ...subtitle.style,
        fontFamily: 'Noto Sans JP ExtraBold',
        fontSize: 123,
        animation: 'none',
        animationDurationUs: 0,
        positionX: 50,
        positionY: 86,
        alignment: 'bottom'
      }
      const cases = [
        ['A', { outlineWidth: 0, shadowColor: '#00000000', shadowBlur: 0, backgroundOpacity: 0 }],
        ['B', { outlineWidth: 14, shadowColor: '#00000000', shadowBlur: 0, backgroundOpacity: 0 }],
        ['C', { outlineWidth: 14, shadowColor: '#d60000', shadowBlur: 0, backgroundOpacity: 0 }],
        ['D', { outlineWidth: 14, shadowColor: '#d60000', shadowBlur: 24, backgroundOpacity: 0 }],
        ['E', { outlineWidth: 14, shadowColor: '#00000000', shadowBlur: 0, backgroundOpacity: 0.15 }],
        ['F', { outlineWidth: 14, shadowColor: '#d60000', shadowBlur: 24, backgroundOpacity: 0.15 }]
      ] as const

      let exactFrame: Buffer | undefined
      for (const [name, stylePatch] of cases) {
        subtitle.style = { ...subtitle.style, ...stylePatch }
        const assName = `${name}.ass`
        const frameName = `${name}.rgb`
        await writeFile(join(root, assName), generateAss(project), 'utf8')
        await executeProcess({
          command: paths.ffmpegPath,
          args: [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'color=c=0x102030:s=640x360:r=30:d=1',
            '-vf', `ass=filename='${assName}'`,
            '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', frameName
          ],
          cwd: root,
          timeoutMs: 30_000
        })
        const frame = await readFile(join(root, frameName))
        if (name === 'F') exactFrame = frame
        expect(frame.byteLength).toBe(640 * 360 * 3)
        let changedPixels = 0
        for (let offset = 0; offset < frame.length; offset += 3) {
          const difference = Math.abs((frame[offset] ?? 0) - 16) + Math.abs((frame[offset + 1] ?? 0) - 32) + Math.abs((frame[offset + 2] ?? 0) - 48)
          if (difference > 24) changedPixels += 1
        }
        expect(changedPixels, `matrix case ${name} should contain subtitle pixels`).toBeGreaterThan(50)
        expect((await stat(join(root, frameName))).size).toBeGreaterThan(0)
      }
      if (!exactFrame) throw new Error('Exact subtitle frame was not generated')
      let brightCount = 0
      let minX = 640
      let minY = 360
      let maxX = -1
      let maxY = -1
      for (let y = 0; y < 360; y += 1) {
        for (let x = 0; x < 640; x += 1) {
          const offset = (y * 640 + x) * 3
          const red = exactFrame[offset] ?? 0
          const green = exactFrame[offset + 1] ?? 0
          const blue = exactFrame[offset + 2] ?? 0
          if (red > 150 && green > 150 && blue > 150) {
            brightCount += 1
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
          }
        }
      }
      expect(brightCount, 'exact project main glyph should remain readable').toBeGreaterThan(20)
      expect(minX).toBeLessThan(320)
      expect(maxX).toBeGreaterThan(320)
      expect(maxY).toBeGreaterThan(250)
      expect(maxY - minY).toBeLessThan(300)
      expect(maxX - minX).toBeLessThan(600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 90_000)
})
