import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types'
import { SubtitleTemplateService } from '../../src/main/subtitle-template-service'

const roots: string[] = []
const draft = (name = '実況用'): { name: string; style: typeof DEFAULT_SUBTITLE_STYLE; captionGeneration: { maxChars: number; maxLines: number; segmentationMode: 'auto'; layoutConstraints: { maxWidthPercent: number } } } => ({
  name, style: structuredClone(DEFAULT_SUBTITLE_STYLE), captionGeneration: { maxChars: 32, maxLines: 2, segmentationMode: 'auto', layoutConstraints: { maxWidthPercent: DEFAULT_SUBTITLE_STYLE.maxWidthPercent } }
})

describe('subtitle template service', () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  it('loads empty userData safely and supports create/update/duplicate/delete', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-template-'))
    roots.push(root)
    const service = new SubtitleTemplateService(root)
    expect(await service.load()).toEqual({ userTemplates: [], malformedCount: 0, migratedCount: 0, defaultTemplateId: 'default' })
    const created = await service.create(draft())
    expect(created.version).toBe('spectra.subtitle-template.v2')
    expect(created.id).toMatch(/^user-template-/)
    expect((await service.load()).userTemplates).toHaveLength(1)
    const updated = await service.update(created.id, { ...draft('更新済み'), style: { ...DEFAULT_SUBTITLE_STYLE, fontFamily: 'Noto Sans JP', fontSize: 123, color: '#ff00aa', outlineWidth: 14, shadowBlur: 24, backgroundOpacity: 0.15, bold: true, italic: true, positionX: 42, positionY: 86, maxWidthPercent: 120, animation: 'fade', animationDurationUs: 500_000 }, captionGeneration: { ...draft().captionGeneration, maxChars: 24, maxLines: 1, segmentationMode: 'rule', layoutConstraints: { maxWidthPercent: 120 } } })
    expect(updated.name).toBe('更新済み')
    expect(updated.style.fontFamily).toBe('Noto Sans JP')
    expect(updated.style.fontSize).toBe(123)
    expect(updated.style.bold).toBe(true)
    expect(updated.captionGeneration.maxChars).toBe(24)
    expect(updated.captionGeneration.maxLines).toBe(1)
    expect(updated.captionGeneration.segmentationMode).toBe('rule')
    const copied = await service.duplicate({ ...draft('複製元'), captionGeneration: { ...draft().captionGeneration, maxChars: 40 } })
    expect(copied.id).not.toBe(created.id)
    expect(copied.name).toBe('複製元 copy')
    expect(await service.remove(created.id)).toBe(true)
    expect(await service.remove(created.id)).toBe(false)
    expect((await service.load()).userTemplates.map((template) => template.id)).toEqual([copied.id])
    expect((await service.setDefault(copied.id)).defaultTemplateId).toBe(copied.id)
    const restarted = new SubtitleTemplateService(root)
    expect((await restarted.load()).userTemplates[0]).toMatchObject({ id: copied.id, name: '複製元 copy', captionGeneration: { maxChars: 40 } })
    expect(await service.remove(copied.id)).toBe(true)
    expect((await new SubtitleTemplateService(root).load()).defaultTemplateId).toBe('default')
  })

  it('writes a versioned path-free store atomically', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-template-store-'))
    roots.push(root)
    const service = new SubtitleTemplateService(root)
    await service.create(draft())
    const stored = await readFile(path.join(root, 'subtitle-templates.v1.json'), 'utf8')
    expect(stored).toContain('spectra.subtitle-template-store.v1')
    expect(stored).toContain('defaultTemplateId')
    expect(stored).not.toContain(root)
    expect(stored).not.toContain('absolutePath')
  })

  it('ignores malformed template records without breaking the catalog', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-template-malformed-'))
    roots.push(root)
    await writeFile(path.join(root, 'subtitle-templates.v1.json'), JSON.stringify({
      version: 'spectra.subtitle-template-store.v1',
      templates: [{ version: 'spectra.subtitle-template.v2', id: 'valid', ...draft('valid'), createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z' }, { version: 'spectra.subtitle-template.v2', id: 'bad', name: 'bad', style: {}, captionGeneration: {}, createdAt: 'bad', updatedAt: 'bad' }]
    }), 'utf8')
    const loaded = await new SubtitleTemplateService(root).load()
    expect(loaded.userTemplates).toHaveLength(1)
    expect(loaded.userTemplates[0]?.name).toBe('valid')
    expect(loaded.malformedCount).toBe(1)
    expect(loaded.defaultTemplateId).toBe('default')
  })

  it('supports built-in defaults and rejects unknown defaults', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-template-default-'))
    roots.push(root)
    const service = new SubtitleTemplateService(root)
    expect((await service.setDefault('high-contrast')).defaultTemplateId).toBe('high-contrast')
    await expect(service.setDefault('missing-template')).rejects.toThrow()
    await expect(service.update('high-contrast', draft('不正な変更'))).rejects.toThrow()
  })

  it('rejects malformed style fields and does not allow path-shaped names', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-template-invalid-'))
    roots.push(root)
    const service = new SubtitleTemplateService(root)
    await expect(service.create({ ...draft(), name: 'C:\\secret\\template', style: { ...DEFAULT_SUBTITLE_STYLE, bold: 'yes' } })).rejects.toThrow()
  })

  it('migrates legacy v1 records and persists the v2 canonical shape', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-template-migration-'))
    roots.push(root)
    await writeFile(path.join(root, 'subtitle-templates.v1.json'), JSON.stringify({
      version: 'spectra.subtitle-template-store.v1',
      templates: [{ version: 'spectra.subtitle-template.v1', id: 'legacy-template', name: '旧template', style: structuredClone(DEFAULT_SUBTITLE_STYLE), maxChars: 40, maxLines: 3, createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z' }],
      defaultTemplateId: 'legacy-template'
    }), 'utf8')
    const service = new SubtitleTemplateService(root)
    const loaded = await service.load()
    expect(loaded.migratedCount).toBe(1)
    expect(loaded.userTemplates[0]).toMatchObject({ version: 'spectra.subtitle-template.v2', captionGeneration: { maxChars: 40, maxLines: 3, segmentationMode: 'auto', layoutConstraints: { maxWidthPercent: 80 } } })
    const stored = JSON.parse(await readFile(path.join(root, 'subtitle-templates.v1.json'), 'utf8'))
    expect(stored.templates[0].version).toBe('spectra.subtitle-template.v2')
  })

  it('rejects unknown fields in the canonical generation block', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-template-unknown-'))
    roots.push(root)
    const service = new SubtitleTemplateService(root)
    await expect(service.create({ ...draft(), captionGeneration: { ...draft().captionGeneration, gpu: true } })).rejects.toThrow()
  })
})
