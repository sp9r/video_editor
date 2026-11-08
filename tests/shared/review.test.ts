import { describe, expect, it } from 'vitest'
import { createEmptyProject, createSubtitleClip } from '../../src/shared/project'
import { deriveCorrectionSummary, deriveReviewEligibility } from '../../src/shared/review/diff'
import { parseExperimentalReviewLog, serializeExperimentalReviewLog, upsertExperimentalReviewRecord } from '../../src/shared/review/log'
import { captureReviewNeighborhood, reviewProjectFingerprint } from '../../src/shared/review/snapshot'
import type { ExperimentalReviewRecord, ReviewNeighborhoodSnapshot } from '../../src/shared/review/types'
import { reviewRatingForShortcut } from '../../src/shared/review/shortcuts'

const word = (id: string, text: string, startUs: number, endUs: number) => ({ id, text, startUs, endUs })
const caption = (id: string, text: string, startUs: number, words?: ReturnType<typeof word>[]): ReviewNeighborhoodSnapshot['captions'][number] => ({
  id, trackId: 'subtitles', name: id, text, startUs, durationUs: 1_000_000, sourceInUs: 0, ...(words ? { words } : {}), wordsMatchText: Boolean(words)
})
const snapshot = (captions: ReviewNeighborhoodSnapshot['captions'], targetCaptionIds: string[], targetWordIds: string[] = []): ReviewNeighborhoodSnapshot => ({ targetId: targetCaptionIds[0] ?? 'target', trackId: 'subtitles', captions, targetCaptionIds, targetWordIds, capturedAt: '2026-08-15T00:00:00.000Z' })

describe('subtitle human review diff', () => {
  it('classifies unchanged, split, merge, move, text, delete, timing and mixed corrections', () => {
    const one = caption('a', '私は', 0, [word('w1', '私', 0, 400_000), word('w2', 'は', 400_000, 900_000)])
    const two = caption('b', '歩く', 1_000_000, [word('w3', '歩く', 1_000_000, 1_900_000)])
    expect(deriveCorrectionSummary(snapshot([one], ['a'], ['w1', 'w2']), snapshot([one], ['a'], ['w1', 'w2'])).primary).toBe('none')
    const splitLeft = caption('a:left', '私', 0, [word('w1', '私', 0, 400_000)])
    const splitRight = caption('a:right', 'は', 400_000, [word('w2', 'は', 400_000, 900_000)])
    expect(deriveCorrectionSummary(snapshot([one], ['a'], ['w1', 'w2']), snapshot([splitLeft, splitRight], ['a:left', 'a:right'], ['w1', 'w2'])).primary).toBe('boundary_split')
    const merged = caption('a', '私は歩く', 0, [word('w1', '私', 0, 400_000), word('w2', 'は', 400_000, 900_000), word('w3', '歩く', 1_000_000, 1_900_000)])
    expect(deriveCorrectionSummary(snapshot([one, two], ['a'], ['w1', 'w2']), snapshot([merged], ['a'], ['w1', 'w2', 'w3'])).primary).toBe('boundary_merge')
    const moved = caption('a', '私は', 200_000, [word('w1', '私', 200_000, 600_000), word('w2', 'は', 600_000, 1_100_000)])
    expect(deriveCorrectionSummary(snapshot([one], ['a'], ['w1', 'w2']), snapshot([moved], ['a'], ['w1', 'w2'])).primary).toBe('timing_edit')
    const left = caption('left', '私', 0, [word('w1', '私', 0, 400_000)])
    const right = caption('right', 'は', 400_000, [word('w2', 'は', 400_000, 900_000)])
    expect(deriveCorrectionSummary(snapshot([left, right], ['left', 'right'], ['w1', 'w2']), snapshot([caption('left', '私は', 0, [word('w1', '私', 0, 400_000), word('w2', 'は', 400_000, 900_000)])], ['left'], ['w1', 'w2'])).primary).toBe('boundary_merge')
    expect(deriveCorrectionSummary(snapshot([one], ['a'], ['w1', 'w2']), snapshot([], [])).primary).toBe('delete')
    const edited = caption('a', '私たちは', 0, [word('w1', '私', 0, 400_000), word('w2', 'たちは', 400_000, 900_000)])
    expect(deriveCorrectionSummary(snapshot([one], ['a'], ['w1', 'w2']), snapshot([edited], ['a'], ['w1', 'w2'])).primary).toBe('text_edit')
    expect(deriveCorrectionSummary(snapshot([one], ['a'], ['w1', 'w2']), snapshot([caption('a', '私たちは', 200_000, [word('w1', '私', 200_000, 600_000), word('w2', 'たちは', 600_000, 1_100_000)])], ['a'], ['w1', 'w2'])).primary).toBe('mixed')
  })

  it('keeps words-none and text-mismatch ineligible for boundary learning', () => {
    const noWords = caption('a', '字幕', 0)
    const mismatch = { ...noWords, words: [word('w1', '別', 0, 100)], wordsMatchText: false }
    expect(deriveReviewEligibility(snapshot([noWords], ['a']), snapshot([noWords], ['a'])).boundaryLearningEligible).toBe(false)
    expect(deriveReviewEligibility(snapshot([mismatch], ['a'], ['w1']), snapshot([mismatch], ['a'], ['w1'])).boundaryLearningEligible).toBe(false)
    expect(deriveReviewEligibility(snapshot([noWords], ['a']), snapshot([noWords], ['a'])).textLearningEligible).toBe(true)
  })

  it('captures only same-track previous/current/next context', () => {
    const project = createEmptyProject('review')
    const track = project.tracks.find((item) => item.kind === 'subtitle')!
    track.clips = [createSubtitleClip(0, 500_000), createSubtitleClip(1_000_000, 500_000), createSubtitleClip(2_000_000, 500_000)]
    const target = track.clips[1]
    expect(target?.kind).toBe('subtitle')
    const result = captureReviewNeighborhood(project, target!.id)
    expect(result?.captions).toHaveLength(3)
    expect(result?.targetCaptionIds).toEqual([target!.id])
  })
})

describe('review persistence and shortcut policy', () => {
  it('round-trips records, replaces the same session target, and tolerates malformed data', () => {
    const record = { version: 'experimental.phase3.5b1', recordId: 'r1', sessionId: 's1', decidedAt: 'now', rating: 'good', target: { captionId: 'a', trackId: 't' }, provenance: { projectId: 'p', projectName: 'p', projectFingerprint: JSON.stringify({ projectPath: 'C:\\\\secret\\\\project.spectra', media: [{ path: 'C:\\\\secret\\\\source.mp4' }] }), media: [{ id: 'm', name: 'source.mp4', fileSize: 1, modifiedAt: 'now' }] } } as unknown as ExperimentalReviewRecord
    const replaced: ExperimentalReviewRecord = { ...record, recordId: 'r2', rating: 'corrected' }
    const records = upsertExperimentalReviewRecord(upsertExperimentalReviewRecord([], record), replaced)
    expect(records).toHaveLength(1)
    expect(parseExperimentalReviewLog(serializeExperimentalReviewLog(records)).records[0]?.recordId).toBe('r2')
    expect(serializeExperimentalReviewLog(records)).not.toContain('secret')
    expect(parseExperimentalReviewLog('{broken').records).toEqual([])
  })

  it('fingerprints project identity without local path fields', () => {
    const project = createEmptyProject('review')
    project.projectPath = 'C:\\\\secret\\\\project.spectra'
    project.media = [{ id: 'm', name: 'source.mp4', path: 'C:\\\\secret\\\\source.mp4', relativePath: '..\\\\source.mp4', kind: 'video', durationUs: 1, hasAudio: true, fileSize: 1, modifiedAt: 'now', offline: false }]
    expect(reviewProjectFingerprint(project)).not.toContain('secret')
    expect(reviewProjectFingerprint(project)).not.toContain('relativePath')
  })

  it('uses A/B/C/D only in review mode and never while typing', () => {
    expect(reviewRatingForShortcut(true, false, 'a')).toBe('good')
    expect(reviewRatingForShortcut(true, false, 'c')).toBe('corrected')
    expect(reviewRatingForShortcut(true, false, 'd')).toBe('skip')
    expect(reviewRatingForShortcut(false, false, 'a')).toBeNull()
    expect(reviewRatingForShortcut(true, true, 'a')).toBeNull()
  })
})
