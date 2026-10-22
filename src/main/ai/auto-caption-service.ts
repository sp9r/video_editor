import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  AUTO_CAPTION_PROGRESS_VERSION,
  parseAutoCaptionProgress,
  parseAutoCaptionResult,
  parseAutoCaptionSilenceAnalysis,
  parseResegmentRequest,
  parseResegmentResult,
  type ResegmentResult,
  type AutoCaptionSilenceAnalysis,
  type AutoCaptionProgress,
  type AutoCaptionResult,
  type AutoCaptionSettings
} from '../../shared/auto-caption-contract.js'
import type { AutoCaptionHealth, AutoCaptionJobStatus, AutoCaptionStartResult, ProjectFile, TimelineClip } from '../../shared/types.js'
import { defaultProcessExecutor, type ProcessExecutor } from '../ffmpeg/process.js'
import { discoverAutoCaptionWorker, type AutoCaptionWorkerDiscovery } from './worker-discovery.js'
import { saveAutoCaptionBaseline } from './auto-caption-baseline.js'
import { DEFAULT_SILENCE_REAPPLY_PROFILE, silenceCutProfileSettings } from '../../shared/silence-cut.js'

const DEFAULT_SETTINGS: AutoCaptionSettings = {
  language: 'ja', maxChars: 32, maxLines: 2, segmentationMode: 'auto',
  silenceCut: DEFAULT_SILENCE_REAPPLY_PROFILE, silenceMinUs: silenceCutProfileSettings(DEFAULT_SILENCE_REAPPLY_PROFILE).minSilenceUs, accelerationMode: 'auto', subtitleTemplate: 'default'
}
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000
const MAX_PROGRESS_BYTES = 8 * 1024 * 1024
const MAX_RESULT_BYTES = 64 * 1024 * 1024
const TERMINAL_RETENTION_MS = 15 * 60 * 1000
const PATH_VALUE = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|tmp|var)\/)/

export interface AutoCaptionProgressEvent extends AutoCaptionProgress {
  result?: AutoCaptionResult
}

interface ActiveJob {
  controller: AbortController
  clipId: string
}

interface RetainedJob extends AutoCaptionJobStatus {
  expiresAt: number
}

export interface AutoCaptionServiceOptions {
  appPath: string
  userDataPath: string
  executor?: ProcessExecutor
  timeoutMs?: number
  discover?: (options: { appPath: string; userDataPath: string }) => Promise<AutoCaptionWorkerDiscovery>
}

type DiscoverWorker = (options: { appPath: string; userDataPath: string }) => Promise<AutoCaptionWorkerDiscovery>

const safeMessage = (message: string): string => message
  .replace(/[A-Za-z]:[\\/][^\s"']+|\\\\[^\s"']+|\/(?:Users|home|private|tmp|var)\/[^\s"']+/g, '[redacted]')
  .replace(/(?:password|secret|token|api[_ -]?key|credential)\s*[=:]\s*[^\s,;]+/gi, '[redacted]')

const assertSafeDiagnostics = (result: AutoCaptionResult): void => {
  if (PATH_VALUE.test(result.provider) || PATH_VALUE.test(result.model)) throw new Error('unsafe worker metadata')
  for (const diagnostic of result.diagnostics) if (PATH_VALUE.test(diagnostic.message)) throw new Error('unsafe worker diagnostic')
  if (result.fallback.reason && PATH_VALUE.test(result.fallback.reason)) throw new Error('unsafe worker fallback')
}

const assertSafeSilenceAnalysis = (analysis: AutoCaptionSilenceAnalysis): void => {
  for (const diagnostic of analysis.diagnostics) if (PATH_VALUE.test(diagnostic.message)) throw new Error('unsafe silence diagnostic')
}

const selectedClip = (project: ProjectFile, selectedClipIds: readonly string[]): Extract<TimelineClip, { kind: 'video' | 'audio' }> => {
  if (selectedClipIds.length !== 1) throw new Error('自動字幕は動画または音声クリップを1つだけ選択して実行してください。')
  const clip = project.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === selectedClipIds[0])
  if (!clip || (clip.kind !== 'video' && clip.kind !== 'audio')) throw new Error('自動字幕は動画または音声クリップを1つ選択して実行してください。')
  if (!Number.isSafeInteger(clip.sourceInUs) || !Number.isSafeInteger(clip.durationUs) || clip.durationUs <= 0) throw new Error('自動字幕のclip範囲が不正です。')
  const asset = project.media.find((candidate) => candidate.id === clip.assetId)
  if (!asset || asset.offline || !asset.hasAudio || !path.isAbsolute(asset.path)) throw new Error('自動字幕の音声素材が利用できません。')
  return clip
}

export class AutoCaptionService {
  private readonly executor: ProcessExecutor
  private readonly timeoutMs: number
  private readonly active = new Map<string, ActiveJob>()
  private readonly retained = new Map<string, RetainedJob>()
  private readonly discover: DiscoverWorker

  constructor(private readonly options: AutoCaptionServiceOptions) {
    this.executor = options.executor ?? defaultProcessExecutor
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.discover = options.discover ?? ((input) => discoverAutoCaptionWorker({ ...input }))
  }

  async health(): Promise<AutoCaptionHealth> {
    try {
      await this.discover({ appPath: this.options.appPath, userDataPath: this.options.userDataPath })
      return { available: true, checkedAt: new Date().toISOString(), provider: 'clip_automation' }
    } catch {
      return {
        available: false,
        checkedAt: new Date().toISOString(),
        provider: 'unavailable',
        reason: '自動字幕エンジンを利用できません。workerの設定と実行環境を確認してください。'
      }
    }
  }

  async start({
    project,
    selectedClipIds,
    settings = DEFAULT_SETTINGS,
    onProgress
  }: {
    project: ProjectFile
    selectedClipIds: readonly string[]
    settings?: AutoCaptionSettings
    onProgress: (progress: AutoCaptionProgressEvent) => void
  }): Promise<AutoCaptionStartResult> {
    const effectiveSettings: AutoCaptionSettings = { ...DEFAULT_SETTINGS, ...settings }
    const clip = selectedClip(project, selectedClipIds)
    const asset = project.media.find((candidate) => candidate.id === clip.assetId)
    if (!asset) throw new Error('自動字幕の音声素材が利用できません。')
    const mediaPath = path.resolve(asset.path)
    try {
      if (!(await stat(mediaPath)).isFile()) throw new Error('missing media')
    } catch {
      throw new Error('自動字幕の音声素材が利用できません。')
    }
    const discovery = await this.discover({ appPath: this.options.appPath, userDataPath: this.options.userDataPath })
    const jobId = `caption-job-${randomUUID()}`
    const controller = new AbortController()
    this.active.set(jobId, { controller, clipId: clip.id })
    void this.runJob({ jobId, project, clip, mediaPath, settings: effectiveSettings, discovery, controller, onProgress })
    return { jobId, clipId: clip.id }
  }

  /**
   * Segmentation-only re-split of already transcribed words (no audio, no Whisper).
   * Runs the same caption segmentation code as the full worker.
   */
  async resegment(requestInput: unknown): Promise<ResegmentResult> {
    const request = parseResegmentRequest(requestInput)
    const discovery = await this.discover({ appPath: this.options.appPath, userDataPath: this.options.userDataPath })
    const scriptPath = path.join(path.dirname(discovery.scriptPath), 'spectra_caption_resegment.py')
    try {
      if (!(await stat(scriptPath)).isFile()) throw new Error('missing')
    } catch {
      throw new Error('字幕の再分割workerが見つかりません。clip_automationを更新してください。')
    }
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'spectra-caption-resegment-'))
    try {
      const requestPath = path.join(workspace, 'request.json')
      const resultPath = path.join(workspace, 'result.json')
      await writeFile(requestPath, `${JSON.stringify(request)}
`, 'utf8')
      await this.executor.run({
        command: discovery.command,
        args: [scriptPath, '--request', requestPath, '--output', resultPath],
        cwd: discovery.root,
        signal: new AbortController().signal,
        // The LLM caption writer thinks before answering and can take an hour for a long clip.
        timeoutMs: this.timeoutMs,
        maxOutputBytes: MAX_PROGRESS_BYTES,
        onStdout: () => undefined
      })
      const resultStat = await stat(resultPath)
      if (!resultStat.isFile() || resultStat.size <= 0 || resultStat.size > MAX_RESULT_BYTES) throw new Error('invalid result size')
      return parseResegmentResult(JSON.parse(await readFile(resultPath, 'utf8')), request)
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  cancel(jobId: string): boolean {
    const job = this.active.get(jobId)
    if (!job) return false
    job.controller.abort()
    return true
  }

  status(jobId: string): AutoCaptionJobStatus | null {
    const retained = this.retained.get(jobId)
    if (!retained) return null
    if (retained.expiresAt <= Date.now()) {
      this.retained.delete(jobId)
      return null
    }
    return { jobId: retained.jobId, clipId: retained.clipId, progress: structuredClone(retained.progress) }
  }

  private async runJob({
    jobId,
    project,
    clip,
    mediaPath,
    settings,
    discovery,
    controller,
    onProgress
  }: {
    jobId: string
    project: ProjectFile
    clip: Extract<TimelineClip, { kind: 'video' | 'audio' }>
    mediaPath: string
    settings: AutoCaptionSettings
    discovery: AutoCaptionWorkerDiscovery
    controller: AbortController
    onProgress: (progress: AutoCaptionProgressEvent) => void
  }): Promise<void> {
    let workspace: string | undefined
    let requestPath = ''
    let resultPath = ''
    let silencePath = ''
    // maxWidthPercent is an editor-side layout setting (stored on the generated
    // clips); the worker only needs the derived lineCapacity.
    const { maxWidthPercent: _maxWidthPercent, ...workerSettings } = settings
    // With a per-line capacity, a caption may hold at most capacity x maxLines
    // characters (the worker accepts 8..80). The baseline keeps the user's maxChars.
    const layoutMaxChars = workerSettings.lineCapacity === undefined
      ? workerSettings.maxChars
      : Math.max(8, Math.min(80, workerSettings.maxChars, workerSettings.lineCapacity * (workerSettings.maxLines ?? 2)))
    const request = {
      version: 'spectra.auto-caption.request.v1',
      jobId,
      mediaPath,
      sourceStartUs: clip.sourceInUs,
      sourceEndUs: clip.sourceInUs + clip.durationUs,
      ...workerSettings,
      maxChars: layoutMaxChars
    }
    let progressBuffer = ''
    let progressBytes = 0
    let malformedProgress = false
    let terminalEmitted = false
    let workerFailure: AutoCaptionProgress | undefined
    let phase = 'workspace'
    const emit = (progress: AutoCaptionProgressEvent): void => {
      if (terminalEmitted) return
      const safeProgress = { ...progress, message: safeMessage(progress.message) }
      if (safeProgress.state === 'completed' || safeProgress.state === 'failed') {
        terminalEmitted = true
        this.retained.set(jobId, { jobId, clipId: clip.id, progress: safeProgress, expiresAt: Date.now() + TERMINAL_RETENTION_MS })
      }
      try {
        onProgress(safeProgress)
      } catch {
        // A renderer may have closed while the worker was still running. The
        // retained terminal status remains available through status().
      }
    }
    const consumeProgress = (chunk: string): void => {
      progressBytes += Buffer.byteLength(chunk, 'utf8')
      if (progressBytes > MAX_PROGRESS_BYTES) {
        malformedProgress = true
        controller.abort()
        return
      }
      progressBuffer += chunk
      const lines = progressBuffer.split(/\r?\n/)
      progressBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const progress = parseAutoCaptionProgress(JSON.parse(line))
          if (progress.jobId !== jobId || progress.version !== AUTO_CAPTION_PROGRESS_VERSION) continue
          // A worker's completed line is only a signal. The service emits the
          // terminal completion after the result artifact has been validated.
          if (progress.state === 'completed') continue
          if (progress.state === 'failed') {
            workerFailure = progress
            continue
          }
          emit(progress)
        } catch {
          malformedProgress = true
          controller.abort()
        }
      }
    }
    try {
      phase = 'workspace'
      workspace = await mkdtemp(path.join(os.tmpdir(), 'spectra-auto-caption-'))
      requestPath = path.join(workspace, 'request.json')
      resultPath = path.join(workspace, 'result.json')
      silencePath = path.join(workspace, 'silence_analysis.json')
      await writeFile(requestPath, `${JSON.stringify(request)}\n`, 'utf8')
      const args = [discovery.scriptPath, '--request', requestPath, '--output', resultPath, '--acceleration-mode', settings.accelerationMode ?? 'auto']
      if (discovery.parallel && settings.silenceCut !== 'off') args.push('--silence-output', silencePath)
      phase = 'worker'
      await this.executor.run({
        command: discovery.command,
        args,
        cwd: discovery.root,
        signal: controller.signal,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: MAX_PROGRESS_BYTES,
        onStdout: consumeProgress
      })
      if (progressBuffer.trim()) consumeProgress(`${progressBuffer}\n`)
      if (malformedProgress) throw new Error('malformed progress')
      if (controller.signal.aborted) throw new Error('cancelled')
      if (workerFailure) throw new Error(workerFailure.errorCode ?? 'worker reported failure')
      phase = 'result_validation'
      const resultStat = await stat(resultPath)
      if (!resultStat.isFile() || resultStat.size <= 0 || resultStat.size > MAX_RESULT_BYTES) throw new Error('invalid result size')
      const result = parseAutoCaptionResult(JSON.parse(await readFile(resultPath, 'utf8')))
      if (result.jobId !== jobId || result.sourceStartUs !== clip.sourceInUs || result.sourceEndUs !== clip.sourceInUs + clip.durationUs) throw new Error('result identity or range mismatch')
      assertSafeDiagnostics(result)
      phase = 'baseline'
      await saveAutoCaptionBaseline({ userDataPath: this.options.userDataPath, project, mediaPath, clip, result, settings })
      let silenceAnalysis: AutoCaptionSilenceAnalysis | undefined
      if (discovery.parallel && settings.silenceCut !== 'off') {
        phase = 'silence_validation'
        const silenceStat = await stat(silencePath)
        if (!silenceStat.isFile() || silenceStat.size <= 0 || silenceStat.size > MAX_RESULT_BYTES) throw new Error('invalid silence result size')
        silenceAnalysis = parseAutoCaptionSilenceAnalysis(JSON.parse(await readFile(silencePath, 'utf8')))
        assertSafeSilenceAnalysis(silenceAnalysis)
      }
      phase = 'terminal_publish'
      emit({ version: AUTO_CAPTION_PROGRESS_VERSION, jobId, state: 'completed', ratio: 1, message: '自動字幕を完了しました。', result, ...(silenceAnalysis ? { silenceAnalysis } : {}) })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const malformedResult = /result|JSON|Unexpected token|unsafe worker|identity|source range/i.test(message)
      const errorCode = malformedProgress ? 'MALFORMED_OUTPUT' : controller.signal.aborted || message === 'cancelled' ? 'CANCELLED' : workerFailure?.errorCode ?? (message.includes('timed out') ? 'TIMEOUT' : malformedResult ? 'MALFORMED_OUTPUT' : 'WORKER_FAILED')
      const workerDiagnostics = workerFailure?.diagnostics?.map((diagnostic) => ({
        ...diagnostic,
        message: safeMessage(diagnostic.message)
      }))
      const diagnostics = errorCode === 'CANCELLED'
        ? undefined
        : workerDiagnostics && workerDiagnostics.length > 0
          ? workerDiagnostics
          : [{ level: 'error' as const, code: `AUTO_CAPTION_${phase.toUpperCase()}`, message: `failure phase=${phase}; reason=${safeMessage(message).slice(0, 200) || 'unknown'}` }]
      emit({
        version: AUTO_CAPTION_PROGRESS_VERSION,
        jobId,
        state: 'failed',
        ratio: 0,
        message: errorCode === 'CANCELLED' ? '自動字幕をキャンセルしました。' : workerFailure?.message ? safeMessage(workerFailure.message) : `自動字幕を完了できませんでした。（${phase}）`,
        errorCode,
        diagnostics
      })
    } finally {
      this.active.delete(jobId)
      if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
