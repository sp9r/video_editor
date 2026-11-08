import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Maximize2, Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react'
import { frameIndexForTime, timeUsForFrameIndex } from '../../../shared/frame-time'
import { formatTimecode, projectDurationUs, projectFingerprint } from '../../../shared/project'
import { visualLayerOrder } from '../../../shared/render-order'
import { subtitleVisualStateKey } from '../../../shared/subtitle-render'
import type { AccuratePreviewFrameResult, MediaAsset, PreviewPlan, PreviewPlanClip } from '../../../shared/types'
import { PreviewAudioMixer, previewAudioClipsForPlayback, previewAudioIsActive, previewAudioSourceTimeUs, previewPlaybackTimeUs, syncPreviewMediaTime } from '../preview-audio'
import { PreviewCompositor } from '../preview-compositor'
import { previewFrameIndex } from '../preview-geometry'
import { previewDiagnosticContext, previewDiagnosticStore } from '../preview-performance-diagnostics'
import { previewQualityLabel } from '../preview-status'
import { useEditorStore } from '../store'
import { IconButton } from './Controls'

const activeAt = (clip: { startUs: number; durationUs: number; enabled: boolean }, timeUs: number): boolean =>
  clip.enabled && clip.startUs <= timeUs && clip.startUs + clip.durationUs > timeUs

export const accuratePreviewFrameMatchesCurrent = (
  frame: Pick<AccuratePreviewFrameResult, 'projectFingerprint' | 'requestedTimeUs'>,
  currentProjectFingerprint: string,
  currentPlayheadUs: number,
  frameDurationUs: number
): boolean => frame.projectFingerprint === currentProjectFingerprint
  && Math.abs(frame.requestedTimeUs - currentPlayheadUs) <= frameDurationUs

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

interface ExactFrame {
  image: HTMLImageElement
  projectFingerprint: string
  frameIndex: number
}

export default function Preview(): React.JSX.Element {
  const { project, playheadUs, setPlayhead, playing, setPlaying, selectClip, showNotice } = useEditorStore()
  previewDiagnosticStore.recordComponentRender('preview')
  const [renderPlan, setRenderPlan] = useState<PreviewPlan | null>(null)
  const [exactCheck, setExactCheck] = useState(false)
  const [exactFrame, setExactFrame] = useState<ExactFrame | null>(null)
  const [exactRendering, setExactRendering] = useState(false)
  const [exactError, setExactError] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const [compositor, setCompositor] = useState<PreviewCompositor | null>(null)
  const requestRef = useRef<number | null>(null)
  const lastFrameRef = useRef<number>(0)
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sourcePoolRef = useRef<HTMLDivElement | null>(null)
  const compositorRef = useRef<PreviewCompositor | null>(null)
  const audioRefs = useRef(new Map<string, HTMLAudioElement>())
  const audioMixer = useRef<PreviewAudioMixer | null>(null)
  const audioLifetime = useRef(0)
  const [audioReadyGeneration, setAudioReadyGeneration] = useState(0)
  const onAudioReady = useCallback(() => setAudioReadyGeneration((generation) => generation + 1), [])
  const audioPlayAttempted = useRef(new Set<string>())
  const exactRequestSequence = useRef(0)
  const onPlaybackError = useCallback((name: string): void => {
    setPlaying(false)
    showNotice(`「${name}」をプレビューで再生できませんでした。素材の形式とファイルを確認してください。`, 'warning')
  }, [setPlaying, showNotice])
  const durationUs = Math.max(renderPlan?.durationUs ?? projectDurationUs(project), 1_000_000)
  const fps = project.sequence.frameRate
  const frameIndex = previewFrameIndex(playheadUs, fps, null)
  const currentProjectFingerprint = useMemo(() => projectFingerprint(project), [project])

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
    const panel = viewerRef.current?.closest('.viewer-panel') as HTMLElement | null
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
    setRenderPlan(null)
    setExactFrame(null)
    let active = true
    void window.spectra.createPreviewPlan(project)
      .then((plan) => { if (active) setRenderPlan(plan) })
      .catch((error: unknown) => {
        if (!active) return
        setRenderPlan(null)
        setExactRendering(false)
        setExactError(error instanceof Error ? error.message : 'プレビューの準備に失敗しました')
      })
    return () => { active = false }
  }, [project])

  // The canvas compositor lives as long as the viewer; StrictMode recreates it.
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const pool = sourcePoolRef.current
    if (!canvas || !pool || !window.spectra) return
    const created = new PreviewCompositor(canvas, pool, window.spectra, {
      onPlaybackError,
      onSubtitleRequest: (key) => previewDiagnosticStore.recordSubtitleOverlayRequest(key),
      onSubtitleOutcome: (cacheHit) => previewDiagnosticStore.recordSubtitleOverlayOutcome(cacheHit)
    })
    compositorRef.current = created
    setCompositor(created)
    return () => {
      created.dispose()
      if (compositorRef.current === created) compositorRef.current = null
      setCompositor(null)
    }
  }, [onPlaybackError])

  useLayoutEffect(() => {
    const element = viewerRef.current
    if (!element) return
    const update = (): void => {
      setViewportSize({ width: element.clientWidth, height: element.clientHeight })
      compositorRef.current?.resize(element.clientWidth, element.clientHeight, window.devicePixelRatio || 1)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    // Moving the window to another monitor changes devicePixelRatio without resizing the box.
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [compositor])

  // "Export-quality check": request FFmpeg's own frame only when asked for.
  useEffect(() => {
    const sequence = ++exactRequestSequence.current
    setExactError(null)
    if (!exactCheck || playing || !window.spectra) {
      setExactRendering(false)
      return
    }
    setExactRendering(true)
    // createPreviewPlan clears the previous project's frame workspace. Wait
    // until it completes, otherwise a reload can invalidate its own new frame.
    if (!renderPlan) return
    const api = window.spectra
    const requestedFrame = frameIndexForTime(playheadUs + 1, project.sequence.frameRate)
    const timeout = window.setTimeout(() => {
      previewDiagnosticStore.recordAccurateRequest()
      void api.renderAccuratePreviewFrame(project, timeUsForFrameIndex(requestedFrame, project.sequence.frameRate) + 1)
        .then(async (result) => {
          previewDiagnosticStore.recordAccurateOutcome(result.cacheHit ?? !result.ffmpegStarted, Boolean(result.ffmpegStarted))
          const current = useEditorStore.getState()
          if (sequence !== exactRequestSequence.current || current.playing || projectFingerprint(current.project) !== result.projectFingerprint) return
          const image = new Image()
          image.crossOrigin = 'anonymous'
          image.src = api.mediaUrl(result.framePath)
          await image.decode()
          if (sequence !== exactRequestSequence.current) return
          setExactFrame({ image, projectFingerprint: result.projectFingerprint, frameIndex: result.frameIndex })
          setExactRendering(false)
        })
        .catch((error: unknown) => {
          if (sequence !== exactRequestSequence.current || useEditorStore.getState().playing) return
          setExactRendering(false)
          setExactError(error instanceof Error ? error.message : '書き出し画質のフレームを生成できませんでした')
        })
    }, 120)
    return () => window.clearTimeout(timeout)
  }, [exactCheck, playheadUs, playing, project, renderPlan])

  const exactShown = Boolean(exactCheck && !playing && exactFrame
    && exactFrame.projectFingerprint === currentProjectFingerprint
    && exactFrame.frameIndex === frameIndex)

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
        return compositorRef.current?.videoForClip(item.clipId) ?? null
      })
      previewDiagnosticStore.recordAnimationFrame(timestamp, next)
      if (previewDiagnosticStore.getSnapshot().active) {
        for (const video of compositorRef.current?.videos() ?? []) {
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

  // Compose the current frame; the compositor redraws itself when media or
  // subtitle images arrive.
  useEffect(() => {
    compositor?.update({ project, playheadUs, playing, exactImage: exactShown ? exactFrame?.image ?? null : null })
  }, [compositor, exactFrame, exactShown, playheadUs, playing, project])

  const hasVisual = useMemo(() => visualLayerOrder(project).some(({ clip }) => activeAt(clip, playheadUs)), [playheadUs, project])
  const previewAudioClips = useMemo(() => previewAudioClipsForPlayback(renderPlan?.audioClips ?? [], playheadUs), [playheadUs, renderPlan])

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

  const onCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const clipId = compositorRef.current?.hitTest(event.clientX - rect.left, event.clientY - rect.top)
    if (clipId) selectClip(clipId)
  }

  const stepFrame = (direction: -1 | 1): void => {
    const target = Math.max(0, frameIndex + direction)
    setPlayhead(Math.min(durationUs, timeUsForFrameIndex(target, fps)))
  }

  return (
    <section className="viewer-panel panel" aria-label="プログラムモニター">
      <header className="viewer-tabs">
        <span className="viewer-tab is-active">完成映像</span>
        <label className="viewer-exact-toggle">
          <input type="checkbox" checked={exactCheck} onChange={(event) => setExactCheck(event.target.checked)} />
          書き出し画質で確認
        </label>
        <span className="viewer-quality" aria-live="polite">
          <i />{previewQualityLabel({ playing, exactCheck, exactShown, exactRendering, exactError })}
          {exactError && <small className="preview-accurate-error" title={exactError}>取得失敗</small>}
        </span>
        <PreviewDiagnosticControls project={project} playheadUs={playheadUs} playing={playing} viewportSize={viewportSize} />
      </header>
      <div className="viewer-stage">
        <div ref={viewerRef} className="viewer-canvas" data-playhead-us={playheadUs} data-playing={playing ? 'true' : 'false'} data-frame-index={frameIndex} style={{ background: project.sequence.backgroundColor, aspectRatio: `${project.sequence.width} / ${project.sequence.height}` }}>
          <canvas ref={canvasRef} className="preview-canvas" data-exact-shown={exactShown ? 'true' : 'false'} aria-label="プレビュー映像" onClick={onCanvasClick} />
          {!hasVisual && <div className="viewer-placeholder"><Play size={34} /><span>再生位置に映像がありません</span></div>}
          <div className="safe-guides" aria-hidden="true"><i /></div>
          {exactShown && <span className="preview-exact-badge">書き出し画質（FFmpeg）</span>}
          <div ref={sourcePoolRef} className="preview-source-pool" aria-hidden="true" />
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
          <IconButton label="1フレーム戻る（←）" onClick={() => stepFrame(-1)}><SkipBack size={17} /></IconButton>
          <IconButton label={playing ? '停止（Space）' : '再生（Space）'} className="play-button" onClick={() => setPlaying(!playing)}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</IconButton>
          <IconButton label="1フレーム進む（→）" onClick={() => stepFrame(1)}><SkipForward size={17} /></IconButton>
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
