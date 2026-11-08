import { describe, expect, it } from 'vitest'
import { previewQualityLabel } from '../../src/renderer/src/preview-status'

const base = { playing: false, exactCheck: false, exactShown: false, exactRendering: false, exactError: null }

describe('preview quality status', () => {
  it('labels the live composite by default, in both states', () => {
    expect(previewQualityLabel(base)).toContain('ライブ合成')
    expect(previewQualityLabel({ ...base, playing: true })).toBe(previewQualityLabel(base))
  })

  it('only claims export quality while the FFmpeg frame is really shown', () => {
    expect(previewQualityLabel({ ...base, exactCheck: true, exactRendering: true })).toContain('生成中')
    expect(previewQualityLabel({ ...base, exactCheck: true, exactError: 'x' })).toContain('取得失敗')
    expect(previewQualityLabel({ ...base, exactCheck: true, exactShown: true })).toContain('書き出し画質（FFmpegの1フレーム）')
    expect(previewQualityLabel({ ...base, exactCheck: true, playing: true, exactShown: true })).not.toContain('FFmpegの1フレーム')
  })
})
