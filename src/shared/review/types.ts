import type { MediaAsset, ProjectFile, SubtitleClip, TimeUs } from '../types'

export type ReviewRating = 'good' | 'acceptable' | 'corrected' | 'skip'
export type CorrectionType =
  | 'boundary_split'
  | 'boundary_merge'
  | 'boundary_move'
  | 'text_edit'
  | 'delete'
  | 'timing_edit'
  | 'mixed'
  | 'none'

export interface ReviewWordSnapshot {
  id: string
  text: string
  startUs: TimeUs
  endUs: TimeUs
}

export interface ReviewCaptionSnapshot {
  id: string
  trackId: string
  name: string
  text: string
  startUs: TimeUs
  durationUs: TimeUs
  sourceInUs: TimeUs
  words?: ReviewWordSnapshot[]
  wordsMatchText: boolean
}

export interface ReviewNeighborhoodSnapshot {
  targetId: string
  trackId: string
  captions: ReviewCaptionSnapshot[]
  targetCaptionIds: string[]
  targetWordIds: string[]
  capturedAt: string
}

export interface CorrectionSummary {
  primary: CorrectionType
  types: CorrectionType[]
  changedCaptionIds: string[]
  changedWordIds: string[]
}

export interface ReviewProvenance {
  projectId: string
  projectName: string
  projectFingerprint: string
  media: Array<Pick<MediaAsset, 'id' | 'name' | 'fileSize' | 'modifiedAt'>>
}

export interface ExperimentalReviewRecord {
  version: 'experimental.phase3.5b1'
  recordId: string
  sessionId: string
  decidedAt: string
  rating: ReviewRating
  target: { captionId: string; trackId: string }
  baseline: ReviewNeighborhoodSnapshot
  final: ReviewNeighborhoodSnapshot
  correction: CorrectionSummary
  boundaryLearningEligible: boolean
  textLearningEligible: boolean
  provenance: ReviewProvenance
}

export interface ExperimentalReviewLog {
  version: 'experimental.phase3.5b1'
  records: ExperimentalReviewRecord[]
}

export type ReviewProject = ProjectFile
export type ReviewCaption = SubtitleClip
