import type { SubtitleStyle } from './types'

/**
 * Conservative, renderer-independent wrapping used by both Preview and ASS.
 * It intentionally leaves 70–85% of the sequence available for captions so
 * glyph outlines do not touch the frame edge.
 */
export const subtitleMaxWidthPercent = (style: Pick<SubtitleStyle, 'maxWidthPercent'>): number =>
  Math.min(85, Math.max(70, style.maxWidthPercent ?? 80))

const graphemes = (text: string): string[] => {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(text), (item) => item.segment)
  }
  return Array.from(text)
}

const wordTokens = (text: string): string[] => {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
    return Array.from(segmenter.segment(text), (item) => item.segment)
  }
  return graphemes(text)
}

export const wrapSubtitleText = (text: string, style: Pick<SubtitleStyle, 'fontSize' | 'letterSpacing' | 'maxWidthPercent'>, sequenceWidth: number): string => {
  const width = Math.max(16, sequenceWidth) * subtitleMaxWidthPercent(style) / 100
  const glyphWidth = Math.max(1, style.fontSize)
  const letterSpacing = Math.max(0, style.letterSpacing)
  const tokenWidth = (token: string): number => graphemes(token).reduce((sum, grapheme) => {
    if (/\s/uy.test(grapheme)) return sum + glyphWidth * 0.45
    if (/^[\u0000-\u00ff]$/u.test(grapheme)) return sum + glyphWidth * 0.58
    return sum + glyphWidth
  }, 0) + Math.max(0, graphemes(token).length - 1) * letterSpacing
  const wrapLine = (line: string): string => {
    if (!line) return ''
    const lines: string[] = []
    let current = ''
    const flush = (): void => {
      if (current) lines.push(current.trimEnd())
      current = ''
    }
    for (const token of wordTokens(line)) {
      if (!token) continue
      if (tokenWidth(token) <= width) {
        if (current && tokenWidth(current + token) > width) {
          flush()
          current = token.trimStart()
        } else {
          current += token
        }
        continue
      }
      // A single word/token is wider than the line. Only this case may split
      // at grapheme boundaries; ordinary English words remain intact.
      flush()
      for (const grapheme of graphemes(token)) {
        if (current && tokenWidth(current + grapheme) > width) flush()
        current += grapheme
      }
    }
    flush()
    return lines.join('\n')
  }
  return text.replace(/\r\n|\r/gu, '\n').split('\n').map(wrapLine).join('\n')
}
