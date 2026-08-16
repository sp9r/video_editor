import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Captions,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Link2,
  Lock,
  LockOpen,
  Magnet,
  MousePointer2,
  Pencil,
  Plus,
  Scissors,
  Trash2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { findSubtitleContext, formatTimecode, layoutSubtitleTracks, makeId } from '../../../shared/project'
import { isSubtitleOwnershipBoundaryAvailable, isSubtitleWordBoundarySplitAvailable, nearestSubtitleOwnershipBoundaryIndex, nearestSubtitleWordBoundaryIndex } from '../../../shared/editing/operations'
import { subtitleEditUnits } from '../../../shared/editing/edit-units'
import { snapSubtitleTimelinePosition } from '../../../shared/editing/subtitle-snap'
import { DEFAULT_SUBTITLE_STYLE, isMediaTrack, type ImportedSubtitleCue, type SubtitleClip, type SubtitleEditUnit, type SubtitleWord, type TimelineClip, type TimelineTrack, type TimeUs } from '../../../shared/types'
import { editorDurationUs, useEditorStore } from '../store'
import { TIMELINE_ZOOM_MAX, TIMELINE_ZOOM_MIN, timelineZoomControlState, trackControlState } from '../action-state'
import { useReviewStore } from '../review-store'
import { previewDiagnosticStore } from '../preview-performance-diagnostics'
import { Button, IconButton } from './Controls'
import { peakCountForPixelWidth, Waveform } from './Waveform'

const seconds = (timeUs: number): number => timeUs / 1_000_000

export interface SubtitleWordGeometry {
  leftPercent: number
  widthPercent: number
}

/** Maps a word's absolute timeline timing to its containing subtitle clip. */
export const subtitleWordGeometry = (
  clip: Pick<SubtitleClip, 'startUs' | 'durationUs'>,
  word: Pick<SubtitleWord, 'startUs' | 'endUs'>
): SubtitleWordGeometry => ({
  leftPercent: ((word.startUs - clip.startUs) / clip.durationUs) * 100,
  widthPercent: ((word.endUs - word.startUs) / clip.durationUs) * 100
})

export const subtitleWordGeometries = (clip: SubtitleClip): Array<SubtitleWordGeometry & { word: SubtitleEditUnit }> =>
  (subtitleEditUnits(clip) ?? []).map((word) => ({ word, ...subtitleWordGeometry(clip, word) }))

export interface SubtitleBoundaryPair {
  left: SubtitleClip
  right: SubtitleClip
}

export const subtitleBoundaryPairs = (track: TimelineTrack): SubtitleBoundaryPair[] => {
  if (track.kind !== 'subtitle') return []
  const pairs: SubtitleBoundaryPair[] = []
  for (let index = 0; index < track.clips.length - 1; index += 1) {
    const left = track.clips[index]
    const right = track.clips[index + 1]
    if (left?.kind === 'subtitle' && right?.kind === 'subtitle' && isSubtitleOwnershipBoundaryAvailable(left, right)) pairs.push({ left, right })
  }
  return pairs
}

export const subtitleBoundaryPositionUs = (pair: SubtitleBoundaryPair): number => {
  const leftEndUs = subtitleEditUnits(pair.left)?.at(-1)?.endUs ?? pair.left.startUs
  const rightStartUs = subtitleEditUnits(pair.right)?.[0]?.startUs ?? pair.right.startUs
  return (leftEndUs + rightStartUs) / 2
}

export interface SubtitleBoundaryGuide {
  subtitleId: string
  side: 'start' | 'end'
  timeUs: TimeUs
  leftPercent: number
}

/** Derives only subtitle cue boundaries that fall inside a video clip. */
export const subtitleBoundaryGuidesForVideoClip = (
  videoClip: Pick<TimelineClip, 'kind' | 'startUs' | 'durationUs'>,
  subtitleClips: readonly Pick<SubtitleClip, 'id' | 'startUs' | 'durationUs'>[]
): SubtitleBoundaryGuide[] => {
  if (videoClip.kind !== 'video' || videoClip.durationUs <= 0) return []
  const videoEndUs = videoClip.startUs + videoClip.durationUs
  const guides: SubtitleBoundaryGuide[] = []
  for (const subtitle of subtitleClips) {
    const boundaries: Array<['start' | 'end', TimeUs]> = [
      ['start', subtitle.startUs],
      ['end', subtitle.startUs + subtitle.durationUs]
    ]
    for (const [side, timeUs] of boundaries) {
      if (timeUs < videoClip.startUs || timeUs > videoEndUs) continue
      guides.push({ subtitleId: subtitle.id, side, timeUs, leftPercent: ((timeUs - videoClip.startUs) / videoClip.durationUs) * 100 })
    }
  }
  return guides
}

export const timelineSplitMenuState = (clip: TimelineClip | undefined, locked = false): { disabled: boolean; label: string } => {
  if (!clip) return { disabled: true, label: '分割対象がありません' }
  if (locked) return { disabled: true, label: 'ロック中のため分割不可' }
  if (clip.kind === 'subtitle') {
    return isSubtitleWordBoundarySplitAvailable(clip)
      ? { disabled: false, label: 'ここで字幕を分割（単語境界）' }
      : { disabled: true, label: '単語境界情報がないため分割不可' }
  }
  return { disabled: false, label: '再生位置で分割' }
}

export interface TimelineFollowScrollInput {
  scrollLeft: number
  clientWidth: number
  scrollWidth: number
  playheadPx: number
  edgeTolerancePx?: number
}

/** Returns the next horizontal scroll position when playback reaches the viewport's right edge. */
export const timelineFollowScrollLeft = (input: TimelineFollowScrollInput): number | null => {
  const { scrollLeft, clientWidth, scrollWidth, playheadPx } = input
  const edgeTolerancePx = input.edgeTolerancePx ?? 1
  if (![scrollLeft, clientWidth, scrollWidth, playheadPx, edgeTolerancePx].every(Number.isFinite)) return null
  if (clientWidth <= 0 || scrollWidth <= clientWidth || edgeTolerancePx < 0) return null
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
  const currentScrollLeft = Math.min(maxScrollLeft, Math.max(0, scrollLeft))
  if (playheadPx < currentScrollLeft + clientWidth - edgeTolerancePx) return null
  const targetScrollLeft = Math.min(maxScrollLeft, Math.max(currentScrollLeft, playheadPx - clientWidth * 0.25))
  return targetScrollLeft > currentScrollLeft + 0.5 ? targetScrollLeft : null
}

export interface TimelineEdgeScrollInput {
  pointerX: number
  viewportLeft: number
  viewportRight: number
  edgeZonePx?: number
  maxStepPx?: number
}

/** Returns a bounded per-frame scroll delta for a pointer held near either viewport edge. */
export const timelineEdgeScrollDelta = (input: TimelineEdgeScrollInput): number => {
  const { pointerX, viewportLeft, viewportRight } = input
  const edgeZonePx = input.edgeZonePx ?? 48
  const maxStepPx = input.maxStepPx ?? 24
  if (![pointerX, viewportLeft, viewportRight, edgeZonePx, maxStepPx].every(Number.isFinite)) return 0
  if (viewportRight <= viewportLeft || edgeZonePx <= 0 || maxStepPx <= 0) return 0
  const leftEdge = viewportLeft + edgeZonePx
  const rightEdge = viewportRight - edgeZonePx
  if (pointerX <= leftEdge) return -maxStepPx * Math.min(1, (leftEdge - pointerX) / edgeZonePx)
  if (pointerX >= rightEdge) return maxStepPx * Math.min(1, (pointerX - rightEdge) / edgeZonePx)
  return 0
}

export interface TimelineScrubMappingInput {
  clientX: number
  laneLeft: number
  scrollLeft: number
  zoomPxPerSecond: number
}

/** Maps a ruler/pointer position to timeline time using the lane's current horizontal scroll. */
export const timelineScrubTimeUs = (input: TimelineScrubMappingInput): number => {
  const { clientX, laneLeft, scrollLeft, zoomPxPerSecond } = input
  if (![clientX, laneLeft, scrollLeft, zoomPxPerSecond].every(Number.isFinite) || zoomPxPerSecond <= 0) return 0
  return Math.max(0, ((clientX - laneLeft + scrollLeft) / zoomPxPerSecond) * 1_000_000)
}

export const isTextEditingTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  return element?.matches('input, textarea, select, [contenteditable="true"]') ?? false
}

export const isOutsideContextMenu = (menu: HTMLElement | null, target: EventTarget | null): boolean =>
  !menu?.contains(target as Node)

const trackGlyph = (kind: TimelineTrack['kind']): string => kind === 'subtitle' ? 'C' : 'V'

const trackLabel = (track: TimelineTrack, tracks: TimelineTrack[]): string => {
  const family = isMediaTrack(track) ? tracks.filter(isMediaTrack) : tracks.filter((candidate) => candidate.kind === 'subtitle')
  const index = Math.max(0, family.findIndex((candidate) => candidate.id === track.id)) + 1
  return `${trackGlyph(track.kind)}${index}`
}

const clipGlyph = (clip: TimelineClip): React.JSX.Element => {
  if (clip.kind === 'subtitle') return <Captions className="clip-type-icon" size={13} aria-hidden="true" />
  if (clip.kind === 'audio') return <Volume2 className="clip-type-icon" size={13} aria-hidden="true" />
  return <span className="clip-type-icon film-glyph" aria-hidden="true">▰</span>
}

/** Keeps clip kind/link/selection styling explicit without changing the clip interaction surface. */
export const timelineClipClassName = (clip: Pick<TimelineClip, 'kind' | 'linkGroupId' | 'enabled'>, selected: boolean): string => [
  'timeline-clip',
  `clip-${clip.kind}`,
  selected ? 'is-selected' : '',
  clip.linkGroupId ? 'is-linked' : '',
  !clip.enabled ? 'is-disabled' : ''
].filter(Boolean).join(' ')

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

interface SubtitleBoundaryDrag {
  leftClipId: string
  rightClipId: string
  initialX: number
  currentX: number
}

interface RazorGhost {
  clipId: string
  timeUs: TimeUs
  boundaryIndex: number
}

export const POINTER_EDIT_DRAG_THRESHOLD_PX = 3

export const shouldCommitPointerEdit = ({
  mode,
  initialX,
  pointerUpX,
  initialTrackId,
  targetTrackId,
  threshold = POINTER_EDIT_DRAG_THRESHOLD_PX
}: {
  mode: PointerEdit['mode']
  initialX: number
  pointerUpX: number
  initialTrackId: string
  targetTrackId: string
  threshold?: number
}): boolean => {
  if (mode === 'move' && targetTrackId !== initialTrackId) return true
  return Math.abs(pointerUpX - initialX) >= threshold
}

export const shouldCommitSubtitleBoundaryDrag = (initialX: number, pointerUpX: number, threshold = POINTER_EDIT_DRAG_THRESHOLD_PX): boolean =>
  Math.abs(pointerUpX - initialX) >= threshold

function TrackControls({ track, tracks }: { track: TimelineTrack; tracks: TimelineTrack[] }): React.JSX.Element {
  const patchTrack = useEditorStore((state) => state.patchTrack)
  const renameTrack = useEditorStore((state) => state.renameTrack)
  const deleteTrack = useEditorStore((state) => state.deleteTrack)
  const reorderTrack = useEditorStore((state) => state.reorderTrack)
  const controls = trackControlState(track, tracks)
  return (
    <div className={`track-header kind-${track.kind}`}>
      <span className="track-index">{trackLabel(track, tracks)}</span>
      <strong title={track.name}>{track.name}</strong>
      <div className="track-controls">
        <IconButton label="トラック名を変更" onClick={() => { const next = window.prompt('トラック名', track.name); if (next !== null) renameTrack(track.id, next) }}><Pencil size={11} /></IconButton>
        <IconButton label={controls.moveUpLabel} disabled={!controls.canMoveUp} onClick={() => reorderTrack(track.id, -1)}><ChevronUp size={11} /></IconButton>
        <IconButton label={controls.moveDownLabel} disabled={!controls.canMoveDown} onClick={() => reorderTrack(track.id, 1)}><ChevronDown size={11} /></IconButton>
        <IconButton label={controls.deleteLabel} disabled={!controls.canDelete} onClick={() => deleteTrack(track.id)}><Trash2 size={11} /></IconButton>
        <IconButton label={track.locked ? 'トラックのロックを解除' : 'トラックをロック'} active={track.locked} onClick={() => patchTrack({ ...track, locked: !track.locked })}>{track.locked ? <Lock size={13} /> : <LockOpen size={13} />}</IconButton>
        <IconButton label={track.muted ? 'ミュートを解除' : 'ミュート'} active={track.muted} onClick={() => patchTrack({ ...track, muted: !track.muted })}>{track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}</IconButton>
        <IconButton label={track.hidden ? 'トラックを表示' : 'トラックを非表示'} active={track.hidden} onClick={() => patchTrack({ ...track, hidden: !track.hidden })}>{track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}</IconButton>
      </div>
    </div>
  )
}

export default function Timeline(): React.JSX.Element {
  const state = useEditorStore()
  previewDiagnosticStore.recordComponentRender('timeline')
  const review = useReviewStore()
  const {
    project,
    selectedClipIds,
    playheadUs,
    playing,
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
    addMediaTrack,
    addSubtitleTrack,
    splitSelected,
    splitSelectedAt,
    moveSubtitleBoundary,
    mergeSubtitleWithPrevious,
    mergeSubtitleWithNext,
    deleteSelected,
    moveSelected,
    trim,
    showNotice,
    applyProject,
    copySelected,
    pasteClipboard,
    duplicateSelected
  } = state
  const viewportRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [pointerEdit, setPointerEdit] = useState<PointerEdit | null>(null)
  const [subtitleBoundaryDrag, setSubtitleBoundaryDrag] = useState<SubtitleBoundaryDrag | null>(null)
  const [razorGhost, setRazorGhost] = useState<RazorGhost | null>(null)
  const [mergeHoverKey, setMergeHoverKey] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clipId: string } | null>(null)
  const [viewportWindow, setViewportWindow] = useState({ scrollLeft: 0, clientWidth: 0 })
  const viewportUpdateRaf = useRef<number | null>(null)
  const durationUs = editorDurationUs(project)
  const timelineWidth = Math.max(900, seconds(durationUs) * zoomPxPerSecond)
  const ticks = useMemo(() => ticksFor(durationUs, zoomPxPerSecond), [durationUs, zoomPxPerSecond])
  const subtitleClips = useMemo(() => project.tracks
    .filter((track) => track.kind === 'subtitle' && !track.hidden)
    .flatMap((track) => track.clips.filter((clip): clip is SubtitleClip => clip.kind === 'subtitle' && clip.enabled)), [project])
  const contextClip = contextMenu ? project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === contextMenu.clipId) : undefined
  const contextTrack = contextClip ? project.tracks.find((track) => track.clips.some((clip) => clip.id === contextClip.id)) : undefined
  const contextSplitMenu = timelineSplitMenuState(contextClip, contextTrack?.locked ?? false)
  const contextSubtitle = contextClip?.kind === 'subtitle' ? findSubtitleContext(project, contextClip.id) : undefined
  const canMergePrevious = Boolean(contextSubtitle?.previous && !contextTrack?.locked)
  const canMergeNext = Boolean(contextSubtitle?.next && !contextTrack?.locked)
  const zoomControls = timelineZoomControlState(zoomPxPerSecond)

  const scheduleViewportWindowUpdate = (): void => {
    const update = (): void => {
      const viewport = viewportRef.current
      if (!viewport) return
      setViewportWindow({ scrollLeft: viewport.scrollLeft, clientWidth: viewport.clientWidth })
    }
    if (typeof window.requestAnimationFrame !== 'function') {
      update()
      return
    }
    if (viewportUpdateRaf.current !== null) return
    viewportUpdateRaf.current = window.requestAnimationFrame(() => {
      viewportUpdateRaf.current = null
      update()
    })
  }

  useLayoutEffect(() => {
    scheduleViewportWindowUpdate()
  }, [timelineWidth, zoomPxPerSecond, project.tracks.length])

  useEffect(() => () => {
    if (viewportUpdateRaf.current !== null) window.cancelAnimationFrame(viewportUpdateRaf.current)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTextEditingTarget(event.target)) return
      const modifier = event.ctrlKey || event.metaKey
      if (!modifier) return
      if (event.key.toLowerCase() === 'c') { event.preventDefault(); copySelected(); setContextMenu(null) }
      if (event.key.toLowerCase() === 'v') { event.preventDefault(); pasteClipboard(); setContextMenu(null) }
      if (event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelected(); setContextMenu(null) }
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (isOutsideContextMenu(contextMenuRef.current, event.target)) setContextMenu(null)
    }
    const onKeyEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setContextMenu(null) }
    const onBlur = (): void => setContextMenu(null)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyEscape)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyEscape)
      window.removeEventListener('blur', onBlur)
    }
  }, [copySelected, duplicateSelected, pasteClipboard])

  useEffect(() => setContextMenu(null), [project.id])

  useLayoutEffect(() => {
    if (!playing) return
    const viewport = viewportRef.current
    if (!viewport) return
    const nextScrollLeft = timelineFollowScrollLeft({
      scrollLeft: viewport.scrollLeft,
      clientWidth: viewport.clientWidth,
      scrollWidth: viewport.scrollWidth,
      playheadPx: (playheadUs / 1_000_000) * zoomPxPerSecond
    })
    if (nextScrollLeft !== null) viewport.scrollLeft = nextScrollLeft
  }, [playing, playheadUs, timelineWidth, zoomPxPerSecond])

  const timeFromPointer = (clientX: number, lane: HTMLElement): number => {
    const bounds = lane.getBoundingClientRect()
    const scrollOffset = lane.classList.contains('timeline-viewport') ? lane.scrollLeft : 0
    return timelineScrubTimeUs({ clientX, laneLeft: bounds.left, scrollLeft: scrollOffset, zoomPxPerSecond })
  }

  const snapTime = (atUs: TimeUs, bypass = false): TimeUs => snapSubtitleTimelinePosition({
    project: useEditorStore.getState().project,
    atUs,
    selectedClipIds: useEditorStore.getState().selectedClipIds,
    reviewEnabled: review.enabled,
    reviewTargetId: review.enabled ? review.targetIds[review.targetIndex] : undefined,
    snapping,
    bypass
  })

  const beginTimelineScrub = (event: React.PointerEvent, lane: HTMLElement, enableEdgeAutoScroll = false): void => {
    event.preventDefault()
    event.stopPropagation()
    const target = event.currentTarget as HTMLElement
    const bypass = event.altKey
    let active = true
    let latestClientX = event.clientX
    let animationFrame: number | null = null
    try { target.setPointerCapture(event.pointerId) } catch { /* synthetic smoke events may not have an active pointer */ }
    const update = (clientX: number): void => setPlayhead(snapTime(timeFromPointer(clientX, lane), bypass))
    update(event.clientX)
    const edgeScroll = (): void => {
      if (!active) return
      const bounds = lane.getBoundingClientRect()
      const delta = timelineEdgeScrollDelta({ pointerX: latestClientX, viewportLeft: bounds.left, viewportRight: bounds.right })
      if (delta !== 0) {
        const before = lane.scrollLeft
        const maxScrollLeft = Math.max(0, lane.scrollWidth - lane.clientWidth)
        const next = Math.min(maxScrollLeft, Math.max(0, before + delta))
        if (next !== before) {
          lane.scrollLeft = next
          update(latestClientX)
        }
      }
      animationFrame = window.requestAnimationFrame(edgeScroll)
    }
    const move = (pointerEvent: PointerEvent): void => {
      latestClientX = pointerEvent.clientX
      update(latestClientX)
    }
    const finish = (pointerEvent: PointerEvent): void => {
      active = false
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
      animationFrame = null
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', finish)
      target.removeEventListener('pointercancel', finish)
      if (target.hasPointerCapture(pointerEvent.pointerId)) target.releasePointerCapture(pointerEvent.pointerId)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', finish)
    target.addEventListener('pointercancel', finish)
    if (enableEdgeAutoScroll) animationFrame = window.requestAnimationFrame(edgeScroll)
  }

  const beginPlayheadDrag = (event: React.PointerEvent): void => {
    const viewport = viewportRef.current
    if (viewport) beginTimelineScrub(event, viewport, true)
  }

  const beginRulerScrub = (event: React.PointerEvent): void => {
    beginTimelineScrub(event, event.currentTarget as HTMLElement)
  }

  const showContextMenu = (event: React.MouseEvent, clip: TimelineClip): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!selectedClipIds.includes(clip.id)) selectClip(clip.id)
    setContextMenu({ x: event.clientX, y: event.clientY, clipId: clip.id })
  }

  const beginSubtitleBoundaryDrag = (event: React.PointerEvent, pair: SubtitleBoundaryPair): void => {
    event.preventDefault()
    event.stopPropagation()
    const target = event.currentTarget as HTMLElement
    try { target.setPointerCapture(event.pointerId) } catch { /* synthetic smoke events may not have an active pointer */ }
    const start: SubtitleBoundaryDrag = { leftClipId: pair.left.id, rightClipId: pair.right.id, initialX: event.clientX, currentX: event.clientX }
    setSubtitleBoundaryDrag(start)
    const move = (pointerEvent: PointerEvent): void => setSubtitleBoundaryDrag((current) => current ? { ...current, currentX: pointerEvent.clientX } : null)
    const finish = (pointerEvent: PointerEvent): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', finish)
      target.removeEventListener('pointercancel', finish)
      if (target.hasPointerCapture(pointerEvent.pointerId)) target.releasePointerCapture(pointerEvent.pointerId)
      setSubtitleBoundaryDrag(null)
      if (!shouldCommitSubtitleBoundaryDrag(start.initialX, pointerEvent.clientX)) return
      const lane = target.closest('.track-lane') as HTMLElement | null
      if (!lane) return
      const projectNow = useEditorStore.getState().project
      const left = projectNow.tracks.flatMap((track) => track.clips).find((clip): clip is SubtitleClip => clip.id === start.leftClipId && clip.kind === 'subtitle')
      const right = projectNow.tracks.flatMap((track) => track.clips).find((clip): clip is SubtitleClip => clip.id === start.rightClipId && clip.kind === 'subtitle')
      if (!left || !right) return
      const boundaryIndex = nearestSubtitleOwnershipBoundaryIndex(left, right, timeFromPointer(pointerEvent.clientX, lane))
      if (boundaryIndex === null) return showNotice('単語境界を解決できないため、字幕の所有権を移動できません。', 'warning')
      moveSubtitleBoundary(left.id, right.id, boundaryIndex)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', finish)
    target.addEventListener('pointercancel', finish)
  }

  const beginPointerEdit = (event: React.PointerEvent, clip: TimelineClip, mode: PointerEdit['mode'], trackId: string): void => {
    event.stopPropagation()
    if (tool === 'razor' && mode === 'move') {
      const lane = event.currentTarget.closest('.track-lane') as HTMLElement | null
      if (!lane || clip.kind !== 'subtitle') return
      const units = subtitleEditUnits(clip)
      const boundaryIndex = units ? nearestSubtitleWordBoundaryIndex(clip, timeFromPointer(event.clientX, lane)) : null
      const boundaryTimeUs = boundaryIndex === null || !units?.[boundaryIndex + 1] ? null : units[boundaryIndex + 1]!.startUs
      if (boundaryIndex === null || boundaryTimeUs === null) return showNotice('字幕の編集境界を解決できません。', 'warning')
      const atUs = snapTime(boundaryTimeUs, event.altKey)
      selectClip(clip.id)
      setPlayhead(atUs)
      useEditorStore.getState().splitSelectedAt(atUs)
      return
    }
    selectClip(clip.id, event.ctrlKey || event.metaKey)
    if (mode === 'move') setPlayhead(clip.startUs)
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
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      const latestTrackId = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)?.closest('.track-lane')?.getAttribute('data-track-id') ?? start.targetTrackId
      if (!shouldCommitPointerEdit({
        mode,
        initialX: start.initialX,
        pointerUpX: pointerEvent.clientX,
        initialTrackId: start.targetTrackId,
        targetTrackId: latestTrackId
      })) {
        setPointerEdit(null)
        return
      }
      const deltaUs = ((pointerEvent.clientX - start.initialX) / zoomPxPerSecond) * 1_000_000
      if (mode === 'move') moveSelected(clip.id, latestTrackId, start.initialStartUs + deltaUs)
      else if (mode === 'trim-start') trim(clip.id, 'start', start.initialStartUs + deltaUs)
      else trim(clip.id, 'end', start.initialStartUs + start.initialDurationUs + deltaUs)
      setPointerEdit(null)
    }
    const cancel = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      setPointerEdit(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
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
    applyProject(layoutSubtitleTracks(next))
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
          <Button className="subtle-button" onClick={addMediaTrack}><Plus size={14} />Vトラック</Button>
          <Button className="subtle-button" onClick={addSubtitleTrack}><Plus size={14} />Cトラック</Button>
          <Button className="subtle-button" onClick={addSubtitle}><Captions size={14} />字幕を追加</Button>
          <IconButton label={selectedClipIds.length ? '再生位置で分割（Ctrl+K）' : '再生位置で分割（クリップを選択してください）'} disabled={!selectedClipIds.length} onClick={splitSelected}><Scissors size={16} /></IconButton>
          <IconButton label={selectedClipIds.length ? (rippleMode ? '選択クリップを自動詰め削除' : '選択クリップを削除') : '選択クリップを削除（クリップを選択してください）'} disabled={!selectedClipIds.length} onClick={() => deleteSelected()}><Trash2 size={16} /></IconButton>
          <span className="toolbar-separator" />
          <IconButton label={zoomControls.canZoomOut ? 'タイムラインを縮小' : `タイムラインを縮小（最小${TIMELINE_ZOOM_MIN}px/秒）`} disabled={!zoomControls.canZoomOut} onClick={() => setZoom(zoomPxPerSecond - 12)}><ZoomOut size={15} /></IconButton>
          <input className="zoom-slider" type="range" min={TIMELINE_ZOOM_MIN} max={TIMELINE_ZOOM_MAX} value={zoomPxPerSecond} onChange={(event) => setZoom(Number(event.target.value))} aria-label="タイムラインの拡大率" />
          <IconButton label={zoomControls.canZoomIn ? 'タイムラインを拡大' : `タイムラインを拡大（最大${TIMELINE_ZOOM_MAX}px/秒）`} disabled={!zoomControls.canZoomIn} onClick={() => setZoom(zoomPxPerSecond + 12)}><ZoomIn size={15} /></IconButton>
        </div>
      </header>
      <div className="timeline-shell">
        <div className="track-labels" ref={labelsRef} style={{ '--track-count': project.tracks.length } as React.CSSProperties} onScroll={(event) => { if (viewportRef.current) viewportRef.current.scrollTop = event.currentTarget.scrollTop }}>
          <div className="ruler-corner"><Plus size={14} /><span>トラック</span></div>
          {project.tracks.map((track) => <TrackControls key={track.id} track={track} tracks={project.tracks} />)}
        </div>
        <div
          className="timeline-viewport"
          ref={viewportRef}
          onScroll={(event) => { if (labelsRef.current) labelsRef.current.scrollTop = event.currentTarget.scrollTop; scheduleViewportWindowUpdate() }}
          onWheel={(event) => {
            if (event.ctrlKey || event.metaKey) {
              event.preventDefault()
              setZoom(zoomPxPerSecond + (event.deltaY < 0 ? 8 : -8))
              return
            }
            event.currentTarget.scrollLeft += event.deltaX + event.deltaY
          }}
        >
          <div className="timeline-content" style={{ width: timelineWidth, '--track-count': project.tracks.length } as React.CSSProperties}>
            <div
              className="time-ruler"
              onPointerDown={beginRulerScrub}
            >
              {ticks.map((tick) => <span key={tick} style={{ left: tick * zoomPxPerSecond }}><i />{formatTimecode(tick * 1_000_000, project).slice(3, 8)}</span>)}
            </div>
            {project.tracks.map((track) => (
              <div
                key={track.id}
                className={`track-lane kind-${track.kind} ${track.locked ? 'is-locked' : ''}`}
                data-track-id={track.id}
                onPointerDown={(event) => {
                  setContextMenu(null)
                  if (event.target === event.currentTarget) {
                    setPlayhead(snapTime(timeFromPointer(event.clientX, event.currentTarget), event.altKey))
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
                {subtitleBoundaryPairs(track).map((pair) => {
                  const boundaryUs = subtitleBoundaryPositionUs(pair)
                  const dragging = subtitleBoundaryDrag?.leftClipId === pair.left.id && subtitleBoundaryDrag.rightClipId === pair.right.id
                  const visualLeft = (boundaryUs / 1_000_000) * zoomPxPerSecond + (dragging ? subtitleBoundaryDrag.currentX - subtitleBoundaryDrag.initialX : 0)
                  const pairKey = `${pair.left.id}:${pair.right.id}`
                  const mergeAllowed = !track.locked
                  return <div
                    key={pairKey}
                    className="subtitle-boundary-zone"
                    style={{ left: visualLeft }}
                    onPointerEnter={() => setMergeHoverKey(pairKey)}
                    onPointerLeave={() => setMergeHoverKey((current) => current === pairKey ? null : current)}
                  >
                    <button
                      type="button"
                      className={`subtitle-boundary-handle${dragging ? ' is-dragging' : ''}`}
                      aria-label="字幕の編集境界を移動"
                      title="字幕の編集境界をドラッグ"
                      onPointerDown={(event) => beginSubtitleBoundaryDrag(event, pair)}
                    />
                    {mergeHoverKey === pairKey ? <button
                      type="button"
                      className="subtitle-merge-control"
                      disabled={!mergeAllowed}
                      aria-label="隣接する字幕を結合"
                      title={mergeAllowed ? '隣接する字幕を結合' : 'ロック中のため結合不可'}
                      onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }}
                      onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (mergeAllowed) mergeSubtitleWithNext(pair.left.id) }}
                    >結合</button> : null}
                  </div>
                })}
                {track.clips.map((clip) => {
                  const edit = pointerEdit?.clipId === clip.id ? pointerEdit : null
                  const deltaPx = edit?.deltaX ?? 0
                  const visualLeft = clip.startUs / 1_000_000 * zoomPxPerSecond + (edit?.mode === 'move' ? deltaPx : edit?.mode === 'trim-start' ? deltaPx : 0)
                  const visualWidth = clip.durationUs / 1_000_000 * zoomPxPerSecond + (edit?.mode === 'trim-start' ? -deltaPx : edit?.mode === 'trim-end' ? deltaPx : 0)
                  const selected = selectedClipIds.includes(clip.id)
                  const clipKindLabel = clip.kind === 'subtitle' ? '字幕' : clip.kind === 'audio' ? '音声' : '映像'
                  const viewportWidth = viewportWindow.clientWidth > 0 ? viewportWindow.clientWidth : 900
                  const clipVisible = visualLeft + visualWidth >= viewportWindow.scrollLeft - 128 && visualLeft <= viewportWindow.scrollLeft + viewportWidth + 128
                  const subtitleGuides = clip.kind === 'video' && !edit && clipVisible
                    ? subtitleBoundaryGuidesForVideoClip(clip, subtitleClips)
                    : []
                  return (
                    <div
                      key={clip.id}
                      className={`${timelineClipClassName(clip, selected)}${edit ? ' is-dragging' : ''}`}
                      style={{ left: Math.max(0, visualLeft), width: Math.max(8, visualWidth) }}
                      onPointerDown={(event) => beginPointerEdit(event, clip, 'move', track.id)}
                      onPointerMove={(event) => {
                        if (tool !== 'razor' || clip.kind !== 'subtitle') return
                        const units = subtitleEditUnits(clip)
                        const lane = event.currentTarget.closest('.track-lane') as HTMLElement | null
                        const index = lane && units ? nearestSubtitleWordBoundaryIndex(clip, timeFromPointer(event.clientX, lane)) : null
                        const timeUs = index === null || !units?.[index + 1] ? null : units[index + 1]!.startUs
                        setRazorGhost(timeUs === null || index === null ? null : { clipId: clip.id, timeUs, boundaryIndex: index })
                      }}
                      onPointerLeave={() => setRazorGhost((current) => current?.clipId === clip.id ? null : current)}
                      onContextMenu={(event) => showContextMenu(event, clip)}
                      title={`${clip.name}\n${seconds(clip.durationUs).toFixed(2)} 秒\n右クリックで編集操作`}
                      aria-label={`${clipKindLabel}: ${clip.kind === 'subtitle' ? clip.text : clip.name}${clip.linkGroupId ? '（リンク済み）' : ''}`}
                    >
                      <button type="button" className="trim-handle trim-start" aria-label="開始位置をトリム" onPointerDown={(event) => beginPointerEdit(event, clip, 'trim-start', track.id)} />
                      {clip.kind === 'subtitle' && clip.words?.length ? (
                        <div className="subtitle-word-layer" aria-hidden="true">
                          {subtitleWordGeometries(clip).map(({ word, leftPercent, widthPercent }) => (
                            <span
                              key={word.id}
                              className="subtitle-word-unit"
                              data-word-id={word.id}
                              style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
                              title={`${word.text}\n${seconds(word.startUs).toFixed(3)}–${seconds(word.endUs).toFixed(3)} 秒`}
                            >
                              {word.text}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {subtitleGuides.map((guide) => <span
                        key={`${guide.subtitleId}:${guide.side}`}
                        className={`subtitle-boundary-guide is-${guide.side}`}
                        style={{ left: `${guide.leftPercent}%` }}
                        data-subtitle-id={guide.subtitleId}
                        data-boundary-side={guide.side}
                        aria-hidden="true"
                      />)}
                      <span className="clip-content">{clipGlyph(clip)}{clip.linkGroupId ? <Link2 className="clip-link-icon" size={12} aria-label="リンクされたクリップ" /> : null}<strong>{clip.kind === 'subtitle' ? clip.text : clip.name}</strong></span>
                      {razorGhost?.clipId === clip.id ? <span
                        className="subtitle-razor-ghost"
                        style={{ left: `${((razorGhost.timeUs - clip.startUs) / clip.durationUs) * 100}%` }}
                        aria-label="字幕の分割候補"
                        title="ここで字幕を分割"
                      /> : null}
                      {clip.kind === 'audio' || clip.kind === 'video' ? <Waveform asset={project.media.find((asset) => asset.id === clip.assetId)} clip={clip} peakCount={peakCountForPixelWidth(visualWidth)} /> : null}
                      <button type="button" className="trim-handle trim-end" aria-label="終了位置をトリム" onPointerDown={(event) => beginPointerEdit(event, clip, 'trim-end', track.id)} />
                    </div>
                  )
                })}
              </div>
            ))}
            <div className="playhead-hit-area" style={{ left: playheadUs / 1_000_000 * zoomPxPerSecond }} onPointerDown={beginPlayheadDrag} aria-label={`再生位置 ${formatTimecode(playheadUs, project)}`}><i className="playhead" /></div>
          </div>
        </div>
      </div>
      {contextMenu && (
        <div ref={contextMenuRef} className="timeline-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            disabled={contextSplitMenu.disabled}
            onClick={() => {
              const atUs = timeFromPointer(contextMenu.x, viewportRef.current!)
              setPlayhead(atUs)
              splitSelectedAt(atUs)
              setContextMenu(null)
            }}
          >{contextSplitMenu.label}</button>
          {contextClip?.kind === 'subtitle' ? <>
            <button type="button" disabled={!canMergePrevious} onClick={() => { mergeSubtitleWithPrevious(contextClip.id); setContextMenu(null) }}>前の字幕と結合</button>
            <button type="button" disabled={!canMergeNext} onClick={() => { mergeSubtitleWithNext(contextClip.id); setContextMenu(null) }}>次の字幕と結合</button>
          </> : null}
          <button type="button" disabled={contextTrack?.locked ?? false} onClick={() => { deleteSelected(false); setContextMenu(null) }}>削除</button>
          <button type="button" disabled={contextTrack?.locked ?? false} onClick={() => { deleteSelected(true); setContextMenu(null) }}>リップル削除</button>
          <button type="button" onClick={() => { copySelected(); setContextMenu(null) }}>コピー</button>
          <button type="button" onClick={() => { pasteClipboard(); setContextMenu(null) }}>貼り付け</button>
          <button type="button" onClick={() => { duplicateSelected(); setContextMenu(null) }}>複製</button>
        </div>
      )}
      <footer className="timeline-footer">
        <span><i className="status-dot" />自動保存オン</span>
        <span>選択: {selectedClipIds.length} クリップ</span>
        <code>{formatTimecode(playheadUs, project)} / {formatTimecode(durationUs, project)}</code>
      </footer>
    </section>
  )
}
