import type { ReviewRating } from './types'

export const reviewRatingForShortcut = (enabled: boolean, typing: boolean, key: string): ReviewRating | null => {
  if (!enabled || typing) return null
  const normalized = key.toLocaleLowerCase()
  if (normalized === 'a') return 'good'
  if (normalized === 'b') return 'acceptable'
  if (normalized === 'c') return 'corrected'
  if (normalized === 'd') return 'skip'
  return null
}
