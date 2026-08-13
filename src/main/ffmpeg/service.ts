import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  EncoderReport,
  ExportProgress,
  ExportSettings,
  ProbeResult,
  ProjectFile
} from '../../shared/types.js'
import { resolveFfmpegPaths, type FfmpegPaths } from './binaries.js'
import {
  EncoderDetector,
  probeEncoder,
  selectEncoderCandidates,
  type H264EncoderId
} from './encoders.js'
import { defaultProcessExecutor, ProcessCancelledError, type ProcessExecutor } from './process.js'
import { probeMediaFile, probeMediaFileSafe, validateRenderedOutput } from './probe.js'
import {
  buildRenderCommandArgs,
  buildRenderFilterGraph,
  createRenderPlan,
  ffmpegSupportsFileBackedOptions,
  type RenderPlan
} from './render-plan.js'
import { generateSrt } from './subtitles.js'
import { WaveformExtractor } from './waveform.js'
import type { WaveformRequest } from '../../shared/types.js'

export interface FfmpegServiceOptions {
  ffmpegPath?: string | null
  ffprobePath?: string | null
  executor?: ProcessExecutor
  platform?: NodeJS.Platform
  workspaceRoot?: string
  vaapiDevice?: string
  paths?: FfmpegPaths
}

export interface ExportJobOptions {
  jobId?: string
  onProgress?: (progress: ExportProgress) => void
}

export interface ExportResult {
  jobId: string
  outputPath: string
  encoderId: H264EncoderId
  fallbackReason?: string
}

export interface ExportJob {
  jobId: string
  outputPath: string
  result: Promise<ExportResult>
}

interface ActiveJob {
  controller: AbortController
}

const safeJobId = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(value)) throw new Error('Job ID contains unsafe characters')
  return value
}

const safeOutputPath = (path: string): string => {
  const absolute = resolve(path)
  if (extname(absolute).toLowerCase() !== '.mp4') throw new Error('Export output must use the .mp4 extension')
  return absolute
}

export const createFfmpegProgressParser = (
  totalUs: number,
  report: (encodedUs: number) => void
): ((chunk: string) => void) => {
  let pending = ''
  let lastUs = 0
  return (chunk: string): void => {
    pending += chunk
    const lines = pending.split(/\r?\n/u)
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const separator = line.indexOf('=')
      if (separator <= 0) continue
      const key = line.slice(0, separator)
      const value = line.slice(separator + 1)
      let encodedUs: number | undefined
      if (key === 'out_time_us') encodedUs = Number.parseInt(value, 10)
      if (key === 'out_time_ms' && encodedUs === undefined) encodedUs = Number.parseInt(value, 10)
      if (key === 'out_time') {
        const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/u.exec(value)
        if (match) {
          encodedUs = Math.round((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1_000_000)
        }
      }
      if (encodedUs !== undefined && Number.isFinite(encodedUs)) {
        lastUs = Math.min(totalUs, Math.max(lastUs, encodedUs))
        report(lastUs)
      }
      if (key === 'progress' && value === 'end') report(totalUs)
    }
  }
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const frameDurationUs = (plan: RenderPlan): number =>
  Math.ceil(plan.frameRateDenominator * 1_000_000 / plan.frameRateNumerator)

const moveIntoPlace = async (temporaryPath: string, outputPath: string): Promise<void> => {
  try {
    await rename(temporaryPath, outputPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') throw error
    const backupPath = `${outputPath}.backup-${randomUUID()}`
    await rename(outputPath, backupPath)
    try {
      await rename(temporaryPath, outputPath)
      await rm(backupPath, { force: true })
    } catch (replacementError) {
      await rename(backupPath, outputPath).catch(() => undefined)
      throw replacementError
    }
  }
}

const assertInputFile = async (path: string): Promise<void> => {
  const file = await stat(path)
  if (!file.isFile()) throw new Error(`Input asset is not a regular file: ${path}`)
}

const isNonRetryableExportError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code
  if (code && ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'ENOENT'].includes(code)) return true
  const message = errorMessage(error).toLowerCase()
  return [
    'no space left on device',
    'disk full',
    'permission denied',
    'access is denied',
    'read-only file system',
    'no such file or directory',
    'cannot find the file'
  ].some((phrase) => message.includes(phrase))
}

const tryStatSameFile = async (left: string, right: string): Promise<boolean> => {
  if (resolve(left).toLowerCase() === resolve(right).toLowerCase()) return true
  try {
    const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)])
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
  } catch {
    return false
  }
}

export class FfmpegService {
  readonly paths: FfmpegPaths
  readonly executor: ProcessExecutor
  readonly detector: EncoderDetector
  readonly waveform: WaveformExtractor
  readonly workspaceRoot: string
  readonly vaapiDevice?: string
  readonly #jobs = new Map<string, ActiveJob>()

  constructor(paths: FfmpegPaths, options: Omit<FfmpegServiceOptions, 'paths' | 'ffmpegPath' | 'ffprobePath'> = {}) {
    this.paths = paths
    this.executor = options.executor ?? defaultProcessExecutor
    this.workspaceRoot = resolve(options.workspaceRoot ?? join(tmpdir(), 'spectra-video-studio'))
    this.vaapiDevice = options.vaapiDevice
    this.detector = new EncoderDetector(paths, {
      executor: this.executor,
      platform: options.platform,
      vaapiDevice: options.vaapiDevice
    })
    this.waveform = new WaveformExtractor(paths, this.executor)
  }

  async detectEncoders(force = false): Promise<EncoderReport> {
    return await this.detector.detect(force)
  }

  async probeMedia(path: string): Promise<ProbeResult> {
    return await probeMediaFile(this.paths, path, { executor: this.executor })
  }

  async probeMediaSafe(path: string): Promise<ProbeResult> {
    return await probeMediaFileSafe(this.paths, path, { executor: this.executor })
  }

  async getWaveformPeaks(request: WaveformRequest): Promise<number[]> {
    return await this.waveform.getPeaks(request)
  }

  createRenderPlan(project: ProjectFile, settings: ExportSettings): RenderPlan {
    return createRenderPlan(project, settings)
  }

  async writeSrt(project: ProjectFile, outputPath: string): Promise<void> {
    await mkdir(dirname(resolve(outputPath)), { recursive: true })
    await writeFile(resolve(outputPath), generateSrt(project), 'utf8')
  }

  cancelExport(jobId: string): boolean {
    const active = this.#jobs.get(jobId)
    if (!active) return false
    active.controller.abort()
    return true
  }

  async startExport(
    project: ProjectFile,
    settings: ExportSettings,
    options: ExportJobOptions = {}
  ): Promise<ExportJob> {
    const jobId = safeJobId(options.jobId ?? randomUUID())
    if (this.#jobs.has(jobId)) throw new Error(`Export job already exists: ${jobId}`)
    const outputPath = safeOutputPath(settings.outputPath)
    const controller = new AbortController()
    this.#jobs.set(jobId, { controller })
    const result = this.#runExport(jobId, project, { ...settings, outputPath }, controller.signal, options.onProgress)
      .finally(() => this.#jobs.delete(jobId))
    return { jobId, outputPath, result }
  }

  async #runExport(
    jobId: string,
    project: ProjectFile,
    settings: ExportSettings,
    signal: AbortSignal,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<ExportResult> {
    const outputPath = settings.outputPath
    let plan: RenderPlan
    try {
      plan = createRenderPlan(project, settings)
    } catch (error) {
      onProgress?.({
        jobId,
        stage: 'failed',
        ratio: 0,
        encodedUs: 0,
        totalUs: 0,
        message: '書き出し計画を作成できませんでした',
        error: errorMessage(error)
      })
      throw error
    }
    const emit = (progress: Omit<ExportProgress, 'jobId' | 'totalUs'>): void => {
      onProgress?.({ jobId, totalUs: plan.durationUs, ...progress })
    }
    let workspacePath: string | undefined
    try {
      for (const input of plan.inputs) {
        await assertInputFile(input.path)
        if (await tryStatSameFile(input.path, outputPath)) {
          throw new Error(`Output path cannot overwrite an input asset: ${basename(input.path)}`)
        }
      }
      emit({ stage: 'probing', ratio: 0, encodedUs: 0, message: '利用可能なエンコーダーを確認しています' })
      const report = await this.detectEncoders(false)
      const supportsFileOption = ffmpegSupportsFileBackedOptions(report.ffmpegVersion)
      const candidates = selectEncoderCandidates(report, settings.encoderMode, settings.preferredEncoderId)
      if (candidates.length === 0) throw new Error('利用可能なH.264エンコーダーがありません')
      workspacePath = join(this.workspaceRoot, `export-${jobId}`)
      await mkdir(dirname(outputPath), { recursive: true })
      await mkdir(workspacePath, { recursive: true })
      await writeFile(join(workspacePath, plan.assFileName), plan.ass, 'utf8')
      if (settings.exportSrt) await writeFile(join(workspacePath, 'captions.srt'), plan.srt, 'utf8')

      let fallbackReason: string | undefined
      const failures: string[] = []
      for (let index = 0; index < candidates.length; index += 1) {
        const encoderId = candidates[index]
        if (!encoderId) continue
        if (signal.aborted) throw new ProcessCancelledError()
        const temporaryPath = join(dirname(outputPath), `.${basename(outputPath, extname(outputPath))}.part-${jobId}-${index}.mp4`)
        const temporarySrtPath = join(dirname(outputPath), `.${basename(outputPath, extname(outputPath))}.part-${jobId}-${index}.srt`)
        const filterGraphPath = join(workspacePath, `render-${index}.ffgraph`)
        try {
          if (index > 0) {
            emit({
              stage: 'fallback',
              ratio: 0,
              encodedUs: 0,
              encoderId,
              fallbackReason,
              message: `${encoderId}で書き出しを再試行します`
            })
          }
          await probeEncoder(this.paths, encoderId, {
            executor: this.executor,
            width: plan.width,
            height: plan.height,
            vaapiDevice: this.vaapiDevice,
            signal
          })
          const graph = buildRenderFilterGraph(plan, encoderId)
          await writeFile(filterGraphPath, graph, 'utf8')
          let latestRatio = 0
          const consumeProgress = createFfmpegProgressParser(plan.durationUs, (encodedUs) => {
            const ratio = Math.max(latestRatio, Math.min(1, encodedUs / plan.durationUs))
            latestRatio = ratio
            emit({
              stage: 'rendering',
              ratio,
              encodedUs,
              encoderId,
              message: `${encoderId}で書き出しています`
            })
          })
          emit({
            stage: 'rendering',
            ratio: 0,
            encodedUs: 0,
            encoderId,
            ...(fallbackReason ? { fallbackReason } : {}),
            message: `${encoderId}で書き出しています`
          })
          await this.executor.run({
            command: this.paths.ffmpegPath,
            args: buildRenderCommandArgs(plan, {
              filterGraphPath,
              outputPath: temporaryPath,
              encoderId,
              videoBitrate: settings.videoBitrate,
              audioBitrate: settings.audioBitrate,
              vaapiDevice: this.vaapiDevice,
              supportsFileOption
            }),
            cwd: workspacePath,
            signal,
            timeoutMs: 7 * 24 * 60 * 60 * 1_000,
            onStdout: consumeProgress,
            maxOutputBytes: 64 * 1024 * 1024
          })
          emit({
            stage: 'validating',
            ratio: 1,
            encodedUs: plan.durationUs,
            encoderId,
            message: '書き出した動画を検証しています'
          })
          await validateRenderedOutput(this.paths, temporaryPath, {
            durationUs: plan.durationUs,
            width: plan.width,
            height: plan.height,
            requireAudio: true,
            frameDurationUs: frameDurationUs(plan)
          }, this.executor, signal)
          const sidecarPath = join(dirname(outputPath), `${basename(outputPath, extname(outputPath))}.srt`)
          if (settings.exportSrt && plan.srt.trim()) {
            // Detect permission/disk errors before replacing a valid existing video.
            await writeFile(temporarySrtPath, plan.srt, 'utf8')
          }
          await mkdir(dirname(outputPath), { recursive: true })
          await moveIntoPlace(temporaryPath, outputPath)
          if (settings.exportSrt && plan.srt.trim()) {
            await moveIntoPlace(temporarySrtPath, sidecarPath)
          }
          emit({
            stage: 'completed',
            ratio: 1,
            encodedUs: plan.durationUs,
            encoderId,
            ...(fallbackReason ? { fallbackReason } : {}),
            outputPath,
            message: '書き出しが完了しました'
          })
          return { jobId, outputPath, encoderId, ...(fallbackReason ? { fallbackReason } : {}) }
        } catch (error) {
          await Promise.all([
            rm(temporaryPath, { force: true }).catch(() => undefined),
            rm(temporarySrtPath, { force: true }).catch(() => undefined)
          ])
          if (error instanceof ProcessCancelledError || signal.aborted) throw new ProcessCancelledError()
          const reason = `${encoderId}: ${errorMessage(error)}`
          failures.push(reason)
          fallbackReason = reason
          if (isNonRetryableExportError(error)) throw error
          const nextEncoder = candidates[index + 1]
          if (!nextEncoder) throw new Error(`すべてのエンコーダーで書き出しに失敗しました: ${failures.join(' | ')}`)
        }
      }
      throw new Error('書き出しエンコーダーを選択できませんでした')
    } catch (error) {
      if (error instanceof ProcessCancelledError || signal.aborted) {
        emit({ stage: 'cancelled', ratio: 0, encodedUs: 0, message: '書き出しをキャンセルしました' })
        throw new ProcessCancelledError('Export was cancelled')
      }
      emit({
        stage: 'failed',
        ratio: 0,
        encodedUs: 0,
        message: '書き出しに失敗しました',
        error: errorMessage(error)
      })
      throw error
    } finally {
      if (workspacePath) await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export const createFfmpegService = async (options: FfmpegServiceOptions = {}): Promise<FfmpegService> => {
  const paths = options.paths ?? await resolveFfmpegPaths({
    ffmpegPath: options.ffmpegPath,
    ffprobePath: options.ffprobePath
  })
  return new FfmpegService(paths, options)
}
