import { mapAutoCaptionSourceTimeToTimelineUs, type AutoCaptionResult } from './auto-caption-contract.js'
import { AUTOMATION_SCHEMA_VERSION, validateAutomationProposal, type AutomationProposal, type TranscriptAiOutput } from './automation.js'
import { createTrack, makeId, validateProject } from './project.js'
import { deriveSubtitleEditUnits } from './editing/edit-units.js'
import { type ProjectFile, type SubtitleClip, type TimelineClip } from './types.js'
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

/** Keep the adapter's ownership check aligned with clip_automation's display policy. */
const DISPLAY_PUNCTUATION = /[、。！？!?…・〜～]+/gu

const normalizeCaptionOwnershipText = (text: string): string => text.replace(DISPLAY_PUNCTUATION, '')

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
      && normalizeCaptionOwnershipText(sourceWordText) === caption.text
    const wordTruth = words.length > 0
      && derivedWords.every((word) => word.endUs >= word.startUs)
      && (exactWordTextMatch || displayNormalizedWordTextMatch)
    return {
      startUs: mappedStartUs,
      endUs: mappedEndUs,
      text: caption.text,
      ...(wordTruth ? { words: derivedWords } : {})
    }
  }).filter((segment) => segment.endUs > segment.startUs)
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
  options: { maxChars?: number; maxLines?: number; sourceTimeMapper?: SourceTimeMapper; subtitleTemplate?: SubtitleTemplateId; userSubtitleTemplates?: readonly UserSubtitleTemplate[]; subtitleTemplateStyle?: SubtitleStyle } = {}
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
    ...(segment.words?.length
      ? {
          words: segment.words.map((word) => ({ ...word })),
          editUnits: deriveSubtitleEditUnits(segment.words.map((word) => ({
            ...word,
            text: result.captions[index]?.textStatus === 'display_normalized'
              ? normalizeCaptionOwnershipText(word.text)
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
  const validated = validateProject(next)
  return {
    project: validated,
    trackId: track.id,
    captionCount: captions.length,
    rawWordCount: result.rawWords.length,
    wordBearingCaptionCount: captions.filter((caption) => Boolean(caption.words?.length)).length
  }
}
