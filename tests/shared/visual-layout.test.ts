import { describe, expect, it } from 'vitest'
import { DEFAULT_TRANSFORM, type TransformSettings } from '../../src/shared/types'
import { computeVisualLayout } from '../../src/shared/visual-layout'

const transform = (patch: Partial<TransformSettings> = {}): TransformSettings => ({ ...structuredClone(DEFAULT_TRANSFORM), ...patch })
const layout = (patch: Partial<TransformSettings>, asset = { width: 1920, height: 1080 }, width = 1280, height = 720) =>
  computeVisualLayout({ id: 'c', transform: transform(patch) }, asset, width, height)

describe('computeVisualLayout', () => {
  it('contain-fits the media inside the sequence frame and centres it', () => {
    expect(layout({})).toMatchObject({ boxWidth: 1280, boxHeight: 720, x: 0, y: 0, rotatedWidth: 1280, rotationRadians: 0 })
    // 4:3 media in a 16:9 frame is limited by height.
    expect(layout({}, { width: 800, height: 600 })).toMatchObject({ boxWidth: 960, boxHeight: 720, x: 160, y: 0 })
    // Portrait media is limited by height too, and stays centred.
    expect(layout({}, { width: 1080, height: 1920 })).toMatchObject({ boxWidth: 404, boxHeight: 720, x: 438, y: 0 })
  })

  it('applies scale after the fit and position from the frame centre', () => {
    expect(layout({ scale: 0.5, positionX: 100, positionY: -50 }))
      .toMatchObject({ boxWidth: 640, boxHeight: 360, x: 420, y: 130 })
  })

  it('crops in place: the box and its position do not change', () => {
    const plain = layout({ scale: 0.5 })
    const cropped = layout({ scale: 0.5, crop: { left: 0.1, top: 0.05, right: 0.2, bottom: 0.1 } })
    expect(cropped.boxWidth).toBe(plain.boxWidth)
    expect(cropped.x).toBe(plain.x)
    expect(cropped.y).toBe(plain.y)
    expect(cropped.crop).toEqual({ left: 64, top: 18, right: 128, bottom: 36 })
    expect(cropped.sourceRect).toEqual({ x: 192, y: 54, width: 1344, height: 918 })
  })

  it('rotates about the centre without shrinking the box', () => {
    const rotated = layout({ rotation: 90 })
    expect(rotated.boxWidth).toBe(1280)
    expect(rotated.rotatedWidth).toBe(720)
    expect(rotated.rotatedHeight).toBe(1280)
    // The bounding box stays centred on the frame centre.
    expect(rotated.x + rotated.rotatedWidth / 2).toBe(640)
    expect(rotated.y + rotated.rotatedHeight / 2).toBe(360)
    const tilted = layout({ rotation: 10 })
    expect(tilted.rotatedWidth % 2).toBe(0)
    expect(tilted.rotatedWidth).toBeGreaterThan(1280)
  })

  it('clamps opacity and crop', () => {
    expect(layout({ opacity: 3 }).opacity).toBe(1)
    expect(layout({ opacity: -1 }).opacity).toBe(0)
    expect(layout({ crop: { left: 0.9, top: 0, right: 0, bottom: 0 } }).crop.left).toBe(627)
  })

  it('falls back to the sequence size when the asset size is unknown', () => {
    expect(computeVisualLayout({ id: 'c', transform: transform() }, undefined, 640, 360)).toMatchObject({ boxWidth: 640, boxHeight: 360 })
  })
})
