import type { ProjectFile, SubtitleClip, SubtitleWord } from '../types'
import type { ReviewCaptionSnapshot, ReviewNeighborhoodSnapshot, ReviewWordSnapshot } from './types'

const clone = <T>(value: T): T => structuredClone(value)

const snapshotWord = (word: SubtitleWord): ReviewWordSnapshot => ({
  id: word.id,
  text: word.text,
  startUs: word.startUs,
  endUs: word.endUs
})

export const snapshotCaption = (trackId: string, clip: SubtitleClip): ReviewCaptionSnapshot => ({
  id: clip.id,
  trackId,
  name: clip.name,
  text: clip.text,
  startUs: clip.startUs,
  durationUs: clip.durationUs,
  sourceInUs: clip.sourceInUs,
  ...(clip.words ? { words: clip.words.map(snapshotWord) } : {}),
  style: clone(clip.style),
  wordsMatchText: Boolean(clip.words?.length) && clip.words!.map((word) => word.text).join('') === clip.text
})

const subtitleCaptions = (project: ProjectFile, trackId: string): SubtitleClip[] => {
  const track = project.tracks.find((item) => item.id === trackId && item.kind === 'subtitle')
  return (track?.clips.filter((clip): clip is SubtitleClip => clip.kind === 'subtitle') ?? [])
    .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
}

export const subtitleTrackIdForClip = (project: ProjectFile, clipId: string): string | null => {
  const track = project.tracks.find((item) => item.kind === 'subtitle' && item.clips.some((clip) => clip.id === clipId))
  return track?.id ?? null
}

export const subtitleTargetIds = (project: ProjectFile, trackId: string): string[] =>
  subtitleCaptions(project, trackId).map((clip) => clip.id)

export const captureReviewNeighborhood = (project: ProjectFile, targetId: string): ReviewNeighborhoodSnapshot | null => {
  const trackId = subtitleTrackIdForClip(project, targetId)
  if (!trackId) return null
  const captions = subtitleCaptions(project, trackId)
  const index = captions.findIndex((clip) => clip.id === targetId)
  if (index < 0) return null
  const window = captions.slice(Math.max(0, index - 1), index + 2)
  const target = captions[index]
  if (!target) return null
  return {
    targetId,
    trackId,
    captions: window.map((clip) => snapshotCaption(trackId, clip)),
    targetCaptionIds: [target.id],
    targetWordIds: target.words?.map((word) => word.id) ?? [],
    capturedAt: new Date().toISOString()
  }
}

const baselineTimeRange = (baseline: ReviewNeighborhoodSnapshot): { startUs: number; endUs: number } => {
  const targets = baseline.captions.filter((caption) => baseline.targetCaptionIds.includes(caption.id))
  const source = targets.length ? targets : baseline.captions
  const startUs = Math.min(...source.map((caption) => caption.startUs), 0)
  const endUs = Math.max(...source.map((caption) => caption.startUs + caption.durationUs), 0)
  return { startUs, endUs }
}

export const captureFinalReviewNeighborhood = (project: ProjectFile, baseline: ReviewNeighborhoodSnapshot): ReviewNeighborhoodSnapshot => {
  const captions = subtitleCaptions(project, baseline.trackId)
  const targetWordIds = new Set(baseline.targetWordIds)
  const targetCaptionIds = new Set(baseline.targetCaptionIds)
  const range = baselineTimeRange(baseline)
  const relevant = captions.filter((clip) => {
    if (targetCaptionIds.has(clip.id)) return true
    if (clip.words?.some((word) => targetWordIds.has(word.id))) return true
    const endUs = clip.startUs + clip.durationUs
    return clip.startUs < range.endUs && endUs > range.startUs
  })
  const relevantIndexes = relevant.map((clip) => captions.findIndex((item) => item.id === clip.id)).filter((index) => index >= 0)
  const first = relevantIndexes.length ? Math.min(...relevantIndexes) : Math.max(0, captions.findIndex((clip) => clip.startUs >= range.startUs))
  const last = relevantIndexes.length ? Math.max(...relevantIndexes) : first
  const window = captions.slice(Math.max(0, first - 1), Math.min(captions.length, last + 2))
  const targetCaptions = relevant.filter((clip) => targetCaptionIds.has(clip.id) || clip.words?.some((word) => targetWordIds.has(word.id)))
  return {
    targetId: baseline.targetId,
    trackId: baseline.trackId,
    captions: window.map((clip) => snapshotCaption(baseline.trackId, clip)),
    targetCaptionIds: targetCaptions.map((clip) => clip.id),
    targetWordIds: targetCaptions.flatMap((clip) => clip.words?.map((word) => word.id) ?? []),
    capturedAt: new Date().toISOString()
  }
}

const LOCAL_PATH_KEYS = new Set(['path', 'relativePath', 'projectPath'])

export const stripLocalPaths = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripLocalPaths)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !LOCAL_PATH_KEYS.has(key))
    .map(([key, item]) => [key, stripLocalPaths(item)]))
}

export const reviewProjectFingerprint = (project: ProjectFile): string => {
  const normalized = clone(project)
  normalized.updatedAt = ''
  normalized.projectPath = undefined
  return JSON.stringify(stripLocalPaths(normalized))
}
