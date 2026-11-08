import { describe, expect, it } from 'vitest'
import { THUMBNAIL_CANDIDATE_COUNT, THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH, isNearBlackLuma, thumbnailCandidateTimesUs, validateThumbnailLayout, type ThumbnailLayout } from '../../src/shared/thumbnail'

const layout: ThumbnailLayout = { title: 'title', subtitle: '', fontFamily: 'Noto Sans JP', fontSize: 92, xPercent: 50, yPercent: 78, outlineWidth: 6, outlineColor: '#000', backgroundColor: '#000', backgroundOpacity: 0, shadowColor: '#000', shadowBlur: 12 }

describe('thumbnail helpers', () => {
  it('creates six evenly distributed times and fixed output dimensions', () => {
    expect(thumbnailCandidateTimesUs(60_000_000)).toHaveLength(THUMBNAIL_CANDIDATE_COUNT)
    expect(thumbnailCandidateTimesUs(60_000_000)[0]).toBe(8_571_429)
    expect(THUMBNAIL_WIDTH).toBe(1280)
    expect(THUMBNAIL_HEIGHT).toBe(720)
  })

  it('rejects near-black luma but keeps useful frames', () => {
    expect(isNearBlackLuma([0, 2, 7])).toBe(true)
    expect(isNearBlackLuma([0, 9, 7])).toBe(false)
    expect(isNearBlackLuma([])).toBe(false)
  })

  it('validates editable layout bounds', () => {
    expect(validateThumbnailLayout(layout)).toEqual(layout)
    expect(() => validateThumbnailLayout({ ...layout, fontSize: 0 })).toThrow()
    expect(() => validateThumbnailLayout({ ...layout, xPercent: 101 })).toThrow()
  })
})
