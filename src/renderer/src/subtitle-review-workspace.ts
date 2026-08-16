import type { ReviewRating } from '../../shared/review/types'

export type SubtitleReviewFilter = 'all' | 'pending' | 'corrected' | 'fallback'

export const subtitleReviewStatusLabel = (rating: ReviewRating | undefined): string => {
  if (rating === 'good') return '良い'
  if (rating === 'acceptable') return '許容'
  if (rating === 'corrected') return '修正済み'
  if (rating === 'skip') return 'スキップ'
  return '未確認'
}

export const subtitleReviewRatingForKey = (key: string): ReviewRating | null => {
  if (key === '1') return 'good'
  if (key === '2') return 'acceptable'
  if (key === '3') return 'corrected'
  if (key === '4') return 'skip'
  return null
}

export const subtitleReviewFilterLabel = (filter: SubtitleReviewFilter): string => ({
  all: '全件',
  pending: '未確認のみ',
  corrected: '修正済みのみ',
  fallback: 'fallback字幕のみ'
}[filter])

export const filterSubtitleReviewIds = (
  ids: readonly string[],
  filter: SubtitleReviewFilter,
  decisions: Readonly<Record<string, { rating: ReviewRating }>>,
  fallbackIds: ReadonlySet<string>
): string[] => ids.filter((id) => {
  const rating = decisions[id]?.rating
  if (filter === 'pending') return !rating
  if (filter === 'corrected') return rating === 'corrected'
  if (filter === 'fallback') return fallbackIds.has(id)
  return true
})

export const subtitleReviewProgress = (ids: readonly string[], decisions: Readonly<Record<string, { rating: ReviewRating }>>): { reviewed: number; total: number } => ({
  reviewed: ids.filter((id) => Boolean(decisions[id])).length,
  total: ids.length
})

export const moveSubtitleReviewIndex = (ids: readonly string[], currentId: string | undefined, direction: -1 | 1): string | undefined => {
  if (!ids.length) return undefined
  const currentIndex = currentId ? ids.indexOf(currentId) : -1
  const nextIndex = Math.min(ids.length - 1, Math.max(0, currentIndex < 0 ? (direction > 0 ? 0 : ids.length - 1) : currentIndex + direction))
  return ids[nextIndex]
}
