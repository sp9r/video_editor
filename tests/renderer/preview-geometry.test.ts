import { describe, expect, it } from 'vitest'
import { computeVisualLayout } from '../../src/shared/visual-layout'
import { fitSequenceToViewer, hitTestVisualLayouts, previewFrameIndex, previewSeekSeconds, timelineFrameForPresentedMedia } from '../../src/renderer/src/preview-geometry'

const fps30 = { numerator: 30, denominator: 1 }
const transform = (patch: Record<string, unknown> = {}) => ({
  positionX: 0, positionY: 0, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 }, ...patch
}) as Parameters<typeof computeVisualLayout>[0]['transform']
const layer = (id: string, patch: Record<string, unknown> = {}) => ({
  clipId: id,
  layout: computeVisualLayout({ id, transform: transform(patch) }, { width: 1280, height: 720 }, 1280, 720)
})

describe('preview seek mapping', () => {
  it('parks half a frame ahead so the source frame matches Final', () => {
    const clip = { startUs: 0, sourceInUs: 0 }
    // frame 3 at 30 fps: 0.1 s + half frame (0.01667 s) - epsilon
    expect(previewSeekSeconds(clip, 3, fps30)).toBeCloseTo(0.1 + 1 / 60 - 0.0005, 6)
    expect(previewSeekSeconds(clip, 0, fps30)).toBeGreaterThan(0)
    expect(previewSeekSeconds(clip, 0, fps30)).toBeLessThan(1 / 60)
  })

  it('offsets by clip start and source in-point', () => {
    const clip = { startUs: 1_000_000, sourceInUs: 2_000_000 }
    expect(previewSeekSeconds(clip, 45, fps30)).toBeCloseTo(2.5 + 1 / 60 - 0.0005, 6)
  })

  it('never lands on a 60 fps tie frame for a 30 fps timeline', () => {
    // Source frames sit at k/60; the target must stay below (n + 0.5)/30 = (2n + 1)/60.
    for (let n = 0; n < 100; n += 1) {
      const target = previewSeekSeconds({ startUs: 0, sourceInUs: 0 }, n, fps30)
      expect(Math.floor(target * 60 + 1e-9)).toBe(2 * n)
    }
  })

  it('maps a presented media time back to its timeline frame', () => {
    const clip = { startUs: 1_000_000, sourceInUs: 2_000_000 }
    expect(timelineFrameForPresentedMedia(clip, 2.5, fps30)).toBe(45)
    expect(timelineFrameForPresentedMedia(clip, 2.5 + 1 / 60 - 0.001, fps30)).toBe(45)
    expect(timelineFrameForPresentedMedia(clip, 2.5 + 1 / 60 + 0.001, fps30)).toBe(46)
  })

  it('treats a playhead one microsecond under a frame boundary as that frame', () => {
    expect(previewFrameIndex(33_333, fps30, null)).toBe(1)
    expect(previewFrameIndex(33_332, fps30, null)).toBe(0)
  })

  it('prefers the presented frame while playing unless it is far from the playhead', () => {
    expect(previewFrameIndex(1_000_000, fps30, 29)).toBe(29)
    expect(previewFrameIndex(1_000_000, fps30, 12)).toBe(30)
  })
})

describe('canvas fit', () => {
  it('letterboxes with one scale factor', () => {
    expect(fitSequenceToViewer(960, 540, 1920, 1080)).toEqual({ scale: 0.5, offsetX: 0, offsetY: 0 })
    expect(fitSequenceToViewer(1000, 540, 1920, 1080)).toEqual({ scale: 0.5, offsetX: 20, offsetY: 0 })
  })
})

describe('layer hit testing', () => {
  it('returns the topmost layer under the point', () => {
    const layers = [layer('back'), layer('front', { scale: 0.5 })]
    expect(hitTestVisualLayouts(layers, 640, 360)).toBe('front')
    expect(hitTestVisualLayouts(layers, 100, 100)).toBe('back')
    expect(hitTestVisualLayouts(layers, -5, 100)).toBeNull()
  })

  it('ignores cropped-away edges', () => {
    const layers = [layer('a', { crop: { left: 0.25, top: 0, right: 0, bottom: 0 } })]
    expect(hitTestVisualLayouts(layers, 100, 360)).toBeNull()
    expect(hitTestVisualLayouts(layers, 400, 360)).toBe('a')
  })

  it('follows the position offset', () => {
    const layers = [layer('moved', { scale: 0.25, positionX: 300, positionY: -100 })]
    expect(hitTestVisualLayouts(layers, 940, 260)).toBe('moved')
    expect(hitTestVisualLayouts(layers, 640, 360)).toBeNull()
  })

  it('accounts for rotation', () => {
    // A 640x360 box rotated 90 degrees about its centre covers x in 460..820, y in 40..680.
    const layers = [layer('turned', { scale: 0.5, rotation: 90 })]
    expect(hitTestVisualLayouts(layers, 640, 80)).toBe('turned')
    expect(hitTestVisualLayouts(layers, 840, 360)).toBeNull()
    expect(hitTestVisualLayouts(layers, 480, 360)).toBe('turned')
  })
})
