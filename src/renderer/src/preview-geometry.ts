import { clipFirstFrame, FRAME_TIE_BAND_US } from '../../shared/clip-frames'
import { frameIndexForTime } from '../../shared/frame-time'
import type { VisualLayout } from '../../shared/visual-layout'
import type { Rational } from '../../shared/types'

/**
 * Half a microsecond: frame timestamps are whole microseconds, so a seek target
 * half a microsecond below a whole-microsecond threshold selects exactly the
 * frames strictly before it without float error.
 */
export const PREVIEW_SEEK_MARGIN_US = 0.5

const frameSeconds = (fps: Rational): number => Math.max(1, Math.round(fps.denominator)) / Math.max(1, Math.round(fps.numerator))

/**
 * Source time the paused video element is parked at to show timeline frame
 * `frameIndex`. Final puts clip frame k, counted from the clip's first frame
 * (a clip starting between two frames starts on the next one), on the last
 * source frame at or before source-in + (k + 0.5) frames.
 */
export const previewSeekSeconds = (
  clip: { startUs: number; sourceInUs: number },
  frameIndex: number,
  fps: Rational
): number => {
  const numerator = Math.max(1, Math.round(fps.numerator))
  const denominator = Math.max(1, Math.round(fps.denominator))
  const clipFrame = Math.max(0, frameIndex - clipFirstFrame(clip.startUs, fps))
  // FFmpeg's fps filter rounds a frame's timestamp (whole microseconds) to the nearest slot, ties to
  // the later one: slot k holds the last frame whose timestamp, plus the tie band, is strictly below
  // source-in + (k + 0.5) frames. Chromium shows the last frame at or before the seek time.
  const thresholdUs = Math.round(clip.sourceInUs) + ((2 * clipFrame + 1) * 1_000_000 * denominator) / (2 * numerator) - FRAME_TIE_BAND_US
  return Math.max(0, (Math.ceil(thresholdUs - 1e-6) - PREVIEW_SEEK_MARGIN_US) / 1_000_000)
}

/** Timeline frame whose picture is the presented source frame at `mediaTimeSeconds`. */
export const timelineFrameForPresentedMedia = (
  clip: { startUs: number; sourceInUs: number },
  mediaTimeSeconds: number,
  fps: Rational
): number => {
  // Slot k holds frames with a timestamp below (k + 0.5) frames, so a frame exactly on the tie belongs to k + 1.
  const slot = Math.floor((mediaTimeSeconds - clip.sourceInUs / 1_000_000) / frameSeconds(fps) + 0.5 + 1e-9)
  return clipFirstFrame(clip.startUs, fps) + Math.max(0, slot)
}

/**
 * The frame to compose. While playing, the frame actually presented by the
 * clock video wins so picture and subtitles change on the same frame; it is
 * ignored when it disagrees with the playhead by more than two frames.
 */
export const previewFrameIndex = (
  playheadUs: number,
  fps: Rational,
  presentedFrame: number | null
): number => {
  // timeUsForFrameIndex floors to whole microseconds, so a playhead parked on a
  // frame boundary can sit up to 1us below it; without this it shows the frame before.
  const playheadFrame = frameIndexForTime(playheadUs + 1, fps)
  return presentedFrame !== null && Math.abs(presentedFrame - playheadFrame) <= 2 ? presentedFrame : playheadFrame
}

/** Largest rect of the sequence aspect ratio that fits the viewer, in CSS pixels. */
export const fitSequenceToViewer = (
  viewerWidth: number,
  viewerHeight: number,
  sequenceWidth: number,
  sequenceHeight: number
): { scale: number; offsetX: number; offsetY: number } => {
  if (!(viewerWidth > 0) || !(viewerHeight > 0) || !(sequenceWidth > 0) || !(sequenceHeight > 0)) return { scale: 1, offsetX: 0, offsetY: 0 }
  const scale = Math.min(viewerWidth / sequenceWidth, viewerHeight / sequenceHeight)
  return { scale, offsetX: (viewerWidth - sequenceWidth * scale) / 2, offsetY: (viewerHeight - sequenceHeight * scale) / 2 }
}

/** Topmost layer whose visible (cropped, rotated) area contains the sequence-pixel point. */
export const hitTestVisualLayouts = (
  layers: ReadonlyArray<{ clipId: string; layout: VisualLayout }>,
  x: number,
  y: number
): string | null => {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const entry = layers[index]
    if (!entry) continue
    const { layout } = entry
    const dx = x - (layout.x + layout.rotatedWidth / 2)
    const dy = y - (layout.y + layout.rotatedHeight / 2)
    const cos = Math.cos(layout.rotationRadians)
    const sin = Math.sin(layout.rotationRadians)
    // Undo the canvas rotation to get back into the unrotated box.
    const localX = dx * cos + dy * sin
    const localY = -dx * sin + dy * cos
    if (localX >= -layout.boxWidth / 2 + layout.crop.left && localX <= layout.boxWidth / 2 - layout.crop.right
      && localY >= -layout.boxHeight / 2 + layout.crop.top && localY <= layout.boxHeight / 2 - layout.crop.bottom) return entry.clipId
  }
  return null
}
