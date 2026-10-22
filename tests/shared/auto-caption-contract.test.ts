import { describe, expect, it } from 'vitest'
import {
  AUTO_CAPTION_BASELINE_VERSION,
  AUTO_CAPTION_MAPPING_FORMULA,
  AUTO_CAPTION_REQUEST_VERSION,
  AUTO_CAPTION_RESULT_VERSION,
  createAutoCaptionBaseline,
  mapAutoCaptionSourceTimeToTimelineUs,
  parseAutoCaptionBaseline,
  parseAutoCaptionProgress,
  parseAutoCaptionRequest,
  parseAutoCaptionResult,
  parseResegmentRequest,
  parseResegmentResult,
  RESEGMENT_REQUEST_VERSION,
  RESEGMENT_RESULT_VERSION
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
  segmentationMode: 'rule',
  silenceCut: 'strong',
  accelerationMode: 'gpu',
  subtitleTemplate: 'high-contrast'
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
    expect(parseAutoCaptionRequest(request())).toMatchObject({ sourceStartUs: 10_000_000, sourceEndUs: 15_000_000, silenceCut: 'strong', accelerationMode: 'gpu', subtitleTemplate: 'high-contrast' })
    expect(() => parseAutoCaptionRequest({ ...request(), sourceStartUs: 1.5 })).toThrow()
    expect(() => parseAutoCaptionRequest({ ...request(), sourceEndUs: 10_000_000 })).toThrow()
    expect(parseAutoCaptionRequest({ ...request(), lineCapacity: 12 })).toMatchObject({ lineCapacity: 12 })
    expect(parseAutoCaptionRequest(request())).not.toHaveProperty('lineCapacity')
    expect(() => parseAutoCaptionRequest({ ...request(), lineCapacity: 0 })).toThrow()
  })

  it('rejects unsupported unified processing settings', () => {
    expect(() => parseAutoCaptionRequest({ ...request(), silenceCut: 'aggressive' })).toThrow()
    expect(() => parseAutoCaptionRequest({ ...request(), accelerationMode: 'fallback' })).toThrow()
    expect(() => parseAutoCaptionRequest({ ...request(), subtitleTemplate: '../unknown' })).toThrow()
  })

  it('accepts the YouTube jump-cut silence profile', () => {
    expect(parseAutoCaptionRequest({ ...request(), silenceCut: 'youtube' })).toMatchObject({ silenceCut: 'youtube' })
  })

  it('accepts additive measured or indeterminate progress metadata', () => {
    expect(parseAutoCaptionProgress({
      version: 'spectra.auto-caption.progress.v1', jobId: 'caption-job-1', state: 'transcribing', ratio: 0.42,
      progressMode: 'determinate', stageRatio: 0.5, message: 'Whisper'
    })).toMatchObject({ progressMode: 'determinate', stageRatio: 0.5 })
    expect(parseAutoCaptionProgress({
      version: 'spectra.auto-caption.progress.v1', jobId: 'caption-job-1', state: 'silence_analyzing', ratio: 0.70,
      progressMode: 'indeterminate', message: '無音解析'
    }).progressMode).toBe('indeterminate')
    expect(() => parseAutoCaptionProgress({
      version: 'spectra.auto-caption.progress.v1', jobId: 'caption-job-1', state: 'transcribing', ratio: 0.42,
      progressMode: 'determinate', stageRatio: 1.2, message: 'Whisper'
    })).toThrow()
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

describe('segmentation-only (resegment) contract', () => {
  const req = () => ({
    version: RESEGMENT_REQUEST_VERSION, jobId: 'rs-1', language: 'ja', maxChars: 24, maxLines: 2, lineCapacity: 12, segmentationMode: 'rule',
    words: [{ id: 'w0', text: '就職', startUs: 0, endUs: 500_000 }, { id: 'w1', text: '試験', startUs: 500_000, endUs: 900_000 }]
  })

  it('validates the request and rejects bad words', () => {
    expect(parseResegmentRequest(req())).toMatchObject({ lineCapacity: 12, words: [{ id: 'w0' }, { id: 'w1' }] })
    expect(() => parseResegmentRequest({ ...req(), words: [] })).toThrow()
    expect(() => parseResegmentRequest({ ...req(), words: [req().words[0], req().words[0]] })).toThrow()
    expect(() => parseResegmentRequest({ ...req(), mediaPath: 'x' })).toThrow()
  })

  it('requires the result to own every input word exactly once, in order', () => {
    const request = parseResegmentRequest(req())
    const caption = (id: string, ids: string[], startUs: number, endUs: number) => ({ id, text: 'x', startUs, endUs, sourceWordIds: ids, textStatus: 'as_transcribed' })
    const result = (captions: unknown[]) => ({ version: RESEGMENT_RESULT_VERSION, jobId: 'rs-1', method: 'rule', captions })
    expect(parseResegmentResult(result([caption('c1', ['w0'], 0, 500_000), caption('c2', ['w1'], 500_000, 900_000)]), request).captions).toHaveLength(2)
    expect(() => parseResegmentResult(result([caption('c1', ['w1'], 0, 500_000), caption('c2', ['w0'], 500_000, 900_000)]), request)).toThrow()
    expect(() => parseResegmentResult(result([caption('c1', ['w0'], 0, 500_000)]), request)).toThrow()
  })
})

describe('hidePunctuation option', () => {
  it('is accepted as a boolean on requests and rejected otherwise', async () => {
    const { parseAutoCaptionSettings } = await import('../../src/shared/auto-caption-contract')
    expect(parseAutoCaptionSettings({ language: 'ja', maxChars: 32, segmentationMode: 'auto', hidePunctuation: false }).hidePunctuation).toBe(false)
    expect(parseAutoCaptionSettings({ language: 'ja', maxChars: 32, segmentationMode: 'auto' }).hidePunctuation).toBeUndefined()
    expect(() => parseAutoCaptionSettings({ language: 'ja', maxChars: 32, segmentationMode: 'auto', hidePunctuation: 'yes' })).toThrow(/boolean/u)
  })

  it('counts a punctuation toggle as a re-segmenting change (absent means on)', async () => {
    const { captionSplitSettingsChanged } = await import('../../src/shared/caption-resegment')
    const base = { maxChars: 12, maxLines: 1, segmentationMode: 'auto', lineCapacity: 12 }
    expect(captionSplitSettingsChanged(base, { ...base, hidePunctuation: true })).toBe(false)
    expect(captionSplitSettingsChanged(base, { ...base, hidePunctuation: false })).toBe(true)
  })
})

describe('LLM caption writer text (ai_cleaned)', () => {
  it('treats deletion-only text as derived from its words, but not added or changed text', async () => {
    const { isCaptionDeletionDerived, isCaptionDisplayDerived } = await import('../../src/shared/caption-display-text')
    expect(isCaptionDeletionDerived('え、今日はえーと、フォートナイトを', '今日はフォートナイトを')).toBe(true)
    expect(isCaptionDisplayDerived('え、今日はえーと、フォートナイトを', '今日はフォートナイトを')).toBe(true)
    expect(isCaptionDeletionDerived('今日は晴れ', '今日は雨')).toBe(false)
    expect(isCaptionDeletionDerived('これはすごい', 'これはすごいね')).toBe(false)
    expect(isCaptionDeletionDerived('これ', '')).toBe(false)
  })

  it('keeps an ai_cleaned caption resegmentable while a rewritten one is not', async () => {
    const { isCaptionResegmentable } = await import('../../src/shared/caption-resegment')
    const clip = (text: string) => ({
      id: 'c', name: 'c', kind: 'subtitle' as const, text, startUs: 0, durationUs: 1_000_000, sourceInUs: 0, enabled: true,
      style: {} as never,
      words: [{ id: 'w1', text: 'えーと、', startUs: 0, endUs: 300_000 }, { id: 'w2', text: '今日は', startUs: 300_000, endUs: 1_000_000 }]
    })
    expect(isCaptionResegmentable(clip('今日は') as never)).toBe(true)
    expect(isCaptionResegmentable(clip('明日は') as never)).toBe(false)
  })

  it('keeps untouched ai_corrected text resegmentable, but not after a manual edit', async () => {
    const { isCaptionResegmentable } = await import('../../src/shared/caption-resegment')
    const clip = (text: string, aiText?: string) => ({
      id: 'c', name: 'c', kind: 'subtitle' as const, text, startUs: 0, durationUs: 1_000_000, sourceInUs: 0, enabled: true,
      style: {} as never,
      ...(aiText === undefined ? {} : { aiText }),
      words: [{ id: 'w1', text: '監視', startUs: 0, endUs: 300_000 }, { id: 'w2', text: 'は', startUs: 300_000, endUs: 1_000_000 }]
    })
    expect(isCaptionResegmentable(clip('看守は', '看守は') as never)).toBe(true)
    expect(isCaptionResegmentable(clip('看守がね', '看守は') as never)).toBe(false)
    expect(isCaptionResegmentable(clip('看守は') as never)).toBe(false)
  })
})
