import { linkedClipIds } from './links'
import type { ProjectFile, TimeUs } from '../types'

/** Screen distance within which a dragged clip edge is pulled onto a target. */
export const CLIP_SNAP_THRESHOLD_PX = 8

export interface ClipSnapTarget {
  timeUs: TimeUs
  kind: 'clip-start' | 'clip-end' | 'playhead' | 'timeline-start'
  clipId?: string
}

export interface ClipSnapResult {
  /** Edge time after snapping (clip start for moves, the trimmed edge for trims). */
  timeUs: TimeUs
  target: ClipSnapTarget
  /** Which edge of the moving clip met the target. */
  edge: 'start' | 'end'
}

export const clipSnapThresholdUs = (zoomPxPerSecond: number, thresholdPx = CLIP_SNAP_THRESHOLD_PX): TimeUs =>
  zoomPxPerSecond > 0 ? (thresholdPx / zoomPxPerSecond) * 1_000_000 : 0

/** Edges of every enabled clip (all tracks) except the dragged clip and its linked partners, plus playhead and 0. */
export const clipSnapTargets = (
  project: ProjectFile,
  { excludeClipIds, playheadUs }: { excludeClipIds: readonly string[]; playheadUs?: TimeUs }
): ClipSnapTarget[] => {
  const excluded = new Set(excludeClipIds.flatMap((id) => linkedClipIds(project, id)))
  for (const id of excludeClipIds) excluded.add(id)
  const targets: ClipSnapTarget[] = [{ timeUs: 0, kind: 'timeline-start' }]
  const seen = new Set<string>(['0:timeline-start'])
  const add = (target: ClipSnapTarget): void => {
    if (!Number.isFinite(target.timeUs)) return
    const key = `${target.timeUs}:${target.kind}:${target.clipId ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    targets.push(target)
  }
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (excluded.has(clip.id) || !clip.enabled) continue
      add({ timeUs: clip.startUs, kind: 'clip-start', clipId: clip.id })
      add({ timeUs: clip.startUs + clip.durationUs, kind: 'clip-end', clipId: clip.id })
    }
  }
  if (playheadUs !== undefined) add({ timeUs: playheadUs, kind: 'playhead' })
  return targets.sort((left, right) => left.timeUs - right.timeUs)
}

/** Snaps a moving clip by whichever of its start/end edges is closest to a target (ties: start edge, then earlier target). */
export const snapClipMove = ({ startUs, durationUs, targets, thresholdUs }: {
  startUs: TimeUs
  durationUs: TimeUs
  targets: readonly ClipSnapTarget[]
  thresholdUs: TimeUs
}): ClipSnapResult | null => {
  let best: { distance: number; result: ClipSnapResult } | null = null
  const consider = (edge: 'start' | 'end', target: ClipSnapTarget): void => {
    const nextStartUs = edge === 'start' ? target.timeUs : target.timeUs - durationUs
    if (nextStartUs < 0) return
    const distance = Math.abs(target.timeUs - (edge === 'start' ? startUs : startUs + durationUs))
    if (distance > thresholdUs) return
    if (best && (distance > best.distance || (distance === best.distance && (edge === 'end' || target.timeUs >= best.result.target.timeUs)))) return
    best = { distance, result: { timeUs: nextStartUs, target, edge } }
  }
  // Start edge first so that on equal distance the earlier-considered start wins.
  for (const target of targets) consider('start', target)
  for (const target of targets) consider('end', target)
  return best ? (best as { result: ClipSnapResult }).result : null
}

/** Snaps a single trimmed edge to the nearest target within the threshold (ties: earlier target). */
export const snapClipEdge = ({ timeUs, targets, thresholdUs }: {
  timeUs: TimeUs
  targets: readonly ClipSnapTarget[]
  thresholdUs: TimeUs
}): { timeUs: TimeUs; target: ClipSnapTarget } | null => {
  let best: { distance: number; target: ClipSnapTarget } | null = null
  for (const target of targets) {
    const distance = Math.abs(target.timeUs - timeUs)
    if (distance > thresholdUs) continue
    if (!best || distance < best.distance || (distance === best.distance && target.timeUs < best.target.timeUs)) best = { distance, target }
  }
  return best ? { timeUs: best.target.timeUs, target: best.target } : null
}
