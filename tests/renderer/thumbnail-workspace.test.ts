import { describe, expect, it } from 'vitest'
import { thumbnailLoadIsCurrent } from '../../src/renderer/src/components/ThumbnailWorkspace'

describe('thumbnail image lifecycle', () => {
  it('rejects a reverse-order stale onload before canvas mutation', () => {
    expect(thumbnailLoadIsCurrent(1, 'A', 2, 'B')).toBe(false)
    expect(thumbnailLoadIsCurrent(2, 'A', 2, 'B')).toBe(false)
    expect(thumbnailLoadIsCurrent(2, 'B', 2, 'B')).toBe(true)
  })
})
