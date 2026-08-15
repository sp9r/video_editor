import { mapAutoCaptionSourceTimeToTimelineUs, type AutoCaptionResult } from './auto-caption-contract.js'
import { AUTOMATION_SCHEMA_VERSION, validateAutomationProposal, type AutomationProposal, type TranscriptAiOutput } from './automation.js'
import { createTrack, makeId, validateProject } from './project.js'
import { deriveSubtitleEditUnits } from './editing/edit-units.js'
import { DEFAULT_SUBTITLE_STYLE, type ProjectFile, type SubtitleClip, type TimelineClip } from './types.js'

const findSubtitleTrack = (project: ProjectFile, requestedTrackId?: string) => {
  const track = requestedTrackId
    ? project.tracks.find((candidate) => candidate.id === requestedTrackId)
    : project.tracks.find((candidate) => candidate.kind === 'subtitle' && !candidate.locked)
  if (!track || track.kind !== 'subtitle' || track.locked) throw new Error('An unlocked subtitle track is required')
  return track
}

/** Convert source-absolute worker timing to one project timeline. */
export const autoCaptionResultToTranscript = (
  clip: Pick<TimelineClip, 'startUs' | 'sourceInUs' | 'durationUs'>,
  result: AutoCaptionResult
): TranscriptAiOutput => {
  if (result.sourceStartUs !== clip.sourceInUs || result.sourceEndUs !== clip.sourceInUs + clip.durationUs) {
    throw new Error('自動字幕結果のsource rangeが選択clipと一致しません。')
  }
  const wordsById = new Map(result.rawWords.map((word) => [word.id, word]))
  const segments = result.captions.map((caption) => {
    const words = caption.sourceWordIds.map((wordId) => {
      const word = wordsById.get(wordId)
      if (!word) throw new Error('自動字幕結果のword ownershipが不正です。')
      return {
        id: word.id,
        text: word.text,
        startUs: mapAutoCaptionSourceTimeToTimelineUs(clip, word.startUs),
        endUs: mapAutoCaptionSourceTimeToTimelineUs(clip, word.endUs)
      }
    })
    const wordTruth = words.length > 0 && words.every((word) => word.endUs > word.startUs) && words.map((word) => word.text).join('') === caption.text
    return {
      startUs: mapAutoCaptionSourceTimeToTimelineUs(clip, caption.startUs),
      endUs: mapAutoCaptionSourceTimeToTimelineUs(clip, caption.endUs),
      text: caption.text,
      ...(wordTruth ? { words } : {})
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
  result: AutoCaptionResult
): AutoCaptionProjectApply => {
  const transcript = autoCaptionResultToTranscript(clip, result)
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
    style: structuredClone(DEFAULT_SUBTITLE_STYLE),
    sourceCaptionId: result.captions[index]?.id,
    sourceJobId: result.jobId,
    ...(segment.words?.length
      ? {
          words: segment.words.map((word) => ({ ...word })),
          editUnits: deriveSubtitleEditUnits(segment.words.map((word) => ({ ...word })))
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
