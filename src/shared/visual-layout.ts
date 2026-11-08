import type { MediaAsset, ProjectFile, TransformSettings } from './types'
import { visualLayerOrder, type VisualClip } from './render-order'

/**
 * The single source of visual geometry for Preview and Final.
 *
 * Every value is in sequence pixels. Final turns it into explicit FFmpeg
 * numbers (no FFmpeg-side size expressions), and Preview draws the same
 * rectangles on a canvas, so both place every pixel in the same spot.
 *
 * Order of operations, matching a conventional NLE:
 *  1. contain-fit the media inside the sequence frame, then apply scale
 *  2. hide cropped edges in place (the visible part is not resized or moved)
 *  3. rotate about the box centre without shrinking
 *  4. place the box centre at frame centre + position
 */
export interface VisualLayout {
  clipId: string
  /** Media size the box was fitted from (display orientation). */
  sourceWidth: number
  sourceHeight: number
  /** Scaled media box, before crop and rotation. Always even. */
  boxWidth: number
  boxHeight: number
  /** Pixels hidden on each side of the box. */
  crop: { left: number; top: number; right: number; bottom: number }
  /** Source-pixel rectangle that stays visible, for canvas drawImage. */
  sourceRect: { x: number; y: number; width: number; height: number }
  rotationRadians: number
  /** Size of the rotated bounding box. Equal to the box when not rotated. */
  rotatedWidth: number
  rotatedHeight: number
  /** Top-left of the rotated bounding box on the sequence frame. */
  x: number
  y: number
  opacity: number
}

export const LAYOUT_MIN_SCALE = 0.01
export const LAYOUT_MAX_SCALE = 20
export const LAYOUT_MAX_CROP = 0.49

const clamp = (value: number, minimum: number, maximum: number, fallback = minimum): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : fallback))

const evenFloor = (value: number): number => Math.max(2, Math.floor(value / 2) * 2)

export const layoutCropFractions = (transform: TransformSettings): { left: number; top: number; right: number; bottom: number } => {
  const crop = {
    left: clamp(transform.crop.left, 0, LAYOUT_MAX_CROP, 0),
    top: clamp(transform.crop.top, 0, LAYOUT_MAX_CROP, 0),
    right: clamp(transform.crop.right, 0, LAYOUT_MAX_CROP, 0),
    bottom: clamp(transform.crop.bottom, 0, LAYOUT_MAX_CROP, 0)
  }
  if (1 - crop.left - crop.right <= 0.01 || 1 - crop.top - crop.bottom <= 0.01) throw new Error('Crop leaves no visible pixels')
  return crop
}

export const computeVisualLayout = (
  clip: Pick<VisualClip, 'id' | 'transform'>,
  asset: Pick<MediaAsset, 'width' | 'height'> | undefined,
  sequenceWidth: number,
  sequenceHeight: number
): VisualLayout => {
  const transform = clip.transform
  const sourceWidth = asset?.width && asset.width > 0 ? asset.width : sequenceWidth
  const sourceHeight = asset?.height && asset.height > 0 ? asset.height : sequenceHeight
  const scale = clamp(transform.scale, LAYOUT_MIN_SCALE, LAYOUT_MAX_SCALE, 1)
  const fit = Math.min(sequenceWidth / sourceWidth, sequenceHeight / sourceHeight) * scale
  const boxWidth = evenFloor(sourceWidth * fit)
  const boxHeight = evenFloor(sourceHeight * fit)

  const fractions = layoutCropFractions(transform)
  const crop = {
    left: Math.round(boxWidth * fractions.left),
    top: Math.round(boxHeight * fractions.top),
    right: Math.round(boxWidth * fractions.right),
    bottom: Math.round(boxHeight * fractions.bottom)
  }
  const sourceRect = {
    x: crop.left / boxWidth * sourceWidth,
    y: crop.top / boxHeight * sourceHeight,
    width: (boxWidth - crop.left - crop.right) / boxWidth * sourceWidth,
    height: (boxHeight - crop.top - crop.bottom) / boxHeight * sourceHeight
  }

  const rotationRadians = clamp(transform.rotation, -360_000, 360_000, 0) * Math.PI / 180
  const rotated = Math.abs(Math.sin(rotationRadians)) > 1e-9 || Math.cos(rotationRadians) < 0
  const cos = Math.abs(Math.cos(rotationRadians))
  const sin = Math.abs(Math.sin(rotationRadians))
  // Even sizes keep the bounding box centred on the same pixel as the box.
  const rotatedWidth = rotated ? Math.ceil((boxWidth * cos + boxHeight * sin) / 2 - 1e-9) * 2 : boxWidth
  const rotatedHeight = rotated ? Math.ceil((boxWidth * sin + boxHeight * cos) / 2 - 1e-9) * 2 : boxHeight

  const centreX = sequenceWidth / 2 + (Number.isFinite(transform.positionX) ? transform.positionX : 0)
  const centreY = sequenceHeight / 2 + (Number.isFinite(transform.positionY) ? transform.positionY : 0)
  return {
    clipId: clip.id,
    sourceWidth,
    sourceHeight,
    boxWidth,
    boxHeight,
    crop,
    sourceRect,
    rotationRadians: rotated ? rotationRadians : 0,
    rotatedWidth,
    rotatedHeight,
    x: Math.round(centreX - rotatedWidth / 2),
    y: Math.round(centreY - rotatedHeight / 2),
    opacity: clamp(transform.opacity, 0, 1, 1)
  }
}

/** Visual layers active at timeUs, background first, with their layout. */
export const visualLayoutsAt = (
  project: ProjectFile,
  timeUs: number
): Array<{ clip: VisualClip; asset: MediaAsset | undefined; layout: VisualLayout }> => {
  const assets = new Map(project.media.map((asset) => [asset.id, asset]))
  return visualLayerOrder(project)
    .filter(({ clip }) => clip.startUs <= timeUs && clip.startUs + clip.durationUs > timeUs)
    .map(({ clip }) => {
      const asset = assets.get(clip.assetId)
      return { clip, asset, layout: computeVisualLayout(clip, asset, project.sequence.width, project.sequence.height) }
    })
}
