import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { createFfmpegService, createPreviewPlan, parseSrt, parseVtt, type FfmpegService } from './ffmpeg/index'
import { loadRecovery, openProject, saveProject, writeRecovery } from './project-service'
import { createMainWindow, installMediaProtocol, isTrustedIpcUrl, registerPrivilegedSchemes, waitForRendererStartup } from './window'
import { IPC } from '../shared/ipc'
import { validateProject } from '../shared/project'
import type { ExportSettings, ProjectFile } from '../shared/types'

registerPrivilegedSchemes()
app.setName('Spectra Video Studio')

const MEDIA_FILTERS = [
  {
    name: '対応メディア',
    extensions: [
      'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v',
      'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus',
      'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'
    ]
  },
  { name: 'すべてのファイル', extensions: ['*'] }
]

let mainWindow: BrowserWindow | null = null
let ffmpegService: FfmpegService | null = null

const assertTrustedSender = (event: Electron.IpcMainInvokeEvent): void => {
  const senderUrl = event.senderFrame?.url ?? ''
  if (!isTrustedIpcUrl(senderUrl)) throw new Error('信頼されていない画面からの操作を拒否しました。')
}

const requireService = (): FfmpegService => {
  if (!ffmpegService) throw new Error('メディアエンジンの初期化が完了していません。')
  return ffmpegService
}

const validateExportSettings = (settings: ExportSettings): ExportSettings => {
  if (!settings || typeof settings !== 'object') throw new Error('書き出し設定がありません。')
  if (!path.isAbsolute(settings.outputPath)) throw new Error('書き出し先は絶対パスで指定してください。')
  if (!Number.isInteger(settings.width) || !Number.isInteger(settings.height) || settings.width < 16 || settings.height < 16) {
    throw new Error('書き出し解像度が不正です。')
  }
  if (settings.width % 2 || settings.height % 2) throw new Error('書き出し解像度は偶数にしてください。')
  if (settings.videoBitrate < 100_000 || settings.videoBitrate > 200_000_000) throw new Error('映像ビットレートが範囲外です。')
  if (settings.audioBitrate < 32_000 || settings.audioBitrate > 1_000_000) throw new Error('音声ビットレートが範囲外です。')
  return structuredClone(settings)
}

const registerIpcHandlers = (): void => {
  ipcMain.handle(IPC.appInfo, (event) => {
    assertTrustedSender(event)
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged
    }
  })

  ipcMain.handle(IPC.mediaPick, async (event) => {
    assertTrustedSender(event)
    const response = await dialog.showOpenDialog({
      title: '動画・音声・画像を読み込む',
      properties: ['openFile', 'multiSelections'],
      filters: MEDIA_FILTERS
    })
    if (response.canceled) return []
    return Promise.all(response.filePaths.map((filePath) => requireService().probeMediaSafe(filePath)))
  })

  ipcMain.handle(IPC.mediaProbe, async (event, input: unknown) => {
    assertTrustedSender(event)
    if (!Array.isArray(input) || input.length > 100 || input.some((item) => typeof item !== 'string' || !path.isAbsolute(item))) {
      throw new Error('読み込む素材パスが不正です。')
    }
    return Promise.all(input.map((filePath) => requireService().probeMediaSafe(filePath)))
  })

  ipcMain.handle(IPC.projectSave, async (event, project: ProjectFile, saveAs: boolean) => {
    assertTrustedSender(event)
    return saveProject(validateProject(project), Boolean(saveAs))
  })

  ipcMain.handle(IPC.projectOpen, async (event) => {
    assertTrustedSender(event)
    return openProject()
  })

  ipcMain.handle(IPC.recoveryWrite, async (event, project: ProjectFile) => {
    assertTrustedSender(event)
    await writeRecovery(validateProject(project))
  })

  ipcMain.handle(IPC.recoveryLoad, async (event) => {
    assertTrustedSender(event)
    return loadRecovery()
  })

  ipcMain.handle(IPC.mediaRelink, async (event, _assetId: string, expectedName: string) => {
    assertTrustedSender(event)
    const response = await dialog.showOpenDialog({
      title: `素材を再リンク: ${String(expectedName).slice(0, 200)}`,
      properties: ['openFile'],
      filters: MEDIA_FILTERS
    })
    const filePath = response.filePaths[0]
    return response.canceled || !filePath ? null : requireService().probeMediaSafe(filePath)
  })

  ipcMain.handle(IPC.previewPlan, (event, projectInput: ProjectFile) => {
    assertTrustedSender(event)
    const project = validateProject(projectInput)
    return createPreviewPlan(project, {
      outputPath: path.join(app.getPath('temp'), 'spectra-preview-plan.mp4'),
      width: project.sequence.width,
      height: project.sequence.height,
      frameRate: project.sequence.frameRate,
      videoBitrate: 2_000_000,
      audioBitrate: 128_000,
      encoderMode: 'software',
      burnSubtitles: true,
      exportSrt: false
    })
  })

  ipcMain.handle(IPC.waveformPeaks, async (event, request) => {
    assertTrustedSender(event)
    return await requireService().getWaveformPeaks(request)
  })

  ipcMain.handle(IPC.subtitlesImport, async (event) => {
    assertTrustedSender(event)
    const response = await dialog.showOpenDialog({
      title: '字幕ファイルを読み込む',
      properties: ['openFile'],
      filters: [{ name: '字幕', extensions: ['srt', 'vtt'] }]
    })
    const filePath = response.filePaths[0]
    if (response.canceled || !filePath) return null
    const content = await readFile(filePath, 'utf8')
    return path.extname(filePath).toLowerCase() === '.vtt' ? parseVtt(content) : parseSrt(content)
  })

  ipcMain.handle(IPC.encodersDetect, (event, force: boolean) => {
    assertTrustedSender(event)
    return requireService().detectEncoders(Boolean(force))
  })

  ipcMain.handle(IPC.exportChoosePath, async (event, defaultName: string) => {
    assertTrustedSender(event)
    const safeName = String(defaultName || 'video').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120)
    const response = await dialog.showSaveDialog({
      title: '動画を書き出す',
      defaultPath: `${safeName}.mp4`,
      filters: [{ name: 'MPEG-4 Video', extensions: ['mp4'] }]
    })
    if (response.canceled || !response.filePath) return null
    return response.filePath.toLowerCase().endsWith('.mp4') ? response.filePath : `${response.filePath}.mp4`
  })

  ipcMain.handle(IPC.exportStart, async (event, projectInput: ProjectFile, settingsInput: ExportSettings) => {
    assertTrustedSender(event)
    const project = validateProject(projectInput)
    const settings = validateExportSettings(settingsInput)
    const job = await requireService().startExport(project, settings, {
      onProgress: (progress) => mainWindow?.webContents.send(IPC.exportProgress, progress)
    })
    // FfmpegService already publishes completed, failed and cancelled stages.
    // Attach a terminal handler only to prevent an unhandled rejection.
    void job.result.catch(() => undefined)
    return { cancelled: false, jobId: job.jobId, outputPath: job.outputPath }
  })

  ipcMain.handle(IPC.exportCancel, (event, jobId: string) => {
    assertTrustedSender(event)
    if (typeof jobId !== 'string' || jobId.length > 200) return false
    return requireService().cancelExport(jobId)
  })

  ipcMain.handle(IPC.exportSrt, async (event, projectInput: ProjectFile, suggestedName: string) => {
    assertTrustedSender(event)
    const project = validateProject(projectInput)
    const safeName = String(suggestedName || project.name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120)
    const response = await dialog.showSaveDialog({
      title: '字幕をSRTで保存',
      defaultPath: `${safeName}.srt`,
      filters: [{ name: 'SubRip Subtitle', extensions: ['srt'] }]
    })
    if (response.canceled || !response.filePath) return null
    const outputPath = response.filePath.toLowerCase().endsWith('.srt') ? response.filePath : `${response.filePath}.srt`
    await requireService().writeSrt(project, outputPath)
    return outputPath
  })
}

const start = async (): Promise<void> => {
  installMediaProtocol()
  ffmpegService = await createFfmpegService({
    workspaceRoot: path.join(app.getPath('temp'), 'spectra-video-studio')
  })
  registerIpcHandlers()
  mainWindow = createMainWindow()
  if (process.env.SPECTRA_STARTUP_SMOKE === '1') {
    try {
      const report = await waitForRendererStartup(mainWindow)
      console.log(`SPECTRA_STARTUP_REPORT ${JSON.stringify(report)}`)
      app.exit(0)
    } catch (error) {
      console.error(`SPECTRA_STARTUP_REPORT ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}`)
      app.exit(1)
    }
    return
  }
  void ffmpegService.detectEncoders(false).catch(() => undefined)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.whenReady().then(start).catch((error: unknown) => {
    dialog.showErrorBox('起動エラー', error instanceof Error ? error.message : String(error))
    app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
