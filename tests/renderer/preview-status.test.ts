import { describe, expect, it } from 'vitest'
import { previewQualityLabel } from '../../src/renderer/src/preview-status'

describe('preview quality status', () => {
  it('never labels a stale accurate frame as displayed', () => {
    expect(previewQualityLabel({ playing: false, accurateFrameMatchesCurrent: false, accurateRendering: false, accurateError: null })).toContain('高速表示')
    expect(previewQualityLabel({ playing: false, accurateFrameMatchesCurrent: false, accurateRendering: true, accurateError: null })).toBe('高速表示 / 正確プレビュー更新中…')
    expect(previewQualityLabel({ playing: false, accurateFrameMatchesCurrent: true, accurateRendering: false, accurateError: null })).toBe('正確プレビュー')
    expect(previewQualityLabel({ playing: true, accurateFrameMatchesCurrent: true, accurateRendering: false, accurateError: null })).toBe('高速プレビュー')
  })
})
