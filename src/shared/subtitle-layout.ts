import type { SubtitleStyle } from './types'

/**
 * Conservative, renderer-independent wrapping used by both Preview and ASS.
 * It intentionally leaves 70–85% of the sequence available for captions so
 * glyph outlines do not touch the frame edge.
 */
export const subtitleMaxWidthPercent = (style: Pick<SubtitleStyle, 'maxWidthPercent'>): number =>
  Math.min(85, Math.max(70, style.maxWidthPercent ?? 80))

export const wrapSubtitleText = (text: string, style: Pick<SubtitleStyle, 'fontSize' | 'letterSpacing' | 'maxWidthPercent'>, sequenceWidth: number): string => {
  const width = Math.max(16, sequenceWidth) * subtitleMaxWidthPercent(style) / 100
  const glyphWidth = Math.max(1, style.fontSize * 0.95 + Math.max(0, style.letterSpacing))
  const charactersPerLine = Math.max(1, Math.floor(width / glyphWidth))
  return text.replace(/\r\n|\r/gu, '\n').split('\n').flatMap((line) => {
    if (!line) return ['']
    const characters = Array.from(line)
    const chunks: string[] = []
    for (let index = 0; index < characters.length; index += charactersPerLine) chunks.push(characters.slice(index, index + charactersPerLine).join(''))
    return chunks
  }).join('\n')
}
