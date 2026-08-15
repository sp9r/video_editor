import type { AutoCaptionSettings, SegmentationMode } from './auto-caption-contract.js'
import type { SubtitleTemplateCaptionGeneration, SubtitleTemplateOption, UserSubtitleTemplate } from './subtitle-templates.js'
import { validateSubtitleMaxLines } from './subtitle-layout.js'
import type { SubtitleClip } from './types.js'

export type SubtitleTemplateGenerationSeed = Pick<AutoCaptionSettings, 'maxChars' | 'maxLines' | 'segmentationMode'>

export interface SubtitleTemplateLineageSeed {
  maxChars?: number
  maxLines?: number
  segmentationMode?: SegmentationMode
}

export interface SubtitleTemplateSeedInput {
  clip: Pick<SubtitleClip, 'style' | 'maxLines'>
  currentSettings: SubtitleTemplateGenerationSeed
  lineage?: SubtitleTemplateLineageSeed
}

/**
 * Derive generation settings for a template saved from an existing caption.
 * Text length is deliberately never used as a maxChars guess.
 */
export const deriveSubtitleTemplateGeneration = ({ clip, currentSettings, lineage }: SubtitleTemplateSeedInput): SubtitleTemplateCaptionGeneration => ({
  maxChars: lineage?.maxChars ?? currentSettings.maxChars,
  maxLines: validateSubtitleMaxLines(clip.maxLines ?? lineage?.maxLines ?? currentSettings.maxLines ?? 2),
  segmentationMode: lineage?.segmentationMode ?? currentSettings.segmentationMode,
  layoutConstraints: { maxWidthPercent: clip.style.maxWidthPercent }
})

/** Apply both visual style and the clip-level line constraint to a new/editable caption. */
export const applySubtitleTemplateToClip = (
  clip: SubtitleClip,
  template: Pick<SubtitleTemplateOption | UserSubtitleTemplate, 'style' | 'captionGeneration'>
): SubtitleClip => ({
  ...structuredClone(clip),
  style: structuredClone(template.style),
  maxLines: validateSubtitleMaxLines(template.captionGeneration.maxLines)
})
