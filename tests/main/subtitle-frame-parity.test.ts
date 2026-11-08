import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveFfmpegPaths } from '../../src/main/ffmpeg/binaries.js'
import { executeProcess } from '../../src/main/ffmpeg/process.js'
import { FfmpegService } from '../../src/main/ffmpeg/service.js'
import { generateAss, generateSubtitleSlotAss } from '../../src/main/ffmpeg/subtitles.js'
import { activeSubtitleCuesAtFrame, subtitleFrameImageIdentity } from '../../src/shared/subtitle-render.js'
import { firstFrameAtOrAfterUs, frameIndexAtOrBeforeUs, frameTimeMs, subtitleAssWindow, subtitleFrameRange } from '../../src/shared/subtitle-timing.js'
import { DEFAULT_SUBTITLE_STYLE, type ProjectFile, type Rational, type SubtitleClip, type SubtitleStyle } from '../../src/shared/types.js'
import { makeProject } from './ffmpeg-fixtures.js'

const WIDTH = 320
const HEIGHT = 180
const RATES: Array<[string, Rational]> = [
  ['24', { numerator: 24, denominator: 1 }],
  ['30', { numerator: 30, denominator: 1 }],
  ['29.97', { numerator: 30_000, denominator: 1_001 }],
  ['60', { numerator: 60, denominator: 1 }]
]

const cue = (id: string, startUs: number, durationUs: number, row: number, style: Partial<SubtitleStyle> = {}): SubtitleClip => ({
  id,
  name: id,
  kind: 'subtitle',
  text: 'XXXX',
  startUs,
  durationUs,
  sourceInUs: 0,
  enabled: true,
  style: {
    ...structuredClone(DEFAULT_SUBTITLE_STYLE),
    fontFamily: 'Arial',
    fontSize: 20,
    bold: true,
    color: '#ffffff',
    outlineWidth: 0,
    shadowColor: '#00000000',
    shadowBlur: 0,
    backgroundOpacity: 0,
    alignment: 'middle',
    positionX: 50,
    positionY: row,
    maxWidthPercent: 90,
    animation: 'none',
    animationDurationUs: 0,
    ...style
  }
})

const projectOf = (frameRate: Rational, clips: SubtitleClip[]): ProjectFile => {
  const project = makeProject()
  project.sequence = { width: WIDTH, height: HEIGHT, frameRate, sampleRate: 48_000, backgroundColor: '#000000' }
  project.media = []
  project.tracks = [{ id: 'subs', name: 'C1', kind: 'subtitle', locked: false, muted: false, hidden: false, clips }]
  return project
}

/** Frames the bundled libass shows, read from the export-style `ass` filter over a black canvas. */
const exportFrames = async (project: ProjectFile, directory: string, frames: number): Promise<Buffer[]> => {
  const paths = await resolveFfmpegPaths()
  const assPath = join(directory, 'export.ass')
  await writeFile(assPath, generateAss(project), 'utf8')
  const { numerator, denominator } = project.sequence.frameRate
  const rawPath = join(directory, 'export.rgb')
  await executeProcess({
    command: paths.ffmpegPath,
    args: ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${WIDTH}x${HEIGHT}:r=${numerator}/${denominator}`, '-vf', "format=rgb24,ass=filename='export.ass'", '-frames:v', String(frames), '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath],
    cwd: directory,
    timeoutMs: 60_000
  })
  const raw = await readFile(rawPath)
  const size = WIDTH * HEIGHT * 3
  return Array.from({ length: frames }, (_, index) => raw.subarray(index * size, (index + 1) * size))
}

const rowBand = (project: ProjectFile, clip: SubtitleClip): [number, number] => {
  const y = Math.round((HEIGHT * clip.style.positionY) / 100)
  return [Math.max(0, y - 12), Math.min(HEIGHT, y + 12)]
}

const lit = (frame: Buffer, band: [number, number]): boolean => {
  for (let y = band[0]; y < band[1]; y += 1) {
    for (let x = 0; x < WIDTH * 3; x += 1) if ((frame[y * WIDTH * 3 + x] ?? 0) > 40) return true
  }
  return false
}

describe('shared subtitle frame ranges', () => {
  it('maps a cue to the first frames at or after its start and end', () => {
    const fps = { numerator: 30, denominator: 1 }
    expect(firstFrameAtOrAfterUs(302_000, fps)).toBe(10)
    expect(firstFrameAtOrAfterUs(300_000, fps)).toBe(9)
    expect(subtitleFrameRange(302_000, 1_000_000, fps)).toEqual({ firstFrame: 10, endFrame: 40 })
    // shorter than a frame and between two frames: never shown
    expect(subtitleFrameRange(302_000, 10_000, fps)).toBeNull()
  })

  it('floors the ASS window to centiseconds of the boundary frames', () => {
    const fps = { numerator: 30, denominator: 1 }
    expect(subtitleAssWindow({ firstFrame: 10, endFrame: 40 }, fps)).toEqual({ startMs: 330, endMs: 1330 })
  })

  it('inverts the floored frame time', () => {
    const fps = { numerator: 30_000, denominator: 1_001 }
    for (let frame = 0; frame < 500; frame += 1) {
      const timeUs = Math.floor((frame * 1_000_000 * 1_001) / 30_000)
      expect(frameIndexAtOrBeforeUs(timeUs, fps)).toBe(frame)
    }
  })
})

describe('Preview and libass show a cue on the same frames', () => {
  it.each(RATES)('at %s fps with off-grid cue times', async (_label, fps) => {
    const directory = await mkdtemp(join(tmpdir(), 'spectra-subtitle-frames-'))
    try {
      const clips = [
        cue('a', 302_000, 1_001_234, 15),
        cue('b', 1_500_017, 333_334, 30),
        cue('c', 2_000_000, 1_000_000, 45),
        cue('d', 2_999_999, 400_001, 60),
        cue('e', 3_500_001, 50_000, 75),
        cue('f', 400_000, 1_000_000, 90)
      ]
      const project = projectOf(fps, clips)
      const frames = Math.ceil((4_200_000 * fps.numerator) / (1_000_000 * fps.denominator))
      const exported = await exportFrames(project, directory, frames)
      for (const clip of clips) {
        const band = rowBand(project, clip)
        const preview: number[] = []
        const export_: number[] = []
        for (let frame = 0; frame < frames; frame += 1) {
          if (activeSubtitleCuesAtFrame(project, frame).some((active) => active.clip.id === clip.id)) preview.push(frame)
          if (lit(exported[frame] ?? Buffer.alloc(0), band)) export_.push(frame)
        }
        expect(export_, `cue ${clip.id} at ${fps.numerator}/${fps.denominator}`).toEqual(preview)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('pre-rendered subtitle frames equal the export frame', () => {
  it.each(RATES)('including intro and fade-out frames at %s fps', async (_label, fps) => {
    const directory = await mkdtemp(join(tmpdir(), 'spectra-subtitle-slots-'))
    try {
      const clips = [
        cue('fade', 302_000, 1_201_234, 25, { animation: 'fade', animationDurationUs: 300_000 }),
        cue('pop', 1_000_017, 900_000, 50, { animation: 'pop', animationDurationUs: 250_000 }),
        cue('slide', 2_000_000, 700_001, 75, { animation: 'slide-up', animationDurationUs: 200_000 }),
        cue('plain', 2_300_003, 800_000, 90),
        cue('short', 3_100_000, 120_000, 10, { animation: 'fade', animationDurationUs: 300_000 })
      ]
      const project = projectOf(fps, clips)
      const frames = Math.ceil((3_600_000 * fps.numerator) / (1_000_000 * fps.denominator))
      const exported = await exportFrames(project, directory, frames)
      const paths = await resolveFfmpegPaths()
      const service = new FfmpegService(paths, { workspaceRoot: join(directory, 'workspace') })
      const wanted = Array.from({ length: frames }, (_, index) => index).filter((frame) => activeSubtitleCuesAtFrame(project, frame).length > 0)
      const result = await service.renderSubtitleFrames(project, wanted)
      expect(result.frames.map((frame) => frame.frameIndex)).toEqual(wanted)
      // identical images are shared: far fewer files than frames when cues are static
      expect(new Set(result.frames.map((frame) => frame.framePath)).size).toBeLessThan(wanted.length)
      let compared = 0
      let worst = 0
      for (const frame of result.frames) {
        const rawPath = join(directory, 'candidate.rgb')
        await executeProcess({
          command: paths.ffmpegPath,
          args: ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${WIDTH}x${HEIGHT}:r=1`, '-i', frame.framePath, '-filter_complex', '[0:v][1:v]overlay=format=auto,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath],
          timeoutMs: 30_000
        })
        const candidate = await readFile(rawPath)
        const reference = exported[frame.frameIndex]
        expect(candidate.length).toBe(reference?.length)
        let diff = 0
        for (let index = 0; index < candidate.length; index += 1) diff = Math.max(diff, Math.abs((candidate[index] ?? 0) - (reference?.[index] ?? 0)))
        worst = Math.max(worst, diff)
        expect(diff, `frame ${frame.frameIndex} (${subtitleFrameImageIdentity(project, frame.frameIndex).image.slice(-24)})`).toBeLessThanOrEqual(3)
        compared += 1
      }
      expect(compared).toBe(wanted.length)
      expect(worst).toBeLessThanOrEqual(3)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 240_000)

  it('places every slot clear of the others in the generated ASS', () => {
    const fps = { numerator: 30, denominator: 1 }
    const project = projectOf(fps, [cue('fade', 302_000, 1_201_234, 25, { animation: 'fade', animationDurationUs: 300_000 })])
    const slots = generateSubtitleSlotAss(project, [10, 12, 20, 40].map((frameIndex) => ({ frameIndex })))
    expect(slots.presentationMs).toHaveLength(4)
    for (let index = 1; index < slots.presentationMs.length; index += 1) {
      expect(slots.presentationMs[index] ?? 0).toBeGreaterThan(slots.presentationMs[index - 1] ?? 0)
    }
    expect(frameTimeMs(10, fps)).toBe(333)
  })
})
