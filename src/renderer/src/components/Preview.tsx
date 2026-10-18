import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Maximize2, Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react'
import { formatTimecode, projectDurationUs, projectFingerprint } from '../../../shared/project'
import { visualLayerOrder, type VisualClip } from '../../../shared/render-order'
import { activeSubtitleClips, fastSubtitleAnimationStyle, subtitleVisualStateKey } from '../../../shared/subtitle-render'
import type { AccuratePreviewFrameResult, MediaAsset, PreviewPlan, PreviewPlanClip, SubtitleOverlayResult } from '../../../shared/types'
import { PreviewAudioMixer, previewAudioClipsForPlayback, previewAudioIsActive, previewAudioSourceTimeUs, previewPlaybackTimeUs, syncPreviewMediaTime } from '../preview-audio'
import { previewDiagnosticContext, previewDiagnosticStore } from '../preview-performance-diagnostics'
import { previewQualityLabel } from '../preview-status'
import { LatestSubtitleOverlayScheduler } from '../subtitle-overlay-scheduler'
import { useEditorStore } from '../store'
import { IconButton } from './Controls'

const activeAt = (clip: { startUs: number; durationUs: number; enabled: boolean }, timeUs: number): boolean =>
  clip.enabled && clip.startUs <= timeUs && clip.startUs + clip.durationUs > timeUs

const nextSubtitleVisualStates = (project: Parameters<typeof subtitleVisualStateKey>[0], timeUs: number): Array<{ timeUs: number; key: string }> => {
  const boundaries = project.tracks
    .filter((track) => track.kind === 'subtitle' && !track.hidden && !track.muted)
    .flatMap((track) => track.clips)
    .filter((clip) => clip.kind === 'subtitle' && clip.enabled)
    .flatMap((clip) => [clip.startUs, clip.startUs + clip.durationUs])
    .filter((boundary) => boundary > timeUs && boundary <= timeUs + 6_000_000)
    .sort((left, right) => left - right)
  const states: Array<{ timeUs: number; key: string }> = []
  let previous = subtitleVisualStateKey(project, timeUs)
  for (const boundary of boundaries) {
    const key = subtitleVisualStateKey(project, boundary)
    if (key === previous || !activeSubtitleClips(project, boundary).length) {
      previous = key
      continue
    }
    states.push({ timeUs: boundary, key })
    previous = key
    if (states.length >= 2) break
  }
  return states
}

export const accuratePreviewFrameMatchesCurrent = (
  frame: Pick<AccuratePreviewFrameResult, 'projectFingerprint' | 'requestedTimeUs'>,
  currentProjectFingerprint: string,
  currentPlayheadUs: number,
  frameDurationUs: number
): boolean => frame.projectFingerprint === currentProjectFingerprint
  && Math.abs(frame.requestedTimeUs - currentPlayheadUs) <= frameDurationUs

function PreviewVisual({
  clip,
  asset,
  mediaSource,
  playheadUs,
  playing,
  onSelect,
  onPlaybackError
}: {
  clip: VisualClip
  asset?: MediaAsset
  mediaSource: string | null
  playheadUs: number
  playing: boolean
  onSelect: () => void
  onPlaybackError: (name: string) => void
}): React.JSX.Element {
  const mediaRef = useRef<HTMLVideoElement | null>(null)
  const [mediaReadyGeneration, setMediaReadyGeneration] = useState(0)
  useEffect(() => {
    if (clip.kind !== 'video' || !mediaRef.current || !mediaSource) return
    const media = mediaRef.current
    const expectedSeconds = (clip.sourceInUs + Math.max(0, playheadUs - clip.startUs)) / 1_000_000
    syncPreviewMediaTime(media, expectedSeconds)
    if (playing) { if (media.paused) void media.play().catch((error: unknown) => {
      if (media.error || (error instanceof DOMException && error.name === 'NotAllowedError')) onPlaybackError(asset?.name ?? clip.name)
    }) }
    else media.pause()
  }, [clip, mediaSource, playheadUs, playing, mediaReadyGeneration, asset?.name, onPlaybackError])

  return (
    <button
      type="button"
      className="preview-visual"
      onClick={onSelect}
      style={{
        transform: `translate(${clip.transform.positionX}px, ${clip.transform.positionY}px) rotate(${clip.transform.rotation}deg) scale(${clip.transform.scale})`,
        opacity: clip.transform.opacity,
        clipPath: `inset(${clip.transform.crop.top * 100}% ${clip.transform.crop.right * 100}% ${clip.transform.crop.bottom * 100}% ${clip.transform.crop.left * 100}%)`
      }}
      aria-label={`${clip.name}を選択`}
    >
      {mediaSource && asset?.kind === 'video' ? (
        <video
          ref={mediaRef}
          key={asset.id}
          className="preview-media"
          data-clip-id={clip.id}
          src={mediaSource}
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={() => setMediaReadyGeneration((generation) => generation + 1)}
          onLoadedData={() => setMediaReadyGeneration((generation) => generation + 1)}
          onSeeked={() => setMediaReadyGeneration((generation) => generation + 1)}
          onError={() => onPlaybackError(asset?.name ?? clip.name)}
          aria-label={asset.name}
        />
      ) : mediaSource && asset?.kind === 'image' ? (
        <img className="preview-media" src={mediaSource} alt={asset.name} />
      ) : (
        <span className="preview-visual-placeholder">{asset?.name ?? clip.name}</span>
      )}
    </button>
  )
}

function PreviewAudio({
  item,
  asset,
  elementRef,
  onMediaReady
}: {
  item: PreviewPlanClip
  asset?: MediaAsset
  elementRef: (clipId: string, element: HTMLAudioElement | null) => void
  onMediaReady: () => void
}): React.JSX.Element | null {
  const ref = useCallback((element: HTMLAudioElement | null) => elementRef(item.clipId, element), [elementRef, item.clipId])
  if (!asset || asset.offline || !window.spectra) return null
  return <audio ref={ref} data-clip-id={item.clipId} crossOrigin="anonymous" src={window.spectra.mediaUrl(asset.path)} preload="auto" onLoadedMetadata={onMediaReady} onLoadedData={onMediaReady} onSeeked={onMediaReady} onPause={onMediaReady} />
}

function PreviewDiagnosticControls({ project, playheadUs, playing, viewportSize }: { project: Parameters<typeof previewDiagnosticContext>[0]; playheadUs: number; playing: boolean; viewportSize: { width: number; height: number } }): React.JSX.Element {
  const state = useSyncExternalStore(previewDiagnosticStore.subscribe, previewDiagnosticStore.getSnapshot, previewDiagnosticStore.getSnapshot)
  const currentContext = (): ReturnType<typeof previewDiagnosticContext> => previewDiagnosticContext(project, {
    cssWidth: viewportSize.width,
    cssHeight: viewportSize.height,
    viewportWidth: typeof window === 'undefined' ? 0 : window.innerWidth,
    viewportHeight: typeof window === 'undefined' ? 0 : window.innerHeight
  }, playheadUs, playing)
  const copyReport = (): void => {
    if (!state.report || typeof navigator === 'undefined' || !navigator.clipboard) return
    void navigator.clipboard.writeText(JSON.stringify(state.report, null, 2)).catch(() => undefined)
  }
  const reportText = state.report ? JSON.stringify(state.report, null, 2) : ''
  return (
    <div className="preview-diagnostic-controls">
      <button
        type="button"
        className="preview-diagnostic-button"
        aria-label={state.active ? 'Preview診断を停止' : 'Preview診断を開始'}
        onClick={() => state.active ? previewDiagnosticStore.stop(currentContext()) : previewDiagnosticStore.start(currentContext())}
      >
        {state.active ? 'Preview診断を停止' : 'Preview診断を開始'}
      </button>
      {state.report && (
        <details className="preview-diagnostic-result" open>
          <summary>診断結果</summary>
          <pre>{reportText}</pre>
          <button type="button" className="preview-diagnostic-copy" onClick={copyReport}>診断結果をコピー</button>
        </details>
      )}
    </div>
  )
}

export default function Preview(): React.JSX.Element {
  const { project, playheadUs, setPlayhead, playing, setPlaying, selectClip, showNotice } = useEditorStore()
  previewDiagnosticStore.recordComponentRender('preview')
  const [renderPlan, setRenderPlan] = useState<PreviewPlan | null>(null)
  const [accurateFrame, setAccurateFrame] = useState<AccuratePreviewFrameResult | null>(null)
  const [fastSubtitleOverlay, setFastSubtitleOverlay] = useState<(SubtitleOverlayResult & { visualStateKey: string }) | null>(null)
  const [fastAnimatedApproximate, setFastAnimatedApproximate] = useState(false)
  const [accurateRendering, setAccurateRendering] = useState(false)
  const [accurateError, setAccurateError] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const requestRef = useRef<number | null>(null)
  const lastFrameRef = useRef<number>(0)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const audioRefs = useRef(new Map<string, HTMLAudioElement>())
  const audioMixer = useRef<PreviewAudioMixer | null>(null)
  const audioLifetime = useRef(0)
  const [audioReadyGeneration, setAudioReadyGeneration] = useState(0)
  const onAudioReady = useCallback(() => setAudioReadyGeneration((generation) => generation + 1), [])
  const audioPlayAttempted = useRef(new Set<string>())
  const accurateRequestSequence = useRef(0)
  const fastRequestSequence = useRef(0)
  const previousPlayheadUs = useRef<number | null>(null)
  const [seekGeneration, setSeekGeneration] = useState(0)
  const onPlaybackError = useCallback((name: string): void => {
    setPlaying(false)
    showNotice(`「${name}」をプレビューで再生できませんでした。素材の形式とファイルを確認してください。`, 'warning')
  }, [setPlaying, showNotice])
  const fastOverlayScheduler = useRef(new LatestSubtitleOverlayScheduler<SubtitleOverlayResult>(40))
  const durationUs = Math.max(renderPlan?.durationUs ?? projectDurationUs(project), 1_000_000)

  useEffect(() => {
    const generation = ++audioLifetime.current
    return () => {
      // StrictMode immediately sets the effect up again with the same DOM.
      queueMicrotask(() => {
        if (audioLifetime.current !== generation) return
        audioMixer.current?.dispose()
        audioMixer.current = null
      })
    }
  }, [])

  const activeSubtitleStateKey = useMemo(() => subtitleVisualStateKey(project, playheadUs), [playheadUs, project])

  useEffect(() => {
    previewDiagnosticStore.recordSubtitleVisualState(activeSubtitleStateKey)
  }, [activeSubtitleStateKey])

  useEffect(() => {
    const onFullscreenChange = (): void => setFullscreen(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  const toggleFullscreen = (): void => {
    const panel = canvasRef.current?.closest('.viewer-panel') as HTMLElement | null
    if (!panel) return
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => showNotice('全画面表示を終了できませんでした。', 'warning'))
      return
    }
    if (typeof panel.requestFullscreen !== 'function') {
      showNotice('全画面表示はこの環境で利用できません。', 'warning')
      return
    }
    void panel.requestFullscreen().catch(() => showNotice('全画面表示を開始できませんでした。', 'warning'))
  }

  useEffect(() => {
    const previous = previousPlayheadUs.current
    if (playing && previous !== null && Math.abs(playheadUs - previous) > 500_000) setSeekGeneration((generation) => generation + 1)
    previousPlayheadUs.current = playheadUs
  }, [playheadUs, playing])

  useEffect(() => {
    if (!window.spectra) {
      setRenderPlan(null)
      return
    }
    setRenderPlan(null)
    setAccurateFrame(null)
    let active = true
    void window.spectra.createPreviewPlan(project)
      .then((plan) => { if (active) setRenderPlan(plan) })
      .catch((error: unknown) => {
        if (!active) return
        setRenderPlan(null)
        setAccurateRendering(false)
        setAccurateError(error instanceof Error ? error.message : 'プレビューの準備に失敗しました')
      })
    return () => { active = false }
  }, [project])

  useEffect(() => {
    const sequence = ++fastRequestSequence.current
    const scheduler = fastOverlayScheduler.current
    scheduler.cancel()
    setFastSubtitleOverlay(null)
    setFastAnimatedApproximate(false)
    if (!playing || !window.spectra || !activeSubtitleClips(project, playheadUs).length) return
    const api = window.spectra
    const currentKey = activeSubtitleStateKey
    const request = (timeUs: number, key: string, prefetch: boolean): void => {
      const run = (): Promise<SubtitleOverlayResult> => {
        previewDiagnosticStore.recordSubtitleOverlayRequest(key)
        return api.renderSubtitleOverlay(project, timeUs, { animationMode: 'base' })
      }
      const onCommit = (result: SubtitleOverlayResult): void => {
        previewDiagnosticStore.recordSubtitleOverlayOutcome(result.cacheHit ?? !result.ffmpegStarted)
        const current = useEditorStore.getState()
        if (sequence !== fastRequestSequence.current || !current.playing || subtitleVisualStateKey(current.project, current.playheadUs) !== key) return
        setFastSubtitleOverlay({ ...result, visualStateKey: key })
        setFastAnimatedApproximate(activeSubtitleClips(current.project, current.playheadUs).some(({ clip }) => clip.style.animation !== 'none'))
      }
      const onError = (error: unknown): void => {
        if (!prefetch && sequence === fastRequestSequence.current) setFastSubtitleOverlay(null)
        if (!prefetch) previewDiagnosticStore.recordSubtitleOverlayOutcome(false)
        void error
      }
      const item = { key, run, onCommit, onError }
      if (prefetch) scheduler.schedulePrefetch(item)
      else scheduler.schedule(item)
    }
    request(playheadUs, currentKey, false)
    for (const next of nextSubtitleVisualStates(project, playheadUs)) request(next.timeUs, next.key, true)
    return () => {
      fastRequestSequence.current += 1
      scheduler.cancel()
    }
  }, [activeSubtitleStateKey, playing, project, seekGeneration])

  useEffect(() => {
    const sequence = ++accurateRequestSequence.current
    setAccurateError(null)
    if (playing || !window.spectra) {
      setAccurateRendering(false)
      return
    }
    setAccurateRendering(true)
    // createPreviewPlan clears the previous project's frame workspace. Wait
    // until it completes, otherwise a reload can invalidate its own new frame.
    if (!renderPlan) return
    const api = window.spectra
    const timeout = window.setTimeout(() => {
      if (!api) return
      previewDiagnosticStore.recordAccurateRequest()
      void api.renderAccuratePreviewFrame(project, playheadUs)
        .then((result) => {
          previewDiagnosticStore.recordAccurateOutcome(result.cacheHit ?? !result.ffmpegStarted, Boolean(result.ffmpegStarted))
          const current = useEditorStore.getState()
          const frameDurationUs = Math.ceil(1_000_000 * current.project.sequence.frameRate.denominator / current.project.sequence.frameRate.numerator)
          if (sequence !== accurateRequestSequence.current
            || current.playing
            || !accuratePreviewFrameMatchesCurrent(result, projectFingerprint(current.project), current.playheadUs, frameDurationUs)) return
          setAccurateFrame(result)
          setAccurateRendering(false)
        })
        .catch((error: unknown) => {
          if (sequence !== accurateRequestSequence.current || useEditorStore.getState().playing) return
          setAccurateRendering(false)
          setAccurateError(error instanceof Error ? error.message : '正確プレビューを生成できませんでした')
        })
    }, 180)
    return () => window.clearTimeout(timeout)
  }, [playheadUs, playing, project, renderPlan])

  useLayoutEffect(() => {
    const element = canvasRef.current
    if (!element) return
    const update = (): void => setViewportSize({ width: element.clientWidth, height: element.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    previewDiagnosticStore.updateContext(previewDiagnosticContext(project, {
      cssWidth: viewportSize.width,
      cssHeight: viewportSize.height,
      viewportWidth: typeof window === 'undefined' ? 0 : window.innerWidth,
      viewportHeight: typeof window === 'undefined' ? 0 : window.innerHeight
    }, playheadUs, playing))
  }, [playing, project, viewportSize.height, viewportSize.width])

  useEffect(() => {
    if (!playing) {
      if (requestRef.current !== null) cancelAnimationFrame(requestRef.current)
      lastFrameRef.current = 0
      return
    }
    const tick = (timestamp: number): void => {
      if (!lastFrameRef.current) lastFrameRef.current = timestamp
      const elapsedUs = (timestamp - lastFrameRef.current) * 1000
      lastFrameRef.current = timestamp
      const state = useEditorStore.getState()
      if (!state.playing) {
        lastFrameRef.current = 0
        requestRef.current = null
        return
      }
      const next = previewPlaybackTimeUs(renderPlan, state.playheadUs, elapsedUs, (item, kind) => {
        if (kind === 'audio') return audioRefs.current.get(item.clipId) ?? null
        const asset = state.project.media.find((asset) => asset.id === item.sourceMediaId)
        if (asset?.kind !== 'video') return undefined
        return Array.from(canvasRef.current?.querySelectorAll('video') ?? []).find((video) => video.dataset.clipId === item.clipId) ?? null
      })
      previewDiagnosticStore.recordAnimationFrame(timestamp, next)
      if (previewDiagnosticStore.getSnapshot().active) {
        const videos = canvasRef.current?.querySelectorAll('video') ?? []
        for (const video of videos) {
          const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null
          previewDiagnosticStore.recordVideoPlaybackQuality(quality ? {
            droppedVideoFrames: quality.droppedVideoFrames,
            totalVideoFrames: quality.totalVideoFrames
          } : null)
        }
      }
      if (next >= Math.max(renderPlan?.durationUs ?? projectDurationUs(state.project), 1_000_000)) {
        state.setPlayhead(0)
        state.setPlaying(false)
        return
      }
      state.setPlayhead(next)
      requestRef.current = requestAnimationFrame(tick)
    }
    requestRef.current = requestAnimationFrame(tick)
    return () => {
      if (requestRef.current !== null) cancelAnimationFrame(requestRef.current)
      lastFrameRef.current = 0
    }
  }, [playing, renderPlan])

  const plannedVideoIds = renderPlan ? new Set(renderPlan.videoClips.map((clip) => clip.clipId)) : null
  const visuals = useMemo(() => visualLayerOrder(project)
    .map(({ clip }) => clip)
    .filter((clip) => activeAt(clip, playheadUs) && (!plannedVideoIds || plannedVideoIds.has(clip.id))), [playheadUs, plannedVideoIds, project])
  const currentProjectFingerprint = useMemo(() => projectFingerprint(project), [project])
  const accurateFrameMatchesCurrent = Boolean(accurateFrame && accuratePreviewFrameMatchesCurrent(
    accurateFrame,
    currentProjectFingerprint,
    playheadUs,
    Math.ceil(1_000_000 * project.sequence.frameRate.denominator / project.sequence.frameRate.numerator)
  ))
  const previewAudioClips = useMemo(() => previewAudioClipsForPlayback(renderPlan?.audioClips ?? [], playheadUs), [playheadUs, renderPlan])
  const scale = viewportSize.width > 0 && viewportSize.height > 0
    ? Math.min(viewportSize.width / project.sequence.width, viewportSize.height / project.sequence.height)
    : 1
  const fastAnimationStyle = useMemo(() => {
    const active = activeSubtitleClips(project, playheadUs).find(({ clip }) => clip.style.animation !== 'none')?.clip
    return active ? fastSubtitleAnimationStyle(active, playheadUs) : { opacity: 1, transform: 'none' }
  }, [playheadUs, project])

  useEffect(() => {
    const activeIds = new Set<string>()
    for (const item of previewAudioClips) {
      const audio = audioRefs.current.get(item.clipId)
      if (!audio) continue
      const asset = item.sourceMediaId ? project.media.find((media) => media.id === item.sourceMediaId) : undefined
      if (!asset || asset.offline) continue
      if (!audioMixer.current && playing) audioMixer.current = new PreviewAudioMixer(new AudioContext())
      audioMixer.current?.update(audio, item, playheadUs, playing, asset.channels)
      const active = previewAudioIsActive(item, playheadUs)
      if (!active) {
        audio.pause()
        audioPlayAttempted.current.delete(item.clipId)
        continue
      }
      activeIds.add(item.clipId)
      const expectedSeconds = previewAudioSourceTimeUs(item, playheadUs) / 1_000_000
      syncPreviewMediaTime(audio, expectedSeconds)
      if (!playing) {
        audio.pause()
        audioPlayAttempted.current.delete(item.clipId)
      } else if (audio.paused && !audioPlayAttempted.current.has(item.clipId)) {
        audioPlayAttempted.current.add(item.clipId)
        void audio.play().catch((error: unknown) => {
          if (audioRefs.current.get(item.clipId) !== audio) return
          audioPlayAttempted.current.delete(item.clipId)
          if (audio.error || (error instanceof DOMException && error.name === 'NotAllowedError')) {
            setPlaying(false)
            showNotice('音声を再生できませんでした。素材の形式とファイルを確認してください。', 'warning')
          }
        }).finally(() => {
          if (audioRefs.current.get(item.clipId) === audio) audioPlayAttempted.current.delete(item.clipId)
        })
      }
    }
    for (const [clipId, audio] of audioRefs.current) {
      if (!activeIds.has(clipId)) {
        audio.pause()
        audioPlayAttempted.current.delete(clipId)
      }
    }
  }, [playheadUs, playing, previewAudioClips, project, audioReadyGeneration, setPlaying, showNotice])

  const setAudioRef = useCallback((clipId: string, element: HTMLAudioElement | null): void => {
    if (element) audioRefs.current.set(clipId, element)
    else {
      const previous = audioRefs.current.get(clipId)
      if (previous) audioMixer.current?.release(previous)
      audioRefs.current.delete(clipId)
      audioPlayAttempted.current.delete(clipId)
    }
  }, [])

  return (
    <section className="viewer-panel panel" aria-label="プログラムモニター">
      <header className="viewer-tabs">
        <span className="viewer-tab is-active">完成映像</span>
        <span className="viewer-quality" aria-live="polite">
          <i />{previewQualityLabel({ playing, accurateFrameMatchesCurrent, accurateRendering, accurateError })}
          {accurateError && <small className="preview-accurate-error" title={accurateError}>取得失敗</small>}
        </span>
        <PreviewDiagnosticControls project={project} playheadUs={playheadUs} playing={playing} viewportSize={viewportSize} />
      </header>
      <div className="viewer-stage">
        <div ref={canvasRef} className="viewer-canvas" data-playhead-us={playheadUs} data-playing={playing ? 'true' : 'false'} style={{ background: project.sequence.backgroundColor, aspectRatio: `${project.sequence.width} / ${project.sequence.height}` }}>
          <div
            className="preview-scene"
            style={{
              width: project.sequence.width,
              height: project.sequence.height,
              transform: `translate(-50%, -50%) scale(${scale})`
            }}
          >
            {visuals.map((clip) => {
              const asset = 'assetId' in clip ? project.media.find((item) => item.id === clip.assetId) : undefined
              const mediaSource = asset && !asset.offline && window.spectra ? window.spectra.mediaUrl(asset.path) : null
              const visualKey = 'assetId' in clip && asset?.kind === 'video' ? `video:${asset.id}` : `visual:${clip.id}`
              return <PreviewVisual key={visualKey} clip={clip} asset={asset} mediaSource={mediaSource} playheadUs={playheadUs} playing={playing} onSelect={() => selectClip(clip.id)} onPlaybackError={onPlaybackError} />
            })}
            {visuals.length === 0 && <div className="viewer-placeholder"><Play size={34} /><span>再生位置に映像がありません</span></div>}
            <div className="safe-guides" aria-hidden="true"><i /></div>
            {playing && fastSubtitleOverlay && fastSubtitleOverlay.visualStateKey === activeSubtitleStateKey && window.spectra && (
              <img
                className="fast-authoritative-subtitle-overlay"
                data-subtitle-authority="libass"
                data-fast-animation-approximate={fastAnimatedApproximate ? 'true' : 'false'}
                data-subtitle-visual-key={fastSubtitleOverlay.subtitleStateFingerprint}
                src={window.spectra.mediaUrl(fastSubtitleOverlay.framePath)}
                alt=""
                draggable={false}
                style={fastAnimatedApproximate ? fastAnimationStyle : undefined}
              />
            )}
            {!playing && accurateFrameMatchesCurrent && accurateFrame && window.spectra && (
              <img
                className="accurate-preview-overlay"
                src={window.spectra.mediaUrl(accurateFrame.framePath)}
                alt=""
                draggable={false}
              />
            )}
          </div>
          <div className="preview-audio-pool" aria-hidden="true">
            {previewAudioClips.map((item) => (
              <PreviewAudio
                key={item.clipId}
                item={item}
                asset={item.sourceMediaId ? project.media.find((asset) => asset.id === item.sourceMediaId) : undefined}
                elementRef={setAudioRef}
                onMediaReady={onAudioReady}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="transport">
        <code>{formatTimecode(playheadUs, project)}</code>
        <div className="transport-buttons">
          <IconButton label="1フレーム戻る（←）" onClick={() => setPlayhead(Math.max(0, playheadUs - 1_000_000 / 30))}><SkipBack size={17} /></IconButton>
          <IconButton label={playing ? '停止（Space）' : '再生（Space）'} className="play-button" onClick={() => setPlaying(!playing)}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</IconButton>
          <IconButton label="1フレーム進む（→）" onClick={() => setPlayhead(Math.min(durationUs, playheadUs + 1_000_000 / 30))}><SkipForward size={17} /></IconButton>
        </div>
        <div className="transport-right">
          <Volume2 size={15} />
          <span className="audio-meter"><i /><i /></span>
          <IconButton label={fullscreen ? '全画面表示を終了' : '全画面表示'} onClick={toggleFullscreen}><Maximize2 size={16} /></IconButton>
        </div>
      </div>
    </section>
  )
}
