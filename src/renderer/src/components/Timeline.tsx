import { useMemo, useRef, useState } from 'react'
import {
  Captions,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Magnet,
  MousePointer2,
  Plus,
  Scissors,
  Trash2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { formatTimecode, makeId } from '../../../shared/project'
import { DEFAULT_SUBTITLE_STYLE, type ImportedSubtitleCue, type TimelineClip, type TimelineTrack } from '../../../shared/types'
import { editorDurationUs, useEditorStore } from '../store'
import { Button, IconButton } from './Controls'

const seconds = (timeUs: number): number => timeUs / 1_000_000

const trackGlyph = (kind: TimelineTrack['kind']): string => ({ video: 'V', audio: 'A', subtitle: 'C' })[kind]

const clipGlyph = (clip: TimelineClip): React.JSX.Element => {
  if (clip.kind === 'subtitle') return <Captions size={13} />
  if (clip.kind === 'audio') return <Volume2 size={13} />
  return <span className="film-glyph">▰</span>
}

const ticksFor = (durationUs: number, zoom: number): number[] => {
  const interval = zoom >= 110 ? 1 : zoom >= 55 ? 2 : 5
  const result: number[] = []
  for (let second = 0; second <= Math.ceil(seconds(durationUs)); second += interval) result.push(second)
  return result
}

interface PointerEdit {
  clipId: string
  mode: 'move' | 'trim-start' | 'trim-end'
  initialX: number
  deltaX: number
  initialStartUs: number
  initialDurationUs: number
  targetTrackId: string
}

function TrackControls({ track }: { track: TimelineTrack }): React.JSX.Element {
  const patchTrack = useEditorStore((state) => state.patchTrack)
  return (
    <div className={`track-header kind-${track.kind}`}>
      <span className="track-index">{trackGlyph(track.kind)}</span>
      <strong title={track.name}>{track.name.replace(/^\w+\s*/, '')}</strong>
      <div className="track-controls">
        <IconButton label={track.locked ? 'トラックのロックを解除' : 'トラックをロック'} active={track.locked} onClick={() => patchTrack({ ...track, locked: !track.locked })}>{track.locked ? <Lock size={13} /> : <LockOpen size={13} />}</IconButton>
        <IconButton label={track.muted ? 'ミュートを解除' : 'ミュート'} active={track.muted} onClick={() => patchTrack({ ...track, muted: !track.muted })}>{track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}</IconButton>
        <IconButton label={track.hidden ? 'トラックを表示' : 'トラックを非表示'} active={track.hidden} onClick={() => patchTrack({ ...track, hidden: !track.hidden })}>{track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}</IconButton>
      </div>
    </div>
  )
}

export default function Timeline(): React.JSX.Element {
  const state = useEditorStore()
  const {
    project,
    selectedClipIds,
    playheadUs,
    zoomPxPerSecond,
    tool,
    snapping,
    rippleMode,
    setPlayhead,
    selectClip,
    setTool,
    setSnapping,
    setRippleMode,
    setZoom,
    addAssetClip,
    addSubtitle,
    splitSelected,
    deleteSelected,
    moveSelected,
    trim,
    showNotice,
    applyProject
  } = state
  const viewportRef = useRef<HTMLDivElement>(null)
  const [pointerEdit, setPointerEdit] = useState<PointerEdit | null>(null)
  const durationUs = editorDurationUs(project)
  const timelineWidth = Math.max(900, seconds(durationUs) * zoomPxPerSecond)
  const ticks = useMemo(() => ticksFor(durationUs, zoomPxPerSecond), [durationUs, zoomPxPerSecond])

  const timeFromPointer = (clientX: number, lane: HTMLElement): number => {
    const bounds = lane.getBoundingClientRect()
    return Math.max(0, ((clientX - bounds.left) / zoomPxPerSecond) * 1_000_000)
  }

  const beginPointerEdit = (event: React.PointerEvent, clip: TimelineClip, mode: PointerEdit['mode'], trackId: string): void => {
    event.stopPropagation()
    if (tool === 'razor' && mode === 'move') {
      const lane = event.currentTarget.closest('.track-lane') as HTMLElement | null
      if (!lane) return
      const atUs = timeFromPointer(event.clientX, lane)
      selectClip(clip.id)
      setPlayhead(atUs)
      window.setTimeout(() => useEditorStore.getState().splitSelected(), 0)
      return
    }
    selectClip(clip.id, event.ctrlKey || event.metaKey)
    const start: PointerEdit = {
      clipId: clip.id,
      mode,
      initialX: event.clientX,
      deltaX: 0,
      initialStartUs: clip.startUs,
      initialDurationUs: clip.durationUs,
      targetTrackId: trackId
    }
    setPointerEdit(start)
    const move = (pointerEvent: PointerEvent): void => {
      const lane = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)?.closest('.track-lane') as HTMLElement | null
      setPointerEdit((current) => current ? { ...current, deltaX: pointerEvent.clientX - current.initialX, targetTrackId: lane?.dataset.trackId ?? current.targetTrackId } : null)
    }
    const up = (pointerEvent: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const deltaUs = ((pointerEvent.clientX - start.initialX) / zoomPxPerSecond) * 1_000_000
      const latestLane = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)?.closest('.track-lane') as HTMLElement | null
      if (mode === 'move') moveSelected(clip.id, latestLane?.dataset.trackId ?? start.targetTrackId, start.initialStartUs + deltaUs)
      else if (mode === 'trim-start') trim(clip.id, 'start', start.initialStartUs + deltaUs)
      else trim(clip.id, 'end', start.initialStartUs + start.initialDurationUs + deltaUs)
      setPointerEdit(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const importSubtitles = async (): Promise<void> => {
    if (!window.spectra) {
      showNotice('デスクトップ版ではSRT/VTTを読み込めます。')
      return
    }
    const cues = await window.spectra.importSubtitles()
    if (!cues?.length) return
    const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')
    if (!subtitleTrack) return showNotice('字幕トラックがありません。', 'error')
    const next = structuredClone(project)
    const target = next.tracks.find((track) => track.id === subtitleTrack.id)
    if (!target) return
    target.clips.push(...cues.map((cue: ImportedSubtitleCue) => ({
      id: makeId('caption'),
      name: cue.text.slice(0, 24) || '字幕',
      kind: 'subtitle' as const,
      startUs: cue.startUs,
      durationUs: Math.max(33_333, cue.endUs - cue.startUs),
      sourceInUs: 0,
      enabled: true,
      text: cue.text,
      style: structuredClone(DEFAULT_SUBTITLE_STYLE)
    })))
    target.clips.sort((a, b) => a.startUs - b.startUs)
    applyProject(next)
    showNotice(`${cues.length}件の字幕を読み込みました。`, 'success')
  }

  return (
    <section className="timeline-panel panel" aria-label="タイムライン">
      <header className="timeline-toolbar">
        <div className="toolbar-group">
          <IconButton label="選択ツール（V）" active={tool === 'select'} onClick={() => setTool('select')}><MousePointer2 size={16} /></IconButton>
          <IconButton label="分割ツール（C）" active={tool === 'razor'} onClick={() => setTool('razor')}><Scissors size={16} /></IconButton>
          <span className="toolbar-separator" />
          <IconButton label="スナップ（S）" active={snapping} onClick={() => setSnapping(!snapping)}><Magnet size={16} /></IconButton>
          <button type="button" className={`mode-button ${rippleMode ? 'is-active' : ''}`} onClick={() => setRippleMode(!rippleMode)}>自動詰め</button>
        </div>
        <div className="timeline-title">
          <span className="status-dot" />
          <strong>メインシーケンス</strong>
          <small>{project.sequence.width}×{project.sequence.height} · {project.sequence.frameRate.numerator / project.sequence.frameRate.denominator} fps</small>
        </div>
        <div className="toolbar-group align-right">
          <Button className="subtle-button" onClick={() => void importSubtitles()}>SRT/VTT読込</Button>
          <Button className="subtle-button" onClick={addSubtitle}><Captions size={14} />字幕を追加</Button>
          <IconButton label="再生位置で分割（Ctrl+K）" disabled={!selectedClipIds.length} onClick={splitSelected}><Scissors size={16} /></IconButton>
          <IconButton label={rippleMode ? '選択クリップを自動詰め削除' : '選択クリップを削除'} disabled={!selectedClipIds.length} onClick={() => deleteSelected()}><Trash2 size={16} /></IconButton>
          <span className="toolbar-separator" />
          <IconButton label="タイムラインを縮小" onClick={() => setZoom(zoomPxPerSecond - 12)}><ZoomOut size={15} /></IconButton>
          <input className="zoom-slider" type="range" min={28} max={220} value={zoomPxPerSecond} onChange={(event) => setZoom(Number(event.target.value))} aria-label="タイムラインの拡大率" />
          <IconButton label="タイムラインを拡大" onClick={() => setZoom(zoomPxPerSecond + 12)}><ZoomIn size={15} /></IconButton>
        </div>
      </header>
      <div className="timeline-shell">
        <div className="track-labels">
          <div className="ruler-corner"><Plus size={14} /><span>トラック</span></div>
          {project.tracks.map((track) => <TrackControls key={track.id} track={track} />)}
        </div>
        <div className="timeline-viewport" ref={viewportRef}>
          <div className="timeline-content" style={{ width: timelineWidth }}>
            <div
              className="time-ruler"
              onPointerDown={(event) => setPlayhead(timeFromPointer(event.clientX, event.currentTarget))}
            >
              {ticks.map((tick) => <span key={tick} style={{ left: tick * zoomPxPerSecond }}><i />{formatTimecode(tick * 1_000_000, project).slice(3, 8)}</span>)}
            </div>
            {project.tracks.map((track) => (
              <div
                key={track.id}
                className={`track-lane kind-${track.kind} ${track.locked ? 'is-locked' : ''}`}
                data-track-id={track.id}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) {
                    setPlayhead(timeFromPointer(event.clientX, event.currentTarget))
                    selectClip(null)
                  }
                }}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes('application/x-spectra-asset')) event.preventDefault()
                }}
                onDrop={(event) => {
                  const assetId = event.dataTransfer.getData('application/x-spectra-asset')
                  if (!assetId) return
                  event.preventDefault()
                  addAssetClip(assetId, track.id, timeFromPointer(event.clientX, event.currentTarget))
                }}
              >
                {track.clips.map((clip) => {
                  const edit = pointerEdit?.clipId === clip.id ? pointerEdit : null
                  const deltaPx = edit?.deltaX ?? 0
                  const visualLeft = clip.startUs / 1_000_000 * zoomPxPerSecond + (edit?.mode === 'move' ? deltaPx : edit?.mode === 'trim-start' ? deltaPx : 0)
                  const visualWidth = clip.durationUs / 1_000_000 * zoomPxPerSecond + (edit?.mode === 'trim-start' ? -deltaPx : edit?.mode === 'trim-end' ? deltaPx : 0)
                  return (
                    <div
                      key={clip.id}
                      className={`timeline-clip clip-${clip.kind} ${selectedClipIds.includes(clip.id) ? 'is-selected' : ''} ${!clip.enabled ? 'is-disabled' : ''} ${edit ? 'is-dragging' : ''}`}
                      style={{ left: Math.max(0, visualLeft), width: Math.max(8, visualWidth) }}
                      onPointerDown={(event) => beginPointerEdit(event, clip, 'move', track.id)}
                      title={`${clip.name}\n${seconds(clip.durationUs).toFixed(2)} 秒`}
                    >
                      <button type="button" className="trim-handle trim-start" aria-label="開始位置をトリム" onPointerDown={(event) => beginPointerEdit(event, clip, 'trim-start', track.id)} />
                      <span className="clip-content">{clipGlyph(clip)}<strong>{clip.kind === 'subtitle' ? clip.text : clip.name}</strong></span>
                      {clip.kind === 'audio' || clip.kind === 'video' ? <span className="waveform" aria-hidden="true" /> : null}
                      <button type="button" className="trim-handle trim-end" aria-label="終了位置をトリム" onPointerDown={(event) => beginPointerEdit(event, clip, 'trim-end', track.id)} />
                    </div>
                  )
                })}
              </div>
            ))}
            <div className="playhead" style={{ left: playheadUs / 1_000_000 * zoomPxPerSecond }} aria-label={`再生位置 ${formatTimecode(playheadUs, project)}`}><i /></div>
          </div>
        </div>
      </div>
      <footer className="timeline-footer">
        <span><i className="status-dot" />自動保存オン</span>
        <span>選択: {selectedClipIds.length} クリップ</span>
        <code>{formatTimecode(playheadUs, project)} / {formatTimecode(durationUs, project)}</code>
      </footer>
    </section>
  )
}
