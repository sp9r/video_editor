import type { ProjectFile, TimeUs } from '../../shared/types'

export interface PreviewDiagnosticContext {
  sequence: { width: number; height: number; fps: number }
  media: { count: number; resolutions: Array<{ width: number; height: number }>; codecs: string[] }
  timeline: { clipCount: number; subtitleCount: number; trackCount: number }
  display: { cssWidth: number; cssHeight: number; devicePixelRatio: number; viewportWidth: number; viewportHeight: number }
  playheadUs: TimeUs
  playing: boolean
}

export interface PreviewDiagnosticReport {
  schemaVersion: 'spectra.preview-performance-diagnostic.v1'
  durationMs: number
  playback: {
    playingMs: number
    playheadStartUs: TimeUs
    playheadEndUs: TimeUs
    playheadAdvanceUs: TimeUs
    realtimeRatio: number | null
    droppedFrames: number | null
    totalVideoFrames: number | null
    playbackQualitySupported: boolean
  }
  renderer: {
    requestAnimationFrameCallbacks: number
    averageFrameIntervalMs: number | null
    maxFrameIntervalMs: number | null
    longFramesOver50Ms: number
    longFramesOver100Ms: number
  }
  react: {
    playheadUpdates: number
    projectStoreUpdates: number
    previewRenderCount: number
    timelineRenderCount: number
  }
  subtitle: {
    visualStateChanges: number
    overlayRequests: number
    overlayCacheHits: number
    overlayCacheMisses: number
    redundantSameSubtitleRequests: number
  }
  waveform: {
    requests: number
    cacheHits: number
    recalculations: number
    recalculationsDuringPlayback: number
  }
  accuratePreview: {
    requests: number
    requestsDuringPlayback: number
    cacheHits: number
    cacheMisses: number
    ffmpegStarts: number
    ffmpegStartsDuringPlayback: number
  }
  project: PreviewDiagnosticContext
  performance: {
    jsHeapUsedBytes: number | null
    jsHeapTotalBytes: number | null
  }
}

type Clock = () => number
type HeapSnapshot = () => { used: number; total: number } | null
type PlaybackQuality = { droppedVideoFrames: number; totalVideoFrames: number }

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

const readHeap = (): { used: number; total: number } | null => {
  if (typeof performance === 'undefined') return null
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory
  if (!memory || !Number.isFinite(memory.usedJSHeapSize) || !Number.isFinite(memory.totalJSHeapSize)) return null
  return { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize }
}

export const previewDiagnosticContext = (project: ProjectFile, display: Pick<PreviewDiagnosticContext['display'], 'cssWidth' | 'cssHeight' | 'viewportWidth' | 'viewportHeight'>, playheadUs: TimeUs, playing: boolean): PreviewDiagnosticContext => ({
  sequence: {
    width: project.sequence.width,
    height: project.sequence.height,
    fps: project.sequence.frameRate.denominator === 0 ? 0 : project.sequence.frameRate.numerator / project.sequence.frameRate.denominator
  },
  media: {
    count: project.media.length,
    resolutions: project.media.flatMap((asset) => asset.width && asset.height ? [{ width: asset.width, height: asset.height }] : []),
    codecs: []
  },
  timeline: {
    clipCount: project.tracks.reduce((count, track) => count + track.clips.length, 0),
    subtitleCount: project.tracks.filter((track) => track.kind === 'subtitle').reduce((count, track) => count + track.clips.filter((clip) => clip.kind === 'subtitle').length, 0),
    trackCount: project.tracks.length
  },
  display: {
    cssWidth: Math.max(0, Math.round(display.cssWidth)),
    cssHeight: Math.max(0, Math.round(display.cssHeight)),
    devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
    viewportWidth: Math.max(0, Math.round(display.viewportWidth)),
    viewportHeight: Math.max(0, Math.round(display.viewportHeight))
  },
  playheadUs,
  playing
})

export class PreviewDiagnosticSession {
  readonly #startedAt: number
  readonly #clock: Clock
  readonly #heap: HeapSnapshot
  #lastPlaying = false
  #playingStartedAt: number | null = null
  #playingMs = 0
  #lastFrameAt: number | null = null
  #frameIntervalTotal = 0
  #frameIntervalCount = 0
  #maxFrameInterval = 0
  #longFramesOver50 = 0
  #longFramesOver100 = 0
  #rafCallbacks = 0
  #playheadStartUs: TimeUs
  #playheadEndUs: TimeUs
  #playheadAdvanceUs = 0
  #lastPlayheadUs: TimeUs
  #droppedFrames: number | null = null
  #totalVideoFrames: number | null = null
  #playbackQualitySupported = false
  #playheadUpdates = 0
  #projectStoreUpdates = 0
  #previewRenderCount = 0
  #timelineRenderCount = 0
  #subtitleVisualStateChanges = 0
  #overlayRequests = 0
  #overlayCacheHits = 0
  #overlayCacheMisses = 0
  #redundantSameSubtitleRequests = 0
  #lastSubtitleVisualKey: string | null = null
  #lastOverlayRequestKey: string | null = null
  #waveformRequests = 0
  #waveformCacheHits = 0
  #waveformRecalculations = 0
  #waveformRecalculationsDuringPlayback = 0
  #accurateRequests = 0
  #accurateRequestsDuringPlayback = 0
  #accurateCacheHits = 0
  #accurateCacheMisses = 0
  #ffmpegStarts = 0
  #ffmpegStartsDuringPlayback = 0
  #accurateRequestPlaybackFlags: boolean[] = []
  #context: PreviewDiagnosticContext
  #heapStart: { used: number; total: number } | null
  #heapPeak: { used: number; total: number } | null

  constructor(context: PreviewDiagnosticContext, options: { clock?: Clock; heap?: HeapSnapshot } = {}) {
    this.#clock = options.clock ?? now
    this.#heap = options.heap ?? readHeap
    this.#startedAt = this.#clock()
    this.#context = context
    this.#playheadStartUs = context.playheadUs
    this.#playheadEndUs = context.playheadUs
    this.#lastPlayheadUs = context.playheadUs
    this.#heapStart = this.#heap()
    this.#heapPeak = this.#heapStart
    this.recordPlaybackState(context.playing, this.#startedAt)
  }

  updateContext(context: PreviewDiagnosticContext): void {
    this.#context = context
    this.recordPlaybackState(context.playing, this.#clock())
    this.#advancePlayhead(context.playheadUs)
  }

  recordPlaybackState(playing: boolean, timestamp = this.#clock()): void {
    if (playing === this.#lastPlaying) return
    if (this.#lastPlaying && this.#playingStartedAt !== null) this.#playingMs += Math.max(0, timestamp - this.#playingStartedAt)
    this.#lastPlaying = playing
    this.#playingStartedAt = playing ? timestamp : null
  }

  recordAnimationFrame(timestamp: number, playheadUs: TimeUs): void {
    this.#rafCallbacks += 1
    if (this.#lastFrameAt !== null) {
      const interval = Math.max(0, timestamp - this.#lastFrameAt)
      this.#frameIntervalTotal += interval
      this.#frameIntervalCount += 1
      this.#maxFrameInterval = Math.max(this.#maxFrameInterval, interval)
      if (interval > 50) this.#longFramesOver50 += 1
      if (interval > 100) this.#longFramesOver100 += 1
    }
    this.#lastFrameAt = timestamp
    this.#advancePlayhead(playheadUs)
    const heap = this.#heap()
    if (heap && (!this.#heapPeak || heap.used > this.#heapPeak.used || heap.total > this.#heapPeak.total)) this.#heapPeak = heap
  }

  recordPlayhead(playheadUs: TimeUs): void {
    this.#playheadUpdates += 1
    this.#advancePlayhead(playheadUs)
  }

  #advancePlayhead(playheadUs: TimeUs): void {
    if (playheadUs > this.#lastPlayheadUs) this.#playheadAdvanceUs += playheadUs - this.#lastPlayheadUs
    this.#lastPlayheadUs = playheadUs
    this.#playheadEndUs = playheadUs
  }

  recordStoreUpdate(playheadChanged: boolean, projectChanged: boolean, playing: boolean): void {
    if (playheadChanged) this.#playheadUpdates += 1
    if (projectChanged) this.#projectStoreUpdates += 1
    this.recordPlaybackState(playing)
  }

  recordComponentRender(component: 'preview' | 'timeline'): void {
    if (component === 'preview') this.#previewRenderCount += 1
    else this.#timelineRenderCount += 1
  }

  recordSubtitleVisualState(key: string): void {
    if (this.#lastSubtitleVisualKey === key) return
    this.#lastSubtitleVisualKey = key
    this.#subtitleVisualStateChanges += 1
  }

  recordSubtitleOverlayRequest(key: string): void {
    this.#overlayRequests += 1
    if (this.#lastOverlayRequestKey === key) this.#redundantSameSubtitleRequests += 1
    this.#lastOverlayRequestKey = key
  }

  recordSubtitleOverlayOutcome(cacheHit: boolean): void {
    if (cacheHit) this.#overlayCacheHits += 1
    else this.#overlayCacheMisses += 1
  }

  recordWaveformRequest(cacheHit: boolean): void {
    this.#waveformRequests += 1
    if (cacheHit) this.#waveformCacheHits += 1
    else {
      this.#waveformRecalculations += 1
      if (this.#lastPlaying) this.#waveformRecalculationsDuringPlayback += 1
    }
  }

  recordAccurateRequest(): void {
    this.#accurateRequests += 1
    const duringPlayback = this.#lastPlaying
    this.#accurateRequestPlaybackFlags.push(duringPlayback)
    if (duringPlayback) this.#accurateRequestsDuringPlayback += 1
  }

  recordAccurateOutcome(cacheHit: boolean, ffmpegStarted: boolean): void {
    if (cacheHit) this.#accurateCacheHits += 1
    else this.#accurateCacheMisses += 1
    const requestedDuringPlayback = this.#accurateRequestPlaybackFlags.shift() ?? this.#lastPlaying
    if (ffmpegStarted) {
      this.#ffmpegStarts += 1
      if (requestedDuringPlayback) this.#ffmpegStartsDuringPlayback += 1
    }
  }

  recordVideoPlaybackQuality(quality: PlaybackQuality | null): void {
    if (!quality || !Number.isFinite(quality.droppedVideoFrames) || !Number.isFinite(quality.totalVideoFrames)) return
    this.#playbackQualitySupported = true
    this.#droppedFrames = Math.max(this.#droppedFrames ?? 0, quality.droppedVideoFrames)
    this.#totalVideoFrames = Math.max(this.#totalVideoFrames ?? 0, quality.totalVideoFrames)
  }

  stop(context?: PreviewDiagnosticContext): PreviewDiagnosticReport {
    if (context) {
      this.#context = context
      this.#advancePlayhead(context.playheadUs)
    }
    const stoppedAt = this.#clock()
    this.recordPlaybackState(false, stoppedAt)
    const durationMs = Math.max(0, stoppedAt - this.#startedAt)
    const heapEnd = this.#heap()
    const heapCandidates = [this.#heapStart, this.#heapPeak, heapEnd].filter((value): value is { used: number; total: number } => value !== null)
    const heapUsed = heapCandidates.length ? Math.max(...heapCandidates.map((value) => value.used)) : null
    const heapTotal = heapCandidates.length ? Math.max(...heapCandidates.map((value) => value.total)) : null
    return {
      schemaVersion: 'spectra.preview-performance-diagnostic.v1',
      durationMs,
      playback: {
        playingMs: this.#playingMs,
        playheadStartUs: this.#playheadStartUs,
        playheadEndUs: this.#playheadEndUs,
        playheadAdvanceUs: this.#playheadAdvanceUs,
        realtimeRatio: this.#playingMs > 0 ? this.#playheadAdvanceUs / (this.#playingMs * 1_000) : null,
        droppedFrames: this.#droppedFrames,
        totalVideoFrames: this.#totalVideoFrames,
        playbackQualitySupported: this.#playbackQualitySupported
      },
      renderer: {
        requestAnimationFrameCallbacks: this.#rafCallbacks,
        averageFrameIntervalMs: this.#frameIntervalCount ? this.#frameIntervalTotal / this.#frameIntervalCount : null,
        maxFrameIntervalMs: this.#frameIntervalCount ? this.#maxFrameInterval : null,
        longFramesOver50Ms: this.#longFramesOver50,
        longFramesOver100Ms: this.#longFramesOver100
      },
      react: {
        playheadUpdates: this.#playheadUpdates,
        projectStoreUpdates: this.#projectStoreUpdates,
        previewRenderCount: this.#previewRenderCount,
        timelineRenderCount: this.#timelineRenderCount
      },
      subtitle: {
        visualStateChanges: this.#subtitleVisualStateChanges,
        overlayRequests: this.#overlayRequests,
        overlayCacheHits: this.#overlayCacheHits,
        overlayCacheMisses: this.#overlayCacheMisses,
        redundantSameSubtitleRequests: this.#redundantSameSubtitleRequests
      },
      waveform: {
        requests: this.#waveformRequests,
        cacheHits: this.#waveformCacheHits,
        recalculations: this.#waveformRecalculations,
        recalculationsDuringPlayback: this.#waveformRecalculationsDuringPlayback
      },
      accuratePreview: {
        requests: this.#accurateRequests,
        requestsDuringPlayback: this.#accurateRequestsDuringPlayback,
        cacheHits: this.#accurateCacheHits,
        cacheMisses: this.#accurateCacheMisses,
        ffmpegStarts: this.#ffmpegStarts,
        ffmpegStartsDuringPlayback: this.#ffmpegStartsDuringPlayback
      },
      project: this.#context,
      performance: { jsHeapUsedBytes: heapUsed, jsHeapTotalBytes: heapTotal }
    }
  }
}

interface PreviewDiagnosticSnapshot {
  active: boolean
  report: PreviewDiagnosticReport | null
}

const idleSnapshot: PreviewDiagnosticSnapshot = { active: false, report: null }
let snapshot = idleSnapshot
let session: PreviewDiagnosticSession | null = null
const listeners = new Set<() => void>()

const notify = (): void => listeners.forEach((listener) => listener())

export const previewDiagnosticStore = {
  getSnapshot: (): PreviewDiagnosticSnapshot => snapshot,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  start: (context: PreviewDiagnosticContext): boolean => {
    if (session) return false
    session = new PreviewDiagnosticSession(context)
    snapshot = { active: true, report: null }
    notify()
    return true
  },
  stop: (context?: PreviewDiagnosticContext): PreviewDiagnosticReport | null => {
    if (!session) return snapshot.report
    const report = session.stop(context)
    session = null
    snapshot = { active: false, report }
    notify()
    return report
  },
  updateContext: (context: PreviewDiagnosticContext): void => session?.updateContext(context),
  recordPlaybackState: (playing: boolean): void => session?.recordPlaybackState(playing),
  recordAnimationFrame: (timestamp: number, playheadUs: TimeUs): void => session?.recordAnimationFrame(timestamp, playheadUs),
  recordStoreUpdate: (playheadChanged: boolean, projectChanged: boolean, playing: boolean): void => session?.recordStoreUpdate(playheadChanged, projectChanged, playing),
  recordComponentRender: (component: 'preview' | 'timeline'): void => session?.recordComponentRender(component),
  recordSubtitleVisualState: (key: string): void => session?.recordSubtitleVisualState(key),
  recordSubtitleOverlayRequest: (key: string): void => session?.recordSubtitleOverlayRequest(key),
  recordSubtitleOverlayOutcome: (cacheHit: boolean): void => session?.recordSubtitleOverlayOutcome(cacheHit),
  recordWaveformRequest: (cacheHit: boolean): void => session?.recordWaveformRequest(cacheHit),
  recordAccurateRequest: (): void => session?.recordAccurateRequest(),
  recordAccurateOutcome: (cacheHit: boolean, ffmpegStarted: boolean): void => session?.recordAccurateOutcome(cacheHit, ffmpegStarted),
  recordVideoPlaybackQuality: (quality: PlaybackQuality | null): void => session?.recordVideoPlaybackQuality(quality)
}

export type { PreviewDiagnosticSnapshot }
