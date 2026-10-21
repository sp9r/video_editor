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
import { createTrack, findSubtitleContext, formatTimecode, makeId, snapUsToFrame, subtitleOverlaps } from '../../../shared/project'
import { isSubtitleOwnershipBoundaryAvailable, isSubtitleWordBoundarySplitAvailable, nearestSubtitleOwnershipBoundaryIndex, nearestSubtitleWordBoundaryIndex } from '../../../shared/editing/operations'
import { subtitleEditUnits } from '../../../shared/editing/edit-units'
import { snapSubtitleTimelinePosition } from '../../../shared/editing/subtitle-snap'
import { clipSnapTargets, clipSnapThresholdUs, snapClipEdge, snapClipMove } from '../../../shared/editing/clip-snap'
import { DEFAULT_SUBTITLE_STYLE, isMediaTrack, type ImportedSubtitleCue, type SubtitleClip, type SubtitleEditUnit, type SubtitleWord, type TimelineClip, type TimelineTrack, type TimeUs } from '../../../shared/types'
import { editorDurationUs, useEditorStore } from '../store'
import { TIMELINE_ZOOM_MAX, TIMELINE_ZOOM_MIN, clampTimelineZoom, shortcutTargetKind, timelineZoomControlState, timelineZoomScrollLeft, trackControlState } from '../action-state'
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

export interface InlineSubtitleBlock {
  subtitleId: string
  text: string
  leftPercent: number
  widthPercent: number
  startUs: TimeUs
  endUs: TimeUs
}

export interface CaptionRailUnitGeometry {
  unit: SubtitleEditUnit
  leftPercent: number
  widthPercent: number
}

/** Projects word/edit-unit timing into the compact caption rail cue. */
export const captionRailUnitGeometries = (
  block: Pick<InlineSubtitleBlock, 'startUs' | 'endUs'>,
  subtitle: Pick<SubtitleClip, 'editUnits' | 'words' | 'text' | 'startUs' | 'durationUs'>
): CaptionRailUnitGeometry[] => {
  const durationUs = block.endUs - block.startUs
  if (durationUs <= 0) return []
  return (subtitleEditUnits({ ...subtitle, kind: 'subtitle' } as SubtitleClip) ?? []).flatMap((unit) => {
    const startUs = Math.max(block.startUs, unit.startUs)
    const endUs = Math.min(block.endUs, unit.endUs)
    if (endUs <= startUs) return []
    return [{
      unit,
      leftPercent: ((startUs - block.startUs) / durationUs) * 100,
      widthPercent: ((endUs - startUs) / durationUs) * 100
    }]
  })
}

/** Derives compact subtitle cues inside a video clip without creating a link. */
export const inlineSubtitleBlocksForVideoClip = (
  videoClip: Pick<TimelineClip, 'kind' | 'startUs' | 'durationUs'>,
  subtitleClips: readonly Pick<SubtitleClip, 'id' | 'text' | 'startUs' | 'durationUs' | 'enabled'>[]
): InlineSubtitleBlock[] => {
  if (videoClip.kind !== 'video' || videoClip.durationUs <= 0) return []
  const videoEndUs = videoClip.startUs + videoClip.durationUs
  return subtitleClips.flatMap((subtitle) => {
    if (!subtitle.enabled || subtitle.durationUs <= 0) return []
    const subtitleEndUs = subtitle.startUs + subtitle.durationUs
    const startUs = Math.max(videoClip.startUs, subtitle.startUs)
    const endUs = Math.min(videoEndUs, subtitleEndUs)
    if (endUs <= startUs) return []
    return [{
      subtitleId: subtitle.id,
      text: subtitle.text,
      leftPercent: ((startUs - videoClip.startUs) / videoClip.durationUs) * 100,
      widthPercent: ((endUs - startUs) / videoClip.durationUs) * 100,
      startUs,
      endUs
    }]
  })
}

export const timelineCandidateRelationIds = (
  focusedClip: Pick<TimelineClip, 'id' | 'kind' | 'startUs' | 'durationUs'>,
  clips: readonly Pick<TimelineClip, 'id' | 'kind' | 'startUs' | 'durationUs'>[]
): string[] => {
  if ((focusedClip.kind !== 'video' && focusedClip.kind !== 'subtitle') || focusedClip.durationUs <= 0) return []
  const focusedEndUs = focusedClip.startUs + focusedClip.durationUs
  return clips
    .filter((candidate) => candidate.id !== focusedClip.id && candidate.kind !== focusedClip.kind && (candidate.kind === 'video' || candidate.kind === 'subtitle') && candidate.durationUs > 0)
    .filter((candidate) => candidate.startUs < focusedEndUs && candidate.startUs + candidate.durationUs > focusedClip.startUs)
    .map((candidate) => candidate.id)
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

/** True when the focused element needs native clipboard/typing keys (text, number, textarea, select). */
export const isTextEditingTarget = (target: EventTarget | null): boolean => shortcutTargetKind(target) === 'text'

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

export const ticksFor = (durationUs: number, zoom: number): number[] => {
  const durationSeconds = Math.max(0, Math.ceil(seconds(durationUs)))
  const preferredInterval = zoom >= 110 ? 1 : zoom >= 55 ? 2 : 5
  // Keep ruler DOM bounded for long sources at high zoom without hiding the
  // fine-grained ruler on normal-length clips.
  const maxTickCount = 2_000
  const interval = Math.max(preferredInterval, Math.ceil(durationSeconds / (maxTickCount - 1)))
  const result: number[] = []
  for (let second = 0; second <= durationSeconds; second += interval) result.push(second)
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
  /** Pointer delta in time after snapping; the live preview and the commit both use this. */
  deltaUs: number
  snapTimeUs: number | null
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
  const [hoveredClipId, setHoveredClipId] = useState<string | null>(null)
  const [showSubtitleDetails, setShowSubtitleDetails] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; clipId: string } | null>(null)
  const [viewportWindow, setViewportWindow] = useState({ scrollLeft: 0, clientWidth: 0 })
  const viewportUpdateRaf = useRef<number | null>(null)
  const durationUs = editorDurationUs(project)
  const timelineWidth = Math.max(900, seconds(durationUs) * zoomPxPerSecond)
  const ticks = useMemo(() => ticksFor(durationUs, zoomPxPerSecond), [durationUs, zoomPxPerSecond])
  const subtitleClips = useMemo(() => project.tracks
    .filter((track) => track.kind === 'subtitle' && !track.hidden && !track.muted)
    .flatMap((track) => track.clips.filter((clip): clip is SubtitleClip => clip.kind === 'subtitle' && clip.enabled)), [project])
  const subtitleBoundaryPairsByClipId = useMemo(() => {
    const pairs = new Map<string, SubtitleBoundaryPair>()
    for (const track of project.tracks.filter((candidate) => candidate.kind === 'subtitle' && !candidate.hidden && !candidate.muted)) {
      for (const pair of subtitleBoundaryPairs(track)) {
        pairs.set(pair.left.id, pair)
        pairs.set(pair.right.id, pair)
      }
    }
    return pairs
  }, [project.tracks])
  const visibleTracks = useMemo(() => showSubtitleDetails ? project.tracks : project.tracks.filter((track) => track.kind !== 'subtitle'), [project.tracks, showSubtitleDetails])
  const captionRailTrackIds = useMemo(() => new Set(project.tracks
    .filter((track) => isMediaTrack(track))
    .filter((track) => track.clips.some((clip) => clip.kind === 'video' && inlineSubtitleBlocksForVideoClip(clip, subtitleClips).length > 0))
    .map((track) => track.id)), [project.tracks, subtitleClips])
  const timelineGridRows = `26px ${visibleTracks.map((track) => captionRailTrackIds.has(track.id) ? '68px' : '56px').join(' ')}`
  const candidateRelationClips = useMemo(() => project.tracks
    .filter((track) => !track.hidden)
    .flatMap((track) => track.clips.filter((clip) => (clip.kind === 'video' || clip.kind === 'subtitle') && clip.enabled)), [project])
  const candidateFocusIds = hoveredClipId ? [hoveredClipId] : selectedClipIds
  const candidateRelationIds = useMemo(() => {
    const related = new Set<string>()
    for (const focusId of candidateFocusIds) {
      const focus = candidateRelationClips.find((clip) => clip.id === focusId)
      if (!focus) continue
      related.add(focus.id)
      for (const id of timelineCandidateRelationIds(focus, candidateRelationClips)) related.add(id)
    }
    return related
  }, [candidateFocusIds, candidateRelationClips])
  const contextClip = contextMenu ? project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === contextMenu.clipId) : undefined
  const contextTrack = contextClip ? project.tracks.find((track) => track.clips.some((clip) => clip.id === contextClip.id)) : undefined
  const contextSplitMenu = timelineSplitMenuState(contextClip, contextTrack?.locked ?? false)
  const contextSubtitle = contextClip?.kind === 'subtitle' ? findSubtitleContext(project, contextClip.id) : undefined
  const canMergePrevious = Boolean(contextSubtitle?.previous && !contextTrack?.locked)
  const canMergeNext = Boolean(contextSubtitle?.next && !contextTrack?.locked)
  const zoomControls = timelineZoomControlState(zoomPxPerSecond)

  const zoomTimeline = (requestedZoom: number): void => {
    const nextZoom = clampTimelineZoom(requestedZoom)
    const viewport = viewportRef.current
    if (!viewport || nextZoom === zoomPxPerSecond) {
      setZoom(nextZoom)
      return
    }
    const oldScrollLeft = viewport.scrollLeft
    const viewportWidth = viewport.clientWidth
    const nextContentWidth = Math.max(900, seconds(durationUs) * nextZoom)
    setZoom(nextZoom)
    const applyScrollCorrection = (): void => {
      const currentViewport = viewportRef.current
      if (!currentViewport) return
      const nextScrollLeft = timelineZoomScrollLeft({
        scrollLeft: oldScrollLeft,
        viewportWidth: viewportWidth || currentViewport.clientWidth,
        nextContentWidth,
        oldZoom: zoomPxPerSecond,
        newZoom: nextZoom,
        anchorTimeUs: playheadUs
      })
      if (nextScrollLeft === null || Math.abs(currentViewport.scrollLeft - nextScrollLeft) <= 0.5) return
      currentViewport.scrollLeft = nextScrollLeft
      scheduleViewportWindowUpdate()
    }
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(applyScrollCorrection)
    else applyScrollCorrection()
  }

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

  /** Pointer position as a timeline time: whole frames (Alt = free), or an exact caption snap target. */
  const pointerTimeUs = (clientX: number, lane: HTMLElement, bypass: boolean): TimeUs => {
    const rawUs = timeFromPointer(clientX, lane)
    const snappedUs = snapTime(rawUs, bypass)
    return snappedUs !== rawUs || bypass ? snappedUs : snapUsToFrame(rawUs, useEditorStore.getState().project)
  }

  const beginTimelineScrub = (event: React.PointerEvent, lane: HTMLElement, enableEdgeAutoScroll = false): void => {
    event.preventDefault()
    event.stopPropagation()
    const target = event.currentTarget as HTMLElement
    const bypass = event.altKey
    let active = true
    let latestClientX = event.clientX
    let animationFrame: number | null = null
    try { target.setPointerCapture(event.pointerId) } catch { /* synthetic smoke events may not have an active pointer */ }
    const update = (clientX: number): void => setPlayhead(pointerTimeUs(clientX, lane, bypass))
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
      if (!lane) return
      if (clip.kind !== 'subtitle') {
        // Razor on a video/audio/image clip cuts it (and its linked partners) at the click position.
        const atUs = pointerTimeUs(event.clientX, lane, event.altKey)
        selectClip(clip.id)
        setPlayhead(atUs)
        useEditorStore.getState().splitSelectedAt(atUs)
        return
      }
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
    // Selecting a clip shows it in the monitor, but must not pull the playhead
    // out of the clip: "place playhead, click clip, Ctrl+K" has to split there.
    const currentPlayheadUs = useEditorStore.getState().playheadUs
    if (mode === 'move' && !(currentPlayheadUs >= clip.startUs && currentPlayheadUs < clip.startUs + clip.durationUs)) setPlayhead(clip.startUs)
    const targets = clipSnapTargets(useEditorStore.getState().project, { excludeClipIds: [clip.id], playheadUs: useEditorStore.getState().playheadUs })
    const thresholdUs = clipSnapThresholdUs(zoomPxPerSecond)
    // One function for preview and commit so that what is shown before release is what is applied.
    const resolve = (clientX: number, altKey: boolean): { deltaUs: number; snapTimeUs: number | null } => {
      const rawDeltaUs = ((clientX - event.clientX) / zoomPxPerSecond) * 1_000_000
      if (altKey || !useEditorStore.getState().snapping) return { deltaUs: rawDeltaUs, snapTimeUs: null }
      if (mode === 'move') {
        const snapped = snapClipMove({ startUs: clip.startUs + rawDeltaUs, durationUs: clip.durationUs, targets, thresholdUs })
        return snapped ? { deltaUs: snapped.timeUs - clip.startUs, snapTimeUs: snapped.target.timeUs } : { deltaUs: rawDeltaUs, snapTimeUs: null }
      }
      const baseUs = mode === 'trim-start' ? clip.startUs : clip.startUs + clip.durationUs
      const snapped = snapClipEdge({ timeUs: Math.max(0, baseUs + rawDeltaUs), targets, thresholdUs })
      return snapped ? { deltaUs: snapped.timeUs - baseUs, snapTimeUs: snapped.timeUs } : { deltaUs: rawDeltaUs, snapTimeUs: null }
    }
    const start: PointerEdit = {
      clipId: clip.id,
      mode,
      initialX: event.clientX,
      deltaX: 0,
      initialStartUs: clip.startUs,
      initialDurationUs: clip.durationUs,
      targetTrackId: trackId,
      deltaUs: 0,
      snapTimeUs: null
    }
    setPointerEdit(start)
    const move = (pointerEvent: PointerEvent): void => {
      const lane = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)?.closest('.track-lane') as HTMLElement | null
      const resolved = resolve(pointerEvent.clientX, pointerEvent.altKey)
      setPointerEdit((current) => current ? { ...current, deltaX: pointerEvent.clientX - current.initialX, ...resolved, targetTrackId: lane?.dataset.trackId ?? current.targetTrackId } : null)
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
      const { deltaUs, snapTimeUs } = resolve(pointerEvent.clientX, pointerEvent.altKey)
      const exact = snapTimeUs !== null
      if (mode === 'move') moveSelected(clip.id, latestTrackId, start.initialStartUs + deltaUs, exact)
      else if (mode === 'trim-start') trim(clip.id, 'start', start.initialStartUs + deltaUs, exact)
      else trim(clip.id, 'end', start.initialStartUs + start.initialDurationUs + deltaUs, exact)
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
    let cues: ImportedSubtitleCue[] | null
    try {
      cues = await window.spectra.importSubtitles()
    } catch (error) {
      showNotice(`字幕ファイルを読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }
    if (!cues?.length) return
    // The file dialog is asynchronous: always work on the project as it is now.
    const currentProject = useEditorStore.getState().project
    const subtitleTracks = currentProject.tracks.filter((track) => track.kind === 'subtitle')
    if (subtitleTracks.length && subtitleTracks.every((track) => track.locked)) return showNotice('字幕トラックがロックされています。ロックを解除してから読み込んでください。', 'warning')
    const usable = cues.filter((cue) => Number.isFinite(cue.startUs) && Number.isFinite(cue.endUs) && cue.startUs >= 0)
    if (!usable.length) return showNotice('字幕ファイルに有効な時刻のキューがありませんでした。', 'warning')
    const next = structuredClone(currentProject)
    // Existing captions stay where they are; each cue goes to the first unlocked
    // caption track where it does not overlap, otherwise to a new caption track.
    const editable = next.tracks.filter((track) => track.kind === 'subtitle' && !track.locked)
    for (const cue of usable) {
      const clip: SubtitleClip = {
        id: makeId('caption'),
        name: cue.text.slice(0, 24) || '字幕',
        kind: 'subtitle',
        startUs: Math.round(cue.startUs),
        durationUs: Math.max(33_333, Math.round(cue.endUs - cue.startUs)),
        sourceInUs: 0,
        enabled: true,
        text: cue.text,
        style: structuredClone(DEFAULT_SUBTITLE_STYLE)
      }
      let target = editable.find((track) => track.clips.every((existing) => existing.kind !== 'subtitle' || !subtitleOverlaps(existing, clip)))
      if (!target) {
        target = createTrack('subtitle', next.tracks.filter((track) => track.kind === 'subtitle').length + 1)
        next.tracks.push(target)
        editable.push(target)
      }
      target.clips.push(clip)
    }
    for (const track of editable) track.clips.sort((a, b) => a.startUs - b.startUs)
    applyProject(next)
    showNotice(`${usable.length}件の字幕を読み込みました${usable.length < cues.length ? `（時刻が不正な${cues.length - usable.length}件は除外）` : ''}。`, 'success')
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
          <Button className={`subtle-button${showSubtitleDetails ? ' is-active' : ''}`} aria-pressed={showSubtitleDetails} onClick={() => setShowSubtitleDetails((current) => !current)}>{showSubtitleDetails ? '字幕詳細 ON' : '字幕詳細'}</Button>
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
          <IconButton label={selectedClipIds.length ? '再生位置で分割（Ctrl+K）' : '再生位置で分割（Ctrl+K・未選択なら再生ヘッド上のクリップをすべて分割）'} onClick={splitSelected}><Scissors size={16} /></IconButton>
          <IconButton label={selectedClipIds.length ? (rippleMode ? '選択クリップを自動詰め削除' : '選択クリップを削除') : '選択クリップを削除（クリップを選択してください）'} disabled={!selectedClipIds.length} onClick={() => deleteSelected()}><Trash2 size={16} /></IconButton>
          <span className="toolbar-separator" />
          <IconButton label={zoomControls.canZoomOut ? 'タイムラインを縮小' : `タイムラインを縮小（最小${TIMELINE_ZOOM_MIN}px/秒）`} disabled={!zoomControls.canZoomOut} onClick={() => zoomTimeline(zoomPxPerSecond - 12)}><ZoomOut size={15} /></IconButton>
          <input className="zoom-slider" type="range" min={TIMELINE_ZOOM_MIN} max={TIMELINE_ZOOM_MAX} value={zoomPxPerSecond} onChange={(event) => zoomTimeline(Number(event.target.value))} aria-label="タイムラインの拡大率" />
          <IconButton label={zoomControls.canZoomIn ? 'タイムラインを拡大' : `タイムラインを拡大（最大${TIMELINE_ZOOM_MAX}px/秒）`} disabled={!zoomControls.canZoomIn} onClick={() => zoomTimeline(zoomPxPerSecond + 12)}><ZoomIn size={15} /></IconButton>
        </div>
      </header>
      <div className="timeline-shell">
        <div className="track-labels" ref={labelsRef} style={{ '--track-count': visibleTracks.length, gridTemplateRows: timelineGridRows } as React.CSSProperties} onScroll={(event) => { if (viewportRef.current) viewportRef.current.scrollTop = event.currentTarget.scrollTop }}>
          <div className="ruler-corner"><Plus size={14} /><span>トラック</span></div>
          {visibleTracks.map((track) => <TrackControls key={track.id} track={track} tracks={project.tracks} />)}
        </div>
        <div
          className="timeline-viewport"
          ref={viewportRef}
          onScroll={(event) => { if (labelsRef.current) labelsRef.current.scrollTop = event.currentTarget.scrollTop; scheduleViewportWindowUpdate() }}
          onWheel={(event) => {
            if (event.ctrlKey || event.metaKey) {
              event.preventDefault()
              zoomTimeline(zoomPxPerSecond + (event.deltaY < 0 ? 8 : -8))
              return
            }
            event.currentTarget.scrollLeft += event.deltaX + event.deltaY
          }}
        >
          <div className="timeline-content" style={{ width: timelineWidth, '--track-count': visibleTracks.length, gridTemplateRows: timelineGridRows } as React.CSSProperties}>
            <div
              className="time-ruler"
              onPointerDown={beginRulerScrub}
            >
              {ticks.map((tick) => <span key={tick} style={{ left: tick * zoomPxPerSecond }}><i />{formatTimecode(tick * 1_000_000, project).slice(3, 8)}</span>)}
            </div>
            {visibleTracks.map((track) => (
              <div
                key={track.id}
                className={`track-lane kind-${track.kind} ${track.locked ? 'is-locked' : ''}`}
                data-track-id={track.id}
                onPointerDown={(event) => {
                  setContextMenu(null)
                  if (event.target === event.currentTarget) {
                    setPlayhead(pointerTimeUs(event.clientX, event.currentTarget, event.altKey))
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
                  const deltaPx = edit ? edit.deltaUs / 1_000_000 * zoomPxPerSecond : 0
                  const visualLeft = clip.startUs / 1_000_000 * zoomPxPerSecond + (edit?.mode === 'move' ? deltaPx : edit?.mode === 'trim-start' ? deltaPx : 0)
                  const visualWidth = clip.durationUs / 1_000_000 * zoomPxPerSecond + (edit?.mode === 'trim-start' ? -deltaPx : edit?.mode === 'trim-end' ? deltaPx : 0)
                  const selected = selectedClipIds.includes(clip.id)
                  const candidateSource = candidateRelationIds.has(clip.id) && candidateFocusIds.includes(clip.id)
                  const candidateRelated = candidateRelationIds.has(clip.id) && !candidateSource
                  const clipKindLabel = clip.kind === 'subtitle' ? '字幕' : clip.kind === 'audio' ? '音声' : '映像'
                  const viewportWidth = viewportWindow.clientWidth > 0 ? viewportWindow.clientWidth : 900
                  const clipVisible = visualLeft + visualWidth >= viewportWindow.scrollLeft - 128 && visualLeft <= viewportWindow.scrollLeft + viewportWidth + 128
                  const subtitleGuides = clip.kind === 'video' && !edit && clipVisible
                    ? subtitleBoundaryGuidesForVideoClip(clip, subtitleClips)
                    : []
                  const inlineSubtitleBlocks = !showSubtitleDetails && clip.kind === 'video' && !edit && clipVisible
                    ? inlineSubtitleBlocksForVideoClip(clip, subtitleClips)
                    : []
                  const hasCaptionRail = inlineSubtitleBlocks.length > 0
                  return (
                    <div
                      key={clip.id}
                      className={`${timelineClipClassName(clip, selected)}${edit ? ' is-dragging' : ''}${hasCaptionRail ? ' has-caption-rail' : ''}${candidateSource ? ' is-candidate-source' : ''}${candidateRelated ? ' is-candidate-related' : ''}`}
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
                      onPointerEnter={() => {
                        if (clip.kind === 'video' || clip.kind === 'subtitle') setHoveredClipId(clip.id)
                      }}
                      onPointerLeave={() => {
                        setHoveredClipId((current) => current === clip.id ? null : current)
                        setRazorGhost((current) => current?.clipId === clip.id ? null : current)
                      }}
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
                      {hasCaptionRail ? <div className="timeline-caption-rail" aria-label="キャプションレール">
                        {inlineSubtitleBlocks.map((block) => {
                          const subtitle = subtitleClips.find((candidate) => candidate.id === block.subtitleId)
                          const units = subtitle ? captionRailUnitGeometries(block, subtitle) : []
                          const boundaryPair = subtitleBoundaryPairsByClipId.get(block.subtitleId)
                          const boundarySide = boundaryPair?.left.id === block.subtitleId ? 'end' : boundaryPair?.right.id === block.subtitleId ? 'start' : null
                          return <div
                            key={`caption-rail:${block.subtitleId}`}
                            className={`caption-rail-cue${selectedClipIds.includes(block.subtitleId) ? ' is-selected' : ''}`}
                            style={{ left: `${block.leftPercent}%`, width: `${block.widthPercent}%` }}
                          >
                            <button
                              type="button"
                              className="caption-rail-cue-button"
                              title={block.text}
                              aria-label={`字幕: ${block.text}`}
                              onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }}
                              onClick={(event) => { event.preventDefault(); event.stopPropagation(); selectClip(block.subtitleId) }}
                            >{block.text}</button>
                            <span className="caption-rail-unit-layer" aria-hidden="true">
                              {units.map(({ unit, leftPercent, widthPercent }) => <i key={unit.id} style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }} title={unit.text} />)}
                            </span>
                            {boundaryPair && boundarySide ? <button
                              type="button"
                              className={`caption-rail-boundary-handle is-${boundarySide}`}
                              aria-label="字幕の編集境界を移動"
                              title="字幕の編集境界をドラッグ"
                              onPointerDown={(event) => beginSubtitleBoundaryDrag(event, boundaryPair)}
                            /> : null}
                          </div>
                        })}
                      </div> : null}
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
            {pointerEdit?.snapTimeUs != null ? <i className="snap-indicator" data-snap-us={pointerEdit.snapTimeUs} style={{ left: pointerEdit.snapTimeUs / 1_000_000 * zoomPxPerSecond }} /> : null}
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
