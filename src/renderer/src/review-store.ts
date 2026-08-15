import { create } from 'zustand'
import type { ProjectFile } from '../../shared/types'
import { deriveCorrectionSummary, deriveReviewEligibility } from '../../shared/review/diff'
import type { ExperimentalReviewRecord, ReviewRating, ReviewNeighborhoodSnapshot } from '../../shared/review/types'
import { captureFinalReviewNeighborhood, captureReviewNeighborhood, reviewProjectFingerprint, subtitleTargetIds, subtitleTrackIdForClip } from '../../shared/review/snapshot'

interface ReviewState {
  enabled: boolean
  sessionId: string | null
  startedAt: string | null
  targetIds: string[]
  targetIndex: number
  baselines: Record<string, ReviewNeighborhoodSnapshot>
  decisions: Record<string, ExperimentalReviewRecord>
  skippedIds: string[]
  completed: boolean
  logPath: string | null
  start(project: ProjectFile, selectedClipId?: string): boolean
  stop(): void
  hydrate(project: ProjectFile, records: ExperimentalReviewRecord[]): void
  selectTarget(project: ProjectFile, targetId: string): void
  decide(project: ProjectFile, rating: ReviewRating): ExperimentalReviewRecord | null
  next(project: ProjectFile): void
  previous(project: ProjectFile): void
}

const randomId = (prefix: string): string => {
  try {
    return `${prefix}-${crypto.randomUUID()}`
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

const indexOfTarget = (targetIds: string[], targetId: string): number => Math.max(0, targetIds.indexOf(targetId))

const ensureBaseline = (project: ProjectFile, targetId: string, baselines: Record<string, ReviewNeighborhoodSnapshot>): ReviewNeighborhoodSnapshot | null =>
  baselines[targetId] ?? captureReviewNeighborhood(project, targetId)

export const reviewProgress = (state: Pick<ReviewState, 'targetIds' | 'decisions'>): { total: number; reviewed: number; good: number; acceptable: number; corrected: number; skipped: number } => {
  const records = state.targetIds.map((id) => state.decisions[id]).filter((record): record is ExperimentalReviewRecord => Boolean(record))
  return {
    total: state.targetIds.length,
    reviewed: records.length,
    good: records.filter((record) => record.rating === 'good').length,
    acceptable: records.filter((record) => record.rating === 'acceptable').length,
    corrected: records.filter((record) => record.rating === 'corrected').length,
    skipped: records.filter((record) => record.rating === 'skip').length
  }
}

export const useReviewStore = create<ReviewState>((set, get) => ({
  enabled: false,
  sessionId: null,
  startedAt: null,
  targetIds: [],
  targetIndex: 0,
  baselines: {},
  decisions: {},
  skippedIds: [],
  completed: false,
  logPath: null,
  start: (project, selectedClipId) => {
    const trackId = selectedClipId ? subtitleTrackIdForClip(project, selectedClipId) : project.tracks.find((track) => track.kind === 'subtitle')?.id
    if (!trackId) return false
    const targetIds = subtitleTargetIds(project, trackId)
    if (!targetIds.length) return false
    const selected = selectedClipId && targetIds.includes(selectedClipId) ? selectedClipId : targetIds[0]
    if (!selected) return false
    const baseline = captureReviewNeighborhood(project, selected)
    if (!baseline) return false
    set((state) => ({
      enabled: true,
      sessionId: state.sessionId ?? randomId('review'),
      startedAt: state.startedAt ?? new Date().toISOString(),
      targetIds,
      targetIndex: indexOfTarget(targetIds, selected),
      baselines: state.baselines[selected] ? state.baselines : { ...state.baselines, [selected]: baseline },
      completed: false
    }))
    return true
  },
  stop: () => set({ enabled: false, sessionId: null, startedAt: null, targetIds: [], targetIndex: 0, baselines: {}, decisions: {}, skippedIds: [], completed: false, logPath: null }),
  hydrate: (project, records) => {
    const subtitleIds = new Set(project.tracks.filter((track) => track.kind === 'subtitle').flatMap((track) => track.clips.filter((clip) => clip.kind === 'subtitle').map((clip) => clip.id)))
    const decisions: Record<string, ExperimentalReviewRecord> = {}
    for (const record of records) {
      if (record.provenance.projectId === project.id && subtitleIds.has(record.target.captionId)) decisions[record.target.captionId] = record
    }
    set({ decisions })
  },
  selectTarget: (project, targetId) => {
    const state = get()
    if (!state.targetIds.includes(targetId)) return
    const baseline = ensureBaseline(project, targetId, state.baselines)
    set({ targetIndex: indexOfTarget(state.targetIds, targetId), ...(baseline ? { baselines: { ...state.baselines, [targetId]: baseline } } : {}) })
  },
  decide: (project, rating) => {
    const state = get()
    const targetId = state.targetIds[state.targetIndex]
    if (!state.enabled || !state.sessionId || !targetId) return null
    const baseline = ensureBaseline(project, targetId, state.baselines)
    if (!baseline) return null
    const final = captureFinalReviewNeighborhood(project, baseline)
    const correction = deriveCorrectionSummary(baseline, final)
    const eligibility = deriveReviewEligibility(baseline, final)
    const record: ExperimentalReviewRecord = {
      version: 'experimental.phase3.5b1',
      recordId: randomId('review-record'),
      sessionId: state.sessionId,
      decidedAt: new Date().toISOString(),
      rating,
      target: { captionId: targetId, trackId: baseline.trackId },
      baseline,
      final,
      correction,
      ...eligibility,
      provenance: {
        projectId: project.id,
        projectName: project.name,
        projectFingerprint: reviewProjectFingerprint(project),
        media: project.media.map((asset) => ({ id: asset.id, name: asset.name, fileSize: asset.fileSize, modifiedAt: asset.modifiedAt }))
      }
    }
    set((current) => ({ decisions: { ...current.decisions, [targetId]: record }, skippedIds: rating === 'skip' ? [...new Set([...current.skippedIds, targetId])] : current.skippedIds }))
    return record
  },
  next: (project) => {
    const state = get()
    if (!state.targetIds.length) return
    for (let index = state.targetIndex + 1; index < state.targetIds.length; index += 1) {
      const targetId = state.targetIds[index]
      if (targetId && !state.decisions[targetId] && !state.skippedIds.includes(targetId)) return state.selectTarget(project, targetId)
    }
    set({ completed: true })
  },
  previous: (project) => {
    const state = get()
    const targetId = state.targetIds[state.targetIndex - 1]
    if (targetId) state.selectTarget(project, targetId)
  }
}))
