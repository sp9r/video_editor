import type { AutoCaptionSilenceAnalysis } from './auto-caption-contract.js'
import { validateProject } from './project.js'
import type { ProjectFile, TimelineClip, TimeUs } from './types.js'

export type SilenceCutRange = Pick<AutoCaptionSilenceAnalysis['keepRanges'][number], 'startUs' | 'endUs'>

export interface SilenceCutSummary {
  selectedClipId: string
  affectedClipIds: string[]
  segmentCount: number
  removedDurationUs: TimeUs
  keepRanges: SilenceCutRange[]
}

export interface SilenceCutApplyResult {
  project: ProjectFile
  summary: SilenceCutSummary
  /** The compacted timeline interval used to map source-absolute captions. */
  sourceClip: { startUs: TimeUs; sourceInUs: TimeUs; durationUs: TimeUs }
}

export interface SourceTimeInterval {
  id?: string
  startUs: TimeUs
  endUs: TimeUs
}

export interface SourceTimeMapper {
  readonly sourceInUs: TimeUs
  readonly sourceEndUs: TimeUs
  readonly keepRanges: readonly SilenceCutRange[]
  readonly removedRanges: readonly SilenceCutRange[]
  mapPoint(sourceUs: TimeUs): TimeUs
  mapInterval(interval: SourceTimeInterval): SourceTimeInterval
  assertNoRemovedOverlap(intervals: readonly SourceTimeInterval[], label?: string): void
}

export class SilenceCutError extends Error {
  readonly code: 'invalid_selection' | 'invalid_ranges' | 'unsafe_ripple' | 'cut_plan_invalid'

  constructor(code: SilenceCutError['code'], message: string) {
    super(message)
    this.name = 'SilenceCutError'
    this.code = code
  }
}

const clone = <T>(value: T): T => structuredClone(value)

const clipEnd = (clip: Pick<TimelineClip, 'startUs' | 'durationUs'>): number => clip.startUs + clip.durationUs

const shiftClip = (clip: TimelineClip, deltaUs: number): TimelineClip => ({
  ...clip,
  startUs: clip.startUs + deltaUs,
  ...(clip.kind === 'subtitle' && clip.words
    ? { words: clip.words.map((word) => ({ ...word, startUs: word.startUs + deltaUs, endUs: word.endUs + deltaUs })) }
    : {}),
  ...(clip.kind === 'subtitle' && clip.editUnits
    ? { editUnits: clip.editUnits.map((unit) => ({ ...unit, startUs: unit.startUs + deltaUs, endUs: unit.endUs + deltaUs })) }
    : {})
}) as TimelineClip

const linkedMembers = (project: ProjectFile, selectedClipId: string): TimelineClip[] => {
  const selected = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId)
  if (!selected) return []
  if (!selected.linkGroupId) return [selected]
  return project.tracks.flatMap((track) => track.clips.filter((clip) => clip.linkGroupId === selected.linkGroupId))
}

const validateKeepRanges = (
  ranges: readonly SilenceCutRange[],
  sourceInUs: number,
  durationUs: number
): SilenceCutRange[] => {
  if (!ranges.length) throw new SilenceCutError('invalid_ranges', '無音カットのkeep rangeが空です。')
  const sourceEndUs = sourceInUs + durationUs
  const normalized = ranges.map((range, index) => {
    if (!Number.isSafeInteger(range.startUs) || !Number.isSafeInteger(range.endUs) || range.startUs < sourceInUs || range.endUs <= range.startUs || range.endUs > sourceEndUs) {
      throw new SilenceCutError('invalid_ranges', `無音カットのkeep range ${index + 1} が選択clipの範囲外です。`)
    }
    return { startUs: range.startUs, endUs: range.endUs }
  })
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1]
    const current = normalized[index]
    if (previous && current && current.startUs < previous.endUs) throw new SilenceCutError('invalid_ranges', '無音カットのkeep rangeが重複または未ソートです。')
  }
  return normalized
}

const isPositiveOverlap = (left: SourceTimeInterval, right: SilenceCutRange): boolean =>
  left.startUs < right.endUs && left.endUs > right.startUs

export const createSilenceCutTimeMapper = (
  originalClip: Pick<TimelineClip, 'startUs' | 'sourceInUs' | 'durationUs'>,
  ranges: readonly SilenceCutRange[]
): SourceTimeMapper => {
  const keepRanges = validateKeepRanges(ranges, originalClip.sourceInUs, originalClip.durationUs)
  const sourceEndUs = originalClip.sourceInUs + originalClip.durationUs
  const removedRanges: SilenceCutRange[] = []
  let cursor = originalClip.sourceInUs
  for (const range of keepRanges) {
    if (cursor < range.startUs) removedRanges.push({ startUs: cursor, endUs: range.startUs })
    cursor = range.endUs
  }
  if (cursor < sourceEndUs) removedRanges.push({ startUs: cursor, endUs: sourceEndUs })
  const mapPoint = (sourceUs: TimeUs): TimeUs => {
    if (!Number.isSafeInteger(sourceUs) || sourceUs < originalClip.sourceInUs || sourceUs > sourceEndUs) {
      throw new SilenceCutError('cut_plan_invalid', 'CUT PLAN INVALID: source timestamp is outside the selected clip.')
    }
    let compactedOffset = 0
    for (const range of keepRanges) {
      if (sourceUs <= range.startUs) return originalClip.startUs + compactedOffset
      if (sourceUs <= range.endUs) return originalClip.startUs + compactedOffset + (sourceUs - range.startUs)
      compactedOffset += range.endUs - range.startUs
    }
    return originalClip.startUs + compactedOffset
  }
  return {
    sourceInUs: originalClip.sourceInUs,
    sourceEndUs,
    keepRanges,
    removedRanges,
    mapPoint,
    mapInterval: (interval) => {
      if (!Number.isSafeInteger(interval.startUs) || !Number.isSafeInteger(interval.endUs) || interval.endUs < interval.startUs) {
        throw new SilenceCutError('cut_plan_invalid', 'CUT PLAN INVALID: source interval is invalid.')
      }
      return { id: interval.id, startUs: mapPoint(interval.startUs), endUs: mapPoint(interval.endUs) }
    },
    assertNoRemovedOverlap: (intervals, label = 'raw Whisper word') => {
      for (const interval of intervals) {
        if (!Number.isSafeInteger(interval.startUs) || !Number.isSafeInteger(interval.endUs) || interval.endUs < interval.startUs) {
          throw new SilenceCutError('cut_plan_invalid', `CUT PLAN INVALID: ${label} interval is invalid.`)
        }
        const pointInRemoved = interval.startUs === interval.endUs && removedRanges.some((range) => interval.startUs >= range.startUs && interval.startUs < range.endUs)
        if (pointInRemoved || removedRanges.some((range) => isPositiveOverlap(interval, range))) {
          const id = interval.id ? ` (${interval.id})` : ''
          throw new SilenceCutError('cut_plan_invalid', `CUT PLAN INVALID: ${label}${id} overlaps a removed source range.`)
        }
      }
    }
  }
}

const segmentId = (clipId: string, index: number, usedIds: Set<string>): string => {
  const base = `${clipId}:silence:${index + 1}`
  let id = base
  let suffix = 2
  while (usedIds.has(id)) id = `${base}:${suffix++}`
  usedIds.add(id)
  return id
}

const replaceTargetClips = (
  next: ProjectFile,
  targets: readonly TimelineClip[],
  keepRanges: readonly SilenceCutRange[],
  originalStartUs: number,
  originalEndUs: number
): void => {
  const usedIds = new Set(next.tracks.flatMap((track) => track.clips.map((clip) => clip.id)))
  const targetIds = new Set(targets.map((clip) => clip.id))
  const groupId = targets[0]?.linkGroupId
  const removedDurationUs = (originalEndUs - originalStartUs) - keepRanges.reduce((sum, range) => sum + (range.endUs - range.startUs), 0)
  for (const track of next.tracks) {
    const targetIndex = track.clips.findIndex((clip) => targetIds.has(clip.id))
    if (targetIndex < 0) continue
    const first = track.clips[targetIndex]
    if (!first) continue
    const target = targets.find((clip) => clip.id === first.id)
    if (!target || (target.kind !== 'video' && target.kind !== 'audio')) throw new SilenceCutError('invalid_selection', '無音カット対象は映像または音声clipである必要があります。')
    const segments = keepRanges.map((range, index) => ({
      ...clone(target),
      id: segmentId(target.id, index, usedIds),
      name: `${target.name} (無音カット ${index + 1})`,
      startUs: originalStartUs + keepRanges.slice(0, index).reduce((sum, item) => sum + item.endUs - item.startUs, 0),
      sourceInUs: range.startUs,
      durationUs: range.endUs - range.startUs,
      ...(groupId ? { linkGroupId: `${groupId}:silence:${index + 1}` } : {})
    }))
    track.clips.splice(targetIndex, 1, ...segments)
    track.clips.sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
  }
  if (removedDurationUs < 0) throw new SilenceCutError('invalid_ranges', '無音カットのkeep range合計がclip長を超えています。')
}

/**
 * Applies a signal-derived keep plan without touching media files. This is
 * intentionally conservative: any non-target clip intersecting the edited
 * interval causes a full reject instead of an unsafe partial ripple.
 */
export const applySilenceCutToProject = (
  project: ProjectFile,
  selectedClipId: string,
  analysis: Pick<AutoCaptionSilenceAnalysis, 'keepRanges'>,
  options: { protectedIntervals?: readonly SourceTimeInterval[]; timeMapper?: SourceTimeMapper } = {}
): SilenceCutApplyResult => {
  const selected = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId)
  const targets = linkedMembers(project, selectedClipId)
  if (!selected || !targets.length || targets.some((clip) => clip.kind !== 'video' && clip.kind !== 'audio')) {
    throw new SilenceCutError('invalid_selection', '無音カット対象の映像clipまたは音声clipが見つかりません。')
  }
  if (targets.length > 2 || new Set(targets.map((clip) => clip.kind)).size !== targets.length) {
    throw new SilenceCutError('invalid_selection', 'linked A/Vが1組として解釈できないため、無音カットを中止しました。')
  }
  const targetTracks = project.tracks.filter((track) => track.clips.some((clip) => targets.some((target) => target.id === clip.id)))
  if (targetTracks.length !== targets.length) throw new SilenceCutError('unsafe_ripple', 'linked A/Vが同一trackに存在するため、安全に分割できません。')
  if (project.tracks.some((track) => track.locked && track.clips.some((clip) => targets.some((target) => target.id === clip.id)))) {
    throw new SilenceCutError('unsafe_ripple', '無音カット対象のtrackがロックされています。')
  }
  const originalStartUs = selected.startUs
  const originalEndUs = clipEnd(selected)
  if (targets.some((clip) => clip.startUs !== originalStartUs || clip.durationUs !== selected.durationUs || clip.sourceInUs !== selected.sourceInUs)) {
    throw new SilenceCutError('unsafe_ripple', 'linked A/Vのtimeline/source範囲が一致しないため、同一cut planを適用できません。')
  }
  const keepRanges = validateKeepRanges(analysis.keepRanges, selected.sourceInUs, selected.durationUs)
  const timeMapper = options.timeMapper ?? createSilenceCutTimeMapper(selected, keepRanges)
  if (timeMapper.sourceInUs !== selected.sourceInUs || timeMapper.sourceEndUs !== selected.sourceInUs + selected.durationUs || timeMapper.keepRanges.length !== keepRanges.length || timeMapper.keepRanges.some((range, index) => range.startUs !== keepRanges[index]?.startUs || range.endUs !== keepRanges[index]?.endUs)) {
    throw new SilenceCutError('cut_plan_invalid', 'CUT PLAN INVALID: source mapper does not match the selected clip.')
  }
  timeMapper.assertNoRemovedOverlap(options.protectedIntervals ?? [], 'raw Whisper word')
  const keptDurationUs = keepRanges.reduce((sum, range) => sum + range.endUs - range.startUs, 0)
  const removedDurationUs = selected.durationUs - keptDurationUs
  // A signal analysis may legitimately produce the full source interval
  // (for example when no removable silence is found).  This is a true
  // no-op: do not treat existing subtitle/overlay clips as unsafe ripple
  // conflicts and do not manufacture a replacement media clip.
  if (removedDurationUs === 0) {
    return {
      project,
      summary: { selectedClipId, affectedClipIds: targets.map((clip) => clip.id), segmentCount: keepRanges.length, removedDurationUs: 0, keepRanges },
      sourceClip: { startUs: selected.startUs, sourceInUs: selected.sourceInUs, durationUs: selected.durationUs }
    }
  }
  const targetIds = new Set(targets.map((clip) => clip.id))
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (targetIds.has(clip.id)) continue
      const intersects = clip.startUs < originalEndUs && clipEnd(clip) > originalStartUs
      if (intersects) throw new SilenceCutError('unsafe_ripple', `既存clip「${clip.name}」が無音カット範囲と重なるため、安全にrippleできません。`)
    }
  }
  const next = clone(project)
  replaceTargetClips(next, targets, keepRanges, originalStartUs, originalEndUs)
  for (const track of next.tracks) {
    const targetIdsInNext = new Set(targets.flatMap((target) => [target.id, ...keepRanges.map((_range, index) => `${target.id}:silence:${index + 1}`)]))
    for (let index = 0; index < track.clips.length; index += 1) {
      const clip = track.clips[index]
      if (!clip || targetIdsInNext.has(clip.id)) continue
      if (clip.startUs >= originalEndUs) track.clips[index] = shiftClip(clip, -removedDurationUs)
    }
    track.clips.sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
  }
  next.updatedAt = new Date().toISOString()
  const validated = validateProject(next)
  const firstTarget = validated.tracks.flatMap((track) => track.clips).find((clip) => clip.id === `${selected.id}:silence:1`)
  if (!firstTarget) throw new SilenceCutError('unsafe_ripple', '無音カット後のclipを特定できません。')
  return {
    project: validated,
    summary: { selectedClipId, affectedClipIds: targets.map((clip) => clip.id), segmentCount: keepRanges.length, removedDurationUs, keepRanges },
    sourceClip: { startUs: firstTarget.startUs, sourceInUs: selected.sourceInUs, durationUs: selected.durationUs }
  }
}

export const mapSourceTimeThroughSilenceCut = (
  originalClip: Pick<TimelineClip, 'startUs' | 'sourceInUs' | 'durationUs'>,
  keepRanges: readonly SilenceCutRange[],
  sourceUs: TimeUs
): TimeUs => {
  return createSilenceCutTimeMapper(originalClip, keepRanges).mapPoint(sourceUs)
}
