import { describe, expect, it } from 'vitest'
import { accuratePreviewFrameMatchesCurrent } from '../../src/renderer/src/components/Preview'

describe('accurate preview state guard', () => {
  const frame = { projectFingerprint: 'project-a', requestedTimeUs: 1_000_000 }

  it('rejects a frame from another project or stale playhead', () => {
    expect(accuratePreviewFrameMatchesCurrent(frame, 'project-b', 1_000_000, 33_334)).toBe(false)
    expect(accuratePreviewFrameMatchesCurrent(frame, 'project-a', 1_100_000, 33_334)).toBe(false)
    expect(accuratePreviewFrameMatchesCurrent(frame, 'project-a', 1_033_334, 33_334)).toBe(true)
  })
})
