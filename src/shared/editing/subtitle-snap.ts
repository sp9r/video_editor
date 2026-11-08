import { subtitleEditUnits } from './edit-units'
import type { ProjectFile, SubtitleClip, TimeUs } from '../types'

export interface SubtitleSnapTarget {
  timeUs: TimeUs
  kind: 'caption-edge' | 'edit-unit-boundary'
  clipId: string
}
const subtitleClips = (project: ProjectFile): SubtitleClip[] => project.tracks
  .filter((track) => track.kind === 'subtitle')
  .flatMap((track) => track.clips.filter((clip): clip is SubtitleClip => clip.kind === 'subtitle'))

const addTarget = (targets: SubtitleSnapTarget[], target: SubtitleSnapTarget): void => {
  if (!Number.isFinite(target.timeUs)) return
  if (!targets.some((item) => item.timeUs === target.timeUs && item.clipId === target.clipId)) targets.push(target)
}

/** Shared target collection for ruler/playhead/lane/Razor subtitle editing. */
export const subtitleSnapTargets = (
  project: ProjectFile,
  selectedClipIds: readonly string[] = [],
  reviewTargetId?: string
): SubtitleSnapTarget[] => {
  const selected = new Set([...selectedClipIds, ...(reviewTargetId ? [reviewTargetId] : [])])
  const clips = subtitleClips(project)
  const selectedClips = clips.filter((clip) => selected.has(clip.id))
  const relevant = new Set<SubtitleClip>(selectedClips)
  for (const track of project.tracks.filter((item) => item.kind === 'subtitle')) {
    const trackClips = track.clips.filter((clip): clip is SubtitleClip => clip.kind === 'subtitle')
    for (const clip of selectedClips.filter((item) => trackClips.includes(item))) {
      const index = trackClips.indexOf(clip)
      if (index > 0 && trackClips[index - 1]) relevant.add(trackClips[index - 1]!)
      if (index + 1 < trackClips.length && trackClips[index + 1]) relevant.add(trackClips[index + 1]!)
    }
  }
  const targets: SubtitleSnapTarget[] = []
  for (const clip of relevant) {
    addTarget(targets, { timeUs: clip.startUs, kind: 'caption-edge', clipId: clip.id })
    addTarget(targets, { timeUs: clip.startUs + clip.durationUs, kind: 'caption-edge', clipId: clip.id })
    const units = subtitleEditUnits(clip)
    if (!units) continue
    for (const unit of units.slice(0, -1)) addTarget(targets, { timeUs: unit.endUs, kind: 'edit-unit-boundary', clipId: clip.id })
  }
  return targets.sort((left, right) => left.timeUs - right.timeUs || left.clipId.localeCompare(right.clipId))
}

export const nearestSubtitleSnapTarget = (targets: readonly SubtitleSnapTarget[], atUs: TimeUs): SubtitleSnapTarget | null => {
  if (!Number.isFinite(atUs) || !targets.length) return null
  return targets.reduce<SubtitleSnapTarget | null>((nearest, target) => {
    if (!nearest) return target
    const distance = Math.abs(target.timeUs - atUs)
    const nearestDistance = Math.abs(nearest.timeUs - atUs)
    return distance < nearestDistance || (distance === nearestDistance && target.timeUs < nearest.timeUs) ? target : nearest
  }, null)
}

export const snapSubtitleTimelinePosition = ({
  project,
  atUs,
  selectedClipIds,
  reviewEnabled,
  reviewTargetId,
  snapping,
  bypass = false,
  thresholdUs = 150_000
}: {
  project: ProjectFile
  atUs: TimeUs
  selectedClipIds?: readonly string[]
  reviewEnabled?: boolean
  reviewTargetId?: string
  snapping: boolean
  bypass?: boolean
  thresholdUs?: TimeUs
}): TimeUs => {
  if (!snapping || bypass || (!selectedClipIds?.some((id) => subtitleClips(project).some((clip) => clip.id === id)) && !reviewEnabled)) return atUs
  const target = nearestSubtitleSnapTarget(subtitleSnapTargets(project, selectedClipIds, reviewEnabled ? reviewTargetId : undefined), atUs)
  return target && Math.abs(target.timeUs - atUs) <= thresholdUs ? target.timeUs : atUs
}
