/**
 * How a caption's display text is derived from its source words.
 *
 * Mirrors clip_automation/caption_text.py. The source word text (including
 * punctuation) is never changed; only the displayed caption text drops marks.
 *
 * - `hide`:   「句読点を表示しない」. Removes 、。，． and half-width , . that are not
 *             between digits (3.14 / 1,000 stay). ? ! … ・ 〜 are kept. The marks are
 *             simply removed (no space is inserted), so the displayed text is always
 *             the concatenation of the words' displayed texts.
 * - `legacy`: the older rule that also removed ！？!?…・〜～ (existing projects).
 */
export type CaptionDisplayMode = 'hide' | 'legacy'

const HIDE_PUNCTUATION = /[、。，．]|(?<!\d)[,.]|[,.](?!\d)/gu
const LEGACY_PUNCTUATION = /[、。！？!?…・〜～]+/gu

export const normalizeCaptionDisplayText = (text: string, mode: CaptionDisplayMode = 'hide'): string =>
  text.replace(mode === 'hide' ? HIDE_PUNCTUATION : LEGACY_PUNCTUATION, '')

/** The mode that derives `display` from `source`, or undefined when no known rule does. */
export const resolveCaptionDisplayMode = (source: string, display: string): CaptionDisplayMode | undefined => {
  if (normalizeCaptionDisplayText(source, 'hide') === display) return 'hide'
  if (normalizeCaptionDisplayText(source, 'legacy') === display) return 'legacy'
  return undefined
}

/** True when `display` is `source` itself or a known display normalisation of it (never a manual edit). */
export const isCaptionDisplayDerived = (source: string, display: string): boolean =>
  source === display || resolveCaptionDisplayMode(source, display) !== undefined
