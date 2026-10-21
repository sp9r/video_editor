import { frameIndexForTime, timeUsForFrameIndex } from '../../shared/frame-time'
import type { VisualLayout } from '../../shared/visual-layout'
import type { Rational } from '../../shared/types'

/**
 * Just under the half-frame tie. FFmpeg's fps filter rounds each source frame
 * to the nearest output slot (ties go to the later slot), so the source frame
 * Final shows for timeline frame n is the last one at or before n + 0.5 frames.
 * Chromium presents the last frame at or before the seek target, hence
 * target = (n + 0.5) frames - epsilon. Seeking to exactly n/fps picks the
 * previous frame about a third of the time because of float error.
 */
export const PREVIEW_SEEK_EPSILON_SECONDS = 0.0005

const frameSeconds = (fps: Rational): number => Math.max(1, Math.round(fps.denominator)) / Math.max(1, Math.round(fps.numerator))

/** Source time the paused video element is parked at to show timeline frame `frameIndex`. */
export const previewSeekSeconds = (
  clip: { startUs: number; sourceInUs: number },
  frameIndex: number,
  fps: Rational
): number => {
  const frameTimeUs = timeUsForFrameIndex(frameIndex, fps)
  const sourceSeconds = (clip.sourceInUs + Math.max(0, frameTimeUs - clip.startUs)) / 1_000_000
  return Math.max(0, sourceSeconds + frameSeconds(fps) / 2 - PREVIEW_SEEK_EPSILON_SECONDS)
}

/** Timeline frame whose picture is the presented source frame at `mediaTimeSeconds`. */
export const timelineFrameForPresentedMedia = (
  clip: { startUs: number; sourceInUs: number },
  mediaTimeSeconds: number,
  fps: Rational
): number => {
  const timelineSeconds = (clip.startUs - clip.sourceInUs) / 1_000_000 + mediaTimeSeconds
  const slot = Math.floor(timelineSeconds / frameSeconds(fps) + 0.5 + 1e-9)
  return Math.max(0, slot)
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
