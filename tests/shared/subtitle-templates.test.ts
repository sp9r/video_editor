import { describe, expect, it } from 'vitest'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types'
import { getSubtitleTemplateSettings, getSubtitleTemplateStyleForId, SUBTITLE_TEMPLATES } from '../../src/shared/subtitle-templates'

describe('subtitle template model', () => {
  it('keeps built-in templates immutable and returns cloned styles', () => {
    const original = SUBTITLE_TEMPLATES[0]!.style.fontSize
    const style = getSubtitleTemplateStyleForId('default')
    style.fontSize = original + 10
    expect(SUBTITLE_TEMPLATES[0]!.style.fontSize).toBe(original)
    expect(DEFAULT_SUBTITLE_STYLE.fontSize).toBe(original)
  })

  it('resolves a user template by id without changing built-ins', () => {
    const user = { version: 'spectra.subtitle-template.v1' as const, id: 'user-template-1', name: 'User', style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), fontSize: 77 }, maxChars: 40, maxLines: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    expect(getSubtitleTemplateStyleForId(user.id, [user]).fontSize).toBe(77)
    expect(getSubtitleTemplateStyleForId('default').fontSize).toBe(DEFAULT_SUBTITLE_STYLE.fontSize)
  })

  it('resolves style and display constraints together for initial caption settings', () => {
    const user = { version: 'spectra.subtitle-template.v1' as const, id: 'user-template-settings', name: 'YouTube標準', style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), fontSize: 77 }, maxChars: 40, maxLines: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    expect(getSubtitleTemplateSettings(user.id, [user])).toMatchObject({ maxChars: 40, maxLines: 3, style: { fontSize: 77 } })
    expect(getSubtitleTemplateSettings('minimal')).toMatchObject({ maxChars: 32, maxLines: 2 })
  })
})
