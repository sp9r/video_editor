import type { Rational } from './types.js'

/**
 * First timeline frame a clip is shown on. A clip that starts between two
 * frames is shown from the next frame on (Final rounds the start up), and the
 * clip's own frame grid begins there. Preview and Final both use this number,
 * so the source picture chosen for timeline frame n is the same in both.
 */
export const clipFirstFrame = (startUs: number, fps: Rational): number => {
  const numerator = Math.max(1, Math.round(fps.numerator))
  const denominator = Math.max(1, Math.round(fps.denominator))
  return Math.max(0, Math.ceil((startUs * numerator) / (denominator * 1_000_000) - 0.0001))
}

/**
 * A source frame whose timestamp lands within this many microseconds before the
 * half-frame boundary between two timeline frames is shown on the later one.
 * FFmpeg and Chromium round frame timestamps to microseconds differently (a
 * 1/60 s frame is 16666 us in one and 16667 us in the other), so an exact tie
 * would otherwise go to different timeline frames.
 */
export const FRAME_TIE_BAND_US = 50
