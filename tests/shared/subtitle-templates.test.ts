import { describe, expect, it } from 'vitest'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types'
import { getSubtitleTemplateStyleForId, SUBTITLE_TEMPLATES } from '../../src/shared/subtitle-templates'

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
})
