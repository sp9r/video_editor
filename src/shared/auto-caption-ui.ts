import type { AutoCaptionProgress, AutoCaptionResult } from './auto-caption-contract.js'

export type AutoCaptionUiStage = 'preparing' | 'transcribing' | 'silence' | 'segmenting' | 'applying' | 'failed'

export const autoCaptionStageLabel = (stage: AutoCaptionUiStage): string => {
  switch (stage) {
    case 'preparing': return '音声準備'
    case 'transcribing': return '文字起こし'
    case 'silence': return '無音解析'
    case 'segmenting': return '字幕区切り'
    case 'applying': return '字幕配置'
    case 'failed': return '自動処理'
  }
}

export const autoCaptionProgressMessage = (progress: Pick<AutoCaptionProgress, 'state' | 'errorCode'>): string => {
  switch (progress.state) {
    case 'preparing': return '音声を準備しています…'
    case 'transcribing': return 'Whisperで文字起こししています…'
    case 'silence_analyzing': return '無音区間を検出しています…'
    case 'segmenting': return '字幕を区切っています…'
    case 'completed': return '字幕をTimelineへ配置しています…'
    case 'failed': return progress.errorCode === 'CANCELLED' ? '自動処理をキャンセルしました。' : '自動処理に失敗しました。詳細は失敗ステージを確認してください。'
  }
}

export const silenceCutProfileLabel = (profile: string | undefined): string => {
  switch (profile) {
    case 'natural': return 'Natural（自然）'
    case 'strong': return 'Strong（強め）'
    case 'youtube': return 'YouTubeジャンプカット'
    case 'off': return 'OFF'
    default: return profile ?? '未実行'
  }
}

export const formatClockDurationUs = (durationUs: number): string => {
  const totalSeconds = Math.max(0, Math.round(durationUs / 1_000_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`
}

export const autoCaptionProgressStage = (progress: Pick<AutoCaptionProgress, 'state'>): AutoCaptionUiStage => {
  switch (progress.state) {
    case 'preparing': return 'preparing'
    case 'transcribing': return 'transcribing'
    case 'silence_analyzing': return 'silence'
    case 'segmenting': return 'segmenting'
    case 'completed': return 'applying'
    case 'failed': return 'failed'
  }
}

/** Resolve the most useful user-facing stage from a path-free failure diagnostic. */
export const autoCaptionFailureStage = (progress: Pick<AutoCaptionProgress, 'state' | 'errorCode' | 'diagnostics' | 'message'>): AutoCaptionUiStage => {
  const evidence = [progress.errorCode ?? '', progress.message, ...(progress.diagnostics ?? []).map((item) => `${item.code} ${item.message}`)].join(' ').toLowerCase()
  if (evidence.includes('silence') || evidence.includes('無音')) return 'silence'
  if (evidence.includes('segment') || evidence.includes('caption') || evidence.includes('字幕')) return 'segmenting'
  if (evidence.includes('result') || evidence.includes('baseline') || evidence.includes('apply') || evidence.includes('適用')) return 'applying'
  if (evidence.includes('transcrib') || evidence.includes('whisper') || evidence.includes('文字起こし')) return 'transcribing'
  return 'preparing'
}

const diagnosticValue = (result: AutoCaptionResult, code: string, prefix: string): string | undefined => {
  const diagnostic = result.diagnostics.find((item) => item.code === code)
  if (!diagnostic || !diagnostic.message.startsWith(prefix)) return undefined
  const value = diagnostic.message.slice(prefix.length).trim()
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : undefined
}

/** Keep the success summary useful without exposing worker paths or credentials. */
export const describeAutoCaptionBackend = (result: AutoCaptionResult): string => {
  const device = diagnosticValue(result, 'WHISPER_DEVICE', 'device=')
  const computeType = diagnosticValue(result, 'WHISPER_COMPUTE_TYPE', 'computeType=')
  if (device) return `${device === 'cuda' ? 'CUDA' : device === 'cpu' ? 'CPU' : device}${computeType ? ` / ${computeType}` : ''}`
  return result.provider === 'faster-whisper+caption.py' ? 'Whisper（backend情報なし）' : 'Whisper'
}

export const formatDurationUs = (durationUs: number): string => `${(durationUs / 1_000_000).toFixed(2)}秒`
