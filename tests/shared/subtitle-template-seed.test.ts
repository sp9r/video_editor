import { describe, expect, it } from 'vitest'
import { applySubtitleTemplateToClip, deriveSubtitleTemplateGeneration } from '../../src/shared/subtitle-template-seed'
import { createSubtitleClip } from '../../src/shared/project'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types'

describe('subtitle template seed from timeline captions', () => {
  const currentSettings = { maxChars: 32, maxLines: 2, segmentationMode: 'auto' as const }

  it('uses clip style and maxLines, lineage generation settings, and never text length', () => {
    const clip = { style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), maxWidthPercent: 125 }, maxLines: 4 as number | undefined }
    const generation = deriveSubtitleTemplateGeneration({
      clip,
      currentSettings,
      lineage: { maxChars: 48, maxLines: 7, segmentationMode: 'rule' }
    })
    expect(generation).toEqual({ maxChars: 48, maxLines: 4, segmentationMode: 'rule', layoutConstraints: { maxWidthPercent: 125 } })
  })

  it('uses current auto-processing settings when lineage is unavailable', () => {
    const generation = deriveSubtitleTemplateGeneration({
      clip: { style: structuredClone(DEFAULT_SUBTITLE_STYLE), maxLines: undefined },
      currentSettings: { maxChars: 64, maxLines: 3, segmentationMode: 'llm' }
    })
    expect(generation).toMatchObject({ maxChars: 64, maxLines: 3, segmentationMode: 'llm' })
  })

  it('applies the saved style and constraints to a new subtitle clip', () => {
    const clip = createSubtitleClip(0, 1_000_000)
    const template = {
      style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), fontSize: 88 },
      captionGeneration: { maxChars: 40, maxLines: 5, segmentationMode: 'rule' as const, layoutConstraints: { maxWidthPercent: 80 } }
    }
    const applied = applySubtitleTemplateToClip(clip, template)
    expect(applied.style.fontSize).toBe(88)
    expect(applied.maxLines).toBe(5)
    expect(applied.text).toBe(clip.text)
  })
})
