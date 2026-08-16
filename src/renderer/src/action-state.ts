import { isMediaTrack, type TimelineTrack } from '../../shared/types'

export const TIMELINE_ZOOM_MIN = 4
export const TIMELINE_ZOOM_MAX = 1000
export const TIMELINE_ZOOM_DEFAULT = 72

export const clampTimelineZoom = (zoom: number): number => {
  if (!Number.isFinite(zoom)) return TIMELINE_ZOOM_DEFAULT
  return Math.min(TIMELINE_ZOOM_MAX, Math.max(TIMELINE_ZOOM_MIN, zoom))
}

export interface TimelineZoomScrollInput {
  scrollLeft: number
  viewportWidth: number
  nextContentWidth: number
  oldZoom: number
  newZoom: number
  anchorTimeUs: number
}

/** Keeps the chosen timeline time at the same viewport x-coordinate after zooming. */
export const timelineZoomScrollLeft = (input: TimelineZoomScrollInput): number | null => {
  const { scrollLeft, viewportWidth, nextContentWidth, oldZoom, newZoom, anchorTimeUs } = input
  if (![scrollLeft, viewportWidth, nextContentWidth, oldZoom, newZoom, anchorTimeUs].every(Number.isFinite)) return null
  if (viewportWidth <= 0 || nextContentWidth <= 0 || oldZoom <= 0 || newZoom <= 0 || anchorTimeUs < 0) return null
  const anchorScreenX = (anchorTimeUs / 1_000_000) * oldZoom - scrollLeft
  const nextAnchorX = (anchorTimeUs / 1_000_000) * newZoom
  const maxScrollLeft = Math.max(0, nextContentWidth - viewportWidth)
  return Math.min(maxScrollLeft, Math.max(0, nextAnchorX - anchorScreenX))
}

export interface TrackControlState {
  canMoveUp: boolean
  canMoveDown: boolean
  canDelete: boolean
  moveUpLabel: string
  moveDownLabel: string
  deleteLabel: string
}

export const trackControlState = (track: TimelineTrack, tracks: TimelineTrack[]): TrackControlState => {
  const index = tracks.findIndex((candidate) => candidate.id === track.id)
  const previous = index > 0 ? tracks[index - 1] : undefined
  const next = index >= 0 ? tracks[index + 1] : undefined
  const canMoveUp = Boolean(previous && isMediaTrack(previous) === isMediaTrack(track))
  const canMoveDown = Boolean(next && isMediaTrack(next) === isMediaTrack(track))
  const mediaTrackCount = tracks.filter(isMediaTrack).length
  const subtitleTrackCount = tracks.filter((candidate) => candidate.kind === 'subtitle').length
  const canDelete = track.clips.length === 0 && (isMediaTrack(track) ? mediaTrackCount > 1 : subtitleTrackCount > 1)

  return {
    canMoveUp,
    canMoveDown,
    canDelete,
    moveUpLabel: canMoveUp ? '上へ移動' : index <= 0 ? '上へ移動（先頭のトラックです）' : '上へ移動（異なる種類のトラックを越えられません）',
    moveDownLabel: canMoveDown ? '下へ移動' : !next ? '下へ移動（末尾のトラックです）' : '下へ移動（異なる種類のトラックを越えられません）',
    deleteLabel: canDelete
      ? '空のトラックを削除'
      : track.clips.length > 0
        ? '空のトラックを削除（クリップがあるため不可）'
        : isMediaTrack(track)
          ? '空のトラックを削除（最後のメディアトラックは削除不可）'
          : '空のトラックを削除（最後の字幕トラックは削除不可）'
  }
}

export const timelineZoomControlState = (zoom: number): { canZoomOut: boolean; canZoomIn: boolean } => ({
  canZoomOut: zoom > TIMELINE_ZOOM_MIN,
  canZoomIn: zoom < TIMELINE_ZOOM_MAX
})

export const mediaAddControlState = ({ offline, hasMediaTrack }: { offline: boolean; hasMediaTrack: boolean }): { disabled: boolean; label: string } => ({
  disabled: offline || !hasMediaTrack,
  label: offline
    ? 'タイムラインへ追加（オフライン素材は再リンクが必要です）'
    : hasMediaTrack
      ? 'タイムラインへ追加'
      : 'タイムラインへ追加（メディアトラックを追加してください）'
})

export interface AutoCaptionControlInput {
  captioning: boolean
  selectionCount?: number
  clipKind?: string
  assetOffline?: boolean
  assetHasAudio?: boolean
}

export interface AutoCaptionControlState {
  disabled: boolean
  label: string
}

/** Keeps the visible run action aligned with the main-process prerequisites. */
export const autoCaptionControlState = ({ captioning, selectionCount = 0, clipKind, assetOffline, assetHasAudio }: AutoCaptionControlInput): AutoCaptionControlState => {
  if (captioning) return { disabled: true, label: '自動処理を実行中です' }
  if (selectionCount > 1) return { disabled: true, label: '自動処理はclipを1つだけ選択してください' }
  if (!clipKind) return { disabled: true, label: '対象clipを選択してください' }
  if (clipKind !== 'video' && clipKind !== 'audio') return { disabled: true, label: '動画または音声clipを選択してください' }
  if (assetOffline) return { disabled: true, label: 'オフライン素材は再リンクしてください' }
  if (!assetHasAudio) return { disabled: true, label: '音声を含む素材を選択してください' }
  return { disabled: false, label: '自動処理を実行' }
}
