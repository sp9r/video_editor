import type { Rational } from './types.js'

/**
 * One timing rule for subtitles, shared by Preview and the libass export.
 *
 * A cue is visible on frame f when firstFrame <= f < endFrame, where
 * firstFrame is the first frame whose time is >= startUs and endFrame (exclusive)
 * is the first frame whose time is >= endUs. The ASS file is then written so
 * libass shows exactly those frames: libass receives the frame time rounded to
 * whole milliseconds and shows an event while start <= time < end with both in
 * centiseconds, so flooring the start/end of the boundary frames to a
 * centisecond keeps the neighbouring frame (at least 10 ms away, i.e. up to
 * 100 fps) on the correct side of each boundary.
 */

const MICROSECONDS_PER_SECOND = 1_000_000

const normalizeRate = (fps: Rational): { numerator: number; denominator: number } => ({
  numerator: Math.max(1, Math.round(fps.numerator)),
  denominator: Math.max(1, Math.round(fps.denominator))
})

const ceilDiv = (numerator: number, denominator: number): number => {
  let quotient = Math.ceil(numerator / denominator)
  while (quotient * denominator < numerator) quotient += 1
  while ((quotient - 1) * denominator >= numerator) quotient -= 1
  return quotient
}

/** First frame whose time (frameIndex * den / num seconds) is >= timeUs. */
export const firstFrameAtOrAfterUs = (timeUs: number, fps: Rational): number => {
  if (!Number.isFinite(timeUs) || timeUs <= 0) return 0
  const { numerator, denominator } = normalizeRate(fps)
  return ceilDiv(Math.round(timeUs) * numerator, MICROSECONDS_PER_SECOND * denominator)
}

/**
 * The millisecond clock libass is asked to draw a frame at. FFmpeg's ass filter
 * computes it as floor(pts * av_q2d(time_base) * 1000) in double precision, so
 * exact-millisecond frame times can land one millisecond early; this mirrors it.
 */
export const frameTimeMs = (frameIndex: number, fps: Rational): number => {
  const { numerator, denominator } = normalizeRate(fps)
  return Math.floor(Math.max(0, frameIndex) * (denominator / numerator) * 1000)
}

/** Frame index at or before the floored microsecond time (inverse of timeUsForFrameIndex). */
export const frameIndexAtOrBeforeUs = (timeUs: number, fps: Rational): number => {
  if (!Number.isFinite(timeUs) || timeUs <= 0) return 0
  const { numerator, denominator } = normalizeRate(fps)
  const frameUs = (index: number): number => Math.floor((index * MICROSECONDS_PER_SECOND * denominator) / numerator)
  let index = Math.floor((timeUs * numerator) / (MICROSECONDS_PER_SECOND * denominator))
  while (frameUs(index + 1) <= timeUs) index += 1
  while (index > 0 && frameUs(index) > timeUs) index -= 1
  return index
}

export const floorToCentisecondMs = (milliseconds: number): number => Math.floor(Math.max(0, milliseconds) / 10) * 10

export interface SubtitleFrameRange {
  /** First frame on which the cue is visible. */
  firstFrame: number
  /** First frame on which the cue is no longer visible (exclusive end). */
  endFrame: number
}

/** Frames a cue occupies, or null when it falls between two frames and is never shown. */
export const subtitleFrameRange = (startUs: number, durationUs: number, fps: Rational): SubtitleFrameRange | null => {
  const firstFrame = firstFrameAtOrAfterUs(startUs, fps)
  const endFrame = firstFrameAtOrAfterUs(startUs + durationUs, fps)
  return endFrame > firstFrame ? { firstFrame, endFrame } : null
}

export interface SubtitleAssWindow {
  /** Centisecond-aligned ASS start, in milliseconds. */
  startMs: number
  /** Centisecond-aligned ASS end (exclusive), in milliseconds. */
  endMs: number
}

/** ASS event times for a frame range; libass shows the event on exactly these frames. */
export const subtitleAssWindow = (range: SubtitleFrameRange, fps: Rational): SubtitleAssWindow => ({
  startMs: floorToCentisecondMs(frameTimeMs(range.firstFrame, fps)),
  endMs: floorToCentisecondMs(frameTimeMs(range.endFrame, fps))
})

export interface SubtitleCueFrameState {
  frameIndex: number
  /** Milliseconds from the ASS start to this frame, as libass computes it. */
  offsetMs: number
  /** Milliseconds from this frame to the ASS end. */
  remainingMs: number
}

export const subtitleCueFrameState = (range: SubtitleFrameRange, frameIndex: number, fps: Rational): SubtitleCueFrameState | null => {
  if (frameIndex < range.firstFrame || frameIndex >= range.endFrame) return null
  const window = subtitleAssWindow(range, fps)
  const now = frameTimeMs(frameIndex, fps)
  return { frameIndex, offsetMs: now - window.startMs, remainingMs: window.endMs - now }
}
