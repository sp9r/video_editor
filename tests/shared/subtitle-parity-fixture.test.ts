import { describe, expect, it } from 'vitest'
import { buildSubtitleRenderSpec } from '../../src/shared/subtitle-render.js'
import { createSubtitleParityFixture } from '../../src/shared/subtitle-parity-fixture.js'

describe('Phase 4.11 subtitle parity fixture', () => {
  it('matches the supplied 1920x1080 project settings', () => {
    const project = createSubtitleParityFixture()
    const clip = project.tracks[0]?.clips[0]
    if (!clip || clip.kind !== 'subtitle') throw new Error('subtitle parity fixture is missing')
    const spec = buildSubtitleRenderSpec(clip, project.sequence)
    expect(project.sequence).toMatchObject({ width: 1920, height: 1080 })
    expect(clip.text).toBe('字幕を入力')
    expect(spec).toMatchObject({
      fontFamily: 'Noto Sans JP',
      fontSizePx: 123,
      color: '#ffffff',
      outlineColor: '#111318',
      outlineWidthPx: 14,
      shadowColor: '#ff0000',
      shadowBlurPx: 24,
      shadowOffsetXPx: 0,
      shadowOffsetYPx: 2,
      backgroundColor: '#000000',
      backgroundOpacity: 0.15,
      bold: true,
      anchor: 'bottom',
      xPx: 960,
      yPx: 928.8,
      maxWidthPx: 1536,
      animation: 'none'
    })
  })
})
