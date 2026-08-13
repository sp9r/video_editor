import { describe, expect, it } from 'vitest'
import { wrapSubtitleText } from '../../src/shared/subtitle-layout'

const style = { fontSize: 20, letterSpacing: 0, maxWidthPercent: 80 }

describe('shared subtitle wrapping', () => {
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
})
