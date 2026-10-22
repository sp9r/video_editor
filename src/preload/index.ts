import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type { DesktopApi, ExportProgress, ExportSettings, ProjectFile, SubtitleOverlayRequestOptions, TimeUs, WaveformRequest } from '../shared/types'
import type { SubtitleTemplateDraft } from '../shared/subtitle-templates'
import type { AutoCaptionProgress } from '../shared/auto-caption-contract'
import type { ExperimentalReviewRecord } from '../shared/review/types'
import type { FullCorrectionSession } from '../shared/full-correction'
import type { SilenceReapplyProfile } from '../shared/silence-cut'

const api: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  loadAppSettings: () => ipcRenderer.invoke(IPC.appSettingsLoad),
  setLastUsedSubtitleTemplateId: (id: string) => ipcRenderer.invoke(IPC.appSettingsLastUsedSubtitleTemplate, id),
  pickMedia: () => ipcRenderer.invoke(IPC.mediaPick),
  probeMedia: (paths: string[]) => ipcRenderer.invoke(IPC.mediaProbe, paths),
  getPathForFile: (file: unknown) => webUtils.getPathForFile(file as File),
  saveProject: (project: ProjectFile, saveAs = false) => ipcRenderer.invoke(IPC.projectSave, project, saveAs),
  openProject: () => ipcRenderer.invoke(IPC.projectOpen),
  writeRecovery: (project: ProjectFile) => ipcRenderer.invoke(IPC.recoveryWrite, project),
  loadRecovery: () => ipcRenderer.invoke(IPC.recoveryLoad),
  relinkMedia: (assetId: string, expectedName: string) => ipcRenderer.invoke(IPC.mediaRelink, assetId, expectedName),
  importSubtitles: () => ipcRenderer.invoke(IPC.subtitlesImport),
  mediaUrl: (filePath: string) => `spectra-media://local/${encodeURIComponent(filePath)}`,
  getWaveformPeaks: (request: WaveformRequest) => ipcRenderer.invoke(IPC.waveformPeaks, request),
  listFontFamilies: () => ipcRenderer.invoke(IPC.fontFamilies),
  createPreviewPlan: (project: ProjectFile) => ipcRenderer.invoke(IPC.previewPlan, project),
  renderAccuratePreviewFrame: (project: ProjectFile, timeUs: TimeUs) => ipcRenderer.invoke(IPC.previewAccurateFrame, project, timeUs),
  renderSubtitleOverlay: (project: ProjectFile, timeUs: TimeUs, options?: SubtitleOverlayRequestOptions) => ipcRenderer.invoke(IPC.previewSubtitleOverlay, project, timeUs, options),
  renderSubtitleOverlaySequence: (project: ProjectFile, startFrame: number, frameCount: number) => ipcRenderer.invoke(IPC.previewSubtitleOverlaySequence, project, startFrame, frameCount),
  renderSubtitleFrames: (project: ProjectFile, frameIndices: number[], options?: { urgent?: boolean }) => ipcRenderer.invoke(IPC.previewSubtitleFrames, project, frameIndices, options),
  startSilenceCutReapply: (project: ProjectFile, selectedClipId: string, jobId: string, profile: SilenceReapplyProfile, minSilenceUs?: number) => ipcRenderer.invoke(IPC.silenceCutReapply, project, selectedClipId, jobId, profile, minSilenceUs),
  cancelSilenceCutReapply: (jobId: string) => ipcRenderer.invoke(IPC.silenceCutCancel, jobId),
  autoCaptionHealth: () => ipcRenderer.invoke(IPC.autoCaptionHealth),
  startAutoCaption: (project: ProjectFile, selectedClipIds: string[], settings) => ipcRenderer.invoke(IPC.autoCaptionStart, project, selectedClipIds, settings),
  cancelAutoCaption: (jobId: string) => ipcRenderer.invoke(IPC.autoCaptionCancel, jobId),
  getAutoCaptionStatus: (jobId: string) => ipcRenderer.invoke(IPC.autoCaptionStatus, jobId),
  loadAutoCaptionBaselines: () => ipcRenderer.invoke(IPC.autoCaptionBaselinesLoad),
  resegmentCaptions: (request) => ipcRenderer.invoke(IPC.autoCaptionResegment, request),
  loadSubtitleTemplates: () => ipcRenderer.invoke(IPC.subtitleTemplatesLoad),
  setDefaultSubtitleTemplate: (id: string) => ipcRenderer.invoke(IPC.subtitleTemplateDefault, id),
  createSubtitleTemplate: (input: SubtitleTemplateDraft) => ipcRenderer.invoke(IPC.subtitleTemplateCreate, input),
  updateSubtitleTemplate: (id: string, input: SubtitleTemplateDraft) => ipcRenderer.invoke(IPC.subtitleTemplateUpdate, id, input),
  duplicateSubtitleTemplate: (input: SubtitleTemplateDraft) => ipcRenderer.invoke(IPC.subtitleTemplateDuplicate, input),
  deleteSubtitleTemplate: (id: string) => ipcRenderer.invoke(IPC.subtitleTemplateDelete, id),
  onAutoCaptionProgress: (callback: (progress: AutoCaptionProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: AutoCaptionProgress): void => callback(progress)
    ipcRenderer.on(IPC.autoCaptionProgress, listener)
    return () => ipcRenderer.removeListener(IPC.autoCaptionProgress, listener)
  },
  detectEncoders: (force = false) => ipcRenderer.invoke(IPC.encodersDetect, force),
  chooseExportPath: (defaultName: string) => ipcRenderer.invoke(IPC.exportChoosePath, defaultName),
  startExport: (project: ProjectFile, settings: ExportSettings) => ipcRenderer.invoke(IPC.exportStart, project, settings),
  cancelExport: (jobId: string) => ipcRenderer.invoke(IPC.exportCancel, jobId),
  exportSrt: (project: ProjectFile, suggestedName: string) => ipcRenderer.invoke(IPC.exportSrt, project, suggestedName),
  loadExperimentalReviewRecords: () => ipcRenderer.invoke(IPC.reviewLoad),
  upsertExperimentalReviewRecord: (record: ExperimentalReviewRecord) => ipcRenderer.invoke(IPC.reviewUpsert, record),
  exportLearningDataset: () => ipcRenderer.invoke(IPC.learningDatasetExport),
  extractThumbnailCandidates: (project: ProjectFile, selectedClipId: string) => ipcRenderer.invoke(IPC.thumbnailCandidates, project, selectedClipId),
  exportThumbnail: (bytes: Uint8Array, format: 'png' | 'jpeg') => ipcRenderer.invoke(IPC.thumbnailExport, bytes, format),
  loadFullCorrectionSessions: () => ipcRenderer.invoke(IPC.fullCorrectionLoad),
  startFullCorrectionSession: (project: ProjectFile, trackId: string): Promise<FullCorrectionSession> => ipcRenderer.invoke(IPC.fullCorrectionStart, project, trackId),
  finishFullCorrectionSession: (project: ProjectFile, sessionId: string): Promise<FullCorrectionSession> => ipcRenderer.invoke(IPC.fullCorrectionFinish, project, sessionId),
  onExportProgress: (callback: (progress: ExportProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ExportProgress): void => callback(progress)
    ipcRenderer.on(IPC.exportProgress, listener)
    return () => ipcRenderer.removeListener(IPC.exportProgress, listener)
  }
}

contextBridge.exposeInMainWorld('spectra', api)
