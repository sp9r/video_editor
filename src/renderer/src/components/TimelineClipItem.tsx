import { memo } from 'react'
import { Captions, Link2, Volume2 } from 'lucide-react'
import { subtitleEditUnits } from '../../../shared/editing/edit-units'
import type { ClipDragPreviewRect } from '../../../shared/editing/drag-preview'
import type { MediaAsset, SubtitleClip, SubtitleEditUnit, SubtitleWord, TimelineClip } from '../../../shared/types'
import type { CaptionRailUnitGeometry, InlineSubtitleBlock, SubtitleBoundaryGuide, SubtitleBoundaryPair } from './Timeline'
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

export interface ClipRailCue {
  block: InlineSubtitleBlock
  units: CaptionRailUnitGeometry[]
  boundaryPair: SubtitleBoundaryPair | undefined
  boundarySide: 'start' | 'end' | null
}

/** Precomputed caption-rail content of one video clip; the reference only changes when its inputs do. */
export interface ClipRailData {
  guides: SubtitleBoundaryGuide[]
  cues: ClipRailCue[]
}

export const EMPTY_CLIP_RAIL: ClipRailData = { guides: [], cues: [] }

/** Stable callbacks (they read the latest Timeline state through a ref) so memoised clips are not invalidated by handler identity. */
export interface TimelineClipHandlers {
  beginEdit(event: React.PointerEvent, clip: TimelineClip, mode: 'move' | 'trim-start' | 'trim-end', trackId: string): void
  razorMove(event: React.PointerEvent, clip: TimelineClip): void
  enter(clip: TimelineClip): void
  leave(clip: TimelineClip): void
  contextMenu(event: React.MouseEvent, clip: TimelineClip): void
  selectClip(clipId: string): void
  beginBoundaryDrag(event: React.PointerEvent, pair: SubtitleBoundaryPair): void
}

export interface TimelineClipItemProps {
  clip: TimelineClip
  trackId: string
  selected: boolean
  zoomPxPerSecond: number
  /** Live geometry, defined only for clips the current drag changes (undefined for every other clip). */
  dragRect: ClipDragPreviewRect | undefined
  candidateSource: boolean
  candidateRelated: boolean
  rail: ClipRailData
  /** Ids of the rail cues that are selected, joined by a separator, so the prop is a comparable primitive. */
  selectedCueKey: string
  razorGhostTimeUs: number | null
  asset: MediaAsset | undefined
  handlers: TimelineClipHandlers
}

export const CUE_KEY_SEPARATOR = '\u0000'

function TimelineClipItemView({
  clip,
  trackId,
  selected,
  zoomPxPerSecond,
  dragRect,
  candidateSource,
  candidateRelated,
  rail,
  selectedCueKey,
  razorGhostTimeUs,
  asset,
  handlers
}: TimelineClipItemProps): React.JSX.Element {
  const dragging = dragRect !== undefined
  const visualLeft = (dragRect?.startUs ?? clip.startUs) / 1_000_000 * zoomPxPerSecond
  const visualWidth = (dragRect?.durationUs ?? clip.durationUs) / 1_000_000 * zoomPxPerSecond
  const clipKindLabel = clip.kind === 'subtitle' ? '字幕' : clip.kind === 'audio' ? '音声' : '映像'
  const hasCaptionRail = rail.cues.length > 0
  const selectedCues = selectedCueKey ? new Set(selectedCueKey.split(CUE_KEY_SEPARATOR)) : null
  return (
    <div
      className={`${timelineClipClassName(clip, selected)}${dragging ? ' is-dragging' : ''}${hasCaptionRail ? ' has-caption-rail' : ''}${candidateSource ? ' is-candidate-source' : ''}${candidateRelated ? ' is-candidate-related' : ''}`}
      style={{ left: Math.max(0, visualLeft), width: Math.max(8, visualWidth) }}
      onPointerDown={(event) => handlers.beginEdit(event, clip, 'move', trackId)}
      onPointerMove={(event) => handlers.razorMove(event, clip)}
      onPointerEnter={() => handlers.enter(clip)}
      onPointerLeave={() => handlers.leave(clip)}
      onContextMenu={(event) => handlers.contextMenu(event, clip)}
      title={`${clip.name}\n${seconds(clip.durationUs).toFixed(2)} 秒\n右クリックで編集操作`}
      aria-label={`${clipKindLabel}: ${clip.kind === 'subtitle' ? clip.text : clip.name}${clip.linkGroupId ? '（リンク済み）' : ''}`}
    >
      <button type="button" className="trim-handle trim-start" aria-label="開始位置をトリム" onPointerDown={(event) => handlers.beginEdit(event, clip, 'trim-start', trackId)} />
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
      {rail.guides.map((guide) => <span
        key={`${guide.subtitleId}:${guide.side}`}
        className={`subtitle-boundary-guide is-${guide.side}`}
        style={{ left: `${guide.leftPercent}%` }}
        data-subtitle-id={guide.subtitleId}
        data-boundary-side={guide.side}
        aria-hidden="true"
      />)}
      {hasCaptionRail ? <div className="timeline-caption-rail" aria-label="キャプションレール">
        {rail.cues.map(({ block, units, boundaryPair, boundarySide }) => (
          <div
            key={`caption-rail:${block.subtitleId}`}
            className={`caption-rail-cue${selectedCues?.has(block.subtitleId) ? ' is-selected' : ''}`}
            style={{ left: `${block.leftPercent}%`, width: `${block.widthPercent}%` }}
          >
            <button
              type="button"
              className="caption-rail-cue-button"
              title={block.text}
              aria-label={`字幕: ${block.text}`}
              onPointerDown={(event) => { event.preventDefault(); event.stopPropagation() }}
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); handlers.selectClip(block.subtitleId) }}
            >{block.text}</button>
            <span className="caption-rail-unit-layer" aria-hidden="true">
              {units.map(({ unit, leftPercent, widthPercent }) => <i key={unit.id} style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }} title={unit.text} />)}
            </span>
            {boundaryPair && boundarySide ? <button
              type="button"
              className={`caption-rail-boundary-handle is-${boundarySide}`}
              aria-label="字幕の編集境界を移動"
              title="字幕の編集境界をドラッグ"
              onPointerDown={(event) => handlers.beginBoundaryDrag(event, boundaryPair)}
            /> : null}
          </div>
        ))}
      </div> : null}
      <span className="clip-content">{clipGlyph(clip)}{clip.linkGroupId ? <Link2 className="clip-link-icon" size={12} aria-label="リンクされたクリップ" /> : null}<strong>{clip.kind === 'subtitle' ? clip.text : clip.name}</strong></span>
      {razorGhostTimeUs !== null ? <span
        className="subtitle-razor-ghost"
        style={{ left: `${((razorGhostTimeUs - clip.startUs) / clip.durationUs) * 100}%` }}
        aria-label="字幕の分割候補"
        title="ここで字幕を分割"
      /> : null}
      {clip.kind === 'audio' || clip.kind === 'video' ? <Waveform asset={asset} clip={clip} peakCount={peakCountForPixelWidth(visualWidth)} /> : null}
      <button type="button" className="trim-handle trim-end" aria-label="終了位置をトリム" onPointerDown={(event) => handlers.beginEdit(event, clip, 'trim-end', trackId)} />
    </div>
  )
}

/**
 * One clip on the timeline. Memoised: during a drag or playback only clips whose
 * own props change (the dragged clip and its linked partners) re-render.
 */
export const TimelineClipItem = memo(TimelineClipItemView)
