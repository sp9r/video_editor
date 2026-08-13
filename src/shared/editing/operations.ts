import { assertSubtitleTrackHasNoOverlap, framesToUs, snapUsToFrame, splitClip, trimClip } from '../project'
import type { ProjectFile, TimelineClip, TimelineTrack, TimeUs } from '../types'
import { linkedClipIds, uniqueLinkedRoots } from './links'

export type EditingOperationCode = 'linked_track_locked' | 'track_incompatible' | 'clip_locked'

export class EditingOperationError extends Error {
  readonly code: EditingOperationCode
  readonly clipIds: string[]

  constructor(code: EditingOperationCode, message: string, clipIds: string[] = []) {
    super(message)
    this.name = 'EditingOperationError'
    this.code = code
    this.clipIds = clipIds
  }
}

interface ClipLocation {
  clip: TimelineClip
  track: TimelineTrack
}

const clone = <T>(value: T): T => structuredClone(value)

const locateClip = (project: ProjectFile, clipId: string): ClipLocation | null => {
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === clipId)
    if (clip) return { clip, track }
  }
  return null
}

const locations = (project: ProjectFile, clipIds: readonly string[]): ClipLocation[] =>
  clipIds.map((clipId) => locateClip(project, clipId)).filter((item): item is ClipLocation => Boolean(item))

const compatibleTrack = (clip: TimelineClip, track: TimelineTrack): boolean =>
  ((clip.kind === 'audio' || clip.kind === 'video' || clip.kind === 'image') && (track.kind === 'media' || track.kind === 'video' || track.kind === 'audio')) ||
  (clip.kind === 'subtitle' && track.kind === 'subtitle')

const assertEditable = (project: ProjectFile, clipIds: readonly string[], targetTrack?: TimelineTrack): void => {
  const found = locations(project, clipIds)
  if (found.length !== clipIds.length || found.some(({ track }) => track.locked) || targetTrack?.locked) {
    throw new EditingOperationError(
      clipIds.length > 1 ? 'linked_track_locked' : 'clip_locked',
      clipIds.length > 1 ? 'リンクされた映像・音声のいずれかのトラックがロックされています。操作を取り消しました。' : 'トラックがロックされています。操作を取り消しました。',
      [...clipIds]
    )
  }
}

const updateClipInProject = (project: ProjectFile, clipId: string, updater: (clip: TimelineClip) => TimelineClip): void => {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((clip) => clip.id === clipId)
    if (index >= 0) {
      const current = track.clips[index]
      if (current) track.clips[index] = updater(current)
      track.clips.sort((left, right) => left.startUs - right.startUs)
      return
    }
  }
}

const moveTrack = (project: ProjectFile, clipId: string, targetTrackId: string): void => {
  const source = locateClip(project, clipId)
  const target = project.tracks.find((track) => track.id === targetTrackId)
  if (!source || !target || source.track.id === target.id) return
  const index = source.track.clips.findIndex((clip) => clip.id === clipId)
  const [clip] = source.track.clips.splice(index, 1)
  if (clip) {
    target.clips.push(clip)
    target.clips.sort((left, right) => left.startUs - right.startUs)
  }
}

const updateTimestamp = (project: ProjectFile): void => { project.updatedAt = new Date().toISOString() }

const applyTimeDelta = (project: ProjectFile, clipIds: readonly string[], deltaUs: TimeUs): void => {
  for (const clipId of clipIds) {
    updateClipInProject(project, clipId, (clip) => ({ ...clip, startUs: Math.max(0, clip.startUs + deltaUs) }))
  }
}

export const moveLinkedClip = (project: ProjectFile, clipId: string, targetTrackId: string, atUs: TimeUs): ProjectFile => {
  const location = locateClip(project, clipId)
  const targetTrack = project.tracks.find((track) => track.id === targetTrackId)
  if (!location || !targetTrack) return project
  if (!compatibleTrack(location.clip, targetTrack)) throw new EditingOperationError('track_incompatible', 'クリップ種別と移動先トラックの種類が一致しません。', [clipId])
  const ids = linkedClipIds(project, clipId)
  assertEditable(project, ids, targetTrack)
  const next = clone(project)
  const selected = locateClip(next, clipId)
  if (!selected) return project
  const nextStart = Math.max(0, snapUsToFrame(atUs, project))
  applyTimeDelta(next, ids, nextStart - selected.clip.startUs)
  moveTrack(next, clipId, targetTrackId)
  for (const track of next.tracks) assertSubtitleTrackHasNoOverlap(track)
  updateTimestamp(next)
  return next
}

export const trimLinkedClip = (project: ProjectFile, clipId: string, edge: 'start' | 'end', atUs: TimeUs): ProjectFile => {
  const location = locateClip(project, clipId)
  if (!location) return project
  const ids = linkedClipIds(project, clipId)
  assertEditable(project, ids)
  if (ids.length === 1) return trimClip(project, clipId, edge, atUs)
  const selectedAfter = trimClip(project, clipId, edge, atUs)
  const selectedBefore = location.clip
  const selectedLocationAfter = locateClip(selectedAfter, clipId)
  if (!selectedLocationAfter) return project
  const next = clone(project)
  const deltaStart = selectedLocationAfter.clip.startUs - selectedBefore.startUs
  const nextDuration = selectedLocationAfter.clip.durationUs
  for (const id of ids) {
    updateClipInProject(next, id, (clip) => edge === 'start'
      ? { ...clip, startUs: clip.startUs + deltaStart, sourceInUs: clip.sourceInUs + deltaStart, durationUs: nextDuration }
      : { ...clip, durationUs: nextDuration })
  }
  for (const track of next.tracks) assertSubtitleTrackHasNoOverlap(track)
  updateTimestamp(next)
  return next
}

const deterministicSplitId = (clipId: string, splitAt: TimeUs, usedIds: Set<string>): string => {
  const base = `${clipId}:right:${splitAt}`
  let result = base
  let suffix = 2
  while (usedIds.has(result)) result = `${base}:${suffix++}`
  usedIds.add(result)
  return result
}

export const splitLinkedClip = (project: ProjectFile, clipId: string, atUs: TimeUs): ProjectFile => {
  const location = locateClip(project, clipId)
  if (!location) return project
  const ids = linkedClipIds(project, clipId)
  assertEditable(project, ids)
  if (ids.length === 1) return splitClip(project, clipId, atUs)
  const splitAt = snapUsToFrame(atUs, project)
  const frameUs = framesToUs(1, project.sequence.frameRate.numerator, project.sequence.frameRate.denominator)
  const sourceClips = locations(project, ids)
  if (sourceClips.some(({ clip }) => splitAt - clip.startUs < frameUs || clip.startUs + clip.durationUs - splitAt < frameUs)) return project
  const next = clone(project)
  const usedIds = new Set(next.tracks.flatMap((track) => track.clips).map((clip) => clip.id))
  const originalGroup = location.clip.linkGroupId
  const rightGroup = originalGroup ? `${originalGroup}:right:${splitAt}` : undefined
  for (const id of ids) {
    const nextLocation = locateClip(next, id)
    if (!nextLocation) continue
    const index = nextLocation.track.clips.findIndex((clip) => clip.id === id)
    const clip = nextLocation.track.clips[index]
    if (!clip) continue
    const leftDuration = splitAt - clip.startUs
    const left = { ...clip, durationUs: leftDuration }
    const right = {
      ...clone(clip),
      id: deterministicSplitId(clip.id, splitAt, usedIds),
      name: `${clip.name} (後半)`,
      startUs: splitAt,
      durationUs: clip.durationUs - leftDuration,
      sourceInUs: clip.sourceInUs + leftDuration,
      ...(rightGroup ? { linkGroupId: rightGroup } : {})
    }
    nextLocation.track.clips.splice(index, 1, left, right)
  }
  updateTimestamp(next)
  return next
}

export const deleteLinkedClips = (project: ProjectFile, clipIds: readonly string[], ripple = false): ProjectFile => {
  const expanded = new Set<string>()
  for (const clipId of clipIds) for (const linkedId of linkedClipIds(project, clipId)) expanded.add(linkedId)
  const ids = [...expanded]
  if (!ids.length) return project
  assertEditable(project, ids)
  return deleteExpandedClips(project, ids, ripple)
}

const deleteExpandedClips = (project: ProjectFile, ids: string[], ripple: boolean): ProjectFile => {
  const next = clone(project)
  const selected = new Set(ids)
  const removed = next.tracks.flatMap((track) => track.clips.filter((clip) => selected.has(clip.id)))
  if (!removed.length) return project
  const intervals = removed
    .map((clip) => [clip.startUs, clip.startUs + clip.durationUs] as const)
    .sort(([left], [right]) => left - right)
    .reduce<Array<readonly [number, number]>>((merged, interval) => {
      const previous = merged.at(-1)
      if (!previous || interval[0] > previous[1]) merged.push(interval)
      else merged[merged.length - 1] = [previous[0], Math.max(previous[1], interval[1])]
      return merged
    }, [])
  for (const track of next.tracks) {
    track.clips = track.clips.filter((clip) => !selected.has(clip.id))
    if (ripple) {
      for (const clip of track.clips) {
        const shift = intervals.reduce((total, [start, end]) => total + (clip.startUs >= end ? end - start : 0), 0)
        if (shift > 0) clip.startUs -= shift
      }
    }
  }
  updateTimestamp(next)
  return next
}

export const splitSelectedRoots = (project: ProjectFile, clipIds: readonly string[]): string[] => uniqueLinkedRoots(project, clipIds)
