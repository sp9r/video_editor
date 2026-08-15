import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defaultAppSettings, parseAppSettings, type AppSettings } from '../shared/app-settings.js'

const SETTINGS_FILE = 'spectra-app-settings.v1.json'

const settingsPath = (userDataPath: string): string => path.join(userDataPath, SETTINGS_FILE)

const atomicRename = async (temporary: string, target: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, target)
      return
    } catch (error) {
      const code = (error as { code?: string }).code
      if (!['EPERM', 'EBUSY'].includes(code ?? '') || attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}

export const loadAppSettings = async (userDataPath: string): Promise<AppSettings> => {
  try {
    return parseAppSettings(JSON.parse(await readFile(settingsPath(userDataPath), 'utf8')))
  } catch {
    return defaultAppSettings()
  }
}

export const saveAppSettings = async (userDataPath: string, settings: AppSettings): Promise<AppSettings> => {
  const normalized = parseAppSettings(settings)
  const target = settingsPath(userDataPath)
  const directory = path.dirname(target)
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    await atomicRename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  return normalized
}

export const setLastUsedSubtitleTemplateId = async (userDataPath: string, id: unknown): Promise<AppSettings> => {
  const current = await loadAppSettings(userDataPath)
  return saveAppSettings(userDataPath, parseAppSettings({ ...current, lastUsedSubtitleTemplateId: id }))
}
