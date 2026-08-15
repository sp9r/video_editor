import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types'
import { SubtitleTemplateService } from '../../src/main/subtitle-template-service'

const roots: string[] = []
const draft = (name = '実況用'): { name: string; style: typeof DEFAULT_SUBTITLE_STYLE; maxChars: number; maxLines: number } => ({
  name, style: structuredClone(DEFAULT_SUBTITLE_STYLE), maxChars: 32, maxLines: 2
})

describe('subtitle template service', () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  it('loads empty userData safely and supports create/update/duplicate/delete', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-template-'))
    roots.push(root)
    const service = new SubtitleTemplateService(root)
    expect(await service.load()).toEqual({ userTemplates: [], malformedCount: 0, defaultTemplateId: 'default' })
    const created = await service.create(draft())
    expect(created.version).toBe('spectra.subtitle-template.v1')
    expect(created.id).toMatch(/^user-template-/)
    expect((await service.load()).userTemplates).toHaveLength(1)
    const updated = await service.update(created.id, { ...draft('更新済み'), maxLines: 3 })
    expect(updated.name).toBe('更新済み')
    expect(updated.maxLines).toBe(3)
    const copied = await service.duplicate({ ...draft('複製元'), maxChars: 40 })
    expect(copied.id).not.toBe(created.id)
    expect(copied.name).toBe('複製元 copy')
    expect(await service.remove(created.id)).toBe(true)
    expect(await service.remove(created.id)).toBe(false)
    expect((await service.load()).userTemplates.map((template) => template.id)).toEqual([copied.id])
    expect((await service.setDefault(copied.id)).defaultTemplateId).toBe(copied.id)
    expect(await service.remove(copied.id)).toBe(true)
    expect((await service.load()).defaultTemplateId).toBe('default')
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
      templates: [{ version: 'spectra.subtitle-template.v1', id: 'bad', name: 'bad', style: {}, maxChars: 32, maxLines: 2, createdAt: 'bad', updatedAt: 'bad' }]
    }), 'utf8')
    const loaded = await new SubtitleTemplateService(root).load()
    expect(loaded.userTemplates).toEqual([])
    expect(loaded.malformedCount).toBe(1)
    expect(loaded.defaultTemplateId).toBe('default')
  })

  it('supports built-in defaults and rejects unknown defaults', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-template-default-'))
    roots.push(root)
    const service = new SubtitleTemplateService(root)
    expect((await service.setDefault('high-contrast')).defaultTemplateId).toBe('high-contrast')
    await expect(service.setDefault('missing-template')).rejects.toThrow()
  })

  it('rejects malformed style fields and does not allow path-shaped names', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-template-invalid-'))
    roots.push(root)
    const service = new SubtitleTemplateService(root)
    await expect(service.create({ ...draft(), name: 'C:\\secret\\template', style: { ...DEFAULT_SUBTITLE_STYLE, bold: 'yes' } })).rejects.toThrow()
  })
})
