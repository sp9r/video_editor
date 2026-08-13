import { useEffect, useMemo, useRef } from 'react'
import { Maximize2, Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react'
import { formatTimecode, projectDurationUs } from '../../../shared/project'
import type { MediaAsset, SubtitleClip, TimelineClip, VideoClip } from '../../../shared/types'
import { useEditorStore } from '../store'
import { IconButton } from './Controls'

const activeAt = (clip: TimelineClip, timeUs: number): boolean =>
  clip.enabled && clip.startUs <= timeUs && clip.startUs + clip.durationUs > timeUs

const frameGradient = (asset?: MediaAsset): string => {
  if (!asset) return 'linear-gradient(145deg, #1b222b, #0d1015)'
  if (asset.id.includes('cafe')) return 'linear-gradient(135deg, #6b402a 0%, #c69866 43%, #33473d 44%, #16251f 100%)'
  return 'linear-gradient(155deg, #9dd8d2 0%, #c9e5da 34%, #65837d 35%, #2b3b3b 51%, #cd9d6a 52%, #6f4836 100%)'
}

export default function Preview(): React.JSX.Element {
  const { project, playheadUs, setPlayhead, playing, setPlaying, selectClip } = useEditorStore()
  const requestRef = useRef<number | null>(null)
  const lastFrameRef = useRef<number>(0)
  const mediaRef = useRef<HTMLVideoElement | null>(null)
  const durationUs = Math.max(projectDurationUs(project), 1_000_000)

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
      if (next >= Math.max(projectDurationUs(state.project), 1_000_000)) {
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
  }, [playing])

  const active = useMemo(() => {
    const clips = project.tracks
      .filter((track) => !track.hidden && !track.muted)
      .flatMap((track) => track.clips.filter((clip) => activeAt(clip, playheadUs)))
    return {
      visuals: clips.filter((clip): clip is VideoClip | Extract<TimelineClip, { kind: 'image' }> => clip.kind === 'video' || clip.kind === 'image'),
      subtitles: clips.filter((clip): clip is SubtitleClip => clip.kind === 'subtitle')
    }
  }, [project, playheadUs])
  const baseVisual = active.visuals.at(-1)
  const asset = baseVisual && 'assetId' in baseVisual ? project.media.find((item) => item.id === baseVisual.assetId) : undefined
  const mediaSource = asset && !asset.offline && window.spectra ? window.spectra.mediaUrl(asset.path) : null

  useEffect(() => {
    const media = mediaRef.current
    if (!media || !baseVisual || baseVisual.kind !== 'video') return
    const expectedSeconds = (baseVisual.sourceInUs + Math.max(0, playheadUs - baseVisual.startUs)) / 1_000_000
    if (Math.abs(media.currentTime - expectedSeconds) > 0.12) media.currentTime = expectedSeconds
    if (playing) void media.play().catch(() => undefined)
    else media.pause()
  }, [baseVisual, playheadUs, playing])

  return (
    <section className="viewer-panel panel" aria-label="プログラムモニター">
      <header className="viewer-tabs">
        <button type="button">ソース</button>
        <button type="button" className="is-active">完成映像</button>
        <span className="viewer-quality"><i />プレビュー品質: 1/2</span>
      </header>
      <div className="viewer-stage">
        <div className="viewer-canvas" style={{ background: project.sequence.backgroundColor }}>
          {baseVisual ? (
            <button
              type="button"
              className="composite-frame"
              onClick={() => selectClip(baseVisual.id)}
              style={{
                backgroundImage: frameGradient(asset),
                transform: `translate(${baseVisual.transform.positionX * 0.15}px, ${baseVisual.transform.positionY * 0.15}px) rotate(${baseVisual.transform.rotation}deg) scale(${baseVisual.transform.scale})`,
                opacity: baseVisual.transform.opacity,
                clipPath: `inset(${baseVisual.transform.crop.top * 100}% ${baseVisual.transform.crop.right * 100}% ${baseVisual.transform.crop.bottom * 100}% ${baseVisual.transform.crop.left * 100}%)`
              }}
              aria-label={`${baseVisual.name}を選択`}
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
              ) : null}
              <span className="frame-skyline" aria-hidden="true"><i /><i /><i /><i /><i /></span>
              <span className="frame-label">{asset?.name}</span>
            </button>
          ) : (
            <div className="viewer-placeholder"><Play size={34} /><span>再生位置に映像がありません</span></div>
          )}
          <div className="safe-guides" aria-hidden="true"><i /></div>
          {active.subtitles.map((subtitle) => (
            <button
              type="button"
              key={subtitle.id}
              className={`preview-subtitle subtitle-${subtitle.style.animation}`}
              onClick={() => selectClip(subtitle.id)}
              style={{
                left: `${subtitle.style.positionX}%`,
                top: `${subtitle.style.positionY}%`,
                color: subtitle.style.color,
                fontFamily: subtitle.style.fontFamily,
                fontSize: `${Math.max(12, subtitle.style.fontSize * 0.55)}px`,
                fontWeight: subtitle.style.bold ? 700 : 400,
                fontStyle: subtitle.style.italic ? 'italic' : 'normal',
                letterSpacing: `${subtitle.style.letterSpacing}px`,
                lineHeight: subtitle.style.lineHeight,
                WebkitTextStroke: `${subtitle.style.outlineWidth * 0.55}px ${subtitle.style.outlineColor}`,
                textShadow: `0 2px ${subtitle.style.shadowBlur}px ${subtitle.style.shadowColor}`,
                background: `color-mix(in srgb, ${subtitle.style.backgroundColor} ${subtitle.style.backgroundOpacity * 100}%, transparent)`
              }}
            >
              {subtitle.text}
            </button>
          ))}
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
