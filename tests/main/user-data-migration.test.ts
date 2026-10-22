import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { MIGRATION_MARKER, migrateLegacyUserData } from '../../src/main/user-data-migration'

describe('legacy userData migration', () => {
  it('copies user data once, never touches the old folder and skips caches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cutline-migrate-'))
    try {
      const legacy = join(root, 'Spectra Video Studio')
      const target = join(root, 'Cutline')
      await mkdir(join(legacy, 'recovery'), { recursive: true })
      await mkdir(join(legacy, 'experimental.full-correction.v1'), { recursive: true })
      await mkdir(join(legacy, 'thumbnail-cache'), { recursive: true })
      await writeFile(join(legacy, 'recovery', 'latest.spectra.autosave'), 'recovery')
      await writeFile(join(legacy, 'experimental.full-correction.v1', 's.json'), 'session')
      await writeFile(join(legacy, 'subtitle-templates.v1.json'), 'templates')
      await writeFile(join(legacy, 'spectra-app-settings.v1.json'), 'settings')
      await writeFile(join(legacy, 'thumbnail-cache', 't.jpg'), 'cache')

      const first = migrateLegacyUserData(legacy, target)
      expect(first.status).toBe('migrated')
      expect(first.copied).toEqual(expect.arrayContaining(['recovery', 'subtitle-templates.v1.json', 'spectra-app-settings.v1.json', 'experimental.full-correction.v1']))
      expect(await readFile(join(target, 'recovery', 'latest.spectra.autosave'), 'utf8')).toBe('recovery')
      expect(await readFile(join(target, 'experimental.full-correction.v1', 's.json'), 'utf8')).toBe('session')
      expect(existsSync(join(target, 'thumbnail-cache'))).toBe(false)
      expect(existsSync(join(target, MIGRATION_MARKER))).toBe(true)
      expect(await readFile(join(legacy, 'subtitle-templates.v1.json'), 'utf8')).toBe('templates')

      // A later edit in the new folder is never overwritten, and the marker stops a second run.
      await writeFile(join(target, 'subtitle-templates.v1.json'), 'edited')
      expect(migrateLegacyUserData(legacy, target).status).toBe('already-migrated')
      expect(await readFile(join(target, 'subtitle-templates.v1.json'), 'utf8')).toBe('edited')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does nothing when there is no old folder and never overwrites existing new files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cutline-migrate-none-'))
    try {
      expect(migrateLegacyUserData(join(root, 'missing'), join(root, 'Cutline')).status).toBe('no-legacy-data')
      expect(existsSync(join(root, 'Cutline'))).toBe(false)
      const legacy = join(root, 'old')
      const target = join(root, 'new')
      await mkdir(legacy, { recursive: true })
      await mkdir(target, { recursive: true })
      await writeFile(join(legacy, 'subtitle-templates.v1.json'), 'old')
      await writeFile(join(target, 'subtitle-templates.v1.json'), 'new')
      migrateLegacyUserData(legacy, target)
      expect(await readFile(join(target, 'subtitle-templates.v1.json'), 'utf8')).toBe('new')
      expect(migrateLegacyUserData(legacy, legacy).status).toBe('same-folder')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
