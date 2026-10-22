import { describe, expect, it } from 'vitest'
import { clipFirstFrame, FRAME_TIE_BAND_US } from '../../src/shared/clip-frames'
import { previewSeekSeconds } from '../../src/renderer/src/preview-geometry'

const fps30 = { numerator: 30, denominator: 1 }
const ntsc = { numerator: 30_000, denominator: 1001 }

describe('clipFirstFrame', () => {
  it('rounds an off-grid clip start up to the next frame and keeps on-grid starts', () => {
    expect(clipFirstFrame(0, fps30)).toBe(0)
    expect(clipFirstFrame(288_687, fps30)).toBe(9)
    expect(clipFirstFrame(300_000, fps30)).toBe(9)
    expect(clipFirstFrame(3_301_877, fps30)).toBe(100)
    expect(clipFirstFrame(3_333_333, fps30)).toBe(100)
    expect(clipFirstFrame(3_333_340, fps30)).toBe(101)
    expect(clipFirstFrame(1_001_000, ntsc)).toBe(30)
  })
})

/**
 * What Final does with a source frame, restated: the clip's timestamps are shifted so that 0 is
 * the source-in (plus the tie band), the fps filter rounds each timestamp (whole microseconds) to
 * the nearest slot with ties to the later slot, and a slot shows the last frame rounded at or
 * before it. Preview must park its video on exactly that frame.
 */
const finalPickTimestamp = (frames: number[], sourceInUs: number, clipFrame: number, fps: { numerator: number; denominator: number }): number | undefined => {
  const slot = (timestampUs: number): number => Math.floor((2 * (timestampUs - sourceInUs + FRAME_TIE_BAND_US) * fps.numerator + fps.denominator * 1_000_000) / (2 * fps.denominator * 1_000_000))
  let pick: number | undefined
  for (const timestampUs of frames) if (slot(timestampUs) <= clipFrame) pick = timestampUs
  return pick
}

describe('preview and Final pick the same source frame', () => {
  it.each([
    ['60 fps on a 30 fps timeline', 1_000_000 / 60, fps30],
    ['59.94 fps on a 30 fps timeline', 1_001_000 / 60, fps30],
    ['30 fps on a 30 fps timeline', 1_000_000 / 30, fps30],
    ['24 fps on a 30 fps timeline', 1_000_000 / 24, fps30],
    ['60 fps on a 29.97 fps timeline', 1_000_000 / 60, ntsc]
  ])('%s', (_name, sourceFrameUs, fps) => {
    let seed = 7
    const random = (): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648 }
    for (let trial = 0; trial < 60; trial += 1) {
      // Source timestamps with jitter and a dropped frame now and then; whole microseconds.
      const frames: number[] = []
      for (let i = 0, t = random() * sourceFrameUs; t < 12_000_000; i += 1, t += sourceFrameUs) {
        if (i % 37 !== 36) frames.push(Math.round(t + (random() - 0.5) * 1_500))
      }
      const startUs = Math.round(random() * 4_000_000)
      const sourceInUs = Math.round(random() * 6_000_000)
      const first = clipFirstFrame(startUs, fps)
      for (let clipFrame = 0; clipFrame < 40; clipFrame += 1) {
        const expected = finalPickTimestamp(frames, sourceInUs, clipFrame, fps)
        const seekUs = previewSeekSeconds({ startUs, sourceInUs }, first + clipFrame, fps) * 1_000_000
        const presented = [...frames].reverse().find((timestampUs) => timestampUs <= seekUs)
        expect(presented).toBe(expected)
      }
    }
  })

  it('treats the exact half-frame tie of an exact 60 fps source as belonging to the earlier timeline frame', () => {
    // Frames at k/60 s. Slot n shows frame 2n, never the tie frame 2n + 1, in both Final and Preview.
    const frames = Array.from({ length: 200 }, (_, i) => Math.round(i * 1_000_000 / 60))
    for (let n = 0; n < 90; n += 1) {
      expect(finalPickTimestamp(frames, 0, n, fps30)).toBe(frames[2 * n])
      const seekUs = previewSeekSeconds({ startUs: 0, sourceInUs: 0 }, n, fps30) * 1_000_000
      expect([...frames].reverse().find((t) => t <= seekUs)).toBe(frames[2 * n])
    }
  })
})
