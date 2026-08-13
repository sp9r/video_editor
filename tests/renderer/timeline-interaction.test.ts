import { describe, expect, it } from 'vitest'
import { isOutsideContextMenu, isTextEditingTarget } from '../../src/renderer/src/components/Timeline'

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
})
