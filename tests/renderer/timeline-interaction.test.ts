import { describe, expect, it } from 'vitest'
import { captionRailUnitGeometries, inlineSubtitleBlocksForVideoClip, isOutsideContextMenu, isTextEditingTarget, shouldCommitPointerEdit, shouldCommitSubtitleBoundaryDrag, subtitleBoundaryGuidesForVideoClip, subtitleBoundaryPairs, subtitleBoundaryPositionUs, subtitleWordGeometries, ticksFor, timelineCandidateRelationIds, timelineEdgeScrollDelta, timelineFollowScrollLeft, timelineScrubTimeUs, timelineSplitMenuState } from '../../src/renderer/src/components/Timeline'
import { timelineZoomScrollLeft } from '../../src/renderer/src/action-state'
import { deriveSubtitleEditUnits } from '../../src/shared/editing/edit-units'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types'

describe('timeline interaction guards', () => {
  it('supports the extended zoom range and preserves the playhead screen position', () => {
    expect(ticksFor(60 * 60 * 1_000_000, 1000).length).toBeLessThanOrEqual(2_000)
    const oldZoom = 220
    const newZoom = 1000
    const playheadUs = 30_000_000
    const scrollLeft = 5_000
    const screenX = (playheadUs / 1_000_000) * oldZoom - scrollLeft
    const nextScrollLeft = timelineZoomScrollLeft({
      scrollLeft,
      viewportWidth: 800,
      nextContentWidth: 60_000,
      oldZoom,
      newZoom,
      anchorTimeUs: playheadUs
    })!
    expect((playheadUs / 1_000_000) * newZoom - nextScrollLeft).toBeCloseTo(screenX)
  })

  it('leaves native clipboard behavior to editable controls', () => {
    for (const tag of ['input', 'textarea', 'select']) expect(isTextEditingTarget(document.createElement(tag))).toBe(true)
    const contenteditable = document.createElement('div')
    contenteditable.setAttribute('contenteditable', 'true')
    expect(isTextEditingTarget(contenteditable)).toBe(true)
    expect(isTextEditingTarget(document.createElement('div'))).toBe(false)
  })

  it('dismisses a context menu only for outside targets', () => {
    const menu = document.createElement('div')
    const child = document.createElement('button')
    const outside = document.createElement('div')
    menu.append(child)
    expect(isOutsideContextMenu(menu, child)).toBe(false)
    expect(isOutsideContextMenu(menu, outside)).toBe(true)
  })

  it('advances the viewport when playback reaches the right edge without changing playhead time', () => {
    expect(timelineFollowScrollLeft({ scrollLeft: 0, clientWidth: 500, scrollWidth: 2_000, playheadPx: 498 })).toBeNull()
    expect(timelineFollowScrollLeft({ scrollLeft: 0, clientWidth: 500, scrollWidth: 2_000, playheadPx: 500 })).toBe(375)
    expect(timelineFollowScrollLeft({ scrollLeft: 375, clientWidth: 500, scrollWidth: 2_000, playheadPx: 873 })).toBeNull()
    expect(timelineFollowScrollLeft({ scrollLeft: 375, clientWidth: 500, scrollWidth: 2_000, playheadPx: 875 })).toBe(750)
  })

  it('does not jitter at the end or scroll when there is no overflow', () => {
    expect(timelineFollowScrollLeft({ scrollLeft: 1_500, clientWidth: 500, scrollWidth: 2_000, playheadPx: 2_000 })).toBeNull()
    expect(timelineFollowScrollLeft({ scrollLeft: 0, clientWidth: 500, scrollWidth: 500, playheadPx: 500 })).toBeNull()
  })

  it('scales continuous drag scrolling near both viewport edges', () => {
    expect(timelineEdgeScrollDelta({ pointerX: 250, viewportLeft: 0, viewportRight: 500 })).toBe(0)
    expect(timelineEdgeScrollDelta({ pointerX: 0, viewportLeft: 0, viewportRight: 500 })).toBe(-24)
    expect(timelineEdgeScrollDelta({ pointerX: 24, viewportLeft: 0, viewportRight: 500 })).toBe(-12)
    expect(timelineEdgeScrollDelta({ pointerX: 500, viewportLeft: 0, viewportRight: 500 })).toBe(24)
    expect(timelineEdgeScrollDelta({ pointerX: 476, viewportLeft: 0, viewportRight: 500 })).toBe(12)
  })

  it('maps ruler pointerdown and pointermove using the current scroll position', () => {
    expect(timelineScrubTimeUs({ clientX: 100, laneLeft: 0, scrollLeft: 0, zoomPxPerSecond: 100 })).toBe(1_000_000)
    expect(timelineScrubTimeUs({ clientX: 100, laneLeft: 0, scrollLeft: 500, zoomPxPerSecond: 100 })).toBe(6_000_000)
    expect(timelineScrubTimeUs({ clientX: -20, laneLeft: 0, scrollLeft: 0, zoomPxPerSecond: 100 })).toBe(0)
    expect(timelineScrubTimeUs({ clientX: 100, laneLeft: 0, scrollLeft: 0, zoomPxPerSecond: 0 })).toBe(0)
  })

  it('does not commit a move for a click or small pointer jitter', () => {
    const base = { mode: 'move' as const, initialX: 100, initialTrackId: 'C1', targetTrackId: 'C1' }
    expect(shouldCommitPointerEdit({ ...base, pointerUpX: 100 })).toBe(false)
    expect(shouldCommitPointerEdit({ ...base, pointerUpX: 99 })).toBe(false)
    expect(shouldCommitPointerEdit({ ...base, pointerUpX: 102 })).toBe(false)
    expect(shouldCommitPointerEdit({ ...base, pointerUpX: 103 })).toBe(true)
  })

  it('commits a real move and a cross-track move even with a small horizontal delta', () => {
    expect(shouldCommitPointerEdit({
      mode: 'move', initialX: 100, pointerUpX: 105, initialTrackId: 'C1', targetTrackId: 'C1'
    })).toBe(true)
    expect(shouldCommitPointerEdit({
      mode: 'move', initialX: 100, pointerUpX: 101, initialTrackId: 'C1', targetTrackId: 'C2'
    })).toBe(true)
  })

  it('treats pointer cancellation as a terminal drag state', () => {
    // The component owns the listener cleanup; this guard documents the
    // contract that cancellation must never be treated as a committed move.
    expect(shouldCommitPointerEdit({ mode: 'move', initialX: 100, pointerUpX: 100, initialTrackId: 'C1', targetTrackId: 'C1' })).toBe(false)
    expect(shouldCommitPointerEdit({ mode: 'trim-start', initialX: 100, pointerUpX: 101, initialTrackId: 'C1', targetTrackId: 'C1' })).toBe(false)
  })

  it('applies the same threshold to trim handles', () => {
    expect(shouldCommitPointerEdit({
      mode: 'trim-start', initialX: 100, pointerUpX: 101, initialTrackId: 'C1', targetTrackId: 'C1'
    })).toBe(false)
    expect(shouldCommitPointerEdit({
      mode: 'trim-end', initialX: 100, pointerUpX: 104, initialTrackId: 'C1', targetTrackId: 'C1'
    })).toBe(true)
  })

  it('only enables context-menu splitting for word-backed subtitles', () => {
    expect(timelineSplitMenuState(undefined)).toEqual({ disabled: true, label: '分割対象がありません' })
    expect(timelineSplitMenuState({ kind: 'subtitle', words: undefined } as never)).toEqual({ disabled: true, label: '単語境界情報がないため分割不可' })
    expect(timelineSplitMenuState({ kind: 'subtitle', text: '字幕', words: [{ id: 'w1', text: '字幕', startUs: 0, endUs: 1 }, { id: 'w2', text: 'を', startUs: 1, endUs: 2 }] } as never)).toEqual({ disabled: true, label: '単語境界情報がないため分割不可' })
    expect(timelineSplitMenuState({ kind: 'subtitle', text: '字幕を', words: [{ id: 'w1', text: '字幕', startUs: 0, endUs: 1 }, { id: 'w2', text: 'を', startUs: 1, endUs: 2 }] } as never)).toEqual({ disabled: false, label: 'ここで字幕を分割（単語境界）' })
    expect(timelineSplitMenuState({ kind: 'image' } as never)).toEqual({ disabled: false, label: '再生位置で分割' })
  })

  it('uses derived edit units for the visible subtitle boundary layer', () => {
    const sourceWord = { id: 'raw', text: '皆さんこんばんはアルマジロウです', startUs: 0, endUs: 1_000_000 }
    const clip = {
      id: 'caption', name: 'caption', kind: 'subtitle' as const, startUs: 0, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: sourceWord.text, style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [sourceWord], editUnits: deriveSubtitleEditUnits([sourceWord])
    }
    expect(subtitleWordGeometries(clip).map(({ word }) => word.text)).toEqual(['皆さん', 'こんばんは', 'アルマジロウ', 'です'])
  })

  it('keeps ownership boundary jitter local and exposes only compatible adjacent pairs', () => {
    expect(shouldCommitSubtitleBoundaryDrag(100, 100)).toBe(false)
    expect(shouldCommitSubtitleBoundaryDrag(100, 102)).toBe(false)
    expect(shouldCommitSubtitleBoundaryDrag(100, 103)).toBe(true)
    const left = { id: 'left', kind: 'subtitle', startUs: 0, durationUs: 1_000, sourceInUs: 0, text: 'AB', words: [{ id: 'a', text: 'A', startUs: 100, endUs: 400 }, { id: 'b', text: 'B', startUs: 600, endUs: 900 }] }
    const right = { id: 'right', kind: 'subtitle', startUs: 1_200, durationUs: 1_000, sourceInUs: 1_200, text: 'CD', words: [{ id: 'c', text: 'C', startUs: 1_300, endUs: 1_500 }, { id: 'd', text: 'D', startUs: 1_600, endUs: 1_900 }] }
    const invalid = { ...right, text: '不一致' }
    expect(subtitleBoundaryPairs({ kind: 'subtitle', clips: [left, right] } as never)).toHaveLength(1)
    expect(subtitleBoundaryPositionUs({ left, right } as never)).toBe(1_100)
    expect(subtitleBoundaryPairs({ kind: 'subtitle', clips: [left, invalid] } as never)).toHaveLength(0)
  })

  it('derives only subtitle cue boundaries inside each video clip', () => {
    const video = { kind: 'video' as const, startUs: 10_000_000, durationUs: 10_000_000 }
    const subtitles = [
      { id: 'before-and-overlap', startUs: 8_000_000, durationUs: 4_000_000 },
      { id: 'inside', startUs: 14_000_000, durationUs: 2_000_000 },
      { id: 'overlap-and-after', startUs: 18_000_000, durationUs: 4_000_000 },
      { id: 'outside', startUs: 1_000_000, durationUs: 2_000_000 }
    ]
    expect(subtitleBoundaryGuidesForVideoClip(video, subtitles)).toEqual([
      { subtitleId: 'before-and-overlap', side: 'end', timeUs: 12_000_000, leftPercent: 20 },
      { subtitleId: 'inside', side: 'start', timeUs: 14_000_000, leftPercent: 40 },
      { subtitleId: 'inside', side: 'end', timeUs: 16_000_000, leftPercent: 60 },
      { subtitleId: 'overlap-and-after', side: 'start', timeUs: 18_000_000, leftPercent: 80 }
    ])
  })

  it('derives reciprocal video/subtitle candidates from positive timeline overlap', () => {
    const videoA = { id: 'video-a', kind: 'video' as const, startUs: 0, durationUs: 10_000_000 }
    const videoB = { id: 'video-b', kind: 'video' as const, startUs: 4_000_000, durationUs: 4_000_000 }
    const subtitle = { id: 'subtitle', kind: 'subtitle' as const, startUs: 2_000_000, durationUs: 3_000_000 }
    const subtitleOverlap = { id: 'subtitle-overlap', kind: 'subtitle' as const, startUs: 4_000_000, durationUs: 2_000_000 }
    const touching = { id: 'touching', kind: 'subtitle' as const, startUs: 10_000_000, durationUs: 1_000_000 }
    const zeroDuration = { id: 'zero-duration', kind: 'video' as const, startUs: 3_000_000, durationUs: 0 }
    const unrelated = { id: 'unrelated', kind: 'subtitle' as const, startUs: 20_000_000, durationUs: 1_000_000 }
    const clips = [videoA, videoB, subtitle, subtitleOverlap, touching, zeroDuration, unrelated]

    expect(timelineCandidateRelationIds(subtitle, clips)).toEqual(['video-a', 'video-b'])
    expect(timelineCandidateRelationIds(videoA, clips)).toEqual(['subtitle', 'subtitle-overlap'])
    expect(timelineCandidateRelationIds(videoB, clips)).toEqual(['subtitle', 'subtitle-overlap'])
    expect(timelineCandidateRelationIds(subtitleOverlap, clips)).toEqual(['video-a', 'video-b'])
    expect(timelineCandidateRelationIds(touching, clips)).toEqual([])
    expect(timelineCandidateRelationIds(zeroDuration, clips)).toEqual([])
  })

  it('projects only the visible overlap of enabled subtitle cues into a video clip', () => {
    const video = { kind: 'video' as const, startUs: 1_000_000, durationUs: 4_000_000 }
    const subtitles = [
      { id: 'partial', text: 'partial', startUs: 500_000, durationUs: 1_000_000, enabled: true },
      { id: 'inside', text: 'inside', startUs: 2_000_000, durationUs: 1_000_000, enabled: true },
      { id: 'disabled', text: 'disabled', startUs: 2_000_000, durationUs: 1_000_000, enabled: false }
    ]
    expect(inlineSubtitleBlocksForVideoClip(video, subtitles)).toEqual([
      { subtitleId: 'partial', text: 'partial', leftPercent: 0, widthPercent: 12.5, startUs: 1_000_000, endUs: 1_500_000 },
      { subtitleId: 'inside', text: 'inside', leftPercent: 25, widthPercent: 25, startUs: 2_000_000, endUs: 3_000_000 }
    ])
  })

  it('projects subtitle edit units into the attached caption rail without changing ownership data', () => {
    const block = { startUs: 2_000_000, endUs: 5_000_000 }
    const subtitle = {
      text: 'これは字幕', startUs: 2_000_000, durationUs: 2_500_000,
      editUnits: [
        { id: 'u1', text: 'これは', parentSourceWordId: 'w1', startUs: 2_000_000, endUs: 3_000_000, timingProvenance: 'estimated' as const },
        { id: 'u2', text: '字幕', parentSourceWordId: 'w1', startUs: 3_000_000, endUs: 4_500_000, timingProvenance: 'estimated' as const }
      ],
      words: []
    }
    expect(captionRailUnitGeometries(block, subtitle)).toEqual([
      { unit: subtitle.editUnits[0], leftPercent: 0, widthPercent: 33.33333333333333 },
      { unit: subtitle.editUnits[1], leftPercent: 33.33333333333333, widthPercent: 50 }
    ])
  })
})

describe('shortcut targets', () => {
  it('keeps editor shortcuts alive after a slider or checkbox was touched', async () => {
    const { shortcutTargetKind, controlOwnsKey } = await import('../../src/renderer/src/action-state')
    const input = (type: string): HTMLInputElement => Object.assign(document.createElement('input'), { type })
    expect(shortcutTargetKind(input('range'))).toBe('control')
    expect(shortcutTargetKind(input('checkbox'))).toBe('control')
    expect(shortcutTargetKind(input('number'))).toBe('text')
    expect(shortcutTargetKind(document.createElement('textarea'))).toBe('text')
    expect(shortcutTargetKind(document.createElement('div'))).toBe('none')
    expect(controlOwnsKey(' ')).toBe(true)
    expect(controlOwnsKey('Delete')).toBe(false)
    expect(isTextEditingTarget(input('range'))).toBe(false)
  })
})
