import { describe, expect, it } from 'vitest'
import { autoCaptionFailureStage, autoCaptionProgressStage, autoCaptionStageLabel, describeAutoCaptionBackend, formatDurationUs } from '../../src/shared/auto-caption-ui'
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
  })
})
