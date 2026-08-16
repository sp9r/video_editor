import type { DesktopApi } from './types'

export const IPC = {
  appInfo: 'app:info',
  appSettingsLoad: 'app-settings:load',
  appSettingsLastUsedSubtitleTemplate: 'app-settings:last-used-subtitle-template',
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
  silenceCutReapply: 'silence-cut:reapply',
  silenceCutCancel: 'silence-cut:cancel',
  autoCaptionHealth: 'auto-caption:health',
  autoCaptionStart: 'auto-caption:start',
  autoCaptionCancel: 'auto-caption:cancel',
  autoCaptionStatus: 'auto-caption:status',
  autoCaptionProgress: 'auto-caption:progress',
  autoCaptionBaselinesLoad: 'auto-caption:baselines-load',
  subtitleTemplatesLoad: 'subtitle-templates:load',
  subtitleTemplateDefault: 'subtitle-templates:default',
  subtitleTemplateCreate: 'subtitle-templates:create',
  subtitleTemplateUpdate: 'subtitle-templates:update',
  subtitleTemplateDuplicate: 'subtitle-templates:duplicate',
  subtitleTemplateDelete: 'subtitle-templates:delete',
  subtitlesImport: 'subtitles:import',
  encodersDetect: 'encoders:detect',
  exportChoosePath: 'export:choose-path',
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  exportSrt: 'export:srt',
  reviewLoad: 'review:load',
  reviewUpsert: 'review:upsert',
  learningDatasetExport: 'learning-dataset:export',
  thumbnailCandidates: 'thumbnail:candidates',
  thumbnailExport: 'thumbnail:export',
  fullCorrectionLoad: 'full-correction:load',
  fullCorrectionStart: 'full-correction:start',
  fullCorrectionFinish: 'full-correction:finish',
  exportProgress: 'export:progress'
} as const

declare global {
  interface Window {
    spectra?: DesktopApi
  }
}
