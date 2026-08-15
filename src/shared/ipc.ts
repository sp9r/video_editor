import type { DesktopApi } from './types'

export const IPC = {
  appInfo: 'app:info',
  mediaPick: 'media:pick',
  mediaProbe: 'media:probe',
  projectSave: 'project:save',
  projectOpen: 'project:open',
  recoveryWrite: 'recovery:write',
  recoveryLoad: 'recovery:load',
  mediaRelink: 'media:relink',
  waveformPeaks: 'waveform:peaks',
  fontFamilies: 'fonts:families',
  previewPlan: 'preview:plan',
  previewAccurateFrame: 'preview:accurate-frame',
  previewSubtitleOverlay: 'preview:subtitle-overlay',
  subtitlesImport: 'subtitles:import',
  encodersDetect: 'encoders:detect',
  exportChoosePath: 'export:choose-path',
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportSrt: 'export:srt',
  reviewLoad: 'review:load',
  reviewUpsert: 'review:upsert',
  exportProgress: 'export:progress'
} as const

declare global {
  interface Window {
    spectra?: DesktopApi
  }
}
