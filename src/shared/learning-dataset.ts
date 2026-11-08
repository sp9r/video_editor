import type { ExperimentalReviewRecord, ReviewCaptionSnapshot, ReviewWordSnapshot } from './review/types'

export const LEARNING_DATASET_VERSION = 'experimental.learning-dataset.v1' as const

export interface LearningDatasetCaption {
  id: string
  trackId: string
  text: string
  startUs: number
  endUs: number
  sourceInUs: number
  words?: ReviewWordSnapshot[]
  wordsMatchText: boolean
  style?: ReviewCaptionSnapshot['style']
}

export interface LearningDatasetSample {
  version: typeof LEARNING_DATASET_VERSION
  sampleKey: string
  project: { anonymousId: string }
  target: { captionId: string; trackId: string }
  baseline: { captions: LearningDatasetCaption[]; targetCaptionIds: string[]; targetWordIds: string[] }
  final: { captions: LearningDatasetCaption[]; targetCaptionIds: string[]; targetWordIds: string[] }
  sourceWordOwnership: { baseline: ReviewWordSnapshot[]; final: ReviewWordSnapshot[] }
  timing: { before: Array<{ captionId: string; startUs: number; endUs: number }>; after: Array<{ captionId: string; startUs: number; endUs: number }> }
  correction: { primary: string; types: string[]; changedCaptionIds: string[]; changedWordIds: string[]; style?: { before: LearningDatasetCaption['style']; after: LearningDatasetCaption['style'] } }
  rating: ExperimentalReviewRecord['rating']
  eligibility: { boundaryLearningEligible: boolean; textLearningEligible: boolean; eligible: boolean }
}

export interface LearningDatasetBuildResult {
  samples: LearningDatasetSample[]
  excludedSamples: number
  diagnostics: string[]
  correctionCategories: Record<string, number>
}

export interface LearningDatasetExportResult {
  eligibleSamples: number
  excludedSamples: number
  malformedRecords: number
  correctionCategories: Record<string, number>
  exported: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const safeString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const hash = (value: string): string => {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16).padStart(8, '0')
}

const caption = (value: unknown): LearningDatasetCaption => {
  if (!isRecord(value) || !safeString(value.id) || !safeString(value.trackId) || typeof value.text !== 'string' || !Number.isSafeInteger(value.startUs) || !Number.isSafeInteger(value.durationUs) || !Number.isSafeInteger(value.sourceInUs)) throw new Error('caption snapshot is malformed')
  const startUs = value.startUs as number
  const durationUs = value.durationUs as number
  const sourceInUs = value.sourceInUs as number
  const words = value.words
  if (words !== undefined && (!Array.isArray(words) || words.some((word) => !isRecord(word) || !safeString(word.id) || typeof word.text !== 'string' || !Number.isSafeInteger(word.startUs) || !Number.isSafeInteger(word.endUs)))) throw new Error('word ownership is malformed')
  return {
    id: value.id,
    trackId: value.trackId,
    text: value.text,
    startUs,
    endUs: startUs + durationUs,
    sourceInUs,
    ...(words ? { words: words.map((word) => ({ id: word.id as string, text: word.text as string, startUs: word.startUs as number, endUs: word.endUs as number })) } : {}),
    wordsMatchText: value.wordsMatchText === true,
    ...(value.style && isRecord(value.style) ? { style: structuredClone(value.style) as unknown as LearningDatasetCaption['style'] } : {})
  }
}

const snapshot = (value: unknown): { captions: LearningDatasetCaption[]; targetCaptionIds: string[]; targetWordIds: string[] } => {
  if (!isRecord(value) || !Array.isArray(value.captions) || !Array.isArray(value.targetCaptionIds) || !Array.isArray(value.targetWordIds)) throw new Error('review snapshot is malformed')
  if (value.targetCaptionIds.some((id) => !safeString(id)) || value.targetWordIds.some((id) => !safeString(id))) throw new Error('review target identity is malformed')
  return { captions: value.captions.map(caption), targetCaptionIds: value.targetCaptionIds as string[], targetWordIds: value.targetWordIds as string[] }
}

const wordsForTargets = (value: { captions: LearningDatasetCaption[]; targetCaptionIds: string[] }): ReviewWordSnapshot[] => value.captions.filter((item) => value.targetCaptionIds.includes(item.id)).flatMap((item) => item.words ?? [])
const timingForTargets = (value: { captions: LearningDatasetCaption[]; targetCaptionIds: string[] }): Array<{ captionId: string; startUs: number; endUs: number }> => value.captions.filter((item) => value.targetCaptionIds.includes(item.id)).map((item) => ({ captionId: item.id, startUs: item.startUs, endUs: item.endUs }))

const convertRecord = (value: unknown): LearningDatasetSample => {
  if (!isRecord(value)) throw new Error('review record is not an object')
  if (value.version !== 'experimental.phase3.5b1') throw new Error('review record version is malformed')
  if (!isRecord(value.target) || !safeString(value.target.captionId) || !safeString(value.target.trackId)) throw new Error('review record target is malformed')
  if (!isRecord(value.provenance) || !safeString(value.provenance.projectId) || !safeString(value.provenance.projectFingerprint)) throw new Error('review record provenance is malformed')
  if (!isRecord(value.baseline) || !isRecord(value.final) || !isRecord(value.correction)) throw new Error('review record payload is malformed')
  const target = value.target
  const baseline = snapshot(value.baseline)
  const final = snapshot(value.final)
  const rating = value.rating
  if (!['good', 'acceptable', 'corrected', 'skip'].includes(String(rating))) throw new Error('review rating is malformed')
  const primary = safeString(value.correction.primary) ? value.correction.primary : 'none'
  const types = Array.isArray(value.correction.types) ? value.correction.types.filter((item): item is string => safeString(item)) : []
  const boundary = value.boundaryLearningEligible === true
  const text = value.textLearningEligible === true
  const beforeStyle = baseline.captions.find((item) => item.id === target.captionId)?.style
  const afterStyle = final.captions.find((item) => item.id === target.captionId)?.style
  const style = beforeStyle && afterStyle && JSON.stringify(beforeStyle) !== JSON.stringify(afterStyle) ? { before: beforeStyle, after: afterStyle } : undefined
  return {
    version: LEARNING_DATASET_VERSION,
    sampleKey: `sample-${hash(`${value.provenance.projectId}|${value.target.trackId}|${value.target.captionId}`)}`,
    project: { anonymousId: `project-${hash(value.provenance.projectId)}` },
    target: { captionId: value.target.captionId, trackId: value.target.trackId },
    baseline,
    final,
    sourceWordOwnership: { baseline: wordsForTargets(baseline), final: wordsForTargets(final) },
    timing: { before: timingForTargets(baseline), after: timingForTargets(final) },
    correction: { primary, types, changedCaptionIds: Array.isArray(value.correction.changedCaptionIds) ? value.correction.changedCaptionIds.filter((item): item is string => safeString(item)) : [], changedWordIds: Array.isArray(value.correction.changedWordIds) ? value.correction.changedWordIds.filter((item): item is string => safeString(item)) : [], ...(style ? { style } : {}) },
    rating: rating as LearningDatasetSample['rating'],
    eligibility: { boundaryLearningEligible: boundary, textLearningEligible: text, eligible: boundary || text }
  }
}

export const buildLearningDataset = (records: readonly unknown[]): LearningDatasetBuildResult => {
  const byKey = new Map<string, { sample: LearningDatasetSample; eligible: boolean }>()
  const diagnostics: string[] = []
  for (const [index, record] of records.entries()) {
    try {
      const sample = convertRecord(record)
      byKey.set(sample.sampleKey, { sample, eligible: sample.eligibility.eligible })
    } catch (error) {
      diagnostics.push(`record ${index + 1} skipped: ${error instanceof Error ? error.message : 'malformed review record'}`)
    }
  }
  const values = [...byKey.values()]
  const correctionCategories: Record<string, number> = {}
  for (const { sample } of values) correctionCategories[sample.correction.primary] = (correctionCategories[sample.correction.primary] ?? 0) + 1
  return { samples: values.filter((item) => item.eligible).map((item) => item.sample), excludedSamples: values.filter((item) => !item.eligible).length, diagnostics, correctionCategories }
}

export const serializeLearningDatasetJsonl = (samples: readonly LearningDatasetSample[]): string => samples.map((sample) => JSON.stringify(sample)).join('\n') + (samples.length ? '\n' : '')

export const parseLearningDatasetJsonl = (raw: string): LearningDatasetSample[] => raw.split(/\r?\n/u).filter(Boolean).map((line) => {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || value.version !== LEARNING_DATASET_VERSION || !safeString(value.sampleKey)) throw new Error('learning dataset sample is malformed')
  return value as unknown as LearningDatasetSample
})
