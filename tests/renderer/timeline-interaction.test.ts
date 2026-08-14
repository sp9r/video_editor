import { describe, expect, it } from 'vitest'
import { isOutsideContextMenu, isTextEditingTarget, shouldCommitPointerEdit, shouldCommitSubtitleBoundaryDrag, subtitleBoundaryPairs, subtitleBoundaryPositionUs, timelineSplitMenuState } from '../../src/renderer/src/components/Timeline'

describe('timeline interaction guards', () => {
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
})
