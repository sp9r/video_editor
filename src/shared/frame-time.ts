import type { Rational, TimeUs } from './types.js'

const MICROSECONDS_PER_SECOND = 1_000_000

/** Final video uses floor semantics: show the last frame at or before playhead. */
export const frameIndexForTime = (timeUs: TimeUs, fps: Rational): number => {
  if (!Number.isFinite(timeUs) || timeUs <= 0) return 0
  const numerator = Math.max(1, Math.round(fps.numerator))
  const denominator = Math.max(1, Math.round(fps.denominator))
  return Math.max(0, Math.floor((timeUs * numerator) / (MICROSECONDS_PER_SECOND * denominator) + Number.EPSILON))
}

export const timeUsForFrameIndex = (frameIndex: number, fps: Rational): TimeUs => {
  const numerator = Math.max(1, Math.round(fps.numerator))
  const denominator = Math.max(1, Math.round(fps.denominator))
  const safeIndex = Math.max(0, Math.floor(Number.isFinite(frameIndex) ? frameIndex : 0))
  return Math.floor((safeIndex * MICROSECONDS_PER_SECOND * denominator) / numerator)
}

export const frameRateText = (fps: Rational): string => `${Math.max(1, Math.round(fps.numerator))}/${Math.max(1, Math.round(fps.denominator))}`
