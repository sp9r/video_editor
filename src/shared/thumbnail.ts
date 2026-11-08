export const THUMBNAIL_WIDTH = 1280
export const THUMBNAIL_HEIGHT = 720
export const THUMBNAIL_CANDIDATE_COUNT = 6

export interface ThumbnailFrameCandidate {
  id: string
  timeUs: number
  framePath: string
}

export interface ThumbnailLayout {
  title: string
  subtitle: string
  fontFamily: string
  fontSize: number
  xPercent: number
  yPercent: number
  outlineWidth: number
  outlineColor: string
  backgroundColor: string
  backgroundOpacity: number
  shadowColor: string
  shadowBlur: number
}

export const thumbnailCandidateTimesUs = (durationUs: number, count = THUMBNAIL_CANDIDATE_COUNT): number[] => {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0 || !Number.isSafeInteger(count) || count <= 0) return []
  return Array.from({ length: count }, (_, index) => Math.min(durationUs - 1, Math.max(0, Math.round(durationUs * (index + 1) / (count + 1)))))
}

export const isNearBlackLuma = (samples: readonly number[], threshold = 8): boolean => samples.length > 0 && samples.every((value) => typeof value === 'number' && Number.isFinite(value) && value <= threshold)

export const validateThumbnailLayout = (layout: ThumbnailLayout): ThumbnailLayout => {
  if (typeof layout.title !== 'string' || layout.title.length > 500) throw new Error('thumbnail title is invalid')
  if (typeof layout.subtitle !== 'string' || layout.subtitle.length > 500) throw new Error('thumbnail subtitle is invalid')
  if (typeof layout.fontFamily !== 'string' || layout.fontFamily.length === 0 || layout.fontFamily.length > 256) throw new Error('thumbnail font is invalid')
  for (const [key, value] of Object.entries(layout)) if (['title', 'subtitle', 'fontFamily', 'outlineColor', 'backgroundColor', 'shadowColor'].includes(key) ? typeof value !== 'string' : typeof value !== 'number' || !Number.isFinite(value)) throw new Error('thumbnail layout contains an invalid value')
  if (layout.fontSize < 12 || layout.fontSize > 300 || layout.xPercent < 0 || layout.xPercent > 100 || layout.yPercent < 0 || layout.yPercent > 100 || layout.outlineWidth < 0 || layout.outlineWidth > 40 || layout.backgroundOpacity < 0 || layout.backgroundOpacity > 1 || layout.shadowBlur < 0 || layout.shadowBlur > 80) throw new Error('thumbnail layout is out of range')
  return structuredClone(layout)
}
