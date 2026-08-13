import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type { DesktopApi, ExportProgress, ExportSettings, ProjectFile, TimeUs, WaveformRequest } from '../shared/types'

const api: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
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
  detectEncoders: (force = false) => ipcRenderer.invoke(IPC.encodersDetect, force),
  chooseExportPath: (defaultName: string) => ipcRenderer.invoke(IPC.exportChoosePath, defaultName),
  startExport: (project: ProjectFile, settings: ExportSettings) => ipcRenderer.invoke(IPC.exportStart, project, settings),
  cancelExport: (jobId: string) => ipcRenderer.invoke(IPC.exportCancel, jobId),
  exportSrt: (project: ProjectFile, suggestedName: string) => ipcRenderer.invoke(IPC.exportSrt, project, suggestedName),
  onExportProgress: (callback: (progress: ExportProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ExportProgress): void => callback(progress)
    ipcRenderer.on(IPC.exportProgress, listener)
    return () => ipcRenderer.removeListener(IPC.exportProgress, listener)
  }
}

contextBridge.exposeInMainWorld('spectra', api)
