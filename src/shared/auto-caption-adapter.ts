import { mapAutoCaptionSourceTimeToTimelineUs, type AutoCaptionResult } from './auto-caption-contract.js'
import { AUTOMATION_SCHEMA_VERSION, validateAutomationProposal, type AutomationProposal, type TranscriptAiOutput } from './automation.js'
import { createTrack, makeId, validateProject } from './project.js'
import { deriveSubtitleEditUnits } from './editing/edit-units.js'
import { normalizeCaptionDisplayText, resolveCaptionDisplayMode } from './caption-display-text.js'
import { type ProjectFile, type SubtitleClip, type SubtitleTrackLayoutSettings, type TimelineClip } from './types.js'
import { validateSubtitleMaxLines } from './subtitle-layout.js'
import type { SourceTimeMapper } from './silence-cut.js'
import { getSubtitleTemplateStyleForId, type UserSubtitleTemplate } from './subtitle-templates.js'
import type { SubtitleTemplateId } from './auto-caption-contract.js'
import type { SubtitleStyle } from './types.js'

const findSubtitleTrack = (project: ProjectFile, requestedTrackId?: string) => {
  const track = requestedTrackId
    ? project.tracks.find((candidate) => candidate.id === requestedTrackId)
    : project.tracks.find((candidate) => candidate.kind === 'subtitle' && !candidate.locked)
  if (!track || track.kind !== 'subtitle' || track.locked) throw new Error('An unlocked subtitle track is required')
  return track
}

/** Keep the adapter's ownership check aligned with clip_automation's display policy (caption_text.py). */

/**
 * Keep derived timeline word timing inside its owning caption.
 *
 * Whisper may emit point words (or a point a few milliseconds before the
 * display caption start). Their source timestamps remain authoritative in the
 * worker result; this only makes the Project Model's derived SubtitleWord
 * timing safe for editing and validation.
 */
const normalizeDerivedWordsToCaption = (
  words: Array<{ id: string; text: string; startUs: number; endUs: number }>,
  captionStartUs: number,
  captionEndUs: number
) => {
  let previousEndUs = captionStartUs
  return words.map((word) => {
    let startUs = Math.min(captionEndUs, Math.max(captionStartUs, word.startUs))
    let endUs = Math.min(captionEndUs, Math.max(captionStartUs, word.endUs))
    if (startUs < previousEndUs) startUs = previousEndUs
    if (endUs < startUs) endUs = startUs
    previousEndUs = endUs
    return { ...word, startUs, endUs }
  })
}

/** Convert source-absolute worker timing to one project timeline. */
export const autoCaptionResultToTranscript = (
  clip: Pick<TimelineClip, 'startUs' | 'sourceInUs' | 'durationUs'>,
  result: AutoCaptionResult,
  options: { sourceTimeMapper?: SourceTimeMapper } = {}
): TranscriptAiOutput => {
  if (result.sourceStartUs !== clip.sourceInUs || result.sourceEndUs !== clip.sourceInUs + clip.durationUs) {
    throw new Error('自動字幕結果のsource rangeが選択clipと一致しません。')
  }
  const wordsById = new Map(result.rawWords.map((word) => [word.id, word]))
  const mapSourceTime = options.sourceTimeMapper?.mapPoint ?? ((sourceUs: number) => mapAutoCaptionSourceTimeToTimelineUs(clip, sourceUs))
  const segments = result.captions.map((caption) => {
    const mappedStartUs = mapSourceTime(caption.startUs)
    const mappedEndUs = mapSourceTime(caption.endUs)
    if (mappedEndUs <= mappedStartUs) {
      throw new Error(`自動字幕のcaption ${caption.id} は無音カット後に正の表示区間を持てません。sourceWordIdを失うため適用を中止しました。`)
    }
    const words = caption.sourceWordIds.map((wordId) => {
      const word = wordsById.get(wordId)
      if (!word) throw new Error('自動字幕結果のword ownershipが不正です。')
      return {
        id: word.id,
        text: word.text,
        startUs: mapSourceTime(word.startUs),
        endUs: mapSourceTime(word.endUs)
      }
    })
    const derivedWords = normalizeDerivedWordsToCaption(words, mappedStartUs, mappedEndUs)
    const sourceWordText = derivedWords.map((word) => word.text).join('')
    const exactWordTextMatch = sourceWordText === caption.text
    const displayNormalizedWordTextMatch = caption.textStatus === 'display_normalized'
      && resolveCaptionDisplayMode(sourceWordText, caption.text) !== undefined
    const wordTruth = words.length > 0
      && derivedWords.every((word) => word.endUs >= word.startUs)
      && (exactWordTextMatch || displayNormalizedWordTextMatch)
    return {
      startUs: mappedStartUs,
      endUs: mappedEndUs,
      text: caption.text,
      ...(wordTruth ? { words: derivedWords } : {})
    }
  })
  if (segments.length === 0) throw new Error('自動字幕結果に字幕がありません。')
  return { kind: 'transcript', language: result.language, text: segments.map((segment) => segment.text).join(''), segments }
}

export const createAutoCaptionAutomationPlan = (
  project: ProjectFile,
  clip: Pick<TimelineClip, 'startUs' | 'sourceInUs' | 'durationUs'>,
  result: AutoCaptionResult,
  options: { subtitleTrackId?: string; title?: string } = {}
): AutomationProposal => {
  const subtitleTrackId = options.subtitleTrackId ?? findSubtitleTrack(project).id
  const output = autoCaptionResultToTranscript(clip, result)
  return validateAutomationProposal(project, {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    title: options.title ?? 'Whisper自動字幕',
    commands: output.segments.map((segment) => ({
      type: 'insert-subtitle' as const,
      trackId: subtitleTrackId,
      clipId: makeId('ai-caption'),
      startUs: segment.startUs,
      durationUs: segment.endUs - segment.startUs,
      text: segment.text,
      words: segment.words
    }))
  })
}

export interface AutoCaptionProjectApply {
  project: ProjectFile
  trackId: string
  captionCount: number
  rawWordCount: number
  wordBearingCaptionCount: number
}

export interface CaptionCoverageRange {
  startUs: number
  endUs: number
}

/**
 * Extends only existing caption clips over short retained gaps.  It never
 * invents text and deliberately leaves long gaps untouched for the silence
 * plan/diagnostics to explain.
 */
export const ensureSubtitleCoverage = (
  project: ProjectFile,
  trackId: string,
  ranges: readonly CaptionCoverageRange[],
  maxGapUs: number
): ProjectFile => {
  if (!Number.isSafeInteger(maxGapUs) || maxGapUs < 0) return project
  const next = structuredClone(project)
  const track = next.tracks.find((candidate) => candidate.id === trackId)
  if (!track || track.kind !== 'subtitle') return project
  const captions = track.clips.filter((clip): clip is SubtitleClip => clip.kind === 'subtitle' && clip.enabled && clip.durationUs > 0)
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.startUs) || !Number.isSafeInteger(range.endUs) || range.endUs <= range.startUs) continue
    const covered = captions.filter((caption) => caption.startUs < range.endUs && caption.startUs + caption.durationUs > range.startUs).sort((left, right) => left.startUs - right.startUs)
    if (!covered.length) continue
    const first = covered[0]!
    const last = covered.at(-1)!
    if (first.startUs > range.startUs && first.startUs - range.startUs <= maxGapUs) {
      first.durationUs += first.startUs - range.startUs
      first.startUs = range.startUs
    }
    const rangeEndUs = range.endUs
    if (rangeEndUs > last.startUs + last.durationUs && rangeEndUs - (last.startUs + last.durationUs) <= maxGapUs) {
      last.durationUs = rangeEndUs - last.startUs
    }
    for (let index = 0; index < covered.length - 1; index += 1) {
      const left = covered[index]!
      const right = covered[index + 1]!
      const gapStartUs = Math.max(range.startUs, left.startUs + left.durationUs)
      const gapEndUs = Math.min(range.endUs, right.startUs)
      if (gapEndUs <= gapStartUs || gapEndUs - gapStartUs > maxGapUs) continue
      const midpointUs = Math.floor((gapStartUs + gapEndUs) / 2)
      const rightEndUs = right.startUs + right.durationUs
      left.durationUs = Math.max(1, midpointUs - left.startUs)
      right.startUs = midpointUs
      right.durationUs = Math.max(1, rightEndUs - midpointUs)
    }
  }
  track.clips.sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
  return validateProject(next)
}

const nextAutoCaptionTrackName = (project: ProjectFile): string => {
  const names = new Set(project.tracks.filter((track) => track.kind === 'subtitle').map((track) => track.name))
  if (!names.has('自動字幕')) return '自動字幕'
  let index = 2
  while (names.has(`自動字幕 ${index}`)) index += 1
  return `自動字幕 ${index}`
}

/**
 * Apply a validated worker result as one new subtitle track.
 * Existing subtitle tracks are never reused or overwritten.
 */
export const applyAutoCaptionResultToProject = (
  project: ProjectFile,
  clip: Pick<TimelineClip, 'startUs' | 'sourceInUs' | 'durationUs'>,
  result: AutoCaptionResult,
  options: { maxChars?: number; maxLines?: number; captionLayout?: SubtitleTrackLayoutSettings; sourceTimeMapper?: SourceTimeMapper; subtitleTemplate?: SubtitleTemplateId; userSubtitleTemplates?: readonly UserSubtitleTemplate[]; subtitleTemplateStyle?: SubtitleStyle; captionCoverageRanges?: readonly CaptionCoverageRange[]; captionCoverageMaxGapUs?: number } = {}
): AutoCaptionProjectApply => {
  const transcript = autoCaptionResultToTranscript(clip, result, { sourceTimeMapper: options.sourceTimeMapper })
  if (options.maxChars !== undefined && (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1 || options.maxChars > 10_000)) {
    throw new Error('自動字幕の最大文字数設定が不正です。')
  }
  if (options.maxChars !== undefined) {
    const oversized = transcript.segments.find((segment) => Array.from(segment.text).length > options.maxChars!)
    if (oversized) throw new Error(`字幕区切りが最大${options.maxChars}文字を超えています。Projectへ適用していません。`)
  }
  const maxLines = options.maxLines === undefined ? undefined : validateSubtitleMaxLines(options.maxLines)
  const track = createTrack('subtitle', project.tracks.filter((candidate) => candidate.kind === 'subtitle').length + 1)
  track.name = nextAutoCaptionTrackName(project)
  // The settings the captions were made with: the settings panel opens with them and later runs start from them.
  if (options.captionLayout) track.captionLayout = { ...options.captionLayout }
  const captions: SubtitleClip[] = transcript.segments.map((segment, index) => ({
    id: makeId('ai-caption'),
    name: segment.text.slice(0, 40),
    kind: 'subtitle',
    startUs: segment.startUs,
    durationUs: segment.endUs - segment.startUs,
    sourceInUs: 0,
    enabled: true,
    text: segment.text,
    style: options.subtitleTemplateStyle
      ? structuredClone(options.subtitleTemplateStyle)
      : getSubtitleTemplateStyleForId(options.subtitleTemplate ?? 'default', options.userSubtitleTemplates),
    ...(maxLines === undefined ? {} : { maxLines }),
    sourceCaptionId: result.captions[index]?.id,
    sourceJobId: result.jobId,
    sourceWordIds: result.captions[index]?.sourceWordIds ? [...result.captions[index]!.sourceWordIds] : [],
    ...(segment.words?.length
      ? {
          words: segment.words.map((word) => ({ ...word })),
          editUnits: deriveSubtitleEditUnits(segment.words.map((word) => ({
            ...word,
            text: result.captions[index]?.textStatus === 'display_normalized'
              ? normalizeCaptionDisplayText(word.text, resolveCaptionDisplayMode(segment.words!.map((item) => item.text).join(''), segment.text) ?? 'legacy')
              : word.text
          })).filter((word) => word.text.length > 0))
        }
      : {})
  }))
  track.clips = captions
  const next: ProjectFile = {
    ...structuredClone(project),
    updatedAt: new Date().toISOString(),
    tracks: [...project.tracks.map((candidate) => structuredClone(candidate)), track]
  }
  const validated = options.captionCoverageRanges && options.captionCoverageMaxGapUs !== undefined
    ? ensureSubtitleCoverage(next, track.id, options.captionCoverageRanges, options.captionCoverageMaxGapUs)
    : validateProject(next)
  return {
    project: validated,
    trackId: track.id,
    captionCount: captions.length,
    rawWordCount: result.rawWords.length,
    wordBearingCaptionCount: captions.filter((caption) => Boolean(caption.words?.length)).length
  }
}
