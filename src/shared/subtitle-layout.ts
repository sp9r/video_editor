import type { SubtitleStyle } from './types'

export const DEFAULT_SUBTITLE_MAX_LINES = 2
export const MIN_SUBTITLE_MAX_LINES = 1
export const MAX_SUBTITLE_MAX_LINES = 16

export interface SubtitleLayoutDiagnostic {
  code: 'MAX_LINES_EXCEEDED'
  message: string
  actualLines: number
  maxLines: number
}

export interface SubtitleLayoutResult {
  wrappedText: string
  lineCount: number
  maxLines: number
  diagnostics: SubtitleLayoutDiagnostic[]
}

/** Renderer-independent width normalization used by Preview and ASS. */
export const subtitleMaxWidthPercent = (style: Pick<SubtitleStyle, 'maxWidthPercent'>): number =>
  Number.isFinite(style.maxWidthPercent) && style.maxWidthPercent > 0 ? style.maxWidthPercent : 80

export const normalizeSubtitleMaxLines = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_SUBTITLE_MAX_LINES && value <= MAX_SUBTITLE_MAX_LINES
    ? value
    : DEFAULT_SUBTITLE_MAX_LINES

export const validateSubtitleMaxLines = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_SUBTITLE_MAX_LINES || value > MAX_SUBTITLE_MAX_LINES) {
    throw new Error(`字幕の最大行数は${MIN_SUBTITLE_MAX_LINES}〜${MAX_SUBTITLE_MAX_LINES}の整数で指定してください。`)
  }
  return value
}

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

export const layoutSubtitleText = (text: string, style: Pick<SubtitleStyle, 'fontSize' | 'letterSpacing' | 'maxWidthPercent'>, sequenceWidth: number, requestedMaxLines?: number): SubtitleLayoutResult => {
  const maxLines = normalizeSubtitleMaxLines(requestedMaxLines)
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
  const wrappedText = text.replace(/\r\n|\r/gu, '\n').split('\n').map(wrapLine).join('\n')
  const lineCount = wrappedText.length === 0 ? 0 : wrappedText.split('\n').length
  const diagnostics = lineCount > maxLines
    ? [{
        code: 'MAX_LINES_EXCEEDED' as const,
        message: `字幕を${maxLines}行以内に収められませんでした。本文を保持したまま${lineCount}行で描画します。`,
        actualLines: lineCount,
        maxLines
      }]
    : []
  return { wrappedText, lineCount, maxLines, diagnostics }
}

export const wrapSubtitleText = (text: string, style: Pick<SubtitleStyle, 'fontSize' | 'letterSpacing' | 'maxWidthPercent'>, sequenceWidth: number, maxLines?: number): string =>
  layoutSubtitleText(text, style, sequenceWidth, maxLines).wrappedText
