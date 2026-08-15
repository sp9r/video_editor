import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from './types.js'
import type { SubtitleTemplateId } from './auto-caption-contract.js'

export const SUBTITLE_TEMPLATE_VERSION = 'spectra.subtitle-template.v1' as const
export const SUBTITLE_TEMPLATE_STORE_VERSION = 'spectra.subtitle-template-store.v1' as const

export interface SubtitleTemplateOption {
  id: SubtitleTemplateId
  label: string
  style: SubtitleStyle
  maxChars: number
  maxLines: number
}

export interface UserSubtitleTemplate {
  version: typeof SUBTITLE_TEMPLATE_VERSION
  id: SubtitleTemplateId
  name: string
  style: SubtitleStyle
  maxChars: number
  maxLines: number
  createdAt: string
  updatedAt: string
}

export interface SubtitleTemplateDraft {
  name: string
  style: SubtitleStyle
  maxChars: number
  maxLines: number
}

export interface SubtitleTemplateLoadResult {
  userTemplates: UserSubtitleTemplate[]
  malformedCount: number
  defaultTemplateId: SubtitleTemplateId
}

const template = (id: SubtitleTemplateId, label: string, style: Partial<SubtitleStyle>): SubtitleTemplateOption => ({
  id,
  label,
  style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), ...style },
  maxChars: 32,
  maxLines: 2
})

export const SUBTITLE_TEMPLATES: readonly SubtitleTemplateOption[] = Object.freeze([
  template('default', '標準', {}),
  template('high-contrast', '高コントラスト', { outlineWidth: 5, shadowBlur: 6 }),
  template('minimal', 'ミニマル', { outlineWidth: 1, shadowBlur: 0, bold: false })
].map((candidate) => Object.freeze({ ...candidate, style: Object.freeze(candidate.style) })))

export const getSubtitleTemplateStyle = (id: SubtitleTemplateId = 'default'): SubtitleStyle => {
  return structuredClone(SUBTITLE_TEMPLATES.find((candidate) => candidate.id === id)?.style ?? DEFAULT_SUBTITLE_STYLE)
}

export const getSubtitleTemplate = (
  id: SubtitleTemplateId = 'default',
  userTemplates: readonly UserSubtitleTemplate[] = []
): SubtitleTemplateOption | UserSubtitleTemplate | undefined => {
  return userTemplates.find((candidate) => candidate.id === id) ?? SUBTITLE_TEMPLATES.find((candidate) => candidate.id === id)
}

export const getSubtitleTemplateStyleForId = (
  id: SubtitleTemplateId = 'default',
  userTemplates: readonly UserSubtitleTemplate[] = []
): SubtitleStyle => {
  const selected = getSubtitleTemplate(id, userTemplates)
  return structuredClone(selected?.style ?? DEFAULT_SUBTITLE_STYLE)
}
