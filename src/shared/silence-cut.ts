import type { AutoCaptionSilenceAnalysis, SilenceCutMode } from './auto-caption-contract.js'
import { validateProject } from './project.js'
import type { ProjectFile, SilenceCutOperationMetadata, TimelineClip, TimeUs } from './types.js'

export type SilenceCutRange = Pick<AutoCaptionSilenceAnalysis['keepRanges'][number], 'startUs' | 'endUs'>
export type SilenceReapplyProfile = Exclude<SilenceCutMode, 'off'>

export const SILENCE_REAPPLY_PROFILES: readonly SilenceReapplyProfile[] = ['natural', 'strong', 'youtube']
export const DEFAULT_SILENCE_REAPPLY_PROFILE: SilenceReapplyProfile = 'youtube'

export interface SilenceCutProfileSettings {
  profile: SilenceReapplyProfile
  minSilenceUs: TimeUs
  retainPauseUs: TimeUs
  noiseDb: number
  speechProtectionUs: TimeUs
  fillerRemoval: false
}

export const isSilenceReapplyProfile = (value: unknown): value is SilenceReapplyProfile =>
  typeof value === 'string' && SILENCE_REAPPLY_PROFILES.includes(value as SilenceReapplyProfile)

export const silenceCutProfileSettings = (profile: SilenceReapplyProfile = DEFAULT_SILENCE_REAPPLY_PROFILE): SilenceCutProfileSettings => {
  switch (profile) {
    case 'natural': return { profile, minSilenceUs: 600_000, retainPauseUs: 180_000, noiseDb: -35, speechProtectionUs: 80_000, fillerRemoval: false }
    case 'strong': return { profile, minSilenceUs: 400_000, retainPauseUs: 100_000, noiseDb: -35, speechProtectionUs: 80_000, fillerRemoval: false }
    case 'youtube': return { profile, minSilenceUs: 150_000, retainPauseUs: 0, noiseDb: -35, speechProtectionUs: 80_000, fillerRemoval: false }
  }
}

export const clampSilenceMinUs = (value: number | undefined, fallback: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.round(Math.max(0, Math.min(2_000_000, value)))
}

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

export interface SilenceCutRestoreResult {
  project: ProjectFile
  operationId: string
  restoredDurationUs: TimeUs
  restoredClipId: string
}

export interface SourceTimeInterval {
  id?: string
  startUs: TimeUs
  endUs: TimeUs
}

export interface SilenceReapplyTarget {
  selectedClipId: string
  assetId: string
  sourceInUs: TimeUs
  durationUs: TimeUs
  protectedIntervals: SourceTimeInterval[]
  alreadyRemovedSourceRanges: SilenceCutRange[]
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

const isMediaClip = (clip: TimelineClip): clip is Extract<TimelineClip, { kind: 'video' | 'audio' }> =>
  clip.kind === 'video' || clip.kind === 'audio'

/**
 * Builds the current-timeline input for an explicit reapply.  Raw Whisper
 * words are the only speech guard; SubtitleEditUnit is intentionally ignored.
 */
export const buildSilenceReapplyTarget = (project: ProjectFile, selectedClipId: string): SilenceReapplyTarget => {
  const selected = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId)
  const targets = linkedMembers(project, selectedClipId)
  if (!selected || !isMediaClip(selected) || !targets.length || targets.some((clip) => !isMediaClip(clip))) {
    throw new SilenceCutError('invalid_selection', '無音カット対象の映像clipまたは音声clipが見つかりません。')
  }
  if (targets.length > 2 || new Set(targets.map((clip) => clip.kind)).size !== targets.length) {
    throw new SilenceCutError('invalid_selection', 'linked A/Vが1組として解釈できないため、無音カットを中止しました。')
  }
  const selectedMedia = selected as Extract<TimelineClip, { kind: 'video' | 'audio' }>
  if (targets.some((clip) => !isMediaClip(clip) || clip.startUs !== selectedMedia.startUs || clip.durationUs !== selectedMedia.durationUs || clip.sourceInUs !== selectedMedia.sourceInUs || clip.assetId !== selectedMedia.assetId)) {
    throw new SilenceCutError('unsafe_ripple', 'linked A/Vの現在のtimeline/source範囲が一致しません。')
  }
  const timelineEndUs = selected.startUs + selected.durationUs
  const protectedIntervals: SourceTimeInterval[] = []
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.kind !== 'subtitle' || !clip.sourceJobId || !clip.words?.length) continue
      for (const word of clip.words) {
        const overlapStartUs = Math.max(selected.startUs, word.startUs)
        const overlapEndUs = Math.min(timelineEndUs, word.endUs)
        if (word.endUs === word.startUs) {
          if (word.startUs < selected.startUs || word.startUs >= timelineEndUs) continue
          const sourceUs = selectedMedia.sourceInUs + (word.startUs - selectedMedia.startUs)
          protectedIntervals.push({ id: word.id, startUs: sourceUs, endUs: sourceUs })
        } else if (overlapEndUs > overlapStartUs) {
          protectedIntervals.push({
            id: word.id,
            startUs: selectedMedia.sourceInUs + (overlapStartUs - selectedMedia.startUs),
            endUs: selectedMedia.sourceInUs + (overlapEndUs - selectedMedia.startUs)
          })
        }
      }
    }
  }

  // A previous silence apply gives each segment a deterministic `:silence:`
  // family.  Gaps between surviving family members are already removed source
  // ranges.  The fresh analysis is still bounded to the selected current clip.
  const silenceMarker = selected.id.indexOf(':silence:')
  const familyPrefix = silenceMarker >= 0 ? selected.id.slice(0, silenceMarker + ':silence:'.length) : null
  const family = familyPrefix
    ? project.tracks.flatMap((track) => track.clips).filter((clip): clip is Extract<TimelineClip, { kind: 'video' | 'audio' }> => isMediaClip(clip) && clip.assetId === selectedMedia.assetId && clip.id.startsWith(familyPrefix))
    : []
  const alreadyRemovedSourceRanges: SilenceCutRange[] = []
  const sourceIntervals = family.map((clip) => ({ startUs: clip.sourceInUs, endUs: clip.sourceInUs + clip.durationUs })).sort((left, right) => left.startUs - right.startUs)
  for (let index = 1; index < sourceIntervals.length; index += 1) {
    const previous = sourceIntervals[index - 1]
    const current = sourceIntervals[index]
    if (previous && current && previous.endUs < current.startUs) alreadyRemovedSourceRanges.push({ startUs: previous.endUs, endUs: current.startUs })
  }
  return {
    selectedClipId,
    assetId: selectedMedia.assetId,
    sourceInUs: selectedMedia.sourceInUs,
    durationUs: selectedMedia.durationUs,
    protectedIntervals,
    alreadyRemovedSourceRanges
  }
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
): Map<string, string[]> => {
  const usedIds = new Set(next.tracks.flatMap((track) => track.clips.map((clip) => clip.id)))
  const targetIds = new Set(targets.map((clip) => clip.id))
  const groupId = targets[0]?.linkGroupId
  const generatedIdsByTarget = new Map<string, string[]>()
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
    generatedIdsByTarget.set(target.id, segments.map((segment) => segment.id))
    track.clips.splice(targetIndex, 1, ...segments)
    track.clips.sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
  }
  if (removedDurationUs < 0) throw new SilenceCutError('invalid_ranges', '無音カットのkeep range合計がclip長を超えています。')
  return generatedIdsByTarget
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
  options: { protectedIntervals?: readonly SourceTimeInterval[]; timeMapper?: SourceTimeMapper; profile?: SilenceReapplyProfile; minSilenceUs?: TimeUs } = {}
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
  const generatedIdsByTarget = replaceTargetClips(next, targets, keepRanges, originalStartUs, originalEndUs)
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
  const existingMetadata = validated.editorMetadata
  if (existingMetadata && (existingMetadata.schemaVersion !== 1 || !Array.isArray(existingMetadata.silenceCutOperations))) {
    throw new SilenceCutError('cut_plan_invalid', '無音カットの内部metadataが不正なため、処理を中止しました。')
  }
  const usedOperationIds = new Set(existingMetadata?.silenceCutOperations.map((operation) => operation.operationId) ?? [])
  let operationIndex = (existingMetadata?.silenceCutOperations.length ?? 0) + 1
  let operationId = `silence-cut:${selected.id}:${operationIndex}`
  while (usedOperationIds.has(operationId)) operationId = `silence-cut:${selected.id}:${++operationIndex}`
  const generatedClipSignatures: Record<string, string> = {}
  for (const clipId of [...generatedIdsByTarget.values()].flat()) {
    const generated = validated.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId)
    if (!generated) throw new SilenceCutError('unsafe_ripple', '無音カット後の生成clipを記録できません。')
    generatedClipSignatures[clipId] = JSON.stringify(generated)
  }
  const operation: SilenceCutOperationMetadata = {
    schemaVersion: 1,
    operationId,
    originalStartUs,
    originalDurationUs: selected.durationUs,
    keepRanges: keepRanges.map(({ startUs, endUs }) => ({ startUs, endUs })),
    removedRanges: timeMapper.removedRanges.map(({ startUs, endUs }) => ({ startUs, endUs })),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.minSilenceUs === undefined ? {} : { minSilenceUs: clampSilenceMinUs(options.minSilenceUs, options.minSilenceUs) }),
    targets: targets.map((target) => {
      const mediaTarget = target as Extract<TimelineClip, { kind: 'video' | 'audio' }>
      const track = project.tracks.find((candidate) => candidate.clips.some((clip) => clip.id === target.id))
      const generatedClipIds = generatedIdsByTarget.get(target.id)
      if (!track || !generatedClipIds) throw new SilenceCutError('unsafe_ripple', '無音カット対象のtrackを記録できません。')
      return {
        clipId: target.id,
        trackId: track.id,
        kind: mediaTarget.kind,
        assetId: mediaTarget.assetId,
        name: mediaTarget.name,
        sourceInUs: mediaTarget.sourceInUs,
        durationUs: mediaTarget.durationUs,
        ...(mediaTarget.linkGroupId ? { linkGroupId: mediaTarget.linkGroupId } : {}),
        generatedClipIds
      }
    }),
    generatedClipSignatures
  }
  validated.editorMetadata = {
    schemaVersion: 1,
    silenceCutOperations: [...(existingMetadata?.silenceCutOperations ?? []), operation]
  }
  const validatedWithMetadata = validateProject(validated)
  return {
    project: validatedWithMetadata,
    summary: { selectedClipId, affectedClipIds: targets.map((clip) => clip.id), segmentCount: keepRanges.length, removedDurationUs, keepRanges },
    sourceClip: { startUs: firstTarget.startUs, sourceInUs: selected.sourceInUs, durationUs: selected.durationUs }
  }
}

const metadataOperations = (project: ProjectFile): SilenceCutOperationMetadata[] => {
  const metadata = project.editorMetadata
  if (!metadata) return []
  if (metadata.schemaVersion !== 1 || !Array.isArray(metadata.silenceCutOperations)) {
    throw new SilenceCutError('cut_plan_invalid', '無音カットの内部metadataが不正です。')
  }
  return metadata.silenceCutOperations
}

const operationForClip = (project: ProjectFile, clipId: string): SilenceCutOperationMetadata => {
  const matches = metadataOperations(project).filter((operation) => operation.targets.some((target) => target.generatedClipIds.includes(clipId)))
  if (matches.length !== 1) throw new SilenceCutError('unsafe_ripple', '無音カットの復元対象を一意に特定できません。')
  return matches[0]!
}

/** Returns the owning internal operation without exposing metadata to edit_project.v1. */
export const silenceCutOperationForClip = (project: ProjectFile, clipId: string): SilenceCutOperationMetadata | null => {
  try { return operationForClip(project, clipId) } catch { return null }
}

const findClipWithTrack = (project: ProjectFile, clipId: string): { clip: TimelineClip; trackId: string } | undefined => {
  for (const track of project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId)
    if (clip) return { clip, trackId: track.id }
  }
  return undefined
}

/** Returns true only while a generated silence-cut family is still untouched. */
export const canRestoreSilenceCut = (project: ProjectFile, clipId: string): boolean => {
  try {
    const operation = operationForClip(project, clipId)
    return operation.targets.every((target) => target.generatedClipIds.every((generatedId) => {
      const current = findClipWithTrack(project, generatedId)?.clip
      return Boolean(current && operation.generatedClipSignatures[generatedId] === JSON.stringify(current))
    }))
  } catch {
    return false
  }
}

/**
 * Restores one source-range silence operation.  It is deliberately strict:
 * any missing, edited, split, trimmed, deleted, or ambiguous generated clip
 * rejects the whole operation before the input project is mutated.
 */
export const restoreSilenceCutToProject = (project: ProjectFile, clipId: string): SilenceCutRestoreResult => {
  const operation = operationForClip(project, clipId)
  const generatedIds = new Set(operation.targets.flatMap((target) => target.generatedClipIds))
  const currentById = new Map<string, { clip: TimelineClip; trackId: string }>()
  for (const target of operation.targets) {
    for (const generatedId of target.generatedClipIds) {
      const found = findClipWithTrack(project, generatedId)
      if (!found || found.clip.kind !== target.kind || found.trackId !== target.trackId || found.clip.assetId !== target.assetId || operation.generatedClipSignatures[generatedId] !== JSON.stringify(found.clip)) {
        throw new SilenceCutError('unsafe_ripple', '無音カット後のclipが変更されているため、安全に解除できません。')
      }
      currentById.set(generatedId, found)
    }
  }
  const keptDurationUs = operation.keepRanges.reduce((sum, range) => sum + range.endUs - range.startUs, 0)
  const compactedEndUs = operation.originalStartUs + keptDurationUs
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (generatedIds.has(clip.id)) continue
      if (clip.startUs < compactedEndUs && clipEnd(clip) > operation.originalStartUs) {
        throw new SilenceCutError('unsafe_ripple', '復元範囲に別clipが重なるため、安全に解除できません。')
      }
    }
  }
  const next = clone(project)
  for (const track of next.tracks) {
    const target = operation.targets.find((candidate) => candidate.trackId === track.id)
    if (target) {
      const firstIndex = track.clips.findIndex((candidate) => target.generatedClipIds.includes(candidate.id))
      if (firstIndex < 0) throw new SilenceCutError('unsafe_ripple', '復元対象trackのclipを特定できません。')
      const firstGenerated = currentById.get(target.generatedClipIds[0]!)?.clip
      if (!firstGenerated) throw new SilenceCutError('unsafe_ripple', '復元元clipを特定できません。')
      const restored = {
        ...clone(firstGenerated),
        id: target.clipId,
        name: target.name,
        startUs: operation.originalStartUs,
        sourceInUs: target.sourceInUs,
        durationUs: target.durationUs,
        ...(target.linkGroupId ? { linkGroupId: target.linkGroupId } : { linkGroupId: undefined })
      } as TimelineClip
      track.clips = track.clips.filter((candidate) => !target.generatedClipIds.includes(candidate.id))
      track.clips.splice(firstIndex, 0, restored)
    }
  }
  for (const track of next.tracks) {
    for (let index = 0; index < track.clips.length; index += 1) {
      const clip = track.clips[index]
      if (!clip || generatedIds.has(clip.id) || operation.targets.some((target) => target.clipId === clip.id)) continue
      if (clip.startUs >= compactedEndUs) track.clips[index] = shiftClip(clip, operation.originalDurationUs - keptDurationUs)
    }
    track.clips.sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
  }
  const remaining = metadataOperations(next).filter((candidate) => candidate.operationId !== operation.operationId)
  if (remaining.length) next.editorMetadata = { schemaVersion: 1, silenceCutOperations: remaining }
  else delete next.editorMetadata
  next.updatedAt = new Date().toISOString()
  const validated = validateProject(next)
  const restoredTarget = operation.targets.find((target) => target.generatedClipIds.includes(clipId)) ?? operation.targets[0]
  if (!restoredTarget) throw new SilenceCutError('unsafe_ripple', '復元後のclip identityを特定できません。')
  return { project: validated, operationId: operation.operationId, restoredDurationUs: operation.originalDurationUs - keptDurationUs, restoredClipId: restoredTarget.clipId }
}

export const mapSourceTimeThroughSilenceCut = (
  originalClip: Pick<TimelineClip, 'startUs' | 'sourceInUs' | 'durationUs'>,
  keepRanges: readonly SilenceCutRange[],
  sourceUs: TimeUs
): TimeUs => {
  return createSilenceCutTimeMapper(originalClip, keepRanges).mapPoint(sourceUs)
}
