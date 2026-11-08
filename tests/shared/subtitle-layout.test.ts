import { describe, expect, it } from 'vitest'
import { layoutSubtitleText, subtitleLineCapacity, subtitleMaxWidthPx, wrapSubtitleText } from '../../src/shared/subtitle-layout'

const style = { fontSize: 20, letterSpacing: 0, maxWidthPercent: 80 }

describe('shared subtitle wrapping', () => {
  it.each([[50, 960], [80, 1536], [100, 1920]])('maps %s%% to the sequence line-box width', (percent, expected) => {
    expect(subtitleMaxWidthPx({ maxWidthPercent: percent }, 1920)).toBe(expected)
  })

  it('uses the full sequence width for a 100% long Japanese line', () => {
    const text = '字幕の利用可能な横幅を確認するための長い日本語テキストです'
    const at80 = layoutSubtitleText(text, { ...style, maxWidthPercent: 80, fontSize: 54 }, 1920, 2)
    const at100 = layoutSubtitleText(text, { ...style, maxWidthPercent: 100, fontSize: 54 }, 1920, 2)
    expect(at100.lineCount).toBeLessThanOrEqual(at80.lineCount)
    expect(at100.wrappedText.replace(/\n/gu, '')).toBe(text)
    expect(at100.diagnostics).toEqual([])
  })

  it('preserves explicit newlines and wraps English at word boundaries', () => {
    expect(wrapSubtitleText('alpha beta gamma\n日本語 caption', style, 160)).toBe('alpha beta\ngamma\n日本語\ncaption')
  })

  it('splits a word only when the word itself is wider than the line', () => {
    expect(wrapSubtitleText('supercalifragilistic', style, 100)).toContain('\n')
    expect(wrapSubtitleText('alpha beta', style, 160)).toBe('alpha beta')
  })

  it('keeps mixed Japanese and English at grapheme-safe boundaries', () => {
    const wrapped = wrapSubtitleText('日本語ABC😀DEF', style, 160)
    expect(wrapped.replace(/\n/gu, '')).toBe('日本語ABC😀DEF')
    expect(wrapped).not.toContain('\uD83D\n\uDE00')
  })

  it('reports one-line and two-line layouts without changing caption text', () => {
    const one = layoutSubtitleText('短い字幕', style, 1920, 2)
    const two = layoutSubtitleText('alpha beta gamma', style, 160, 2)
    expect(one).toMatchObject({ lineCount: 1, maxLines: 2, diagnostics: [] })
    expect(two.lineCount).toBe(2)
    expect(two.diagnostics).toEqual([])
    expect(two.wrappedText.replace(/\n/gu, ' ')).toBe('alpha beta gamma')
  })

  it('does not silently discard overflow and emits a max-lines diagnostic', () => {
    const overflow = layoutSubtitleText('alpha beta gamma', style, 160, 1)
    const longWord = layoutSubtitleText('超長い日本語字幕'.repeat(8), style, 160, 2)
    expect(overflow.lineCount).toBeGreaterThan(1)
    expect(overflow.diagnostics[0]).toMatchObject({ code: 'MAX_LINES_EXCEEDED', maxLines: 1, actualLines: overflow.lineCount })
    expect(longWord.lineCount).toBeGreaterThan(2)
    expect(longWord.diagnostics[0]?.code).toBe('MAX_LINES_EXCEEDED')
    expect(longWord.wrappedText.replace(/\n/gu, '')).toBe('超長い日本語字幕'.repeat(8))
  })

  it('keeps Japanese, font-size variation, and landscape width in the same model', () => {
    const small = layoutSubtitleText('日本語の字幕です', { ...style, fontSize: 20 }, 1920, 2)
    const large = layoutSubtitleText('日本語の字幕です', { ...style, fontSize: 80 }, 1920, 2)
    const landscape = layoutSubtitleText('English subtitle for landscape', style, 1280, 2)
    expect(small.wrappedText.replace(/\n/gu, '')).toBe('日本語の字幕です')
    expect(large.wrappedText.replace(/\n/gu, '')).toBe('日本語の字幕です')
    expect(landscape.lineCount).toBeLessThanOrEqual(2)
  })

  it('keeps the legacy wrapper API while accepting a line limit', () => {
    expect(wrapSubtitleText('one two three', style, 160, 2).split('\n').length).toBe(2)
  })
})

describe('subtitle line capacity', () => {
  const userStyle = { fontSize: 120, letterSpacing: 0, maxWidthPercent: 80 }

  it('fits 12 full-width characters per line for 120 px text in 80% of 1920 px', () => {
    expect(subtitleLineCapacity(userStyle, 1920)).toBe(12)
  })

  it('agrees with layoutSubtitleText: capacity chars stay on one line, one more wraps', () => {
    for (const [fontSize, letterSpacing, percent, width] of [[120, 0, 80, 1920], [54, 2, 80, 1920], [72, 4, 60, 1080], [48, 0.5, 100, 1280]] as const) {
      const s = { fontSize, letterSpacing, maxWidthPercent: percent }
      const capacity = subtitleLineCapacity(s, width)
      expect(layoutSubtitleText('あ'.repeat(capacity), s, width, 4).lineCount).toBe(1)
      expect(layoutSubtitleText('あ'.repeat(capacity + 1), s, width, 4).lineCount).toBe(2)
    }
  })

  it('is at least 1 even when one glyph is wider than the line', () => {
    expect(subtitleLineCapacity({ fontSize: 400, letterSpacing: 0, maxWidthPercent: 10 }, 1920)).toBe(1)
  })
})

describe('Japanese bunsetsu-aware balanced wrapping', () => {
  const user = { fontSize: 120, letterSpacing: 0, maxWidthPercent: 80 }
  const lines = (text: string, maxLines = 2) => layoutSubtitleText(text, user, 1920, maxLines).wrappedText.split('\n')

  it('does not leave a verb ending alone: 解説します', () => {
    const wrapped = lines('突破するコツを3分で解説します')
    expect(wrapped).toHaveLength(2)
    expect(wrapped.join('')).toBe('突破するコツを3分で解説します')
    expect(wrapped.some((line) => line === 'ます' || line.startsWith('ます'))).toBe(false)
    expect(wrapped.join('|')).not.toContain('解説し|')
  })

  it('does not leave a particle alone: エントリーシートを', () => {
    const wrapped = lines('あなたはエントリーシートを')
    expect(wrapped.join('')).toBe('あなたはエントリーシートを')
    expect(wrapped.every((line) => line !== 'を' && !line.startsWith('を'))).toBe(true)
  })

  it('balances the lines instead of filling the first line', () => {
    const wrapped = lines('すると嬉しいことに面接の通知が来ました')
    expect(wrapped).toHaveLength(2)
    const widths = wrapped.map((line) => Array.from(line).length)
    expect(Math.abs(widths[0]! - widths[1]!)).toBeLessThanOrEqual(4)
  })

  it('never starts a line with punctuation or a closing bracket', () => {
    const wrapped = lines('それはとても大切なことなのですが、今日はここまでにします。')
    for (const line of wrapped) expect(line).not.toMatch(/^[、。」）]/u)
    expect(wrapped.join('')).toBe('それはとても大切なことなのですが、今日はここまでにします。')
  })

  it('keeps the text and never needs fewer lines than the capacity allows', () => {
    const text = '憧れの会社に提出すると嬉しいことに面接の通知が来ました'
    for (const percent of [30, 45, 60, 80, 100]) {
      const result = layoutSubtitleText(text, { ...user, maxWidthPercent: percent }, 1920, 4)
      expect(result.wrappedText.replace(/\n/gu, '')).toBe(text)
      const capacity = subtitleLineCapacity({ ...user, maxWidthPercent: percent }, 1920)
      expect(result.lineCount).toBeGreaterThanOrEqual(Math.ceil(Array.from(text).length / capacity))
    }
  })

  it('is deterministic (Preview and ASS share this function)', () => {
    const a = layoutSubtitleText('突破するコツを3分で解説します', user, 1920, 2)
    const b = layoutSubtitleText('突破するコツを3分で解説します', user, 1920, 2)
    expect(a).toEqual(b)
  })
})

describe('wrapping examples from the Japanese line-break review', () => {
  const user = { fontSize: 120, letterSpacing: 0, maxWidthPercent: 80 }
  it('keeps a verb stem with its auxiliary and a particle with its noun', () => {
    expect(layoutSubtitleText('トレーニングすべきでしょうか', user, 1920, 2).wrappedText).toBe('トレーニング\nすべきでしょうか')
    expect(layoutSubtitleText('あなたはエントリーシートを', user, 1920, 2).wrappedText).toBe('あなたは\nエントリーシートを')
    expect(layoutSubtitleText('突破するコツを3分で解説します', user, 1920, 2).wrappedText).toBe('突破するコツを\n3分で解説します')
  })
  it('wraps English at word boundaries and balances the lines', () => {
    expect(layoutSubtitleText('This is an English caption for testing', user, 1920, 2).wrappedText).toBe('This is an English\ncaption for testing')
  })
})
