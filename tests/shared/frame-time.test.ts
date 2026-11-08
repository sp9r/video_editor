import { describe, expect, it } from 'vitest'
import { frameIndexForTime, timeUsForFrameIndex } from '../../src/shared/frame-time'

describe('canonical frame time', () => {
  const fps = { numerator: 30, denominator: 1 }

  it('uses the frame at or before the playhead', () => {
    expect(frameIndexForTime(0, fps)).toBe(0)
    expect(frameIndexForTime(33_333, fps)).toBe(0)
    expect(frameIndexForTime(33_334, fps)).toBe(1)
    expect(frameIndexForTime(66_666, fps)).toBe(1)
    expect(frameIndexForTime(66_667, fps)).toBe(2)
  })

  it('round-trips canonical frame start times', () => {
    expect(timeUsForFrameIndex(0, fps)).toBe(0)
    expect(timeUsForFrameIndex(1, fps)).toBe(33_333)
    expect(timeUsForFrameIndex(2, fps)).toBe(66_666)
    expect(frameIndexForTime(timeUsForFrameIndex(12, fps), fps)).toBe(12)
  })

  it('supports non-integer rational frame rates', () => {
    const ntsc = { numerator: 30_000, denominator: 1_001 }
    expect(frameIndexForTime(33_367, ntsc)).toBe(1)
    expect(frameIndexForTime(33_366, ntsc)).toBe(0)
  })
})
