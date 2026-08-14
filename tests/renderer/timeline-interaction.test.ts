import { describe, expect, it } from 'vitest'
import { isOutsideContextMenu, isTextEditingTarget, shouldCommitPointerEdit } from '../../src/renderer/src/components/Timeline'

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
})
