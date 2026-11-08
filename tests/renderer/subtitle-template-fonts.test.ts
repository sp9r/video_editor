import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveFontFamilyOptions } from '../../src/renderer/src/components/SubtitleTemplateManagerPanel'
import SubtitleTemplateManagerPanel from '../../src/renderer/src/components/SubtitleTemplateManagerPanel'

describe('subtitle template font dropdown options', () => {
  let root: Root | undefined

  afterEach(() => {
    root?.unmount()
    root = undefined
    delete window.spectra
  })

  it('keeps the current family, Japanese names, and safe fallbacks', () => {
    const options = resolveFontFamilyOptions(['游ゴシック', 'Noto Sans JP', '游ゴシック'], '保存済みフォント')
    expect(options).toContain('保存済みフォント')
    expect(options).toContain('游ゴシック')
    expect(options).toContain('Noto Sans JP')
    expect(options).toContain('sans-serif')
    expect(options.filter((family) => family === '游ゴシック')).toHaveLength(1)
  })

  it('loads installed families, changes the select, and updates preview immediately', async () => {
    class ResizeObserverMock {
      observe(): void {}
      disconnect(): void {}
    }
    window.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
    window.spectra = { listFontFamilies: vi.fn().mockResolvedValue(['游ゴシック']) } as never
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(createElement(SubtitleTemplateManagerPanel, {
        userTemplates: [],
        defaultTemplateId: 'default',
        onTemplatesChange: vi.fn(),
        onDefaultChange: vi.fn(),
        onClose: vi.fn()
      }))
    })
    const createButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '新規作成')
    expect(createButton).toBeTruthy()
    await act(async () => { createButton?.click() })
    const fontLabel = [...container.querySelectorAll('label')].find((label) => label.textContent?.includes('フォント'))
    const fontSelect = fontLabel?.querySelector('select') as HTMLSelectElement | null
    expect(fontSelect?.querySelector('option[value="游ゴシック"]')).toBeTruthy()
    await act(async () => {
      if (!fontSelect) throw new Error('font select missing')
      fontSelect.value = '游ゴシック'
      fontSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect((container.querySelector('.preview-subtitle-main') as HTMLElement | null)?.style.fontFamily).toContain('游ゴシック')
    container.remove()
  })
})
