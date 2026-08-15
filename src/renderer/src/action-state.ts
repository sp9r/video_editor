import { isMediaTrack, type TimelineTrack } from '../../shared/types'

export const TIMELINE_ZOOM_MIN = 28
export const TIMELINE_ZOOM_MAX = 220

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
  clipKind?: string
  assetOffline?: boolean
  assetHasAudio?: boolean
}

export interface AutoCaptionControlState {
  disabled: boolean
  label: string
}

/** Keeps the visible run action aligned with the main-process prerequisites. */
export const autoCaptionControlState = ({ captioning, clipKind, assetOffline, assetHasAudio }: AutoCaptionControlInput): AutoCaptionControlState => {
  if (captioning) return { disabled: true, label: '自動処理を実行中です' }
  if (!clipKind) return { disabled: true, label: '対象clipを選択してください' }
  if (clipKind !== 'video' && clipKind !== 'audio') return { disabled: true, label: '動画または音声clipを選択してください' }
  if (assetOffline) return { disabled: true, label: 'オフライン素材は再リンクしてください' }
  if (!assetHasAudio) return { disabled: true, label: '音声を含む素材を選択してください' }
  return { disabled: false, label: '自動処理を実行' }
}
