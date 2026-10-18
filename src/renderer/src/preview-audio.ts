import type { PreviewPlan, PreviewPlanClip } from '../../shared/types'

export const PREVIEW_AUDIO_DRIFT_TOLERANCE_SECONDS = 0.12
const mediaSeekState = new WeakMap<object, { requestedAt: number; target: number; observedTarget: number }>()

/** Let an outstanding decoder seek finish before requesting a newer position. */
export const syncPreviewMediaTime = (media: Pick<HTMLMediaElement, 'currentTime' | 'readyState' | 'seeking'>, expectedSeconds: number): void => {
  const previous = mediaSeekState.get(media)
  const explicitSeek = previous && Math.abs(expectedSeconds - previous.observedTarget) > 0.5
  if (previous) previous.observedTarget = expectedSeconds
  if (media.readyState < 2 || media.seeking) return
  if (!Number.isFinite(media.currentTime) || Math.abs(media.currentTime - expectedSeconds) > PREVIEW_AUDIO_DRIFT_TOLERANCE_SECONDS) {
    const now = performance.now()
    // A completed seek can fire before the decoder presents its first sample.
    // Reissuing the same seek from seeked/loadeddata creates a feedback loop.
    if (previous && (previous.target === expectedSeconds || (!explicitSeek && now - previous.requestedAt < 500))) return
    mediaSeekState.set(media, { requestedAt: now, target: expectedSeconds, observedTarget: expectedSeconds })
    media.currentTime = Math.max(0, expectedSeconds)
  }
}

export const previewAudioIsActive = (item: PreviewPlanClip, playheadUs: number): boolean =>
  item.enabled && item.startUs <= playheadUs && item.startUs + item.durationUs > playheadUs

export const previewAudioSourceTimeUs = (item: PreviewPlanClip, playheadUs: number): number =>
  item.sourceInUs + Math.max(0, playheadUs - item.startUs)

type PlaybackClock = Pick<HTMLMediaElement, 'currentTime' | 'readyState' | 'seeking' | 'paused' | 'ended'>

/** Follow decoded media instead of repeatedly seeking it toward a wall clock. */
export const previewPlaybackTimeUs = (
  plan: PreviewPlan | null,
  playheadUs: number,
  elapsedUs: number,
  mediaFor: (clip: PreviewPlanClip, kind: 'audio' | 'video') => PlaybackClock | null | undefined
): number => {
  for (const kind of ['audio', 'video'] as const) {
    for (const clip of (kind === 'audio' ? plan?.audioClips : plan?.videoClips) ?? []) {
      if (!previewAudioIsActive(clip, playheadUs)) continue
      const media = mediaFor(clip, kind)
      // Images have no native playback clock. A missing media element is pending.
      if (media === undefined) continue
      if (!media || media.readyState < 2 || media.seeking || (media.paused && !media.ended)) return playheadUs
      if (media.ended) return clip.startUs + clip.durationUs
      const position = clip.startUs + Math.max(0, media.currentTime * 1_000_000 - clip.sourceInUs)
      return Math.max(playheadUs, Math.min(clip.startUs + clip.durationUs, position))
    }
  }
  return playheadUs + elapsedUs
}

export const previewAudioVolume = (volumeDb = 0): number =>
  10 ** (Math.max(-96, Math.min(24, volumeDb)) / 20)

/** Match Final's stereo channel attenuation, rather than equal-power panning. */
export const previewAudioChannelGains = (item: PreviewPlanClip, channels = 2): [number, number] => {
  const pan = Math.max(-1, Math.min(1, item.pan ?? 0))
  const volume = previewAudioVolume(item.volumeDb) * (channels === 1 ? Math.SQRT1_2 : 1)
  return [volume * (pan <= 0 ? 1 : 1 - pan), volume * (pan >= 0 ? 1 : 1 + pan)]
}

const scheduleFade = (parameter: AudioParam, contextTime: number, elapsed: number, duration: number, fade: number, incoming: boolean): void => {
  parameter.cancelScheduledValues(contextTime)
  if (fade <= 0) {
    parameter.setValueAtTime(1, contextTime)
    return
  }
  const start = incoming ? 0 : duration - fade
  const progress = Math.max(0, Math.min(1, (elapsed - start) / fade))
  parameter.setValueAtTime(incoming ? progress : 1 - progress, contextTime)
  if (elapsed < start) parameter.setValueAtTime(incoming ? 0 : 1, contextTime + start - elapsed)
  const end = start + fade
  if (elapsed < end) parameter.linearRampToValueAtTime(incoming ? 1 : 0, contextTime + end - elapsed)
}

/** One shared context, with a bounded graph for each currently mounted element. */
export class PreviewAudioMixer {
  private readonly graphs = new Map<HTMLAudioElement, { nodes: AudioNode[]; left: GainNode; right: GainNode; fadeIn: GainNode; fadeOut: GainNode }>()
  private readonly sources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>()

  constructor(private readonly context: AudioContext) {}

  update(audio: HTMLAudioElement, item: PreviewPlanClip, playheadUs: number, playing: boolean, channels = 2): void {
    let graph = this.graphs.get(audio)
    if (!graph) {
      const source = this.sources.get(audio) ?? this.context.createMediaElementSource(audio)
      this.sources.set(audio, source)
      const fadeIn = this.context.createGain()
      // FFmpeg aformat=channel_layouts=stereo upmixes mono before channel pan.
      fadeIn.channelCount = 2
      fadeIn.channelCountMode = 'explicit'
      const fadeOut = this.context.createGain()
      const splitter = this.context.createChannelSplitter(2)
      const left = this.context.createGain()
      const right = this.context.createGain()
      const merger = this.context.createChannelMerger(2)
      source.connect(fadeIn).connect(fadeOut).connect(splitter)
      splitter.connect(left, 0)
      splitter.connect(right, 1)
      left.connect(merger, 0, 0)
      right.connect(merger, 0, 1)
      merger.connect(this.context.destination)
      graph = { nodes: [source, fadeIn, fadeOut, splitter, left, right, merger], left, right, fadeIn, fadeOut }
      this.graphs.set(audio, graph)
      audio.volume = 1
    }
    const now = this.context.currentTime
    const [left, right] = previewAudioChannelGains(item, channels)
    graph.left.gain.setValueAtTime(left, now)
    graph.right.gain.setValueAtTime(right, now)
    const duration = item.durationUs / 1_000_000
    const elapsed = Math.max(0, Math.min(duration, (playheadUs - item.startUs) / 1_000_000))
    scheduleFade(graph.fadeIn.gain, now, elapsed, duration, Math.max(0, Math.min(duration, (item.fadeInUs ?? 0) / 1_000_000)), true)
    scheduleFade(graph.fadeOut.gain, now, elapsed, duration, Math.max(0, Math.min(duration, (item.fadeOutUs ?? 0) / 1_000_000)), false)
    if (playing && this.context.state === 'suspended') void this.context.resume().catch(() => undefined)
  }

  release(audio: HTMLAudioElement): void {
    audio.pause()
    this.graphs.get(audio)?.nodes.forEach((node) => node.disconnect())
    this.graphs.delete(audio)
  }

  dispose(): void {
    for (const audio of this.graphs.keys()) this.release(audio)
    void this.context.close().catch(() => undefined)
  }
}

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
