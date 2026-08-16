import { describe, expect, it } from 'vitest'
import { autoCaptionControlState, mediaAddControlState, timelineZoomControlState, trackControlState } from '../../src/renderer/src/action-state'

const track = (id: string, kind: 'media' | 'subtitle', clips: unknown[] = []) => ({ id, kind, name: id, clips } as never)

describe('visible action prerequisites', () => {
  it('disables track moves that the store would reject', () => {
    const tracks = [track('V1', 'media'), track('C1', 'subtitle'), track('C2', 'subtitle')]
    expect(trackControlState(tracks[0]!, tracks)).toMatchObject({ canMoveUp: false, canMoveDown: false })
    expect(trackControlState(tracks[1]!, tracks)).toMatchObject({ canMoveUp: false, canMoveDown: true })
    expect(trackControlState(tracks[2]!, tracks)).toMatchObject({ canMoveUp: true, canMoveDown: false })
  })

  it('only enables deletion when it can succeed without a warning-only click', () => {
    const tracks = [track('V1', 'media'), track('V2', 'media'), track('C1', 'subtitle'), track('C2', 'subtitle')]
    expect(trackControlState(tracks[0]!, tracks).canDelete).toBe(true)
    expect(trackControlState(track('V1', 'media', [{ id: 'clip' }]), tracks).canDelete).toBe(false)
    expect(trackControlState(tracks[2]!, [tracks[2]!]).canDelete).toBe(false)
  })

  it('disables zoom buttons at both bounded endpoints', () => {
    expect(timelineZoomControlState(28)).toEqual({ canZoomOut: false, canZoomIn: true })
    expect(timelineZoomControlState(220)).toEqual({ canZoomOut: true, canZoomIn: false })
    expect(timelineZoomControlState(100)).toEqual({ canZoomOut: true, canZoomIn: true })
  })

  it('explains why media placement is unavailable', () => {
    expect(mediaAddControlState({ offline: true, hasMediaTrack: true })).toMatchObject({ disabled: true, label: expect.stringContaining('再リンク') })
    expect(mediaAddControlState({ offline: false, hasMediaTrack: false })).toMatchObject({ disabled: true, label: expect.stringContaining('メディアトラック') })
    expect(mediaAddControlState({ offline: false, hasMediaTrack: true })).toEqual({ disabled: false, label: 'タイムラインへ追加' })
  })

  it('keeps auto-caption run disabled until the selected source is usable', () => {
    expect(autoCaptionControlState({ captioning: false })).toEqual({ disabled: true, label: '対象clipを選択してください' })
    expect(autoCaptionControlState({ captioning: false, selectionCount: 2 })).toEqual({ disabled: true, label: '自動処理はclipを1つだけ選択してください' })
    expect(autoCaptionControlState({ captioning: false, clipKind: 'subtitle' })).toMatchObject({ disabled: true })
    expect(autoCaptionControlState({ captioning: false, clipKind: 'video', assetOffline: true, assetHasAudio: true })).toEqual({ disabled: true, label: 'オフライン素材は再リンクしてください' })
    expect(autoCaptionControlState({ captioning: false, clipKind: 'video', assetOffline: false, assetHasAudio: false })).toEqual({ disabled: true, label: '音声を含む素材を選択してください' })
    expect(autoCaptionControlState({ captioning: false, clipKind: 'video', assetOffline: false, assetHasAudio: true })).toEqual({ disabled: false, label: '自動処理を実行' })
    expect(autoCaptionControlState({ captioning: true, clipKind: 'video', assetOffline: false, assetHasAudio: true })).toMatchObject({ disabled: true })
  })
})
