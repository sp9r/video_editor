import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from './types.js'
import type { SubtitleTemplateId } from './auto-caption-contract.js'

export interface SubtitleTemplateOption {
  id: SubtitleTemplateId
  label: string
  style: SubtitleStyle
}

const template = (id: SubtitleTemplateId, label: string, style: Partial<SubtitleStyle>): SubtitleTemplateOption => ({
  id,
  label,
  style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), ...style }
})

export const SUBTITLE_TEMPLATES: readonly SubtitleTemplateOption[] = [
  template('default', '標準', {}),
  template('high-contrast', '高コントラスト', { outlineWidth: 5, shadowBlur: 6 }),
  template('minimal', 'ミニマル', { outlineWidth: 1, shadowBlur: 0, bold: false })
]

export const getSubtitleTemplateStyle = (id: SubtitleTemplateId = 'default'): SubtitleStyle => {
  return structuredClone(SUBTITLE_TEMPLATES.find((candidate) => candidate.id === id)?.style ?? DEFAULT_SUBTITLE_STYLE)
}
