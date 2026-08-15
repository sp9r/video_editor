import { describe, expect, it } from 'vitest'
import { mediaAddControlState, timelineZoomControlState, trackControlState } from '../../src/renderer/src/action-state'

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
})
