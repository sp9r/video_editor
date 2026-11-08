import type { ProjectFile, TimeUs } from '../types'
import { linkedClipIds } from './links'
import { moveLinkedClip, trimLinkedClip } from './operations'

export interface ClipDragPreviewInput {
  clipId: string
  mode: 'move' | 'trim-start' | 'trim-end'
  targetTrackId: string
  initialStartUs: TimeUs
  initialDurationUs: TimeUs
  /** Pointer delta in time after snapping (the same value the commit uses). */
  deltaUs: number
  /** True when the delta came from a snap target, i.e. the commit is exact (not frame-rounded). */
  exact: boolean
}

export interface ClipDragPreviewRect {
  startUs: TimeUs
  durationUs: TimeUs
}

/**
 * Live positions of every clip that the drag will change on release. It runs the
 * real commit operation on the current project, so the preview cannot disagree
 * with the result (linked partners, clamping, frame rounding). If the operation
 * would be rejected, only the grabbed clip is previewed with the raw delta.
 */
export const computeClipDragPreview = (project: ProjectFile, input: ClipDragPreviewInput): Map<string, ClipDragPreviewRect> => {
  const result = new Map<string, ClipDragPreviewRect>()
  try {
    const next = input.mode === 'move'
      ? moveLinkedClip(project, input.clipId, input.targetTrackId, input.initialStartUs + input.deltaUs, input.exact)
      : input.mode === 'trim-start'
        ? trimLinkedClip(project, input.clipId, 'start', input.initialStartUs + input.deltaUs, input.exact)
        : trimLinkedClip(project, input.clipId, 'end', input.initialStartUs + input.initialDurationUs + input.deltaUs, input.exact)
    const byId = new Map(next.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]))
    for (const id of linkedClipIds(project, input.clipId)) {
      const clip = byId.get(id)
      if (clip) result.set(id, { startUs: clip.startUs, durationUs: clip.durationUs })
    }
    if (result.has(input.clipId)) return result
  } catch {
    // Rejected edits fall through to the raw single-clip preview below.
  }
  result.clear()
  result.set(input.clipId, input.mode === 'move'
    ? { startUs: input.initialStartUs + input.deltaUs, durationUs: input.initialDurationUs }
    : input.mode === 'trim-start'
      ? { startUs: input.initialStartUs + input.deltaUs, durationUs: input.initialDurationUs - input.deltaUs }
      : { startUs: input.initialStartUs, durationUs: input.initialDurationUs + input.deltaUs })
  return result
}
