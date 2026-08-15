import type { ExperimentalReviewLog, ExperimentalReviewRecord } from './types'

export const REVIEW_LOG_VERSION = 'experimental.phase3.5b1' as const

export const createEmptyReviewLog = (): ExperimentalReviewLog => ({ version: REVIEW_LOG_VERSION, records: [] })

export const parseExperimentalReviewLog = (raw: string): ExperimentalReviewLog => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return createEmptyReviewLog()
    const value = parsed as Partial<ExperimentalReviewLog>
    if (value.version !== REVIEW_LOG_VERSION || !Array.isArray(value.records)) return createEmptyReviewLog()
    return { version: REVIEW_LOG_VERSION, records: value.records.filter((record): record is ExperimentalReviewRecord => Boolean(record && typeof record === 'object' && (record as ExperimentalReviewRecord).version === REVIEW_LOG_VERSION)) }
  } catch {
    return createEmptyReviewLog()
  }
}

export const serializeExperimentalReviewLog = (records: ExperimentalReviewRecord[]): string =>
  JSON.stringify({ version: REVIEW_LOG_VERSION, records }, null, 2) + '\n'

export const upsertExperimentalReviewRecord = (records: ExperimentalReviewRecord[], record: ExperimentalReviewRecord): ExperimentalReviewRecord[] => {
  const next = records.filter((item) => !(item.sessionId === record.sessionId && item.target.captionId === record.target.captionId))
  return [...next, structuredClone(record)]
}
