import { describe, expect, it } from 'vitest'
import { autoCaptionDisplayRatio, autoCaptionFailureStage, autoCaptionProgressMessage, autoCaptionProgressMode, autoCaptionProgressStage, autoCaptionStageLabel, describeAutoCaptionBackend, formatClockDurationUs, formatDurationUs, formatElapsedMs, silenceCutProfileLabel, captionLayoutHint, resolveCaptionLayoutLimits } from '../../src/shared/auto-caption-ui'
import type { AutoCaptionProgress, AutoCaptionResult } from '../../src/shared/auto-caption-contract'

const result = (diagnostics: AutoCaptionResult['diagnostics']): AutoCaptionResult => ({
  version: 'spectra.auto-caption.result.v1', jobId: 'job-ui', sourceStartUs: 0, sourceEndUs: 1_000_000,
  language: 'ja', provider: 'faster-whisper+caption.py', model: 'large-v3', rawWords: [], captions: [], diagnostics, fallback: { used: false }
})

describe('auto-caption product status helpers', () => {
  it('maps progress states to the visible Japanese stages', () => {
    expect(autoCaptionStageLabel(autoCaptionProgressStage({ state: 'preparing' }))).toBe('音声準備')
    expect(autoCaptionStageLabel(autoCaptionProgressStage({ state: 'transcribing' }))).toBe('文字起こし')
    expect(autoCaptionStageLabel(autoCaptionProgressStage({ state: 'silence_analyzing' }))).toBe('無音解析')
    expect(autoCaptionStageLabel(autoCaptionProgressStage({ state: 'segmenting' }))).toBe('字幕区切り')
    expect(autoCaptionStageLabel(autoCaptionProgressStage({ state: 'completed' }))).toBe('字幕配置')
  })

  it('identifies a silence failure without exposing a path', () => {
    const progress: Pick<AutoCaptionProgress, 'state' | 'errorCode' | 'diagnostics' | 'message'> = {
      state: 'failed', errorCode: 'WORKER_FAILED', message: '自動字幕を完了できませんでした。（silence_validation）',
      diagnostics: [{ level: 'error', code: 'AUTO_CAPTION_SILENCE_VALIDATION', message: 'failure phase=silence_validation; reason=ffmpeg failed' }]
    }
    expect(autoCaptionStageLabel(autoCaptionFailureStage(progress))).toBe('無音解析')
    expect(JSON.stringify(progress)).not.toContain('C:\\Users')
  })

  it('summarizes the path-free whisper backend and durations', () => {
    expect(describeAutoCaptionBackend(result([
      { level: 'info', code: 'WHISPER_DEVICE', message: 'device=cuda' },
      { level: 'info', code: 'WHISPER_COMPUTE_TYPE', message: 'computeType=float16' }
    ]))).toBe('CUDA / float16')
    expect(describeAutoCaptionBackend(result([]))).toBe('Whisper（backend情報なし）')
    expect(formatDurationUs(1_250_000)).toBe('1.25秒')
    expect(formatClockDurationUs(65_000_000)).toBe('1:05')
    expect(silenceCutProfileLabel('youtube')).toBe('YouTubeジャンプカット')
    expect(autoCaptionProgressMessage({ state: 'silence_analyzing' })).toBe('無音区間を検出しています…')
  })

  it('uses measured stage progress and never treats legacy active ratios as total progress', () => {
    expect(autoCaptionProgressMode({ state: 'transcribing' })).toBe('indeterminate')
    expect(autoCaptionProgressMode({ state: 'silence_analyzing', progressMode: 'indeterminate' })).toBe('indeterminate')
    expect(autoCaptionProgressMode({ state: 'transcribing', progressMode: 'determinate' })).toBe('determinate')
    expect(autoCaptionDisplayRatio({ ratio: 0.70, stageRatio: 0.42 })).toBe(0.42)
    expect(formatElapsedMs(65_400)).toBe('1:05')
    expect(formatElapsedMs(3_665_000)).toBe('1:01:05')
  })
})

describe('caption layout limits', () => {
  const style = { fontSize: 120, letterSpacing: 0, maxWidthPercent: 80 }

  it('limits maxChars to lineCapacity x maxLines and explains it', () => {
    const limits = resolveCaptionLayoutLimits({ maxChars: 32, maxLines: 2, style, sequenceWidth: 1920 })
    expect(limits).toMatchObject({ lineCapacity: 12, blockCapacity: 24, effectiveMaxChars: 24, layoutIsBinding: true, widthPercent: 80 })
    const hint = captionLayoutHint({ maxChars: 32, maxLines: 2, style, sequenceWidth: 1920 })
    expect(hint).toContain('1行に約12文字')
    expect(hint).toContain('2行で約24文字まで')
  })

  it('keeps the typed maxChars when it is the tighter limit and honours a width override', () => {
    expect(resolveCaptionLayoutLimits({ maxChars: 16, maxLines: 2, style, sequenceWidth: 1920 })).toMatchObject({ effectiveMaxChars: 16, layoutIsBinding: false })
    const wide = resolveCaptionLayoutLimits({ maxChars: 40, maxLines: 2, style, maxWidthPercent: 100, sequenceWidth: 1920 })
    expect(wide).toMatchObject({ lineCapacity: 16, effectiveMaxChars: 32, widthPercent: 100 })
  })

  it('stays inside the worker range 8..80', () => {
    expect(resolveCaptionLayoutLimits({ maxChars: 200, maxLines: 4, style: { ...style, fontSize: 20 }, sequenceWidth: 1920 }).effectiveMaxChars).toBe(80)
    expect(resolveCaptionLayoutLimits({ maxChars: 32, maxLines: 1, style: { ...style, fontSize: 400 }, sequenceWidth: 1920 }).effectiveMaxChars).toBe(8)
  })
})
