import { describe, expect, it } from 'vitest'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types'
import { getSubtitleTemplateSettings, getSubtitleTemplateStyleForId, SUBTITLE_TEMPLATES } from '../../src/shared/subtitle-templates'

describe('subtitle template model', () => {
  it('ships only the three restrained built-in templates', () => {
    expect(SUBTITLE_TEMPLATES.map((template) => template.label)).toEqual(['標準（切り抜き）', '白文字・黒縁', '大きめ強調'])
    expect(SUBTITLE_TEMPLATES).toHaveLength(3)
    expect(SUBTITLE_TEMPLATES[1]?.style).toMatchObject({ color: '#ffffff', outlineColor: '#000000' })
    expect(SUBTITLE_TEMPLATES[2]?.style.fontSize).toBeGreaterThan(SUBTITLE_TEMPLATES[1]?.style.fontSize ?? 0)
  })

  it('makes the standard template look like the posted clips', () => {
    expect(SUBTITLE_TEMPLATES[0]?.style).toMatchObject({ fontFamily: 'Keifont', color: '#fff800', outlineColor: '#000000', outlineWidth: 7, fontSize: 130 })
    expect(getSubtitleTemplateSettings('default')).toMatchObject({ maxChars: 14, maxLines: 1 })
  })

  it('keeps built-in templates immutable and returns cloned styles', () => {
    const original = SUBTITLE_TEMPLATES[0]!.style.fontSize
    const style = getSubtitleTemplateStyleForId('default')
    style.fontSize = original + 10
    expect(SUBTITLE_TEMPLATES[0]!.style.fontSize).toBe(original)
    expect(getSubtitleTemplateStyleForId('default').fontSize).toBe(original)
  })

  it('resolves a user template by id without changing built-ins', () => {
    const user = { version: 'spectra.subtitle-template.v2' as const, id: 'user-template-1', name: 'User', style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), fontSize: 77 }, captionGeneration: { maxChars: 40, maxLines: 3, segmentationMode: 'auto' as const, layoutConstraints: { maxWidthPercent: 80 } }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    expect(getSubtitleTemplateStyleForId(user.id, [user]).fontSize).toBe(77)
    expect(getSubtitleTemplateStyleForId('default').fontSize).toBe(SUBTITLE_TEMPLATES[0]!.style.fontSize)
  })

  it('resolves style and display constraints together for initial caption settings', () => {
    const user = { version: 'spectra.subtitle-template.v2' as const, id: 'user-template-settings', name: 'YouTube標準', style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), fontSize: 77 }, captionGeneration: { maxChars: 40, maxLines: 3, segmentationMode: 'rule' as const, layoutConstraints: { maxWidthPercent: 80 } }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    expect(getSubtitleTemplateSettings(user.id, [user])).toMatchObject({ maxChars: 40, maxLines: 3, segmentationMode: 'rule', style: { fontSize: 77 } })
    expect(getSubtitleTemplateSettings('minimal')).toMatchObject({ maxChars: 32, maxLines: 2, segmentationMode: 'auto' })
  })
})
