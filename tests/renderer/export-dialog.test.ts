import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EncoderReport } from '../../src/shared/types'
import ExportDialog from '../../src/renderer/src/components/ExportDialog'

const report = (selectedId: string, nvencAvailable: boolean): EncoderReport => ({
  ffmpegPath: null,
  ffmpegVersion: 'test',
  platform: 'win32',
  selectedId,
  checkedAt: '2026-08-16T00:00:00.000Z',
  capabilities: [
    { id: 'h264_nvenc', name: 'NVIDIA NVENC', codec: 'h264', vendor: 'nvidia', hardware: true, available: nvencAvailable, ...(nvencAvailable ? {} : { reason: 'probe failed' }) },
    { id: 'libx264', name: 'CPU (libx264)', codec: 'h264', vendor: 'cpu', hardware: false, available: true }
  ]
})

describe('ExportDialog encoder refresh state', () => {
  let root: Root | undefined

  afterEach(() => {
    root?.unmount()
    root = undefined
    document.body.replaceChildren()
    delete window.spectra
  })

  it('initializes a fresh dialog from the detector selected encoder', async () => {
    window.spectra = { onExportProgress: vi.fn().mockReturnValue(vi.fn()) } as never
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => { root?.render(createElement(ExportDialog, { report: report('h264_nvenc', true), onClose: vi.fn(), refreshEncoders: vi.fn() })) })
    const select = [...container.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('優先エンコーダー'))
      ?.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('h264_nvenc')
  })

  it('adopts a newly detected selected encoder until the user makes an explicit choice', async () => {
    window.spectra = { onExportProgress: vi.fn().mockReturnValue(vi.fn()) } as never
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => { root?.render(createElement(ExportDialog, { report: report('libx264', false), onClose: vi.fn(), refreshEncoders: vi.fn() })) })
    const select = [...container.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('優先エンコーダー'))
      ?.querySelector('select') as HTMLSelectElement
    expect(select).toBeTruthy()
    expect(select.value).toBe('libx264')

    await act(async () => { root?.render(createElement(ExportDialog, { report: report('h264_nvenc', true), onClose: vi.fn(), refreshEncoders: vi.fn() })) })
    expect(select.value).toBe('h264_nvenc')

    await act(async () => {
      select.value = 'libx264'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { root?.render(createElement(ExportDialog, { report: report('h264_nvenc', true), onClose: vi.fn(), refreshEncoders: vi.fn() })) })
    expect(select.value).toBe('libx264')
  })
})
