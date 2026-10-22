import path from 'node:path'
import { mkdtempSync } from 'node:fs'
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
import { buildSubtitleRenderSpec, subtitleVisualStateKey } from '../shared/subtitle-render'
import { createSubtitleParityFixture } from '../shared/subtitle-parity-fixture'
import { loadExperimentalReviewRecords, saveExperimentalReviewRecord } from './review-service'
import { exportLearningDataset } from './learning-dataset-service'
import type { ExperimentalReviewRecord } from '../shared/review/types'
import { finishFullCorrectionSession, loadFullCorrectionSessions, startFullCorrectionSession } from './full-correction-service'
import { parseAutoCaptionSettings } from '../shared/auto-caption-contract'
import { AutoCaptionService } from './ai/auto-caption-service'
import { loadAutoCaptionBaselines } from './ai/auto-caption-baseline'
import type { AutoCaptionSettings } from '../shared/auto-caption-contract'
import { SubtitleTemplateService } from './subtitle-template-service'
import { loadAppSettings, setLastUsedSubtitleTemplateId } from './app-settings-service'
import { SilenceAnalysisService } from './silence-analysis-service'
import { DEFAULT_SILENCE_REAPPLY_PROFILE, isSilenceReapplyProfile } from '../shared/silence-cut'
import { runProjectQa } from '../shared/project-qa'
import { ThumbnailService } from './thumbnail-service'
import { LEGACY_USER_DATA_FOLDER, migrateLegacyUserData } from './user-data-migration'

registerPrivilegedSchemes()
app.setName('Cutline')

const smokeMode = ['SPECTRA_ACCURATE_PREVIEW_SMOKE', 'SPECTRA_STARTUP_SMOKE', 'SPECTRA_INTERACTION_SMOKE', 'SPECTRA_SUBTITLE_PARITY_SMOKE']
  .some((key) => process.env[key] === '1')
if (smokeMode) {
  // Test windows must not read recovery/settings or populate the user's caches.
  const profile = mkdtempSync(path.join(app.getPath('temp'), 'spectra-smoke-profile-'))
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
} else if (!app.commandLine.hasSwitch('user-data-dir')) {
  // An explicit --user-data-dir (isolated profile) is left untouched.
  // The product was renamed from "Spectra Video Studio"; copy the old settings/recovery/templates once, before anything reads userData.
  const appData = app.getPath('appData')
  const userData = path.join(appData, 'Cutline')
  app.setPath('userData', userData)
  try {
    migrateLegacyUserData(path.join(appData, LEGACY_USER_DATA_FOLDER), userData)
  } catch (error) {
    console.error('Legacy user data migration failed', error)
  }
}

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
let autoCaptionService: AutoCaptionService | null = null
let silenceAnalysisService: SilenceAnalysisService | null = null
let subtitleTemplateService: SubtitleTemplateService | null = null

const assertTrustedSender = (event: Electron.IpcMainInvokeEvent): void => {
  const senderUrl = event.senderFrame?.url ?? ''
  if (!isTrustedIpcUrl(senderUrl)) throw new Error('信頼されていない画面からの操作を拒否しました。')
}

const requireService = (): FfmpegService => {
  if (!ffmpegService) throw new Error('メディアエンジンの初期化が完了していません。')
  return ffmpegService
}

const requireAutoCaptionService = (): AutoCaptionService => {
  if (!autoCaptionService) throw new Error('自動字幕エンジンの初期化が完了していません。')
  return autoCaptionService
}

const requireSilenceAnalysisService = (): SilenceAnalysisService => {
  if (!silenceAnalysisService) throw new Error('無音解析エンジンの初期化が完了していません。')
  return silenceAnalysisService
}

const requireSubtitleTemplateService = (): SubtitleTemplateService => {
  if (!subtitleTemplateService) throw new Error('字幕テンプレートサービスの初期化が完了していません。')
  return subtitleTemplateService
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
      smokeMode
    }
  })

  ipcMain.handle(IPC.appSettingsLoad, async (event) => {
    assertTrustedSender(event)
    return loadAppSettings(app.getPath('userData'))
  })

  ipcMain.handle(IPC.appSettingsLastUsedSubtitleTemplate, async (event, id: unknown) => {
    assertTrustedSender(event)
    return setLastUsedSubtitleTemplateId(app.getPath('userData'), id)
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
    return requireService().clearAccuratePreviewCache().then(() => createPreviewPlan(project, {
      outputPath: path.join(app.getPath('temp'), 'spectra-preview-plan.mp4'),
      width: project.sequence.width,
      height: project.sequence.height,
      frameRate: project.sequence.frameRate,
      videoBitrate: 2_000_000,
      audioBitrate: 128_000,
      encoderMode: 'software',
      burnSubtitles: true,
      exportSrt: false
    }))
  })

  ipcMain.handle(IPC.previewAccurateFrame, async (event, projectInput: ProjectFile, timeUs: unknown) => {
    assertTrustedSender(event)
    if (typeof timeUs !== 'number' || !Number.isFinite(timeUs) || timeUs < 0) {
      throw new Error('正確プレビューの時刻が不正です。')
    }
    return await requireService().renderAccurateFrame(validateProject(projectInput), timeUs)
  })

  ipcMain.handle(IPC.previewSubtitleOverlay, async (event, projectInput: ProjectFile, timeUs: unknown, optionsInput: unknown) => {
    assertTrustedSender(event)
    if (typeof timeUs !== 'number' || !Number.isFinite(timeUs) || timeUs < 0) {
      throw new Error('字幕overlayの時刻が不正です。')
    }
    const rawOptions = optionsInput && typeof optionsInput === 'object' ? optionsInput as { animationMode?: unknown } : undefined
    const animationMode = rawOptions?.animationMode === 'base' || rawOptions?.animationMode === 'full'
      ? rawOptions.animationMode
      : undefined
    return await requireService().renderSubtitleOverlay(validateProject(projectInput), timeUs, { animationMode })
  })

  ipcMain.handle(IPC.previewSubtitleOverlaySequence, async (event, projectInput: ProjectFile, startFrame: unknown, frameCount: unknown) => {
    assertTrustedSender(event)
    if (typeof startFrame !== 'number' || !Number.isSafeInteger(startFrame) || startFrame < 0 || typeof frameCount !== 'number' || !Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 240) {
      throw new Error('字幕overlay連番の範囲が不正です。')
    }
    return await requireService().renderSubtitleOverlaySequence(validateProject(projectInput), startFrame, frameCount)
  })

  ipcMain.handle(IPC.previewSubtitleFrames, async (event, projectInput: ProjectFile, frameIndices: unknown, optionsInput?: unknown) => {
    assertTrustedSender(event)
    if (!Array.isArray(frameIndices) || frameIndices.length < 1 || frameIndices.length > 256 || frameIndices.some((frame) => typeof frame !== 'number' || !Number.isSafeInteger(frame) || frame < 0)) {
      throw new Error('字幕overlayのフレーム指定が不正です。')
    }
    return await requireService().renderSubtitleFrames(validateProject(projectInput), frameIndices as number[], { urgent: (optionsInput as { urgent?: unknown } | undefined)?.urgent === true })
  })

  ipcMain.handle(IPC.silenceCutReapply,async (event, projectInput: ProjectFile, selectedClipId: unknown, jobId: unknown, profileInput: unknown, minSilenceInput: unknown) => {
    assertTrustedSender(event)
    if (typeof selectedClipId !== 'string' || selectedClipId.length > 200 || typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/u.test(jobId)) {
      throw new Error('無音再適用の対象またはjob IDが不正です。')
    }
    const profile = profileInput === undefined ? DEFAULT_SILENCE_REAPPLY_PROFILE : profileInput
    if (!isSilenceReapplyProfile(profile)) throw new Error('無音再適用のprofileが不正です。')
    const minSilenceUs = minSilenceInput === undefined ? undefined : typeof minSilenceInput === 'number' && Number.isSafeInteger(minSilenceInput) ? minSilenceInput : (() => { throw new Error('無音再適用の最小無音時間が不正です。') })()
    return await requireSilenceAnalysisService().start(validateProject(projectInput), selectedClipId, jobId, profile, minSilenceUs)
  })

  ipcMain.handle(IPC.silenceCutCancel, (event, jobId: unknown) => {
    assertTrustedSender(event)
    if (typeof jobId !== 'string' || jobId.length > 160) return false
    return requireSilenceAnalysisService().cancel(jobId)
  })

  ipcMain.handle(IPC.autoCaptionHealth, async (event) => {
    assertTrustedSender(event)
    return requireAutoCaptionService().health()
  })

  ipcMain.handle(IPC.autoCaptionStart, async (event, projectInput: ProjectFile, selectedClipIds: unknown, settingsInput: unknown) => {
    assertTrustedSender(event)
    if (!Array.isArray(selectedClipIds) || selectedClipIds.some((id) => typeof id !== 'string')) {
      throw new Error('自動字幕の選択状態が不正です。')
    }
    const settings: AutoCaptionSettings | undefined = settingsInput === undefined ? undefined : parseAutoCaptionSettings(settingsInput)
    return await requireAutoCaptionService().start({
      project: validateProject(projectInput),
      selectedClipIds,
      settings,
      onProgress: (progress) => mainWindow?.webContents.send(IPC.autoCaptionProgress, progress)
    })
  })

  ipcMain.handle(IPC.autoCaptionCancel, (event, jobId: unknown) => {
    assertTrustedSender(event)
    if (typeof jobId !== 'string' || jobId.length > 200) return false
    return requireAutoCaptionService().cancel(jobId)
  })

  ipcMain.handle(IPC.autoCaptionStatus, (event, jobId: unknown) => {
    assertTrustedSender(event)
    if (typeof jobId !== 'string' || jobId.length > 200) return null
    return requireAutoCaptionService().status(jobId)
  })

  ipcMain.handle(IPC.autoCaptionResegment, async (event, requestInput: unknown) => {
    assertTrustedSender(event)
    return requireAutoCaptionService().resegment(requestInput)
  })

  ipcMain.handle(IPC.autoCaptionBaselinesLoad, async (event) => {
    assertTrustedSender(event)
    return loadAutoCaptionBaselines(app.getPath('userData'))
  })

  ipcMain.handle(IPC.subtitleTemplatesLoad, async (event) => {
    assertTrustedSender(event)
    return requireSubtitleTemplateService().load()
  })
  ipcMain.handle(IPC.subtitleTemplateDefault, async (event, id: unknown) => {
    assertTrustedSender(event)
    return requireSubtitleTemplateService().setDefault(id)
  })

  ipcMain.handle(IPC.subtitleTemplateCreate, async (event, input: unknown) => {
    assertTrustedSender(event)
    return requireSubtitleTemplateService().create(input)
  })

  ipcMain.handle(IPC.subtitleTemplateUpdate, async (event, id: unknown, input: unknown) => {
    assertTrustedSender(event)
    return requireSubtitleTemplateService().update(id, input)
  })

  ipcMain.handle(IPC.subtitleTemplateDuplicate, async (event, input: unknown) => {
    assertTrustedSender(event)
    return requireSubtitleTemplateService().duplicate(input)
  })

  ipcMain.handle(IPC.subtitleTemplateDelete, async (event, id: unknown) => {
    assertTrustedSender(event)
    return requireSubtitleTemplateService().remove(id)
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
    const qaReport = runProjectQa(project, { encoderReport: await requireService().detectEncoders(false), outputSettings: settings })
    const qaError = qaReport.issues.find((issue) => issue.severity === 'error')
    if (qaError) throw new Error(`QAエラー [${qaError.code}]: ${qaError.message}`)
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

  ipcMain.handle(IPC.reviewLoad, (event) => {
    assertTrustedSender(event)
    return loadExperimentalReviewRecords()
  })

  ipcMain.handle(IPC.reviewUpsert, (event, record: ExperimentalReviewRecord) => {
    assertTrustedSender(event)
    if (!record || record.version !== 'experimental.phase3.5b1' || typeof record.sessionId !== 'string') {
      throw new Error('レビュー記録の形式が不正です。')
    }
    return saveExperimentalReviewRecord(structuredClone(record))
  })

  ipcMain.handle(IPC.learningDatasetExport, (event) => {
    assertTrustedSender(event)
    return exportLearningDataset()
  })

  ipcMain.handle(IPC.thumbnailCandidates, async (event, projectInput: ProjectFile, selectedClipId: unknown) => {
    assertTrustedSender(event)
    if (typeof selectedClipId !== 'string' || selectedClipId.length > 200) throw new Error('サムネイル対象clipが不正です。')
    const project = validateProject(projectInput)
    const selected = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId)
    if (!selected || selected.kind !== 'video' || !selected.assetId) throw new Error('映像clipを1つ選択してください。')
    const asset = project.media.find((item) => item.id === selected.assetId)
    if (!asset || asset.offline || !path.isAbsolute(asset.path)) throw new Error('サムネイル用の映像素材を解決できません。')
    const service = requireService()
    return new ThumbnailService(service.paths, { executor: service.executor, cacheRoot: path.join(app.getPath('userData'), 'thumbnail-cache') }).extractCandidates({ mediaPath: asset.path, sourceInUs: selected.sourceInUs, durationUs: selected.durationUs })
  })

  ipcMain.handle(IPC.thumbnailExport, async (event, bytes: unknown, format: unknown) => {
    assertTrustedSender(event)
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 25 * 1024 * 1024 || (format !== 'png' && format !== 'jpeg')) throw new Error('サムネイル画像データが不正です。')
    const response = await dialog.showSaveDialog({
      title: 'サムネイルを書き出す',
      defaultPath: `cutline-thumbnail.${format === 'png' ? 'png' : 'jpg'}`,
      filters: [{ name: format === 'png' ? 'PNG image' : 'JPEG image', extensions: [format === 'png' ? 'png' : 'jpg'] }]
    })
    if (response.canceled || !response.filePath) return null
    const outputPath = response.filePath.toLowerCase().endsWith(format === 'png' ? '.png' : '.jpg') ? response.filePath : `${response.filePath}.${format === 'png' ? 'png' : 'jpg'}`
    await writeFile(outputPath, bytes)
    return outputPath
  })

  ipcMain.handle(IPC.fullCorrectionLoad, (event) => {
    assertTrustedSender(event)
    return loadFullCorrectionSessions()
  })

  ipcMain.handle(IPC.fullCorrectionStart, (event, projectInput: ProjectFile, trackId: unknown) => {
    assertTrustedSender(event)
    if (typeof trackId !== 'string' || trackId.length > 200) throw new Error('全文修正のtrack指定が不正です。')
    return startFullCorrectionSession(validateProject(projectInput), trackId)
  })

  ipcMain.handle(IPC.fullCorrectionFinish, (event, projectInput: ProjectFile, sessionId: unknown) => {
    assertTrustedSender(event)
    if (typeof sessionId !== 'string' || sessionId.length > 200) throw new Error('全文修正のsession指定が不正です。')
    return finishFullCorrectionSession(validateProject(projectInput), sessionId)
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

/**
 * The preview parity checks run from scripts/accurate-preview-smoke.mjs over
 * the DevTools protocol (--remote-debugging-port). Smoke mode only provides an
 * isolated profile plus the spectra:e2e-project hook, then waits to be driven.
 */
const runAccuratePreviewSmoke = async (window: BrowserWindow): Promise<void> => {
  await waitForRendererStartup(window)
  console.log('SPECTRA_ACCURATE_PREVIEW_READY')
  await new Promise<void>(() => undefined)
}

const runInteractionStateSmoke = async (window: BrowserWindow): Promise<Record<string, unknown>> => {
  const fixturePath = process.env.SPECTRA_INTERACTION_SMOKE_PROJECT
  if (!fixturePath) throw new Error('SPECTRA_INTERACTION_SMOKE_PROJECT is required')
  const project = validateProject(JSON.parse(await readFile(fixturePath, 'utf8')) as ProjectFile)
  const startup = await waitForRendererStartup(window)
  const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const readDom = async (): Promise<Record<string, unknown>> => await window.webContents.executeJavaScript(`(() => {
    const text = (button) => button?.textContent?.replace(/\\s+/gu, '') ?? ''
    const buttons = [...document.querySelectorAll('button')]
    const byText = (value) => buttons.find((button) => text(button).includes(value))
    const auto = byText('自動処理')
    const run = byText('実行')
    const review = document.querySelector('button.review-toggle')
    const correction = byText('全文修正')
    const dialog = document.querySelector('.caption-dialog')
    const reviewWorkspace = document.querySelector('.subtitle-review-workspace')
    const learningDataset = byText('学習データを書き出す')
    const thumbnailWorkspace = document.querySelector('.thumbnail-workspace')
    return {
      dialog: Boolean(dialog),
      dialogTitle: dialog?.querySelector('h2')?.textContent ?? '',
      autoProcessing: auto ? { disabled: auto.disabled, title: auto.getAttribute('title') ?? '', text: text(auto) } : null,
      run: run ? { disabled: run.disabled, title: run.getAttribute('title') ?? '', text: text(run) } : null,
      review: review ? { disabled: review.disabled, text: text(review), active: review.classList.contains('is-active') } : null,
      fullCorrection: correction ? { disabled: correction.disabled, text: text(correction) } : null,
      reviewWorkspace: reviewWorkspace ? { title: reviewWorkspace.querySelector('h2')?.textContent ?? '' } : null,
      learningDataset: learningDataset ? { disabled: learningDataset.disabled } : null,
      thumbnailWorkspace: thumbnailWorkspace ? { title: thumbnailWorkspace.querySelector('h2')?.textContent ?? '' } : null,
      saved: document.querySelector('.project-menu')?.textContent?.includes('保存済み') ?? false,
      focusedTag: document.activeElement?.tagName ?? '',
      rootChildCount: document.querySelector('#root')?.childElementCount ?? 0
    }
  })()`)
  const dispatchProject = async (detail: Record<string, unknown>): Promise<void> => {
    await window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('spectra:e2e-project', { detail: ${JSON.stringify(detail)} }))`)
    await wait(100)
  }
  const dispatchProcessing = async (state: string): Promise<void> => {
    await window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('spectra:e2e-processing', { detail: ${JSON.stringify({ state })} }))`)
    await wait(100)
  }
  const click = async (selector: string): Promise<void> => {
    await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.click()`)
    await wait(100)
  }
  const clickText = async (value: string): Promise<void> => {
    await window.webContents.executeJavaScript(`(() => { const buttons = [...document.querySelectorAll('button')]; const button = buttons.find((item) => (item.textContent ?? '').replace(/\\s+/gu, '').includes(${JSON.stringify(value)})); button?.click() })()`)
    await wait(100)
  }
  const empty = structuredClone(project)
  empty.media = []
  empty.tracks = empty.tracks.map((track) => ({ ...track, clips: [] }))
  const mediaOnly = structuredClone(project)
  mediaOnly.tracks = mediaOnly.tracks.map((track) => ({ ...track, clips: [] }))
  const noAudio = structuredClone(project)
  noAudio.media = noAudio.media.map((asset) => ({ ...asset, hasAudio: false }))
  const multiSelect = structuredClone(project)
  const mediaTrack = multiSelect.tracks.find((track) => track.kind === 'media')
  const firstVideo = mediaTrack?.clips.find((clip) => clip.kind === 'video')
  if (mediaTrack && firstVideo) mediaTrack.clips.push({ ...structuredClone(firstVideo), id: 'night07-video-2', startUs: 7_000_000 })
  const offline = structuredClone(project)
  offline.media = offline.media.map((asset) => ({ ...asset, offline: true }))
  const transitions: Record<string, unknown> = {}
  await dispatchProject({ project: empty })
  transitions.emptyProject = await readDom()
  await clickText('自動処理')
  transitions.noSelectionDialog = await readDom()
  await click('.caption-dialog button[aria-label^="閉じる"]')
  await dispatchProject({ project: mediaOnly })
  transitions.mediaImported = await readDom()
  await dispatchProject({ project: mediaOnly, selectAssetId: 'night07-source' })
  transitions.mediaSelected = await readDom()
  await dispatchProject({ project })
  transitions.clipOnTimeline = await readDom()
  await dispatchProject({ project, selectClipId: 'night07-video' })
  await clickText('自動処理')
  transitions.clipSelected = await readDom()
  await dispatchProcessing('running')
  transitions.processingRunning = await readDom()
  await dispatchProcessing('completed')
  transitions.processingCompleted = await readDom()
  await dispatchProcessing('failed')
  transitions.processingFailed = await readDom()
  await click('.caption-dialog button[aria-label^="閉じる"]')
  transitions.modalClosed = await readDom()
  await dispatchProject({ project, selectClipId: 'night07-caption' })
  transitions.subtitleSelected = await readDom()
  await clickText('レビューOFF')
  transitions.reviewMode = await readDom()
  await dispatchProject({ project, selectClipId: 'night07-caption' })
  transitions.fullCorrection = await readDom()
  await clickText('レビューON')
  await clickText('字幕レビュー')
  transitions.reviewWorkspace = await readDom()
  await click('.subtitle-review-workspace button[aria-label^="字幕レビューを閉じる"]')
  await clickText('サムネイル')
  transitions.thumbnailWorkspace = await readDom()
  await click('.thumbnail-workspace button[aria-label^="サムネイルを閉じる"]')
  await dispatchProject({ project: offline })
  await dispatchProject({ project: offline, selectClipId: 'night07-video' })
  await clickText('自動処理')
  transitions.offlineMedia = await readDom()
  await dispatchProject({ project: noAudio, selectClipId: 'night07-video' })
  await clickText('自動処理')
  transitions.noAudio = await readDom()
  await click('.caption-dialog button[aria-label^="閉じる"]')
  await dispatchProject({ project: multiSelect, selectClipIds: ['night07-video', 'night07-video-2'] })
  await clickText('自動処理')
  transitions.multiSelection = await readDom()
  return { ...startup, transitions }
}

const start = async (): Promise<void> => {
  installMediaProtocol()
  ffmpegService = await createFfmpegService({
    workspaceRoot: smokeMode ? path.join(app.getPath('userData'), 'media-workspace') : path.join(app.getPath('temp'), 'cutline')
  })
  silenceAnalysisService = new SilenceAnalysisService(ffmpegService.paths, { executor: ffmpegService.executor })
  autoCaptionService = new AutoCaptionService({ appPath: app.getAppPath(), userDataPath: app.getPath('userData') })
  subtitleTemplateService = new SubtitleTemplateService(app.getPath('userData'))
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
      await runAccuratePreviewSmoke(mainWindow)
    } catch (error) {
      console.error(`SPECTRA_ACCURATE_PREVIEW_ERROR ${error instanceof Error ? error.message : String(error)}`)
      app.exit(1)
    }
    return
  }
  if (process.env.SPECTRA_INTERACTION_SMOKE === '1') {
    try {
      const report = await runInteractionStateSmoke(mainWindow)
      console.log(`SPECTRA_INTERACTION_REPORT ${JSON.stringify(report)}`)
      app.exit(0)
    } catch (error) {
      console.error(`SPECTRA_INTERACTION_REPORT ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}`)
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
