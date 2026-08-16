import type { PreviewPlanClip } from '../../shared/types'

export const PREVIEW_AUDIO_DRIFT_TOLERANCE_SECONDS = 0.12

export const previewAudioIsActive = (item: PreviewPlanClip, playheadUs: number): boolean =>
  item.enabled && item.startUs <= playheadUs && item.startUs + item.durationUs > playheadUs

export const previewAudioSourceTimeUs = (item: PreviewPlanClip, playheadUs: number): number =>
  item.sourceInUs + Math.max(0, playheadUs - item.startUs)

export const previewAudioVolume = (volumeDb = 0): number =>
  10 ** (Math.max(-96, Math.min(24, volumeDb)) / 20)

/**
 * Keep the audio DOM bounded during long silence-cut timelines. Every active
 * contribution is retained for mixing; only the next contribution per source
 * asset is prefetched so a sequential cut does not create one element per
 * segment.
 */
export const previewAudioClipsForPlayback = (clips: readonly PreviewPlanClip[], playheadUs: number): PreviewPlanClip[] => {
  const enabled = clips.filter((clip) => clip.enabled && clip.durationUs > 0 && clip.sourceMediaId)
  const active = enabled.filter((clip) => previewAudioIsActive(clip, playheadUs))
  const activeIds = new Set(active.map((clip) => clip.clipId))
  const nextByAsset = new Map<string, PreviewPlanClip>()
  for (const clip of enabled) {
    if (clip.startUs <= playheadUs || activeIds.has(clip.clipId) || !clip.sourceMediaId) continue
    const current = nextByAsset.get(clip.sourceMediaId)
    if (!current || clip.startUs < current.startUs) nextByAsset.set(clip.sourceMediaId, clip)
  }
  return [...active, ...nextByAsset.values()].sort((left, right) => left.startUs - right.startUs || left.clipId.localeCompare(right.clipId))
}
