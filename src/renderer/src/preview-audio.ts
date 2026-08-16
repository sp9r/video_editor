import type { PreviewPlanClip } from '../../shared/types'

export const PREVIEW_AUDIO_DRIFT_TOLERANCE_SECONDS = 0.12

export const previewAudioIsActive = (item: PreviewPlanClip, playheadUs: number): boolean =>
  item.enabled && item.startUs <= playheadUs && item.startUs + item.durationUs > playheadUs

export const previewAudioSourceTimeUs = (item: PreviewPlanClip, playheadUs: number): number =>
  item.sourceInUs + Math.max(0, playheadUs - item.startUs)

export const previewAudioVolume = (volumeDb = 0): number =>
  10 ** (Math.max(-96, Math.min(24, volumeDb)) / 20)
