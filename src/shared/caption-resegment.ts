import {
  RESEGMENT_REQUEST_VERSION,
  type ResegmentCaption,
  type ResegmentRequest,
  type ResegmentResult,
  type ResegmentWord
} from './auto-caption-contract.js'
import { resolveCaptionLayoutLimits } from './auto-caption-ui.js'
import { normalizeCaptionDisplayText, resolveCaptionDisplayMode } from './caption-display-text.js'
import { deriveSubtitleEditUnits } from './editing/edit-units.js'
import { makeId, validateProject } from './project.js'
import type { ProjectFile, SubtitleClip, SubtitleStyle, SubtitleTrackLayoutSettings, SubtitleWord, TimelineTrack } from './types.js'

/**
 * Re-applying caption settings to captions that already exist.
 *
 * Appearance changes (style, width, display line limit) only rewrite the
 * clips. Layout changes (max chars, lines, width -> per-line capacity, mode)
 * re-split the captions' own source words with the worker (no audio, no
 * Whisper). Captions the user edited by hand are never re-split.
 */

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

/**
 * A caption can be re-split only while its text is still exactly what its
 * source words say (the worker may have removed display punctuation). Editing
 * the text in the Inspector drops the word data, which also excludes it.
 */
export const isCaptionResegmentable = (clip: SubtitleClip): boolean => {
  const words = clip.words
  if (!words?.length) return false
  if (words.some((word) => !ID_PATTERN.test(word.id) || word.text.length === 0 || word.text.length > 400)) return false
  const joined = words.map((word) => word.text).join('')
  if (joined === clip.text || resolveCaptionDisplayMode(joined, clip.text) !== undefined) return true
  // Text that differs from the words only by display punctuation is still not a manual edit.
  return normalizeCaptionDisplayText(joined, 'hide') === normalizeCaptionDisplayText(clip.text, 'hide')
    || normalizeCaptionDisplayText(joined, 'legacy') === normalizeCaptionDisplayText(clip.text, 'legacy')
}

export interface CaptionResegmentRun {
  clipIds: string[]
  words: ResegmentWord[]
  spanStartUs: number
  spanEndUs: number
}

export interface CaptionResegmentPlan {
  trackId: string
  runs: CaptionResegmentRun[]
  /** In-scope captions that are kept as they are (hand-edited or without word data). */
  keptClipIds: string[]
}

const subtitleTrack = (project: ProjectFile, trackId: string): TimelineTrack => {
  const track = project.tracks.find((candidate) => candidate.id === trackId)
  if (!track || track.kind !== 'subtitle') throw new Error('字幕トラックが見つかりません。')
  if (track.locked) throw new Error('字幕トラックがロックされています。')
  return track
}

const subtitleClips = (track: TimelineTrack): SubtitleClip[] =>
  track.clips.filter((clip): clip is SubtitleClip => clip.kind === 'subtitle').sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))

export const planCaptionResegment = (project: ProjectFile, trackId: string, scopeClipIds?: ReadonlySet<string>): CaptionResegmentPlan => {
  const clips = subtitleClips(subtitleTrack(project, trackId))
  const runs: CaptionResegmentRun[] = []
  const keptClipIds: string[] = []
  const seenWordIds = new Set<string>()
  let current: SubtitleClip[] = []
  const closeRun = (): void => {
    if (current.length === 0) return
    runs.push({
      clipIds: current.map((clip) => clip.id),
      words: current.flatMap((clip) => (clip.words ?? []).map((word) => ({ id: word.id, text: word.text, startUs: word.startUs, endUs: word.endUs }))),
      spanStartUs: current[0]!.startUs,
      spanEndUs: current.at(-1)!.startUs + current.at(-1)!.durationUs
    })
    current = []
  }
  for (const clip of clips) {
    const inScope = !scopeClipIds || scopeClipIds.has(clip.id)
    const duplicateWord = clip.words?.some((word) => seenWordIds.has(word.id)) ?? false
    if (inScope && isCaptionResegmentable(clip) && !duplicateWord) {
      clip.words!.forEach((word) => seenWordIds.add(word.id))
      current.push(clip)
      continue
    }
    closeRun()
    if (inScope) keptClipIds.push(clip.id)
  }
  closeRun()
  return { trackId, runs, keptClipIds }
}

export const buildResegmentRequests = (
  plan: CaptionResegmentPlan,
  options: { jobPrefix: string; language: string; maxChars: number; maxLines: number; lineCapacity: number; hidePunctuation: boolean; segmentationMode: SubtitleTrackLayoutSettings['segmentationMode'] }
): ResegmentRequest[] =>
  plan.runs.map((run, index) => ({
    version: RESEGMENT_REQUEST_VERSION,
    jobId: `${options.jobPrefix}-${index + 1}`,
    language: options.language,
    maxChars: options.maxChars,
    maxLines: options.maxLines,
    lineCapacity: options.lineCapacity,
    hidePunctuation: options.hidePunctuation,
    segmentationMode: options.segmentationMode,
    words: run.words
  }))

/** The effective limits sent to the worker for these settings. */
export const resegmentLimits = (
  settings: Pick<SubtitleTrackLayoutSettings, 'maxChars' | 'maxLines' | 'maxWidthPercent'>,
  style: Pick<SubtitleStyle, 'fontSize' | 'letterSpacing' | 'maxWidthPercent'>,
  sequenceWidth: number
): { maxChars: number; lineCapacity: number } => {
  const limits = resolveCaptionLayoutLimits({ maxChars: settings.maxChars, maxLines: settings.maxLines, style, maxWidthPercent: settings.maxWidthPercent, sequenceWidth })
  return { maxChars: limits.effectiveMaxChars, lineCapacity: limits.lineCapacity }
}

/**
 * Does moving from `previous` to `next` change how captions are split?
 * Colours, position, animation... never do; size/width/lines/chars/mode do.
 */
export const captionSplitSettingsChanged = (
  previous: { maxChars: number; maxLines: number; segmentationMode: string; lineCapacity: number; hidePunctuation?: boolean },
  next: { maxChars: number; maxLines: number; segmentationMode: string; lineCapacity: number; hidePunctuation?: boolean }
): boolean =>
  (previous.hidePunctuation ?? true) !== (next.hidePunctuation ?? true)
  || previous.maxChars !== next.maxChars
  || previous.maxLines !== next.maxLines
  || previous.segmentationMode !== next.segmentationMode
  || previous.lineCapacity !== next.lineCapacity

export interface CaptionAppearanceOptions {
  /** Style for each in-scope clip (already containing the chosen width). */
  styleFor: (clip: SubtitleClip) => SubtitleStyle
  maxLines: number
  layout: SubtitleTrackLayoutSettings
}

/** Appearance-only pass: rewrites style, display line limit and the stored track settings. */
export const applyCaptionAppearance = (project: ProjectFile, trackId: string, scopeClipIds: ReadonlySet<string> | undefined, options: CaptionAppearanceOptions): ProjectFile => {
  subtitleTrack(project, trackId)
  const next = structuredClone(project)
  const track = next.tracks.find((candidate) => candidate.id === trackId)!
  for (const clip of track.clips) {
    if (clip.kind !== 'subtitle' || (scopeClipIds && !scopeClipIds.has(clip.id))) continue
    clip.style = structuredClone(options.styleFor(clip))
    clip.maxLines = options.maxLines
  }
  track.captionLayout = { ...options.layout }
  return validateProject(next)
}

export interface CaptionResegmentApplyOutcome {
  project: ProjectFile
  replacedCount: number
  createdCount: number
  keptCount: number
}

/**
 * Replace each run's captions with the worker's captions. Every new caption
 * owns the same source words as before (text, timing, ownership), keeps the
 * style/maxLines of the caption that owned its first word, and stays between
 * the hand-edited captions that were left in place.
 */
export const applyCaptionResegmentResults = (
  project: ProjectFile,
  plan: CaptionResegmentPlan,
  results: readonly ResegmentResult[]
): CaptionResegmentApplyOutcome => {
  if (results.length !== plan.runs.length) throw new Error('再分割の結果の数が一致しません。')
  subtitleTrack(project, plan.trackId)
  const next = structuredClone(project)
  const track = next.tracks.find((candidate) => candidate.id === plan.trackId)!
  const byId = new Map(track.clips.map((clip) => [clip.id, clip]))
  const created: SubtitleClip[] = []
  const removed = new Set<string>()
  plan.runs.forEach((run, runIndex) => {
    const result = results[runIndex]!
    const oldClips = run.clipIds.map((id) => byId.get(id)).filter((clip): clip is SubtitleClip => clip?.kind === 'subtitle')
    if (oldClips.length !== run.clipIds.length) throw new Error('再分割の対象字幕が変更されています。')
    const wordOwner = new Map<string, SubtitleClip>()
    const wordById = new Map<string, SubtitleWord>()
    for (const clip of oldClips) for (const word of clip.words ?? []) {
      wordOwner.set(word.id, clip)
      wordById.set(word.id, word)
    }
    const covered = (timeUs: number): boolean => oldClips.some((clip) => clip.startUs <= timeUs && timeUs < clip.startUs + clip.durationUs)
    const captions: ResegmentCaption[] = result.captions
    const runCreated = captions.map((caption, index): SubtitleClip => {
      const words = caption.sourceWordIds.map((id) => wordById.get(id)!)
      const owner = wordOwner.get(caption.sourceWordIds[0]!)!
      const lastWord = words.at(-1)!
      let startUs = words[0]!.startUs
      let endUs = Math.max(lastWord.endUs, startUs + 1)
      if (index === 0) startUs = Math.min(startUs, run.spanStartUs)
      if (index === captions.length - 1) endUs = Math.max(endUs, run.spanEndUs)
      return {
        id: makeId('ai-caption'),
        name: caption.text.slice(0, 40),
        kind: 'subtitle',
        startUs,
        durationUs: endUs - startUs,
        sourceInUs: 0,
        enabled: owner.enabled,
        text: caption.text,
        style: structuredClone(owner.style),
        ...(owner.maxLines === undefined ? {} : { maxLines: owner.maxLines }),
        ...(owner.sourceJobId === undefined ? {} : { sourceJobId: owner.sourceJobId }),
        sourceWordIds: [...caption.sourceWordIds],
        words: words.map((word) => ({ ...word }))
      }
    })
    // Neighbouring captions never overlap, and short pauses that were covered stay covered.
    for (let index = 0; index < runCreated.length - 1; index += 1) {
      const left = runCreated[index]!
      const right = runCreated[index + 1]!
      let endUs = left.startUs + left.durationUs
      if (endUs > right.startUs) endUs = right.startUs
      else if (endUs < right.startUs && covered(Math.floor((endUs + right.startUs) / 2))) endUs = right.startUs
      if (endUs <= left.startUs) throw new Error('字幕の時間が重なるため再分割できませんでした。')
      left.durationUs = endUs - left.startUs
    }
    runCreated.forEach((clip, index) => {
      const caption = captions[index]!
      const clipEndUs = clip.startUs + clip.durationUs
      const rawWords = clip.words!
      const wordsInside = rawWords.every((word) => word.startUs >= clip.startUs && word.endUs <= clipEndUs)
      const joined = rawWords.map((word) => word.text).join('')
      const exact = joined === caption.text
      const displayMode = caption.textStatus === 'display_normalized' ? resolveCaptionDisplayMode(joined, caption.text) : undefined
      const normalized = displayMode !== undefined
      if (!wordsInside || (!exact && !normalized)) {
        delete clip.words
        return
      }
      const unitWords = normalized
        ? rawWords.map((word) => ({ ...word, text: normalizeCaptionDisplayText(word.text, displayMode) })).filter((word) => word.text.length > 0)
        : rawWords
      const units = deriveSubtitleEditUnits(unitWords)
      if (units && units.map((unit) => unit.text).join('') === clip.text) clip.editUnits = units
      else delete clip.words
    })
    for (const clip of oldClips) removed.add(clip.id)
    created.push(...runCreated)
  })
  track.clips = [...track.clips.filter((clip) => !removed.has(clip.id)), ...created]
    .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
  return {
    project: validateProject(next),
    replacedCount: removed.size,
    createdCount: created.length,
    keptCount: plan.keptClipIds.length
  }
}

export const resegmentKeptMessage = (keptCount: number): string =>
  keptCount > 0 ? `手で編集した（または単語情報のない）字幕${keptCount}件はそのまま残しました。` : ''
