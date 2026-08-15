import { describe, expect, it } from 'vitest'
import {
  AUTO_CAPTION_BASELINE_VERSION,
  AUTO_CAPTION_MAPPING_FORMULA,
  AUTO_CAPTION_REQUEST_VERSION,
  AUTO_CAPTION_RESULT_VERSION,
  createAutoCaptionBaseline,
  mapAutoCaptionSourceTimeToTimelineUs,
  parseAutoCaptionBaseline,
  parseAutoCaptionRequest,
  parseAutoCaptionResult
} from '../../src/shared/auto-caption-contract.js'

const request = () => ({
  version: AUTO_CAPTION_REQUEST_VERSION,
  jobId: 'caption-job-1',
  mediaPath: 'C:\\media\\source.mp4',
  sourceStartUs: 10_000_000,
  sourceEndUs: 15_000_000,
  language: 'ja',
  maxChars: 32,
  maxLines: 2,
  segmentationMode: 'rule'
})

const result = () => ({
  version: AUTO_CAPTION_RESULT_VERSION,
  jobId: 'caption-job-1',
  sourceStartUs: 10_000_000,
  sourceEndUs: 15_000_000,
  language: 'ja',
  provider: 'faster-whisper',
  model: 'large-v3',
  rawWords: [
    { id: 'word-1', text: '字幕', startUs: 10_100_000, endUs: 10_300_000, confidence: 0.9 },
    { id: 'word-2', text: 'です', startUs: 10_400_000, endUs: 10_600_000 }
  ],
  captions: [{
    id: 'caption-1', text: '字幕です', sourceWordIds: ['word-1', 'word-2'], startUs: 10_100_000, endUs: 10_600_000,
    textStatus: 'as_transcribed', provenance: 'caption_algorithm'
  }],
  diagnostics: [],
  fallback: { used: false }
})

describe('auto-caption worker contract draft', () => {
  it('validates a range-scoped request with integer microseconds', () => {
    expect(parseAutoCaptionRequest(request())).toMatchObject({ sourceStartUs: 10_000_000, sourceEndUs: 15_000_000 })
    expect(() => parseAutoCaptionRequest({ ...request(), sourceStartUs: 1.5 })).toThrow()
    expect(() => parseAutoCaptionRequest({ ...request(), sourceEndUs: 10_000_000 })).toThrow()
  })

  it('validates word ownership, provenance, diagnostics, and fallback', () => {
    expect(parseAutoCaptionResult(result()).captions[0]?.sourceWordIds).toEqual(['word-1', 'word-2'])
    expect(() => parseAutoCaptionResult({ ...result(), captions: [{ ...result().captions[0], sourceWordIds: ['missing'] }] })).toThrow()
    expect(() => parseAutoCaptionResult({ ...result(), credentials: { token: 'secret' } })).toThrow()
    expect(() => parseAutoCaptionResult({ ...result(), rawWords: [{ ...result().rawWords[0], startUs: 9_999_999 }] })).toThrow()
  })

  it('keeps the selected source range in source time and maps it to timeline time', () => {
    const clip = { startUs: 2_000_000, sourceInUs: 10_000_000, durationUs: 5_000_000 }
    expect(mapAutoCaptionSourceTimeToTimelineUs(clip, 10_000_000)).toBe(2_000_000)
    expect(mapAutoCaptionSourceTimeToTimelineUs(clip, 12_500_000)).toBe(4_500_000)
    expect(() => mapAutoCaptionSourceTimeToTimelineUs(clip, 15_000_001)).toThrow()
  })

  it('creates a path-free immutable baseline payload', () => {
    const baseline = createAutoCaptionBaseline({
      result: parseAutoCaptionResult(result()),
      jobId: 'caption-job-1',
      createdAt: '2026-08-15T00:00:00.000Z',
      projectFingerprint: 'sha256:project',
      mediaFingerprint: 'sha256:media',
      sourceClip: { clipId: 'clip-1', assetId: 'asset-1', startUs: 2_000_000, sourceInUs: 10_000_000, durationUs: 5_000_000 },
      settings: { language: 'ja', maxChars: 32, maxLines: 2, segmentationMode: 'rule' }
    })
    expect(baseline).toMatchObject({ version: AUTO_CAPTION_BASELINE_VERSION, timelineMapping: { formula: AUTO_CAPTION_MAPPING_FORMULA } })
    expect(parseAutoCaptionBaseline(baseline)).toMatchObject({ version: AUTO_CAPTION_BASELINE_VERSION, jobId: 'caption-job-1' })
    expect(JSON.stringify(baseline)).not.toContain('mediaPath')
    expect(baseline.rawWords).not.toBe(parseAutoCaptionResult(result()).rawWords)
  })
})
