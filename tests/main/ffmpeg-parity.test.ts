import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveFfmpegPaths, type FfmpegPaths } from '../../src/main/ffmpeg/binaries.js'
import { executeProcess } from '../../src/main/ffmpeg/process.js'
import { FfmpegService } from '../../src/main/ffmpeg/service.js'
import type { ExportSettings, ProjectFile } from '../../src/shared/types.js'
import { makeExportSettings, makeProject } from './ffmpeg-fixtures.js'

const BACKGROUND = [16, 32, 48]

interface Rgb { width: number; height: number; data: Buffer }

const ffmpeg = (paths: FfmpegPaths, args: string[]): Promise<unknown> =>
  executeProcess({ command: paths.ffmpegPath, args: ['-hide_banner', '-loglevel', 'error', '-y', ...args], timeoutMs: 90_000 })

/** Decodes one frame to RGB. `vf` may pin the input matrix; otherwise FFmpeg follows the file's tags. */
const decodeRgb = async (paths: FfmpegPaths, root: string, file: string, width: number, height: number, vf = 'null', seek = 0): Promise<Rgb> => {
  const out = join(root, `${Math.random().toString(36).slice(2)}.rgb`)
  await ffmpeg(paths, ['-ss', String(seek), '-i', file, '-vf', `${vf},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', out])
  return { width, height, data: await readFile(out) }
}

const meanAbsDiff = (a: Rgb, b: Rgb): number[] => {
  const sums = [0, 0, 0]
  const pixels = a.width * a.height
  for (let index = 0; index < pixels; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      sums[channel] = (sums[channel] ?? 0) + Math.abs((a.data[index * 3 + channel] ?? 0) - (b.data[index * 3 + channel] ?? 0))
    }
  }
  return sums.map((sum) => sum / pixels)
}

const pixel = (frame: Rgb, x: number, y: number): number[] =>
  [0, 1, 2].map((channel) => frame.data[(y * frame.width + x) * 3 + channel] ?? 0)

const isBackground = (value: number[]): boolean => value.every((channel, index) => Math.abs(channel - (BACKGROUND[index] ?? 0)) <= 4)

const softwareSettings = (outputPath: string, width: number, height: number): ExportSettings => ({
  ...makeExportSettings(outputPath),
  width,
  height,
  videoBitrate: 4_000_000,
  audioBitrate: 96_000,
  encoderMode: 'software',
  burnSubtitles: false
})

const baseProject = (width: number, height: number): ProjectFile => {
  const project = makeProject()
  project.sequence = { width, height, frameRate: { numerator: 30, denominator: 1 }, sampleRate: 48_000, backgroundColor: '#102030' }
  project.tracks = project.tracks.filter((track) => track.kind !== 'subtitle')
  return project
}

const exportProject = async (paths: FfmpegPaths, root: string, project: ProjectFile, settings: ExportSettings, jobId: string): Promise<void> => {
  const service = new FfmpegService(paths, { platform: 'darwin', workspaceRoot: join(root, `ws-${jobId}`) })
  await (await service.startExport(project, settings, { jobId })).result
}

describe('Final export geometry and colour', () => {
  it('keeps BT.709 colour between source and export for tagged and untagged HD and tagged SD sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-colour-'))
    try {
      const paths = await resolveFfmpegPaths()
      const service = new FfmpegService(paths, { platform: 'darwin', workspaceRoot: join(root, 'ws') })
      const variants = [
        { name: 'hd-tagged', size: [1280, 720], tags: ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'], matrix: 'bt709', probed: 'bt709' },
        { name: 'hd-untagged', size: [1280, 720], tags: [], matrix: 'bt709', probed: undefined },
        { name: 'sd-tagged', size: [640, 360], tags: ['-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-color_range', 'tv'], matrix: 'bt601', probed: 'smpte170m' }
      ] as const
      for (const variant of variants) {
        const [width, height] = variant.size
        const source = join(root, `${variant.name}.mp4`)
        // Convert with the matrix the tags (or the HD default) describe, as a camera would.
        await ffmpeg(paths, [
          '-f', 'lavfi', '-i', `smptehdbars=size=${width}x${height}:rate=30:duration=1`,
          '-vf', `scale=out_color_matrix=${variant.matrix}:out_range=tv,format=yuv420p`,
          '-c:v', 'libx264', '-crf', '12', ...variant.tags,
          ...(variant.tags.length === 0 ? ['-bsf:v', 'h264_metadata=colour_primaries=2:transfer_characteristics=2:matrix_coefficients=2'] : []), source
        ])
        const probe = await service.probeMedia(source)
        expect(probe.colorSpace).toBe(variant.probed)
        const project = baseProject(width, height)
        const asset = project.media[0]
        if (!asset) throw new Error('fixture')
        Object.assign(asset, { path: source, width, height, durationUs: 1_000_000, hasAudio: false, colorSpace: probe.colorSpace, colorRange: probe.colorRange })
        project.tracks = project.tracks.filter((track) => track.id === 'track-main')
        const clip = project.tracks[0]?.clips[0]
        if (clip?.kind !== 'video') throw new Error('fixture')
        clip.durationUs = 1_000_000
        clip.sourceInUs = 0
        clip.sourceAudioEnabled = false
        const output = join(root, `${variant.name}-out.mp4`)
        await exportProject(paths, root, project, softwareSettings(output, width, height), variant.name)

        const reference = await decodeRgb(paths, root, source, width, height, `scale=in_color_matrix=${variant.matrix}:in_range=tv:flags=bicubic+accurate_rnd+full_chroma_int`, 0.5)
        // Like a player: exact conversion, matrix taken from the file's tags.
        const exported = await decodeRgb(paths, root, output, width, height, 'scale=flags=bicubic+accurate_rnd+full_chroma_int', 0.5)
        const diff = meanAbsDiff(reference, exported)
        console.log(`colour ${variant.name} mean abs diff R/G/B`, diff.map((value) => value.toFixed(2)).join(' '))
        for (const value of diff) expect(value).toBeLessThan(1.5)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)

  it('crops in place: remaining pixels keep their position and size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-crop-'))
    try {
      const paths = await resolveFfmpegPaths()
      const source = join(root, 'source.mkv')
      await ffmpeg(paths, ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1', '-c:v', 'ffv1', source])
      const make = (crop: boolean): ProjectFile => {
        const project = baseProject(320, 180)
        Object.assign(project.media[0] ?? {}, { path: source, width: 320, height: 180, durationUs: 1_000_000, hasAudio: false })
        project.tracks = project.tracks.filter((track) => track.id === 'track-main')
        const clip = project.tracks[0]?.clips[0]
        if (clip?.kind !== 'video') throw new Error('fixture')
        Object.assign(clip, { durationUs: 1_000_000, sourceInUs: 0, sourceAudioEnabled: false })
        if (crop) clip.transform = { ...clip.transform, crop: { left: 0.25, top: 0, right: 0, bottom: 0.2 } }
        return project
      }
      const plain = join(root, 'plain.mp4')
      const cropped = join(root, 'cropped.mp4')
      await exportProject(paths, root, make(false), softwareSettings(plain, 320, 180), 'plain')
      await exportProject(paths, root, make(true), softwareSettings(cropped, 320, 180), 'cropped')
      const a = await decodeRgb(paths, root, plain, 320, 180, 'null', 0.5)
      const b = await decodeRgb(paths, root, cropped, 320, 180, 'null', 0.5)
      // Left 80 columns and bottom 36 rows are hidden; the rest is untouched.
      expect(isBackground(pixel(b, 10, 90))).toBe(true)
      expect(isBackground(pixel(b, 200, 170))).toBe(true)
      expect(isBackground(pixel(a, 10, 90))).toBe(false)
      const visible: Rgb = { width: 1, height: 1, data: Buffer.alloc(0) }
      let total = 0
      let count = 0
      for (let y = 4; y < 140; y += 1) {
        for (let x = 84; x < 316; x += 1) {
          const left = pixel(a, x, y)
          const right = pixel(b, x, y)
          total += left.reduce((sum, value, index) => sum + Math.abs(value - (right[index] ?? 0)), 0) / 3
          count += 1
        }
      }
      expect(visible.width).toBe(1)
      expect(total / count).toBeLessThan(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('rotates about the centre without shrinking the image', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-rotate-'))
    try {
      const paths = await resolveFfmpegPaths()
      const image = join(root, 'red.bmp')
      await ffmpeg(paths, ['-f', 'lavfi', '-i', 'color=c=red:s=320x180', '-frames:v', '1', image])
      const project = baseProject(320, 180)
      Object.assign(project.media[1] ?? {}, { path: image, width: 320, height: 180 })
      project.tracks = project.tracks.filter((track) => track.id === 'track-overlay')
      const clip = project.tracks[0]?.clips[0]
      if (clip?.kind !== 'image') throw new Error('fixture')
      Object.assign(clip, { startUs: 0, durationUs: 1_000_000 })
      clip.transform = { ...clip.transform, positionX: 0, positionY: 0, scale: 0.5, opacity: 1, rotation: 90, crop: { left: 0, top: 0, right: 0, bottom: 0 } }
      const output = join(root, 'rot.mp4')
      await exportProject(paths, root, project, softwareSettings(output, 320, 180), 'rot')
      const frame = await decodeRgb(paths, root, output, 320, 180, 'null', 0.5)
      let minX = 999, maxX = -1, minY = 999, maxY = -1
      for (let y = 0; y < 180; y += 1) {
        for (let x = 0; x < 320; x += 1) {
          if (!isBackground(pixel(frame, x, y))) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
          }
        }
      }
      // A 160x90 box turned 90 degrees is a 90x160 box, centred.
      expect(maxX - minX + 1).toBeGreaterThanOrEqual(88)
      expect(maxX - minX + 1).toBeLessThanOrEqual(98)
      expect(maxY - minY + 1).toBeGreaterThanOrEqual(158)
      expect(maxY - minY + 1).toBeLessThanOrEqual(166)
      expect(Math.abs((minX + maxX) / 2 - 160)).toBeLessThan(3)
      expect(Math.abs((minY + maxY) / 2 - 90)).toBeLessThan(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('letterboxes the sequence frame when the export aspect ratio differs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-letterbox-'))
    try {
      const paths = await resolveFfmpegPaths()
      const image = join(root, 'red.bmp')
      await ffmpeg(paths, ['-f', 'lavfi', '-i', 'color=c=red:s=320x180', '-frames:v', '1', image])
      const project = baseProject(320, 180)
      Object.assign(project.media[1] ?? {}, { path: image, width: 320, height: 180 })
      project.tracks = project.tracks.filter((track) => track.id === 'track-overlay')
      const clip = project.tracks[0]?.clips[0]
      if (clip?.kind !== 'image') throw new Error('fixture')
      Object.assign(clip, { startUs: 0, durationUs: 1_000_000 })
      clip.transform = { ...clip.transform, positionX: 0, positionY: 0, scale: 1, opacity: 1, rotation: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 } }
      const output = join(root, 'box.mp4')
      await exportProject(paths, root, project, softwareSettings(output, 640, 640), 'box')
      const frame = await decodeRgb(paths, root, output, 640, 640, 'null', 0.5)
      // 16:9 content in a square frame: 640x360 centred, bars of 140 rows.
      expect(isBackground(pixel(frame, 320, 60))).toBe(true)
      expect(isBackground(pixel(frame, 320, 580))).toBe(true)
      const centre = pixel(frame, 320, 320)
      expect(centre[0]).toBeGreaterThan(200)
      expect(centre[1]).toBeLessThan(40)
      expect(isBackground(pixel(frame, 320, 150))).toBe(false)
      expect(isBackground(pixel(frame, 320, 490))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('Accurate Preview window parity', () => {
  it('shows the same frame as Final at early, middle and late times for clips off the frame grid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-window-parity-'))
    try {
      const paths = await resolveFfmpegPaths()
      const source = join(root, 'source.mkv')
      await ffmpeg(paths, ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=5', '-c:v', 'ffv1', source])
      const image = join(root, 'overlay.bmp')
      await ffmpeg(paths, ['-f', 'lavfi', '-i', 'color=c=red:s=80x60', '-frames:v', '1', image])
      const project = baseProject(320, 180)
      Object.assign(project.media[0] ?? {}, { path: source, width: 320, height: 180, durationUs: 5_000_000, hasAudio: false })
      Object.assign(project.media[1] ?? {}, { path: image })
      const video = project.tracks.find((track) => track.id === 'track-main')?.clips[0]
      const overlay = project.tracks.find((track) => track.id === 'track-overlay')?.clips[0]
      if (video?.kind !== 'video' || overlay?.kind !== 'image') throw new Error('fixture')
      // Neither start lies on the 30 fps grid.
      Object.assign(video, { startUs: 103_300, sourceInUs: 1_000_000, durationUs: 3_600_000, sourceAudioEnabled: false })
      Object.assign(overlay, { startUs: 701_300, durationUs: 2_300_000 })
      overlay.transform = { ...overlay.transform, rotation: 12, crop: { left: 0, top: 0, right: 0, bottom: 0 } }
      const output = join(root, 'final.mp4')
      const settings = { ...softwareSettings(output, 320, 180), videoBitrate: 8_000_000 }
      const service = new FfmpegService(paths, { platform: 'darwin', workspaceRoot: join(root, 'ws') })
      await (await service.startExport(project, settings, { jobId: 'window' })).result
      const ssim = async (a: string, b: string): Promise<number> => {
        const result = await executeProcess({
          command: paths.ffmpegPath,
          args: ['-hide_banner', '-loglevel', 'info', '-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-'],
          timeoutMs: 60_000
        })
        return Number(/All:([0-9.]+)/u.exec(`${result.stdout}\n${result.stderr}`)?.[1])
      }
      for (const timeUs of [250_000, 1_900_000, 3_500_000]) {
        const accurate = await service.renderAccurateFrame(project, timeUs)
        const scores: number[] = []
        for (const n of [accurate.frameIndex - 1, accurate.frameIndex, accurate.frameIndex + 1]) {
          const framePath = join(root, `final-${n}.png`)
          await ffmpeg(paths, ['-i', output, '-vf', `select='eq(n,${n})',scale=in_color_matrix=bt709:in_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24`, '-frames:v', '1', framePath])
          scores.push(await ssim(accurate.framePath, framePath))
        }
        console.log(`window parity t=${timeUs} frame=${accurate.frameIndex} ssim(n-1,n,n+1)=${scores.map((s) => s.toFixed(3)).join(' ')}`)
        // Final is lossy H.264, so compare to the neighbours as well as to an absolute floor.
        expect(scores[1]).toBeGreaterThan(0.93)
        expect(scores[1]).toBeGreaterThan(Math.max(scores[0] ?? 0, scores[2] ?? 0))
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 240_000)
})
