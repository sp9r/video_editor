import { mapAutoCaptionSourceTimeToTimelineUs, type AutoCaptionResult } from './auto-caption-contract.js'
import { AUTOMATION_SCHEMA_VERSION, validateAutomationProposal, type AutomationProposal, type TranscriptAiOutput } from './automation.js'
import { makeId } from './project.js'
import type { ProjectFile, TimelineClip } from './types.js'

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
    return {
      startUs: mapAutoCaptionSourceTimeToTimelineUs(clip, caption.startUs),
      endUs: mapAutoCaptionSourceTimeToTimelineUs(clip, caption.endUs),
      text: caption.text,
      words
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
