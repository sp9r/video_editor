import { assertSubtitleTrackHasNoOverlap, framesToUs, shiftClipTimeline, snapUsToFrame, splitClip, subtitleTrimKeepsWordTiming, subtitleWordsMatchText, trimClip } from '../project'
import { sourceWordIdsForEditUnits, subtitleEditUnitBoundaryIsSourceWordBoundary, subtitleEditUnits } from './edit-units'
import type { ProjectFile, SubtitleClip, SubtitleEditUnit, SubtitleWord, TimelineClip, TimelineTrack, TimeUs } from '../types'
import { linkedClipIds, uniqueLinkedRoots } from './links'

export type EditingOperationCode =
  | 'linked_track_locked'
  | 'track_incompatible'
  | 'clip_locked'
  | 'subtitle_invalid_boundary'
  | 'subtitle_no_adjacent'
  | 'subtitle_trim_conflict'

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

const subtitleLocation = (project: ProjectFile, clipId: string): { clip: SubtitleClip; track: TimelineTrack; index: number } | null => {
  for (const track of project.tracks) {
    if (track.kind !== 'subtitle') continue
    const index = track.clips.findIndex((clip) => clip.id === clipId && clip.kind === 'subtitle')
    const clip = track.clips[index]
    if (clip?.kind === 'subtitle') return { clip, track, index }
  }
  return null
}

const allClipIds = (project: ProjectFile): Set<string> => new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)))

const splitSubtitleId = (clipId: string, splitAtUs: TimeUs, usedIds: Set<string>): string => {
  const base = `${clipId}:subtitle-right:${splitAtUs}`
  let candidate = base
  let suffix = 2
  while (usedIds.has(candidate)) candidate = `${base}:${suffix++}`
  return candidate
}

const subtitleTextFromUnits = (units: readonly SubtitleEditUnit[] | undefined): string | null => {
  if (!units?.length) return null
  return units.map((unit) => unit.text).join('')
}

const subtitleUnitsAreValid = (clip: SubtitleClip): boolean => {
  if (!clip.editUnits) return subtitleWordsAreValid(clip)
  const units = subtitleEditUnits(clip)
  return Boolean(units?.length && subtitleTextFromUnits(units) === clip.text)
}

const rawWordsForUnitPartition = (
  left: SubtitleClip,
  right: SubtitleClip,
  leftUnits: readonly SubtitleEditUnit[],
  rightUnits: readonly SubtitleEditUnit[],
  boundaryIndex: number
): { left: SubtitleWord[]; right: SubtitleWord[] } | null => {
  if (!subtitleWordsAreValid(left) || !subtitleWordsAreValid(right)) return null
  const combinedWords = [...left.words!, ...right.words!]
  const combinedUnits = [...leftUnits, ...rightUnits]
  const leftUnit = combinedUnits[boundaryIndex]
  const rightUnit = combinedUnits[boundaryIndex + 1]
  if (!leftUnit || !rightUnit || !subtitleEditUnitBoundaryIsSourceWordBoundary(leftUnit, rightUnit)) return null
  const sourceIds = sourceWordIdsForEditUnits(combinedUnits)
  if (sourceIds.length !== combinedWords.length || sourceIds.some((id, index) => id !== combinedWords[index]?.id)) return null
  const leftCount = sourceIds.indexOf(rightUnit.parentSourceWordId)
  if (leftCount <= 0 || leftCount >= combinedWords.length) return null
  return { left: combinedWords.slice(0, leftCount), right: combinedWords.slice(leftCount) }
}

/** Returns whether a subtitle has enough trusted metadata for a timeline split. */
export const isSubtitleWordBoundarySplitAvailable = (clip: TimelineClip): clip is SubtitleClip =>
  clip.kind === 'subtitle' && (clip.editUnits
    ? Boolean(subtitleUnitsAreValid(clip) && subtitleEditUnits(clip)!.length >= 2)
    : Boolean(clip.words && clip.words.length >= 2 && subtitleWordsMatchText(clip)))

/**
 * Finds the closest internal subtitle word boundary without changing timestamps.
 * A gap between adjacent words is one boundary region with zero distance.
 */
export const nearestSubtitleWordBoundaryIndex = (clip: SubtitleClip, atUs: TimeUs): number | null => {
  if (!isSubtitleWordBoundarySplitAvailable(clip) || !Number.isFinite(atUs)) return null
  if (!clip.editUnits) {
    const words = clip.words
    if (!words) return null
    const clipEndUs = clip.startUs + clip.durationUs
    if (atUs < clip.startUs || atUs >= clipEndUs) return null
    let nearest: number | null = null
    let nearestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < words.length - 1; index += 1) {
      const leftWord = words[index]
      const rightWord = words[index + 1]
      if (!leftWord || !rightWord) continue
      const distance = atUs < leftWord.endUs
        ? leftWord.endUs - atUs
        : atUs > rightWord.startUs
          ? atUs - rightWord.startUs
          : 0
      if (distance < nearestDistance) {
        nearest = index
        nearestDistance = distance
      }
    }
    return nearest
  }
  const units = subtitleEditUnits(clip)
  if (!units) return null
  const clipEndUs = clip.startUs + clip.durationUs
  if (atUs < clip.startUs || atUs >= clipEndUs) return null

  let nearest: number | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < units.length - 1; index += 1) {
    const leftWord = units[index]
    const rightWord = units[index + 1]
    if (!leftWord || !rightWord || (leftWord.startUs === rightWord.startUs && leftWord.endUs === rightWord.endUs)) continue
    const distance = atUs < leftWord.endUs
      ? leftWord.endUs - atUs
      : atUs > rightWord.startUs
        ? atUs - rightWord.startUs
        : 0
    if (distance < nearestDistance) {
      nearest = index
      nearestDistance = distance
    }
  }
  return nearest
}

const subtitleWordsAreValid = (clip: SubtitleClip): boolean => {
  if (!clip.words?.length || !subtitleWordsMatchText(clip)) return false
  let previousEndUs = clip.startUs
  const ids = new Set<string>()
  for (const word of clip.words) {
    if (ids.has(word.id) || !Number.isFinite(word.startUs) || !Number.isFinite(word.endUs) || word.startUs < previousEndUs || word.endUs < word.startUs) return false
    ids.add(word.id)
    previousEndUs = word.endUs
  }
  return true
}

export const isSubtitleOwnershipBoundaryAvailable = (left: TimelineClip, right: TimelineClip): boolean =>
  left.kind === 'subtitle' && right.kind === 'subtitle' && (left.editUnits ? subtitleUnitsAreValid(left) : subtitleWordsAreValid(left)) && (right.editUnits ? subtitleUnitsAreValid(right) : subtitleWordsAreValid(right))

/** Resolves a combined left/right subtitle ownership boundary from a timeline position. */
export const nearestSubtitleOwnershipBoundaryIndex = (left: SubtitleClip, right: SubtitleClip, atUs: TimeUs): number | null => {
  if (!left.editUnits && !right.editUnits) {
    if (!subtitleWordsAreValid(left) || !subtitleWordsAreValid(right)) return null
    const rightEndUs = right.startUs + right.durationUs
    if (!Number.isFinite(rightEndUs) || rightEndUs <= left.startUs) return null
    const combined: SubtitleClip = {
      ...left,
      durationUs: rightEndUs - left.startUs,
      text: `${left.text}${right.text}`,
      words: [...left.words!, ...right.words!].map((word) => ({ ...word }))
    }
    return nearestSubtitleWordBoundaryIndex(combined, atUs)
  }
  if (!subtitleUnitsAreValid(left) || !subtitleUnitsAreValid(right)) return null
  const leftUnits = subtitleEditUnits(left)
  const rightUnits = subtitleEditUnits(right)
  if (!leftUnits || !rightUnits) return null
  const rightEndUs = right.startUs + right.durationUs
  if (!Number.isFinite(rightEndUs) || rightEndUs <= left.startUs) return null
  const combined: SubtitleClip = {
    ...left,
    startUs: left.startUs,
    durationUs: rightEndUs - left.startUs,
    text: `${left.text}${right.text}`,
    editUnits: [...leftUnits, ...rightUnits].map((unit) => ({ ...unit }))
  }
  return nearestSubtitleWordBoundaryIndex(combined, atUs)
}

/** Move subtitle word ownership between adjacent captions without changing word timestamps. */
export const moveSubtitleBoundary = (project: ProjectFile, leftClipId: string, rightClipId: string, boundaryIndex: number): ProjectFile => {
  const leftLocation = subtitleLocation(project, leftClipId)
  const rightLocation = subtitleLocation(project, rightClipId)
  if (!leftLocation || !rightLocation || leftLocation.track.id !== rightLocation.track.id || leftLocation.index + 1 !== rightLocation.index) {
    throw new EditingOperationError('subtitle_invalid_boundary', '隣接した字幕の単語境界だけを移動できます。', [leftClipId, rightClipId])
  }
  if (leftLocation.track.locked) throw new EditingOperationError('clip_locked', '字幕トラックがロックされています。', [leftClipId, rightClipId])
  if (!subtitleUnitsAreValid(leftLocation.clip) || !subtitleUnitsAreValid(rightLocation.clip)) {
    throw new EditingOperationError('subtitle_invalid_boundary', '単語タイミング情報がないか、字幕本文と一致しません。', [leftClipId, rightClipId])
  }
  const leftUnits = subtitleEditUnits(leftLocation.clip)!
  const rightUnits = subtitleEditUnits(rightLocation.clip)!
  const combinedUnits = [...leftUnits, ...rightUnits]
  const combinedIds = new Set<string>()
  let previousEndUs = leftLocation.clip.startUs
  for (const unit of combinedUnits) {
    if (combinedIds.has(unit.id) || unit.startUs < previousEndUs || unit.endUs < unit.startUs) {
      throw new EditingOperationError('subtitle_invalid_boundary', '単語タイミングの順序またはIDが不正です。', [leftClipId, rightClipId])
    }
    combinedIds.add(unit.id)
    previousEndUs = unit.endUs
  }
  if (!Number.isInteger(boundaryIndex) || boundaryIndex < 0 || boundaryIndex >= combinedUnits.length - 1) {
    throw new EditingOperationError('subtitle_invalid_boundary', '選択した単語境界では字幕を分割できません。', [leftClipId, rightClipId])
  }
  const nextLeftUnits = combinedUnits.slice(0, boundaryIndex + 1)
  const nextRightUnits = combinedUnits.slice(boundaryIndex + 1)
  const nextLeftEndUs = nextLeftUnits.at(-1)?.endUs
  const nextRightStartUs = nextRightUnits[0]?.startUs
  const rightOuterEndUs = rightLocation.clip.startUs + rightLocation.clip.durationUs
  if (nextLeftEndUs === undefined || nextRightStartUs === undefined) {
    throw new EditingOperationError('subtitle_invalid_boundary', '字幕の外側へ単語境界を移動できません。', [leftClipId, rightClipId])
  }
  const nextRightSourceInUs = rightLocation.clip.sourceInUs + nextRightStartUs - rightLocation.clip.startUs
  if (!Number.isFinite(nextLeftEndUs) || !Number.isFinite(nextRightStartUs) || !Number.isFinite(rightOuterEndUs) || !Number.isFinite(nextRightSourceInUs) || nextLeftEndUs <= leftLocation.clip.startUs || nextRightStartUs >= rightOuterEndUs || nextRightSourceInUs < 0) {
    throw new EditingOperationError('subtitle_invalid_boundary', '字幕の外側へ単語境界を移動できません。', [leftClipId, rightClipId])
  }
  if (boundaryIndex === leftUnits.length - 1) return project

  const next = clone(project)
  const nextLeftLocation = subtitleLocation(next, leftClipId)
  const nextRightLocation = subtitleLocation(next, rightClipId)
  if (!nextLeftLocation || !nextRightLocation) return project
  nextLeftLocation.clip.text = nextLeftUnits.map((unit) => unit.text).join('')
  nextLeftLocation.clip.durationUs = nextLeftEndUs - nextLeftLocation.clip.startUs
  nextLeftLocation.clip.editUnits = nextLeftUnits.map((unit) => ({ ...unit }))
  nextRightLocation.clip.startUs = nextRightStartUs
  nextRightLocation.clip.text = nextRightUnits.map((unit) => unit.text).join('')
  nextRightLocation.clip.durationUs = rightOuterEndUs - nextRightStartUs
  nextRightLocation.clip.sourceInUs = nextRightSourceInUs
  nextRightLocation.clip.editUnits = nextRightUnits.map((unit) => ({ ...unit }))
  const rawPartition = rawWordsForUnitPartition(leftLocation.clip, rightLocation.clip, leftUnits, rightUnits, boundaryIndex)
  if (rawPartition) {
    nextLeftLocation.clip.words = rawPartition.left.map((word) => ({ ...word }))
    nextRightLocation.clip.words = rawPartition.right.map((word) => ({ ...word }))
  } else {
    nextLeftLocation.clip.words = undefined
    nextRightLocation.clip.words = undefined
  }
  nextRightLocation.track.clips.sort((a, b) => a.startUs - b.startUs || a.id.localeCompare(b.id))
  assertSubtitleTrackHasNoOverlap(nextRightLocation.track)
  updateTimestamp(next)
  return next
}

/** Split a caption only at a word boundary with timestamp metadata. */
export const splitSubtitleAtWordBoundary = (project: ProjectFile, clipId: string, boundaryIndex: number): ProjectFile => {
  const location = subtitleLocation(project, clipId)
  if (!location || location.track.locked) throw new EditingOperationError('clip_locked', '字幕トラックがロックされています。', [clipId])
  const units = subtitleEditUnits(location.clip)
  const leftUnit = units?.[boundaryIndex]
  const rightUnit = units?.[boundaryIndex + 1]
  const combinedText = subtitleTextFromUnits(units)
  if (!units || !leftUnit || !rightUnit || combinedText !== location.clip.text || boundaryIndex < 0 || boundaryIndex >= units.length - 1) {
    throw new EditingOperationError('subtitle_invalid_boundary', '単語タイミング情報がないか、選択した位置で分割できません。', [clipId])
  }
  const splitAtUs = rightUnit.startUs
  const leftEndUs = leftUnit.endUs
  const originalEndUs = location.clip.startUs + location.clip.durationUs
  if (!Number.isFinite(splitAtUs) || !Number.isFinite(leftEndUs) || leftEndUs < location.clip.startUs || splitAtUs < leftEndUs || splitAtUs >= originalEndUs || rightUnit.endUs < splitAtUs || splitAtUs <= location.clip.startUs) {
    throw new EditingOperationError('subtitle_invalid_boundary', '単語の時間範囲が字幕の範囲内にありません。', [clipId])
  }
  const next = clone(project)
  const nextLocation = subtitleLocation(next, clipId)
  if (!nextLocation) return project
  const usedIds = allClipIds(next)
  const rightId = splitSubtitleId(clipId, splitAtUs, usedIds)
  const left: SubtitleClip = {
    ...nextLocation.clip,
    text: units.slice(0, boundaryIndex + 1).map((unit) => unit.text).join(''),
    durationUs: leftEndUs - nextLocation.clip.startUs,
    editUnits: units.slice(0, boundaryIndex + 1).map((unit) => ({ ...unit }))
  }
  const right: SubtitleClip = {
    ...nextLocation.clip,
    id: rightId,
    name: `${nextLocation.clip.name} (後半)`,
    startUs: splitAtUs,
    text: units.slice(boundaryIndex + 1).map((unit) => unit.text).join(''),
    durationUs: originalEndUs - splitAtUs,
    sourceInUs: nextLocation.clip.sourceInUs + (splitAtUs - nextLocation.clip.startUs),
    editUnits: units.slice(boundaryIndex + 1).map((unit) => ({ ...unit }))
  }
  if (nextLocation.clip.words && subtitleWordsMatchText(nextLocation.clip) && subtitleEditUnitBoundaryIsSourceWordBoundary(leftUnit, rightUnit)) {
    const sourceIds = sourceWordIdsForEditUnits(units)
    const rightSourceIndex = sourceIds.indexOf(rightUnit.parentSourceWordId)
    if (sourceIds.length === nextLocation.clip.words.length && rightSourceIndex > 0) {
      left.words = nextLocation.clip.words.slice(0, rightSourceIndex).map((word) => ({ ...word }))
      right.words = nextLocation.clip.words.slice(rightSourceIndex).map((word) => ({ ...word }))
    } else {
      left.words = undefined
      right.words = undefined
    }
  } else {
    left.words = undefined
    right.words = undefined
  }
  nextLocation.track.clips.splice(nextLocation.index, 1, left, right)
  nextLocation.track.clips.sort((a, b) => a.startUs - b.startUs || a.id.localeCompare(b.id))
  assertSubtitleTrackHasNoOverlap(nextLocation.track)
  updateTimestamp(next)
  return next
}

const mergeSubtitle = (project: ProjectFile, clipId: string, direction: 'previous' | 'next'): ProjectFile => {
  const location = subtitleLocation(project, clipId)
  if (!location || location.track.locked) throw new EditingOperationError('clip_locked', '字幕トラックがロックされています。', [clipId])
  const adjacentIndex = direction === 'previous' ? location.index - 1 : location.index + 1
  const adjacent = location.track.clips[adjacentIndex]
  if (!adjacent || adjacent.kind !== 'subtitle') {
    throw new EditingOperationError('subtitle_no_adjacent', direction === 'previous' ? '前に結合できる字幕がありません。' : '後ろに結合できる字幕がありません.', [clipId])
  }
  const first = direction === 'previous' ? adjacent : location.clip
  const second = direction === 'previous' ? location.clip : adjacent
  const next = clone(project)
  const nextLocation = subtitleLocation(next, clipId)
  if (!nextLocation) return project
  const nextAdjacent = nextLocation.track.clips[adjacentIndex]
  if (!nextAdjacent || nextAdjacent.kind !== 'subtitle') return project
  const firstWordsMatch = first.kind === 'subtitle' && subtitleWordsMatchText(first)
  const secondWordsMatch = second.kind === 'subtitle' && subtitleWordsMatchText(second)
  const firstLastWord = first.words?.at(-1)
  const secondFirstWord = second.words?.[0]
  if (firstWordsMatch && secondWordsMatch && firstLastWord && secondFirstWord && firstLastWord.endUs > secondFirstWord.startUs) {
    throw new EditingOperationError('subtitle_invalid_boundary', '単語タイミングの順序が逆転するため、字幕を結合できません。', [clipId])
  }
  const mergedWords = firstWordsMatch && secondWordsMatch ? [...first.words!, ...second.words!].map((word) => ({ ...word })) : undefined
  const firstUnits = subtitleEditUnits(first)
  const secondUnits = subtitleEditUnits(second)
  const mergedUnits = firstUnits && secondUnits ? [...firstUnits, ...secondUnits].map((unit) => ({ ...unit })) : undefined
  const merged: SubtitleClip = {
    ...(direction === 'previous' ? nextAdjacent : nextLocation.clip),
    text: `${first.text}${second.text}`,
    startUs: Math.min(first.startUs, second.startUs),
    durationUs: Math.max(first.startUs + first.durationUs, second.startUs + second.durationUs) - Math.min(first.startUs, second.startUs),
    sourceInUs: Math.min(first.sourceInUs, second.sourceInUs),
    ...(mergedWords ? { words: mergedWords } : { words: undefined }),
    ...(mergedUnits ? { editUnits: mergedUnits } : { editUnits: undefined })
  }
  const removeIndex = direction === 'previous' ? nextLocation.index : adjacentIndex
  const replaceIndex = direction === 'previous' ? adjacentIndex : nextLocation.index
  nextLocation.track.clips.splice(replaceIndex, 1, merged)
  nextLocation.track.clips.splice(removeIndex > replaceIndex ? removeIndex : removeIndex + 1, 1)
  nextLocation.track.clips.sort((a, b) => a.startUs - b.startUs || a.id.localeCompare(b.id))
  assertSubtitleTrackHasNoOverlap(nextLocation.track)
  updateTimestamp(next)
  return next
}

export const mergeSubtitleWithPrevious = (project: ProjectFile, clipId: string): ProjectFile => mergeSubtitle(project, clipId, 'previous')
export const mergeSubtitleWithNext = (project: ProjectFile, clipId: string): ProjectFile => mergeSubtitle(project, clipId, 'next')

const applyTimeDelta = (project: ProjectFile, clipIds: readonly string[], deltaUs: TimeUs): void => {
  for (const clipId of clipIds) {
    updateClipInProject(project, clipId, (clip) => {
      const nextStart = Math.max(0, clip.startUs + deltaUs)
      return shiftClipTimeline(clip, nextStart - clip.startUs)
    })
  }
}

export const moveLinkedClip = (project: ProjectFile, clipId: string, targetTrackId: string, atUs: TimeUs, exact = false): ProjectFile => {
  const location = locateClip(project, clipId)
  const targetTrack = project.tracks.find((track) => track.id === targetTrackId)
  if (!location || !targetTrack) return project
  if (!compatibleTrack(location.clip, targetTrack)) throw new EditingOperationError('track_incompatible', 'クリップ種別と移動先トラックの種類が一致しません。', [clipId])
  const ids = linkedClipIds(project, clipId)
  assertEditable(project, ids, targetTrack)
  if (!Number.isFinite(atUs)) return project
  const next = clone(project)
  const selected = locateClip(next, clipId)
  if (!selected) return project
  const nextStart = Math.max(0, exact ? Math.round(atUs) : snapUsToFrame(atUs, project))
  // Linked clips move by the same delta; none of them may cross the timeline
  // origin, otherwise a partial clamp would silently desynchronize the group.
  const earliestStartUs = Math.min(...locations(next, ids).map(({ clip }) => clip.startUs))
  applyTimeDelta(next, ids, Math.max(nextStart - selected.clip.startUs, -earliestStartUs))
  moveTrack(next, clipId, targetTrackId)
  for (const track of next.tracks) assertSubtitleTrackHasNoOverlap(track)
  updateTimestamp(next)
  return next
}

export const trimLinkedClip = (project: ProjectFile, clipId: string, edge: 'start' | 'end', atUs: TimeUs, exact = false): ProjectFile => {
  const location = locateClip(project, clipId)
  if (!location) return project
  const ids = linkedClipIds(project, clipId)
  assertEditable(project, ids)
  for (const candidate of locations(project, ids)) {
    if (!subtitleTrimKeepsWordTiming(project, candidate.clip, edge, atUs)) {
      throw new EditingOperationError('subtitle_trim_conflict', '単語タイミングより内側には字幕を縮められません。', [candidate.clip.id])
    }
  }
  if (ids.length === 1) return trimClip(project, clipId, edge, atUs, exact)
  const selectedAfter = trimClip(project, clipId, edge, atUs, exact)
  const selectedBefore = location.clip
  const selectedLocationAfter = locateClip(selectedAfter, clipId)
  if (!selectedLocationAfter) return project
  const next = clone(project)
  const frameUs = framesToUs(1, project.sequence.frameRate.numerator, project.sequence.frameRate.denominator)
  const linked = locations(project, ids).map(({ clip }) => clip)
  if (edge === 'start') {
    // Every linked clip shifts its start by the same amount. Clamp that amount
    // so that no peer starts before 0 / before its own source, or collapses.
    const requested = selectedLocationAfter.clip.startUs - selectedBefore.startUs
    const earliest = Math.max(...linked.map((clip) => Math.max(-clip.sourceInUs, -clip.startUs)))
    const latest = Math.min(...linked.map((clip) => clip.durationUs - frameUs))
    const delta = Math.min(latest, Math.max(earliest, requested))
    for (const id of ids) {
      updateClipInProject(next, id, (clip) => ({ ...clip, startUs: clip.startUs + delta, sourceInUs: clip.sourceInUs + delta, durationUs: clip.durationUs - delta }))
    }
  } else {
    const requested = selectedLocationAfter.clip.durationUs - selectedBefore.durationUs
    for (const id of ids) {
      updateClipInProject(next, id, (clip) => {
        const asset = 'assetId' in clip ? project.media.find((item) => item.id === clip.assetId) : undefined
        const limit = asset && asset.kind !== 'image' && asset.durationUs > 0
          ? Math.max(frameUs, asset.durationUs - clip.sourceInUs)
          : Number.MAX_SAFE_INTEGER
        return { ...clip, durationUs: Math.min(limit, Math.max(frameUs, clip.durationUs + requested)) }
      })
    }
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
  if (location.clip.kind === 'subtitle' && (location.clip.words?.length || location.clip.editUnits?.length)) {
    throw new EditingOperationError('subtitle_invalid_boundary', '単語タイミングがある字幕は、Inspectorの単語境界から分割してください。', [clipId])
  }
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
    // A locked track must not be modified at all, ripple included.
    if (ripple && !track.locked) {
      for (const clip of track.clips) {
        const shift = intervals.reduce((total, [start, end]) => total + (clip.startUs >= end ? end - start : 0), 0)
        if (shift > 0) {
          const index = track.clips.indexOf(clip)
          track.clips[index] = shiftClipTimeline(clip, -shift)
        }
      }
    }
  }
  updateTimestamp(next)
  return next
}

export const splitSelectedRoots = (project: ProjectFile, clipIds: readonly string[]): string[] => uniqueLinkedRoots(project, clipIds)
