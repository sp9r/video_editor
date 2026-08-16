import { describe, expect, it } from 'vitest'
import { layoutSubtitleText, subtitleMaxWidthPx, wrapSubtitleText } from '../../src/shared/subtitle-layout'

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
