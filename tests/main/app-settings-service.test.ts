import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadAppSettings, saveAppSettings, setLastUsedSubtitleTemplateId } from '../../src/main/app-settings-service'

const roots: string[] = []

describe('app settings', () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  it('persists last-used template across a fresh service load without project/path data', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-app-settings-'))
    roots.push(root)
    expect(await loadAppSettings(root)).toMatchObject({ lastUsedSubtitleTemplateId: 'default' })
    expect((await setLastUsedSubtitleTemplateId(root, 'user-template-ja')).lastUsedSubtitleTemplateId).toBe('user-template-ja')
    expect((await loadAppSettings(root)).lastUsedSubtitleTemplateId).toBe('user-template-ja')
    const stored = await readFile(path.join(root, 'spectra-app-settings.v1.json'), 'utf8')
    expect(stored).not.toContain(root)
    expect(stored).not.toContain('mediaPath')
    expect(stored).not.toContain('projectPath')
  })

  it('falls back safely for malformed files and IDs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-app-settings-malformed-'))
    roots.push(root)
    await writeFile(path.join(root, 'spectra-app-settings.v1.json'), JSON.stringify({ version: 'bad', lastUsedSubtitleTemplateId: 'C:\\secret' }), 'utf8')
    expect((await loadAppSettings(root)).lastUsedSubtitleTemplateId).toBe('default')
    expect((await saveAppSettings(root, { version: 'spectra.app-settings.v1', lastUsedSubtitleTemplateId: '../bad' })).lastUsedSubtitleTemplateId).toBe('default')
  })
})
