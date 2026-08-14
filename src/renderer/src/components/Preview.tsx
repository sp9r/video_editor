import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react'
import { formatTimecode, projectDurationUs } from '../../../shared/project'
import { visualLayerOrder, type VisualClip } from '../../../shared/render-order'
import { activeSubtitleClips, buildSubtitleRenderSpec, subtitleAnchorTransform, subtitleVisualStateKey } from '../../../shared/subtitle-render'
import { canonicalShadowBlurRadius } from '../../../shared/subtitle-shadow'
import type { AccuratePreviewFrameResult, MediaAsset, PreviewPlan, PreviewPlanClip, SubtitleClip, SubtitleOverlayResult } from '../../../shared/types'
import { useEditorStore } from '../store'
import { IconButton } from './Controls'

const activeAt = (clip: { startUs: number; durationUs: number; enabled: boolean }, timeUs: number): boolean =>
  clip.enabled && clip.startUs <= timeUs && clip.startUs + clip.durationUs > timeUs

const dbToLinear = (value = 0): number => 10 ** (Math.max(-96, Math.min(24, value)) / 20)

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

export default function Preview(): React.JSX.Element {
  const { project, playheadUs, setPlayhead, playing, setPlaying, selectClip } = useEditorStore()
  const [renderPlan, setRenderPlan] = useState<PreviewPlan | null>(null)
  const [accurateFrame, setAccurateFrame] = useState<AccuratePreviewFrameResult | null>(null)
  const [accurateRendering, setAccurateRendering] = useState(false)
  const [accurateError, setAccurateError] = useState<string | null>(null)
  const [subtitleOverlay, setSubtitleOverlay] = useState<SubtitleOverlayResult | null>(null)
  const [subtitleOverlayRendering, setSubtitleOverlayRendering] = useState(false)
  const [subtitleOverlayError, setSubtitleOverlayError] = useState<string | null>(null)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const requestRef = useRef<number | null>(null)
  const lastFrameRef = useRef<number>(0)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const audioRefs = useRef(new Map<string, HTMLAudioElement>())
  const accurateRequestSequence = useRef(0)
  const subtitleOverlayRequestSequence = useRef(0)
  const playheadRef = useRef(playheadUs)
  playheadRef.current = playheadUs
  const durationUs = Math.max(renderPlan?.durationUs ?? projectDurationUs(project), 1_000_000)

  const activeSubtitleState = useMemo(() => {
    const active = activeSubtitleClips(project, playheadUs)
    return {
      active,
      hasAnimated: active.some(({ clip }) => clip.style.animation !== 'none'),
      key: subtitleVisualStateKey(project, playheadUs)
    }
  }, [playheadUs, project])

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
      void api.renderAccuratePreviewFrame(project, playheadUs)
        .then((result) => {
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

  useEffect(() => {
    const sequence = ++subtitleOverlayRequestSequence.current
    setSubtitleOverlayError(null)
    if (!playing || !window.spectra || activeSubtitleState.active.length === 0 || activeSubtitleState.hasAnimated) {
      setSubtitleOverlay(null)
      setSubtitleOverlayRendering(false)
      return
    }
    setSubtitleOverlay(null)
    setSubtitleOverlayRendering(true)
    const api = window.spectra
    const timeout = window.setTimeout(() => {
      void api.renderSubtitleOverlay(project, playheadRef.current)
        .then((result) => {
          if (sequence !== subtitleOverlayRequestSequence.current || !useEditorStore.getState().playing) return
          setSubtitleOverlay(result)
          setSubtitleOverlayRendering(false)
        })
        .catch((error: unknown) => {
          if (sequence !== subtitleOverlayRequestSequence.current || !useEditorStore.getState().playing) return
          setSubtitleOverlayRendering(false)
          setSubtitleOverlayError(error instanceof Error ? error.message : '字幕overlayを生成できませんでした')
        })
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [activeSubtitleState.hasAnimated, activeSubtitleState.key, activeSubtitleState.active.length, playing, project])

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
  const showCssSubtitles = activeSubtitleState.hasAnimated || (!playing && !accurateFrame) || (playing && Boolean(subtitleOverlayError))
  const scale = viewportSize.width > 0 && viewportSize.height > 0
    ? Math.min(viewportSize.width / project.sequence.width, viewportSize.height / project.sequence.height)
    : 1

  useEffect(() => {
    const activeIds = new Set<string>()
    for (const item of renderPlan?.audioClips ?? []) {
      const audio = audioRefs.current.get(item.clipId)
      if (!audio) continue
      const asset = item.sourceMediaId ? project.media.find((media) => media.id === item.sourceMediaId) : undefined
      if (!asset || asset.offline) continue
      audio.volume = dbToLinear(item.volumeDb)
      const active = activeAt(item, playheadUs)
      if (!active) {
        audio.pause()
        continue
      }
      activeIds.add(item.clipId)
      const expectedSeconds = (item.sourceInUs + playheadUs - item.startUs) / 1_000_000
      if (Math.abs(audio.currentTime - expectedSeconds) > 0.12 || !Number.isFinite(audio.currentTime)) audio.currentTime = Math.max(0, expectedSeconds)
      if (playing) void audio.play().catch(() => undefined)
      else audio.pause()
    }
    for (const [clipId, audio] of audioRefs.current) {
      if (!activeIds.has(clipId)) audio.pause()
    }
  }, [playheadUs, playing, project, renderPlan])

  const setAudioRef = (clipId: string) => (element: HTMLAudioElement | null): void => {
    if (element) audioRefs.current.set(clipId, element)
    else audioRefs.current.delete(clipId)
  }

  return (
    <section className="viewer-panel panel" aria-label="プログラムモニター">
      <header className="viewer-tabs">
        <button type="button">ソース</button>
        <button type="button" className="is-active">完成映像</button>
        <span className="viewer-quality" aria-live="polite">
          <i />{playing ? subtitleOverlayRendering ? '高速プレビュー（字幕生成中…）' : '高速プレビュー' : accurateRendering ? '正確プレビュー更新中…' : accurateFrame ? '正確プレビュー' : '正確プレビュー生成中…'}
          {accurateError && <small className="preview-accurate-error" title={accurateError}>取得失敗</small>}
          {subtitleOverlayError && <small className="preview-accurate-error" title={subtitleOverlayError}>字幕fallback</small>}
        </span>
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
              return <PreviewVisual key={clip.id} clip={clip} asset={asset} mediaSource={mediaSource} playheadUs={playheadUs} playing={playing} onSelect={() => selectClip(clip.id)} />
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
                </button>
              })()
            ))}
            {playing && subtitleOverlay && !activeSubtitleState.hasAnimated && window.spectra && (
              <img
                className="fast-authoritative-subtitle-overlay"
                data-subtitle-renderer="authoritative-libass"
                src={window.spectra.mediaUrl(subtitleOverlay.framePath)}
                alt=""
                draggable={false}
              />
            )}
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
            {(renderPlan?.audioClips ?? []).map((item) => (
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
          <IconButton label="全画面表示"><Maximize2 size={16} /></IconButton>
        </div>
      </div>
    </section>
  )
}
