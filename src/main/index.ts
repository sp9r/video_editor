import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { createFfmpegService, createPreviewPlan, parseSrt, parseVtt, type FfmpegService } from './ffmpeg/index'
import { loadRecovery, openProject, saveProject, writeRecovery } from './project-service'
import { createMainWindow, installMediaProtocol, isTrustedIpcUrl, registerPrivilegedSchemes, waitForRendererStartup } from './window'
import { IPC } from '../shared/ipc'
import { validateProject } from '../shared/project'
import type { ExportSettings, ProjectFile } from '../shared/types'
import { enumerateFontFamilies } from './fonts'
import { generateAss } from './ffmpeg/subtitles'
import { buildSubtitleRenderSpec } from '../shared/subtitle-render'
import { createSubtitleParityFixture } from '../shared/subtitle-parity-fixture'

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
      packaged: app.isPackaged,
      smokeMode: process.env.SPECTRA_ACCURATE_PREVIEW_SMOKE === '1'
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

  ipcMain.handle(IPC.previewAccurateFrame, async (event, projectInput: ProjectFile, timeUs: unknown) => {
    assertTrustedSender(event)
    if (typeof timeUs !== 'number' || !Number.isFinite(timeUs) || timeUs < 0) {
      throw new Error('正確プレビューの時刻が不正です。')
    }
    return await requireService().renderAccurateFrame(validateProject(projectInput), timeUs)
  })

  ipcMain.handle(IPC.previewSubtitleOverlay, async (event, projectInput: ProjectFile, timeUs: unknown) => {
    assertTrustedSender(event)
    if (typeof timeUs !== 'number' || !Number.isFinite(timeUs) || timeUs < 0) {
      throw new Error('字幕overlayの時刻が不正です。')
    }
    return await requireService().renderSubtitleOverlay(validateProject(projectInput), timeUs)
  })

  ipcMain.handle(IPC.waveformPeaks, async (event, request) => {
    assertTrustedSender(event)
    return await requireService().getWaveformPeaks(request)
  })

  ipcMain.handle(IPC.fontFamilies, async (event) => {
    assertTrustedSender(event)
    return enumerateFontFamilies()
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

const runSubtitleParitySmoke = async (window: BrowserWindow): Promise<void> => {
  const fixture = createSubtitleParityFixture()
  const subtitle = fixture.tracks[0]?.clips[0]
  if (!subtitle || subtitle.kind !== 'subtitle') throw new Error('Subtitle parity fixture is invalid')
  const spec = buildSubtitleRenderSpec(subtitle, fixture.sequence)
  const previewPath = path.resolve(process.env.SPECTRA_PARITY_PREVIEW_PATH ?? path.join(app.getPath('temp'), 'spectra-subtitle-preview.png'))
  const assPath = path.resolve(process.env.SPECTRA_PARITY_ASS_PATH ?? path.join(app.getPath('temp'), 'spectra-subtitle-captions.ass'))
  const overlay = await requireService().renderSubtitleOverlay(fixture, 500_000)
  await writeFile(previewPath, await readFile(overlay.framePath))
  await writeFile(assPath, generateAss(fixture), 'utf8')
  console.log(`SPECTRA_SUBTITLE_PARITY_REPORT ${JSON.stringify({
    previewPath,
    assPath,
    sequence: fixture.sequence,
    spec,
    overlayFramePath: overlay.framePath,
    overlayFrameIndex: overlay.frameIndex,
    overlayStateFingerprint: overlay.subtitleStateFingerprint,
    viewport: { width: fixture.sequence.width, height: fixture.sequence.height },
    sceneRect: { x: 0, y: 0, width: fixture.sequence.width, height: fixture.sequence.height },
    textRect: null
  })}`)
}

const runAccuratePreviewSmoke = async (window: BrowserWindow): Promise<Record<string, unknown>> => {
  const projectPath = process.env.SPECTRA_PREVIEW_E2E_PROJECT
  if (!projectPath) throw new Error('SPECTRA_PREVIEW_E2E_PROJECT is required')
  console.log('SPECTRA_ACCURATE_PREVIEW_STAGE project-read')
  const project = validateProject(JSON.parse(await readFile(projectPath, 'utf8')) as ProjectFile)
  const smokeSubtitle = project.tracks.flatMap((track) => track.clips).find((clip) => clip.kind === 'subtitle')
  const subtitleSpec = smokeSubtitle?.kind === 'subtitle' ? buildSubtitleRenderSpec(smokeSubtitle, project.sequence) : null
  const startup = await waitForRendererStartup(window)
  console.log('SPECTRA_ACCURATE_PREVIEW_STAGE renderer-ready')
  await new Promise((resolve) => setTimeout(resolve, 100))
  const detail = JSON.stringify({ project, timeUs: 500_000 })
  await window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('spectra:e2e-project', { detail: ${detail} }))`)
  console.log('SPECTRA_ACCURATE_PREVIEW_STAGE project-dispatched')
  const readDom = async (): Promise<{ viewport: { width: number; height: number }; overlay: boolean; overlayReady: boolean; fastSubtitleOverlay: boolean; fastSubtitleOverlayReady: boolean; cssFallbackCount: number; quality: string; playButton: boolean; overlayCount: number; overlaySrc: string; fastSubtitleOverlaySrc: string; subtitleMain: { x: number; y: number; width: number; height: number }; subtitleStack: { x: number; y: number; width: number; height: number }; visual: { x: number; y: number; width: number; height: number } }> => await window.webContents.executeJavaScript(`(() => {
    const rect = (element) => {
      const value = element?.getBoundingClientRect()
      return value ? { x: value.x, y: value.y, width: value.width, height: value.height } : { x: 0, y: 0, width: 0, height: 0 }
    }
    return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    overlay: document.querySelector('.accurate-preview-overlay') !== null,
    overlayReady: (() => { const image = document.querySelector('.accurate-preview-overlay'); return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 })(),
    fastSubtitleOverlay: document.querySelector('.fast-authoritative-subtitle-overlay') !== null,
    fastSubtitleOverlayReady: (() => { const image = document.querySelector('.fast-authoritative-subtitle-overlay'); return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 })(),
    cssFallbackCount: document.querySelectorAll('[data-subtitle-renderer="css-fallback"]').length,
    quality: document.querySelector('.viewer-quality')?.textContent ?? '',
    playButton: document.querySelector('.play-button') !== null,
    overlayCount: document.querySelectorAll('.accurate-preview-overlay').length,
    overlaySrc: document.querySelector('.accurate-preview-overlay')?.getAttribute('src') ?? '',
    subtitleMain: rect(document.querySelector('.preview-subtitle-main')),
    subtitleStack: rect(document.querySelector('.preview-subtitle-stack')),
    visual: rect(document.querySelector('.preview-visual'))
    }
  })()`)
  console.log('SPECTRA_ACCURATE_PREVIEW_STAGE dom-poll-start')
  const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const waitForPaint = (): Promise<unknown> => window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  const until = async (predicate: (dom: Awaited<ReturnType<typeof readDom>>) => boolean, timeoutMs = 10_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const dom = await readDom()
      if (predicate(dom)) return true
      await wait(50)
    }
    return false
  }
  const accurateInitial = await until((dom) => dom.overlay && dom.overlayReady)
  const initialDom = await readDom()
  if (!initialDom.playButton) throw new Error('Preview play button is missing')
  const initialOverlaySrc = initialDom.overlaySrc
  const screenshotTag = (process.env.SPECTRA_ACCURATE_PREVIEW_TAG ?? '').replace(/[^a-z0-9_-]/giu, '').slice(0, 48)
  const screenshotSuffix = screenshotTag ? `-${screenshotTag}` : ''
  const accurateScreenshotPath = path.join(app.getPath('temp'), `spectra-accurate-preview-phase4r2${screenshotSuffix}.png`)
  await waitForPaint()
  await writeFile(accurateScreenshotPath, (await window.webContents.capturePage()).toPNG())
  await requireService().clearSubtitleOverlayCache()
  const coldOverlayStartedAt = performance.now()
  const coldSubtitleOverlay = await requireService().renderSubtitleOverlay(project, 500_000)
  const subtitleOverlayColdMs = performance.now() - coldOverlayStartedAt
  const cacheHitStartedAt = performance.now()
  const cachedSubtitleOverlay = await requireService().renderSubtitleOverlay(project, 500_000)
  const subtitleOverlayCacheHitMs = performance.now() - cacheHitStartedAt
  await window.webContents.executeJavaScript(`document.querySelector('.play-button')?.click()`)
  const fastFixture = await until((dom) => !dom.overlay && dom.quality.includes('高速') && dom.fastSubtitleOverlay && dom.fastSubtitleOverlayReady)
  const fastFixtureDom = await readDom()
  const playbackFrameSample = await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = performance.now()
    let frames = 0
    const tick = () => {
      frames += 1
      const elapsedMs = performance.now() - started
      if (elapsedMs >= 200) resolve({ frames, elapsedMs, fps: frames / elapsedMs * 1000 })
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })`)
  const fastScreenshotPath = path.join(app.getPath('temp'), `spectra-fast-preview-phase4r2${screenshotSuffix}.png`)
  await waitForPaint()
  await writeFile(fastScreenshotPath, (await window.webContents.capturePage()).toPNG())
  await window.webContents.executeJavaScript(`document.querySelector('.play-button')?.click()`)
  const accurateFixtureAfterResume = (await readDom()).overlay
    && await until((dom) => dom.overlay && dom.overlayReady)
  const editedProject = structuredClone(project)
  const editedSubtitle = editedProject.tracks.flatMap((track) => track.clips).find((clip) => clip.kind === 'subtitle')
  if (editedSubtitle?.kind === 'subtitle') editedSubtitle.text = 'Accurate Preview edited'
  await window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('spectra:e2e-project', { detail: ${JSON.stringify({ project: editedProject, timeUs: 500_000 })} }))`)
  const pendingDom = await readDom()
  const editPendingPreservesOverlay = pendingDom.overlay && pendingDom.overlaySrc === initialOverlaySrc && pendingDom.quality.includes('更新中')
  const editedFrameReady = await until((dom) => dom.overlay && dom.overlayReady && dom.overlaySrc !== initialOverlaySrc && dom.quality.includes('正確プレビュー'))
  const cueSwitchStartedAt = performance.now()
  await window.webContents.executeJavaScript(`document.querySelector('.play-button')?.click()`)
  const fastDuringPlay = await until((dom) => !dom.overlay && dom.quality.includes('高速') && dom.fastSubtitleOverlay && dom.fastSubtitleOverlayReady)
  const subtitleOverlayCueSwitchMs = performance.now() - cueSwitchStartedAt
  await window.webContents.executeJavaScript(`document.querySelector('.play-button')?.click()`)
  const overlayImmediatelyAfterPause = (await readDom()).overlay
  const accurateAfterResume = overlayImmediatelyAfterPause && await until((dom) => dom.overlay && dom.overlayReady)
  const finalDom = await readDom()
  const report = { accurateInitial, initialQuality: initialDom.quality, viewport: initialDom.viewport, sequence: { width: project.sequence.width, height: project.sequence.height }, subtitleSpec, fastFixture, fastSubtitleOverlay: fastFixtureDom.fastSubtitleOverlay, fastSubtitleOverlayReady: fastFixtureDom.fastSubtitleOverlayReady, fastSubtitleOverlaySrc: fastFixtureDom.fastSubtitleOverlaySrc, fastCssFallbackCount: fastFixtureDom.cssFallbackCount, playbackFrameSample, subtitleOverlayFramePath: cachedSubtitleOverlay.framePath, subtitleOverlayFrameIndex: cachedSubtitleOverlay.frameIndex, subtitleOverlayStateFingerprint: cachedSubtitleOverlay.subtitleStateFingerprint, subtitleOverlayColdMs, subtitleOverlayCacheHitMs, subtitleOverlayCueSwitchMs, coldOverlayFramePath: coldSubtitleOverlay.framePath, accurateFixtureAfterResume, editPendingPreservesOverlay, editedFrameReady, fastDuringPlay, overlayImmediatelyAfterPause, accurateAfterResume, initialOverlaySrc, editedOverlaySrc: finalDom.overlaySrc, overlayCount: finalDom.overlayCount, fastScreenshotPath, accurateScreenshotPath, fastSubtitleMain: fastFixtureDom.subtitleMain, accurateSubtitleMain: initialDom.subtitleMain, fastSubtitleStack: fastFixtureDom.subtitleStack, accurateSubtitleStack: initialDom.subtitleStack, fastVisual: fastFixtureDom.visual, accurateVisual: initialDom.visual }
  return { ...startup, ...report }
}

const start = async (): Promise<void> => {
  installMediaProtocol()
  ffmpegService = await createFfmpegService({
    workspaceRoot: path.join(app.getPath('temp'), 'spectra-video-studio')
  })
  registerIpcHandlers()
  mainWindow = createMainWindow()
  if (process.env.SPECTRA_SUBTITLE_PARITY_SMOKE === '1') {
    try {
      await waitForRendererStartup(mainWindow)
      await runSubtitleParitySmoke(mainWindow)
      app.exit(0)
    } catch (error) {
      console.error(`SPECTRA_SUBTITLE_PARITY_REPORT ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}`)
      app.exit(1)
    }
    return
  }
  if (process.env.SPECTRA_ACCURATE_PREVIEW_SMOKE === '1') {
    try {
      const report = await runAccuratePreviewSmoke(mainWindow)
      console.log(`SPECTRA_ACCURATE_PREVIEW_REPORT ${JSON.stringify(report)}`)
      app.exit(0)
    } catch (error) {
      console.error(`SPECTRA_ACCURATE_PREVIEW_REPORT ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}`)
      app.exit(1)
    }
    return
  }
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
