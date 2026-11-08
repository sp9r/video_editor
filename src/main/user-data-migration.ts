import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Folder name Electron used for userData before the product was renamed to Cutline. */
export const LEGACY_USER_DATA_FOLDER = 'Spectra Video Studio'
export const MIGRATION_MARKER = '.migrated-from-spectra-video-studio.json'

/**
 * Everything the app persists under userData that the user would miss.
 * Disposable caches (thumbnail-cache, media-workspace, Chromium Cache/GPUCache etc.) are deliberately omitted.
 */
export const LEGACY_USER_DATA_ITEMS: readonly string[] = [
  'recovery',
  'spectra-app-settings.v1.json',
  'subtitle-templates.v1.json',
  'auto-caption-worker.json',
  'experimental.auto-caption-baseline.v1',
  'experimental.full-correction.v1',
  'review',
  'learning'
]

export interface UserDataMigrationResult {
  status: 'migrated' | 'partial' | 'already-migrated' | 'no-legacy-data' | 'same-folder'
  copied: string[]
  failed: string[]
}

/**
 * Copies (never moves or deletes) the user's data from the old userData folder into the new one, once.
 * Existing files in the new folder are never overwritten. The marker is only written when every item copied.
 */
export const migrateLegacyUserData = (legacyDir: string, targetDir: string): UserDataMigrationResult => {
  const result: UserDataMigrationResult = { status: 'no-legacy-data', copied: [], failed: [] }
  if (path.resolve(legacyDir).toLowerCase() === path.resolve(targetDir).toLowerCase()) return { ...result, status: 'same-folder' }
  if (existsSync(path.join(targetDir, MIGRATION_MARKER))) return { ...result, status: 'already-migrated' }
  let legacyIsDirectory = false
  try { legacyIsDirectory = statSync(legacyDir).isDirectory() } catch { /* absent */ }
  if (!legacyIsDirectory) return result

  mkdirSync(targetDir, { recursive: true })
  for (const item of LEGACY_USER_DATA_ITEMS) {
    const source = path.join(legacyDir, item)
    if (!existsSync(source)) continue
    try {
      cpSync(source, path.join(targetDir, item), { recursive: true, force: false, errorOnExist: false })
      result.copied.push(item)
    } catch {
      result.failed.push(item)
    }
  }
  if (result.failed.length > 0) return { ...result, status: 'partial' }
  writeFileSync(
    path.join(targetDir, MIGRATION_MARKER),
    `${JSON.stringify({ migratedAt: new Date().toISOString(), from: legacyDir, copied: result.copied }, null, 2)}\n`,
    'utf8'
  )
  return { ...result, status: 'migrated' }
}
