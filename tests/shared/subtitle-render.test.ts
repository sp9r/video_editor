import { describe, expect, it } from 'vitest'
import { buildSubtitleRenderSpec, subtitleAnchorTransform } from '../../src/shared/subtitle-render.js'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types.js'

const caption = (style: Partial<typeof DEFAULT_SUBTITLE_STYLE> = {}, text = 'alpha beta\n日本語'): Parameters<typeof buildSubtitleRenderSpec>[0] => ({
  id: 'caption',
  name: 'caption',
  kind: 'subtitle',
  startUs: 0,
  durationUs: 2_000_000,
  sourceInUs: 0,
  enabled: true,
  text,
  style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), ...style }
})

describe('canonical subtitle render spec', () => {
  it('uses the same logical position and anchor semantics for all alignments', () => {
    const sequence = { width: 1920, height: 1080 }
    const top = buildSubtitleRenderSpec(caption({ alignment: 'top', positionX: 50, positionY: 10 }), sequence)
    const middle = buildSubtitleRenderSpec(caption({ alignment: 'middle', positionX: 50, positionY: 50 }), sequence)
    const bottom = buildSubtitleRenderSpec(caption({ alignment: 'bottom', positionX: 50, positionY: 90 }), sequence)
    expect([top.xPx, middle.xPx, bottom.xPx]).toEqual([960, 960, 960])
    expect([top.yPx, middle.yPx, bottom.yPx]).toEqual([108, 540, 972])
    expect(subtitleAnchorTransform(top.anchor)).toBe('translate(-50%, 0)')
    expect(subtitleAnchorTransform(middle.anchor)).toBe('translate(-50%, -50%)')
    expect(subtitleAnchorTransform(bottom.anchor)).toBe('translate(-50%, -100%)')
  })

  it('shares wrapped text and accepts the expanded editable range', () => {
    const spec = buildSubtitleRenderSpec(caption({ maxWidthPercent: 150, positionX: -25, positionY: 150, fontSize: 64, fontFamily: 'Test Family', bold: false, italic: true, color: '#123456', outlineColor: '#654321', outlineWidth: 7, letterSpacing: 3, lineHeight: 1.4, shadowColor: '#abcdef', shadowBlur: 8, backgroundColor: '#fedcba', backgroundOpacity: 0.4 }), { width: 1920, height: 1080 })
    expect(spec.maxWidthPx).toBe(2880)
    expect(spec.xPx).toBe(-480)
    expect(spec.yPx).toBe(1620)
    expect(spec.wrappedText).toContain('\n')
    expect(spec).toMatchObject({ fontFamily: 'Test Family', fontSizePx: 64, bold: false, italic: true, color: '#123456', outlineColor: '#654321', outlineWidthPx: 7, letterSpacingPx: 3, lineHeight: 1.4, shadowColor: '#abcdef', shadowBlurPx: 8, backgroundColor: '#fedcba', backgroundOpacity: 0.4 })
  })
})
