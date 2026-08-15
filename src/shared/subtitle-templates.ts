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

export interface SubtitleTemplateSettings {
  style: SubtitleStyle
  maxChars: number
  maxLines: number
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
  template('high-contrast', '白文字・黒縁', { color: '#ffffff', outlineColor: '#000000', outlineWidth: 5, shadowColor: '#00000000', shadowBlur: 0, bold: true }),
  template('minimal', '大きめ強調', { fontSize: 72, outlineColor: '#111318', outlineWidth: 4, shadowBlur: 4, bold: true })
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

export const getSubtitleTemplateSettings = (
  id: SubtitleTemplateId = 'default',
  userTemplates: readonly UserSubtitleTemplate[] = []
): SubtitleTemplateSettings => {
  const selected = getSubtitleTemplate(id, userTemplates)
  return {
    style: structuredClone(selected?.style ?? DEFAULT_SUBTITLE_STYLE),
    maxChars: selected?.maxChars ?? 32,
    maxLines: selected?.maxLines ?? 2
  }
}
