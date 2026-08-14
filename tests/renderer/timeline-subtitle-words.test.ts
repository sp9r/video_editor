import { describe, expect, it } from 'vitest'
import { subtitleWordGeometries, subtitleWordGeometry } from '../../src/renderer/src/components/Timeline'
import { DEFAULT_SUBTITLE_STYLE, type SubtitleClip, type SubtitleWord } from '../../src/shared/types'

const makeClip = (overrides: Partial<SubtitleClip> = {}): SubtitleClip => ({
  id: 'caption',
  name: 'caption',
  kind: 'subtitle',
  startUs: 10_000_000,
  durationUs: 2_000_000,
  sourceInUs: 0,
  enabled: true,
  text: '私の持ってない',
  style: structuredClone(DEFAULT_SUBTITLE_STYLE),
  ...overrides
})

const word = (id: string, startUs: number, endUs: number, text = id): SubtitleWord => ({ id, text, startUs, endUs })

describe('timeline subtitle word visualization geometry', () => {
  it('maps three contiguous words to exact clip percentages', () => {
    const clip = makeClip({ words: [word('one', 10_000_000, 10_500_000), word('two', 10_500_000, 11_500_000), word('three', 11_500_000, 12_000_000)] })
    expect(subtitleWordGeometries(clip).map(({ leftPercent, widthPercent }) => ({ leftPercent, widthPercent }))).toEqual([
      { leftPercent: 0, widthPercent: 25 },
      { leftPercent: 25, widthPercent: 50 },
      { leftPercent: 75, widthPercent: 25 }
    ])
  })

  it('preserves gaps instead of normalizing word widths', () => {
    const clip = makeClip({ words: [word('first', 10_200_000, 10_500_000), word('second', 10_800_000, 11_200_000)] })
    expect(subtitleWordGeometries(clip).map(({ leftPercent, widthPercent }) => ({ leftPercent, widthPercent }))).toEqual([
      { leftPercent: 10, widthPercent: 15 },
      { leftPercent: 40, widthPercent: 20 }
    ])
  })

  it('renders no word units when words are undefined or empty', () => {
    expect(subtitleWordGeometries(makeClip())).toEqual([])
    expect(subtitleWordGeometries(makeClip({ words: [] }))).toEqual([])
  })

  it('keeps very short word timing exact without a minimum visual width', () => {
    expect(subtitleWordGeometry(makeClip(), word('short', 10_000_000, 10_010_000))).toEqual({ leftPercent: 0, widthPercent: 0.5 })
  })

  it('keeps word metadata available for text-mismatch captions without throwing', () => {
    const clip = makeClip({ text: '編集済み本文', words: [word('source', 10_000_000, 10_500_000, '元本文')] })
    expect(subtitleWordGeometries(clip)).toHaveLength(1)
    expect(subtitleWordGeometries(clip)[0]?.word.text).toBe('元本文')
  })
})
