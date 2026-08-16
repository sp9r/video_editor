import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Maximize2, Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react'
import { formatTimecode, projectDurationUs } from '../../../shared/project'
import { visualLayerOrder, type VisualClip } from '../../../shared/render-order'
import { buildSubtitleRenderSpec, subtitleAnchorTransform, subtitleVisualStateKey } from '../../../shared/subtitle-render'
import { canonicalShadowBlurRadius } from '../../../shared/subtitle-shadow'
import type { AccuratePreviewFrameResult, MediaAsset, PreviewPlan, PreviewPlanClip, SubtitleClip } from '../../../shared/types'
import { PREVIEW_AUDIO_DRIFT_TOLERANCE_SECONDS, previewAudioClipsForPlayback, previewAudioIsActive, previewAudioSourceTimeUs, previewAudioVolume } from '../preview-audio'
import { previewDiagnosticContext, previewDiagnosticStore } from '../preview-performance-diagnostics'
import { useEditorStore } from '../store'
import { IconButton } from './Controls'

const activeAt = (clip: { startUs: number; durationUs: number; enabled: boolean }, timeUs: number): boolean =>
  clip.enabled && clip.startUs <= timeUs && clip.startUs + clip.durationUs > timeUs

function PreviewVisual({
  clip,
  asset,
  mediaSource,
  playheadUs,
  playing,
  onSelect
}: {
  clip: VisualClip
  asset?: MediaAsset
  mediaSource: string | null
  playheadUs: number
  playing: boolean
  onSelect: () => void
}): React.JSX.Element {
  const mediaRef = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    if (clip.kind !== 'video' || !mediaRef.current || !mediaSource) return
    const media = mediaRef.current
    const expectedSeconds = (clip.sourceInUs + Math.max(0, playheadUs - clip.startUs)) / 1_000_000
    if (Math.abs(media.currentTime - expectedSeconds) > 0.12) media.currentTime = expectedSeconds
    if (playing) void media.play().catch(() => undefined)
    else media.pause()
  }, [clip, mediaSource, playheadUs, playing])

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
          src={mediaSource}
          muted
          playsInline
          preload="metadata"
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
  elementRef
}: {
  item: PreviewPlanClip
  asset?: MediaAsset
  elementRef: (element: HTMLAudioElement | null) => void
}): React.JSX.Element | null {
  if (!asset || asset.offline || !window.spectra) return null
  return <audio ref={elementRef} data-clip-id={item.clipId} src={window.spectra.mediaUrl(asset.path)} preload="auto" />
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
  const [accurateRendering, setAccurateRendering] = useState(false)
  const [accurateError, setAccurateError] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const requestRef = useRef<number | null>(null)
  const lastFrameRef = useRef<number>(0)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const audioRefs = useRef(new Map<string, HTMLAudioElement>())
  const audioPlayAttempted = useRef(new Set<string>())
  const accurateRequestSequence = useRef(0)
  const durationUs = Math.max(renderPlan?.durationUs ?? projectDurationUs(project), 1_000_000)

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
    if (!window.spectra) {
      setRenderPlan(null)
      return
    }
    let active = true
    void window.spectra.createPreviewPlan(project)
      .then((plan) => { if (active) setRenderPlan(plan) })
      .catch(() => { if (active) setRenderPlan(null) })
    return () => { active = false }
  }, [project])

  useEffect(() => {
    const sequence = ++accurateRequestSequence.current
    setAccurateError(null)
    if (playing || !window.spectra) {
      setAccurateRendering(false)
      return
    }
    setAccurateRendering(true)
    const api = window.spectra
    const timeout = window.setTimeout(() => {
      if (!api) return
      previewDiagnosticStore.recordAccurateRequest()
      void api.renderAccuratePreviewFrame(project, playheadUs)
        .then((result) => {
          previewDiagnosticStore.recordAccurateOutcome(result.cacheHit ?? !result.ffmpegStarted, Boolean(result.ffmpegStarted))
          if (sequence !== accurateRequestSequence.current || useEditorStore.getState().playing) return
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
  }, [playheadUs, playing, project])

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
      const next = state.playheadUs + elapsedUs
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
  }, [playing, renderPlan?.durationUs])

  const plannedVideoIds = renderPlan ? new Set(renderPlan.videoClips.map((clip) => clip.clipId)) : null
  const plannedCaptionIds = renderPlan ? new Set(renderPlan.captions.map((clip) => clip.clipId)) : null
  const visuals = useMemo(() => visualLayerOrder(project)
    .map(({ clip }) => clip)
    .filter((clip) => activeAt(clip, playheadUs) && (!plannedVideoIds || plannedVideoIds.has(clip.id))), [playheadUs, plannedVideoIds, project])
  const subtitles = useMemo(() => project.tracks
    .filter((track) => track.kind === 'subtitle' && !track.hidden && !track.muted)
    .flatMap((track) => track.clips.filter((clip): clip is SubtitleClip => clip.kind === 'subtitle' && activeAt(clip, playheadUs) && (!plannedCaptionIds || plannedCaptionIds.has(clip.id)))), [plannedCaptionIds, playheadUs, project])
  const showCssSubtitles = playing || (!accurateFrame && subtitles.length > 0)
  const previewAudioClips = useMemo(() => previewAudioClipsForPlayback(renderPlan?.audioClips ?? [], playheadUs), [playheadUs, renderPlan])
  const scale = viewportSize.width > 0 && viewportSize.height > 0
    ? Math.min(viewportSize.width / project.sequence.width, viewportSize.height / project.sequence.height)
    : 1

  useEffect(() => {
    const activeIds = new Set<string>()
    for (const item of previewAudioClips) {
      const audio = audioRefs.current.get(item.clipId)
      if (!audio) continue
      const asset = item.sourceMediaId ? project.media.find((media) => media.id === item.sourceMediaId) : undefined
      if (!asset || asset.offline) continue
      audio.volume = previewAudioVolume(item.volumeDb)
      const active = previewAudioIsActive(item, playheadUs)
      if (!active) {
        audio.pause()
        audioPlayAttempted.current.delete(item.clipId)
        continue
      }
      activeIds.add(item.clipId)
      const expectedSeconds = previewAudioSourceTimeUs(item, playheadUs) / 1_000_000
      if (Math.abs(audio.currentTime - expectedSeconds) > PREVIEW_AUDIO_DRIFT_TOLERANCE_SECONDS || !Number.isFinite(audio.currentTime)) audio.currentTime = Math.max(0, expectedSeconds)
      if (!playing) {
        audio.pause()
        audioPlayAttempted.current.delete(item.clipId)
      } else if (audio.paused && !audioPlayAttempted.current.has(item.clipId)) {
        audioPlayAttempted.current.add(item.clipId)
        void audio.play().catch(() => undefined)
      }
    }
    for (const [clipId, audio] of audioRefs.current) {
      if (!activeIds.has(clipId)) {
        audio.pause()
        audioPlayAttempted.current.delete(clipId)
      }
    }
  }, [playheadUs, playing, previewAudioClips, project])

  const setAudioRef = (clipId: string) => (element: HTMLAudioElement | null): void => {
    if (element) audioRefs.current.set(clipId, element)
    else audioRefs.current.delete(clipId)
  }

  return (
    <section className="viewer-panel panel" aria-label="プログラムモニター">
      <header className="viewer-tabs">
        <span className="viewer-tab is-active">完成映像</span>
        <span className="viewer-quality" aria-live="polite">
          <i />{playing ? '高速プレビュー' : accurateRendering ? '正確プレビュー更新中…' : accurateFrame ? '正確プレビュー' : '正確プレビュー生成中…'}
          {accurateError && <small className="preview-accurate-error" title={accurateError}>取得失敗</small>}
        </span>
        <PreviewDiagnosticControls project={project} playheadUs={playheadUs} playing={playing} viewportSize={viewportSize} />
      </header>
      <div className="viewer-stage">
        <div ref={canvasRef} className="viewer-canvas" style={{ background: project.sequence.backgroundColor, aspectRatio: `${project.sequence.width} / ${project.sequence.height}` }}>
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
              return <PreviewVisual key={visualKey} clip={clip} asset={asset} mediaSource={mediaSource} playheadUs={playheadUs} playing={playing} onSelect={() => selectClip(clip.id)} />
            })}
            {visuals.length === 0 && <div className="viewer-placeholder"><Play size={34} /><span>再生位置に映像がありません</span></div>}
            <div className="safe-guides" aria-hidden="true"><i /></div>
            {showCssSubtitles && subtitles.map((subtitle) => (
              (() => {
                const spec = buildSubtitleRenderSpec(subtitle, project.sequence)
                const textStyle = {
                  fontFamily: spec.fontFamily,
                  fontSize: `${spec.fontSizePx}px`,
                  fontWeight: spec.bold ? 700 : 400,
                  fontStyle: spec.italic ? 'italic' : 'normal' as const,
                  letterSpacing: `${spec.letterSpacingPx}px`,
                  lineHeight: spec.lineHeight,
                  whiteSpace: 'pre-wrap' as const,
                  overflowWrap: 'anywhere' as const
                }
                return <button
                  type="button"
                  key={subtitle.id}
                  className={`preview-subtitle subtitle-${spec.animation} anchor-${spec.anchor}`}
                  data-subtitle-renderer="css-fallback"
                  title={spec.layoutDiagnostics.map((diagnostic) => diagnostic.message).join(' ')}
                  onClick={() => selectClip(subtitle.id)}
                  style={{
                    left: `${spec.xPx}px`,
                    top: `${spec.yPx}px`,
                    width: `${spec.maxWidthPx}px`,
                    animationDuration: `${Math.max(0, spec.animationDurationUs / 1_000)}ms`,
                    transform: subtitleAnchorTransform(spec.anchor)
                  }}
                >
                  <span className="preview-subtitle-stack">
                    <span className="preview-subtitle-text-box">
                    {spec.backgroundOpacity > 0 && <span
                      className="preview-subtitle-layer preview-subtitle-background"
                      aria-hidden="true"
                      style={{
                        ...textStyle,
                        color: 'transparent',
                        WebkitTextStroke: '0 transparent',
                        background: `color-mix(in srgb, ${spec.backgroundColor} ${spec.backgroundOpacity * 100}%, transparent)`
                      }}
                    >{spec.wrappedText}</span>}
                    {spec.shadowColor && <span
                      className="preview-subtitle-layer preview-subtitle-shadow"
                      aria-hidden="true"
                      style={{
                        ...textStyle,
                        color: spec.shadowColor,
                        transform: `translate(${spec.shadowOffsetXPx}px, ${spec.shadowOffsetYPx}px)`,
                        filter: canonicalShadowBlurRadius(spec.shadowBlurPx) > 0 ? `blur(${canonicalShadowBlurRadius(spec.shadowBlurPx)}px)` : undefined
                      }}
                    >{spec.wrappedText}</span>}
                    <span
                      className="preview-subtitle-layer preview-subtitle-main"
                      style={{
                        ...textStyle,
                        color: spec.color,
                        WebkitTextStroke: `${spec.outlineWidthPx}px ${spec.outlineColor}`,
                        paintOrder: 'stroke fill'
                      }}
                    >{spec.wrappedText}</span>
                    </span>
                  </span>
                </button>
              })()
            ))}
            {!playing && accurateFrame && window.spectra && (
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
                elementRef={setAudioRef(item.clipId)}
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
