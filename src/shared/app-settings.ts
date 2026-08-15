export const APP_SETTINGS_VERSION = 'spectra.app-settings.v1' as const
export const DEFAULT_LAST_USED_SUBTITLE_TEMPLATE_ID = 'default' as const

export interface AppSettings {
  version: typeof APP_SETTINGS_VERSION
  lastUsedSubtitleTemplateId: string
}

export const defaultAppSettings = (): AppSettings => ({
  version: APP_SETTINGS_VERSION,
  lastUsedSubtitleTemplateId: DEFAULT_LAST_USED_SUBTITLE_TEMPLATE_ID
})

export const parseAppSettings = (value: unknown): AppSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultAppSettings()
  const record = value as Record<string, unknown>
  if (record.version !== APP_SETTINGS_VERSION || typeof record.lastUsedSubtitleTemplateId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.lastUsedSubtitleTemplateId)) {
    return defaultAppSettings()
  }
  return {
    version: APP_SETTINGS_VERSION,
    lastUsedSubtitleTemplateId: record.lastUsedSubtitleTemplateId
  }
}
