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

/**
 * Canonical subtitle line-box width used by both CSS Preview and ASS layout.
 * This is a wrapping limit, not the width of the text-sized background box.
 */
export const subtitleMaxWidthPx = (
  style: Pick<SubtitleStyle, 'maxWidthPercent'>,
  sequenceWidth: number
): number => Math.max(16, Number.isFinite(sequenceWidth) ? sequenceWidth : 1920) * subtitleMaxWidthPercent(style) / 100

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

/**
 * Approximate text width in px: CJK glyph = fontSize, Latin 0.58, space 0.45,
 * plus letterSpacing between graphemes. Shared by wrapping and caption generation.
 */
export const measureSubtitleTextWidth = (token: string, style: Pick<SubtitleStyle, 'fontSize' | 'letterSpacing'>): number => {
  const glyphWidth = Math.max(1, style.fontSize)
  const letterSpacing = Math.max(0, style.letterSpacing)
  const parts = graphemes(token)
  return parts.reduce((sum, grapheme) => {
    if (/\s/uy.test(grapheme)) return sum + glyphWidth * 0.45
    if (/^[\u0000-\u00ff]$/u.test(grapheme)) return sum + glyphWidth * 0.58
    return sum + glyphWidth
  }, 0) + Math.max(0, parts.length - 1) * letterSpacing
}

/**
 * How many full-width (CJK) characters fit on one line at this style and
 * sequence width. n glyphs need n*fontSize + (n-1)*letterSpacing, the same
 * measurement layoutSubtitleText wraps with, so generation and wrapping agree.
 */
export const subtitleLineCapacity = (
  style: Pick<SubtitleStyle, 'fontSize' | 'letterSpacing' | 'maxWidthPercent'>,
  sequenceWidth: number
): number => {
  const glyphWidth = Math.max(1, style.fontSize)
  const letterSpacing = Math.max(0, style.letterSpacing)
  const width = subtitleMaxWidthPx(style, sequenceWidth)
  return Math.max(1, Math.floor((width + letterSpacing) / (glyphWidth + letterSpacing) + 1e-9))
}


// --- Japanese-aware, balanced line breaking --------------------------------
// Intl.Segmenter word tokens split verb endings ("解説|し|ます") and attach
// nothing to particles, so a plain greedy fill produced lines like "解説し /
// ます". Tokens are first merged into bunsetsu-like chunks with a small rule
// set, then the chunks are distributed over the minimum number of lines so
// that the lines are balanced. Preview and ASS both call layoutSubtitleText,
// so they always get the same breaks.

const HIRAGANA_ONLY = /^[ぁ-ゖー]+$/u
const NO_BREAK_BEFORE = /^[、。，．,.!！?？…・」』）】〕》〉%％〜～)]/u
const OPENING_BRACKET_END = /[「『（【〔《〈(]$/u
const FUNCTION_WORDS = new Set([
  'の', 'は', 'が', 'を', 'に', 'へ', 'と', 'で', 'も', 'や', 'か', 'ね', 'よ', 'な', 'ば', 'て', 'た', 'だ', 'し', 'ん',
  'から', 'まで', 'より', 'ので', 'のに', 'けど', 'けれど', 'って', 'とか', 'だけ', 'ほど', 'しか', 'ばかり', 'くらい', 'ぐらい', 'ながら',
  'ます', 'ました', 'ません', 'ませ', 'ましょう', 'です', 'でした', 'でしょう', 'だった', 'ない', 'なかっ', 'なく', 'ある', 'いる', 'れる', 'られる',
  'せる', 'させる', 'たい', 'たら', 'たり', 'ず', 'ぬ', 'そうです', 'ようです', 'みたい',
  'しょう', 'よう', 'だろう', 'ください', 'いただき', 'じゃ', 'ちゃ', 'ちゃう', 'ござい', 'ありません'
])
// Auxiliary verb endings with an optional sentence-final particle ("でしょうか", "ですね").
const AUXILIARY_ENDING = /^(でしょう|しょう|ましょう|だろう|です|ます|ました|ません|でした|ない|なかっ|たい|ください|ちゃ|じゃ)[かねよなぞわ]?$/u
const SUFFIX_WORDS = new Set(['さん', 'ちゃん', 'くん', 'たち', 'など', '的', '化', '性', '様'])
const DEMONSTRATIVES = new Set(['これ', 'それ', 'あれ', 'どれ', 'ここ', 'そこ', 'どこ', 'この', 'その', 'あの', 'どの', 'こう', 'そう', 'ああ', 'どう', 'もう', 'まだ', 'すぐ', 'また', 'いま', 'でも', 'だが', 'だから', 'そして', 'しかし', 'では', 'じゃあ', 'まあ'])

type BreakKind = 'free' | 'weak' | 'hard'

/**
 * How reluctant a line break before `token` should be.
 * hard: punctuation, particles, auxiliaries, suffixes ("を", "ます", "。")
 * weak: probably the same word ("解説|し", "エントリー|シート", "3|分")
 * free: an ordinary bunsetsu boundary.
 */
const breakKindBefore = (token: string, previous: string): BreakKind => {
  if (!/\S/u.test(token)) return 'hard'
  const trimmed = token.trim()
  if (NO_BREAK_BEFORE.test(trimmed)) return 'hard'
  if (OPENING_BRACKET_END.test(previous.trimEnd())) return 'hard'
  if (previous !== previous.trimEnd()) return 'free'
  if (SUFFIX_WORDS.has(trimmed) || FUNCTION_WORDS.has(trimmed) || AUXILIARY_ENDING.test(trimmed)) return 'hard'
  if (HIRAGANA_ONLY.test(trimmed) && Array.from(trimmed).length <= 2 && !DEMONSTRATIVES.has(trimmed)) return 'weak'
  // Consecutive katakana tokens are one loanword compound ("エントリー|シート").
  if (/^[゠-ヿ]+$/u.test(trimmed) && /[゠-ヿ]$/u.test(previous)) return 'weak'
  // A number glued to its counter: "3|分", "100|円".
  if (/[0-9０-９.,]$/u.test(previous) && /^[㐀-鿿]/u.test(trimmed)) return 'weak'
  return 'free'
}

const wrapCache = new Map<string, string>()
const WRAP_CACHE_LIMIT = 800

const balancedWrapLine = (
  line: string,
  width: number,
  measure: (text: string) => number,
  greedyWrapLine: (line: string) => string
): string => {
  if (!line) return ''
  const key = `${width}|${measure('あ')}|${measure('ああ')}|${measure('a')}|${line}`
  const cached = wrapCache.get(key)
  if (cached !== undefined) return cached
  const store = (value: string): string => {
    if (wrapCache.size >= WRAP_CACHE_LIMIT) wrapCache.delete(wrapCache.keys().next().value as string)
    wrapCache.set(key, value)
    return value
  }
  const tokens = wordTokens(line).filter((token) => token.length > 0)
  // A token wider than the line must be split inside itself: use the plain greedy path.
  if (tokens.length < 2 || tokens.some((token) => measure(token.trimEnd()) > width)) return store(greedyWrapLine(line))
  const count = tokens.length
  const widthCache = new Map<number, number>()
  const lineWidth = (from: number, to: number): number => {
    const cacheKey = from * 4096 + to
    let value = widthCache.get(cacheKey)
    if (value === undefined) {
      value = measure(tokens.slice(from, to).join('').trim())
      widthCache.set(cacheKey, value)
    }
    return value
  }
  // Minimum number of lines (greedy over tokens).
  let lineCount = 1
  let start = 0
  for (let index = 1; index < count; index += 1) {
    if (lineWidth(start, index + 1) > width) {
      lineCount += 1
      start = index
    }
  }
  if (lineCount === 1) return store(tokens.join('').trim())
  const breakPenalty = tokens.map((token, index) => {
    if (index === 0) return 0
    const kind = breakKindBefore(token, tokens[index - 1]!)
    // A single leftover kana is the most likely to be the middle of a word.
    const weak = (Array.from(token.trim()).length <= 1 ? 2.4 : 2) * width * width
    return kind === 'hard' ? 6 * width * width : kind === 'weak' ? weak : 0
  })
  const INF = Number.POSITIVE_INFINITY
  const cost: number[][] = Array.from({ length: lineCount + 1 }, () => new Array<number>(count + 1).fill(INF))
  const from: number[][] = Array.from({ length: lineCount + 1 }, () => new Array<number>(count + 1).fill(-1))
  cost[0]![0] = 0
  for (let lineIndex = 1; lineIndex <= lineCount; lineIndex += 1) {
    for (let end = lineIndex; end <= count; end += 1) {
      // Larger split points first: on equal cost the earlier line stays fuller.
      for (let split = end - 1; split >= lineIndex - 1; split -= 1) {
        const previous = cost[lineIndex - 1]![split]!
        if (previous === INF) continue
        const used = lineWidth(split, end)
        if (used > width) continue
        const slack = width - used
        // Prefer breaking after punctuation.
        const punctuationBonus = /[、。，．,.!！?？]$/u.test(tokens[end - 1]!.trimEnd()) && end < count ? 0.15 * width * width : 0
        const total = previous + slack * slack - punctuationBonus + (split > 0 ? breakPenalty[split]! : 0)
        if (total < cost[lineIndex]![end]! - 1e-9) {
          cost[lineIndex]![end] = total
          from[lineIndex]![end] = split
        }
      }
    }
  }
  if (cost[lineCount]![count] === INF) return store(greedyWrapLine(line))
  const lines: string[] = []
  let end = count
  for (let lineIndex = lineCount; lineIndex >= 1; lineIndex -= 1) {
    const split = from[lineIndex]![end]!
    lines.unshift(tokens.slice(split, end).join('').trim())
    end = split
  }
  return store(lines.join('\n'))
}

export const layoutSubtitleText = (text: string, style: Pick<SubtitleStyle, 'fontSize' | 'letterSpacing' | 'maxWidthPercent'>, sequenceWidth: number, requestedMaxLines?: number): SubtitleLayoutResult => {
  const maxLines = normalizeSubtitleMaxLines(requestedMaxLines)
  const width = subtitleMaxWidthPx(style, sequenceWidth)
  const tokenWidth = (token: string): number => measureSubtitleTextWidth(token, style)
  const greedyWrapLine = (line: string): string => {
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
  const wrapLine = (line: string): string => balancedWrapLine(line, width, tokenWidth, greedyWrapLine)
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
