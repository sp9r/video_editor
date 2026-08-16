import { describe, expect, it } from 'vitest'
import { buildLearningDataset, LEARNING_DATASET_VERSION, parseLearningDatasetJsonl, serializeLearningDatasetJsonl } from '../../src/shared/learning-dataset'

const record = (captionId = 'caption-1', eligible = true): unknown => ({
  version: 'experimental.phase3.5b1',
  recordId: `record-${captionId}`,
  sessionId: 'session-1',
  decidedAt: '2026-08-17T00:00:00.000Z',
  rating: 'corrected',
  target: { captionId, trackId: 'subtitle-track' },
  baseline: {
    targetId: captionId, trackId: 'subtitle-track', targetCaptionIds: [captionId], targetWordIds: ['word-1'], capturedAt: 'now',
    captions: [{ id: captionId, trackId: 'subtitle-track', name: 'caption', text: '元の字幕', startUs: 0, durationUs: 1_000_000, sourceInUs: 0, words: [{ id: 'word-1', text: '元の字幕', startUs: 0, endUs: 1_000_000 }], wordsMatchText: true, style: { fontFamily: 'Noto Sans JP' } }]
  },
  final: {
    targetId: captionId, trackId: 'subtitle-track', targetCaptionIds: [captionId], targetWordIds: ['word-1'], capturedAt: 'now',
    captions: [{ id: captionId, trackId: 'subtitle-track', name: 'caption', text: '修正後の字幕', startUs: 100_000, durationUs: 900_000, sourceInUs: 0, words: [{ id: 'word-1', text: '修正後の字幕', startUs: 100_000, endUs: 1_000_000 }], wordsMatchText: true, style: { fontFamily: 'Noto Serif JP' } }]
  },
  correction: { primary: 'text_edit', types: ['text_edit'], changedCaptionIds: [captionId], changedWordIds: ['word-1'] },
  boundaryLearningEligible: eligible,
  textLearningEligible: eligible,
  provenance: { projectId: 'project-secret-path-1', projectName: 'private project', projectFingerprint: '{"media":{"path":"C:\\secret\\source.mp4"}}', media: [{ id: 'media', name: 'source.mp4', fileSize: 1, modifiedAt: 'now' }] }
})

describe('learning dataset v1', () => {
  it('converts corrections, strips path-bearing provenance, and counts eligibility', () => {
    const built = buildLearningDataset([record(), record('caption-2', false)])
    expect(built.samples).toHaveLength(1)
    expect(built.excludedSamples).toBe(1)
    expect(built.samples[0]).toMatchObject({ version: LEARNING_DATASET_VERSION, correction: { primary: 'text_edit', style: { before: { fontFamily: 'Noto Sans JP' }, after: { fontFamily: 'Noto Serif JP' } } }, eligibility: { eligible: true }, sourceWordOwnership: { baseline: [{ id: 'word-1' }] } })
    expect(JSON.stringify(built)).not.toContain('secret')
    expect(JSON.stringify(built)).not.toContain('source.mp4')
  })

  it('deduplicates by stable project/track/caption key and skips malformed records', () => {
    const built = buildLearningDataset([record(), { version: 'old' }, record()])
    expect(built.samples).toHaveLength(1)
    expect(built.diagnostics).toHaveLength(1)
  })

  it('round-trips JSONL and scales to 1000 records', () => {
    const built = buildLearningDataset(Array.from({ length: 1000 }, (_, index) => record(`caption-${index}`)))
    const parsed = parseLearningDatasetJsonl(serializeLearningDatasetJsonl(built.samples))
    expect(parsed).toHaveLength(1000)
    expect(parsed[999]?.sampleKey).toBe(built.samples[999]?.sampleKey)
  })
})
