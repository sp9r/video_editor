import { describe, expect, it } from 'vitest'
import { filterSubtitleReviewIds, moveSubtitleReviewIndex, subtitleReviewProgress, subtitleReviewRatingForKey, subtitleReviewStatusLabel } from '../../src/renderer/src/subtitle-review-workspace'

describe('subtitle review workspace helpers', () => {
  const ids = ['caption-1', 'caption-2', 'caption-3']
  const decisions = { 'caption-1': { rating: 'good' as const }, 'caption-3': { rating: 'corrected' as const } }

  it('maps product keyboard and status labels without changing review schema', () => {
    expect(subtitleReviewRatingForKey('1')).toBe('good')
    expect(subtitleReviewRatingForKey('2')).toBe('acceptable')
    expect(subtitleReviewRatingForKey('3')).toBe('corrected')
    expect(subtitleReviewRatingForKey('4')).toBe('skip')
    expect(subtitleReviewRatingForKey('a')).toBeNull()
    expect(subtitleReviewStatusLabel(undefined)).toBe('未確認')
    expect(subtitleReviewStatusLabel('corrected')).toBe('修正済み')
  })

  it('filters pending, corrected and fallback rows', () => {
    expect(filterSubtitleReviewIds(ids, 'pending', decisions, new Set())).toEqual(['caption-2'])
    expect(filterSubtitleReviewIds(ids, 'corrected', decisions, new Set())).toEqual(['caption-3'])
    expect(filterSubtitleReviewIds(ids, 'fallback', decisions, new Set(['caption-2']))).toEqual(['caption-2'])
    expect(filterSubtitleReviewIds(ids, 'all', decisions, new Set())).toEqual(ids)
  })

  it('moves within the filtered list and reports all-item progress', () => {
    expect(moveSubtitleReviewIndex(['caption-2', 'caption-3'], 'caption-2', 1)).toBe('caption-3')
    expect(moveSubtitleReviewIndex(['caption-2', 'caption-3'], 'caption-2', -1)).toBe('caption-2')
    expect(moveSubtitleReviewIndex(['caption-2', 'caption-3'], undefined, 1)).toBe('caption-2')
    expect(subtitleReviewProgress(ids, decisions)).toEqual({ reviewed: 2, total: 3 })
  })

  it('handles a large caption list without preview-oriented expansion', () => {
    const large = Array.from({ length: 1000 }, (_, index) => `caption-${index}`)
    expect(filterSubtitleReviewIds(large, 'pending', {}, new Set())).toHaveLength(1000)
    expect(moveSubtitleReviewIndex(large, 'caption-499', 1)).toBe('caption-500')
  })
})
