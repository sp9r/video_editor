import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  EncoderReport,
  AccuratePreviewFrameResult,
  SubtitleOverlayResult,
  SubtitleOverlaySequenceResult,
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
import { QueuedProcessExecutor } from './process-queue.js'
import { defaultProcessExecutor, ProcessCancelledError, type ProcessExecutor } from './process.js'
import { probeMediaFile, probeMediaFileSafe, validateRenderedOutput } from './probe.js'
import {
  buildRenderCommandArgs,
  buildAccurateFrameFilterGraph,
  buildRenderFilterGraph,
  createRenderPlan,
  ffmpegSupportsFileBackedOptions,
  type RenderPlan
} from './render-plan.js'
import { generateAss, generateSrt, generateSubtitleSlotAss } from './subtitles.js'
import { WaveformExtractor } from './waveform.js'
import { ExportPublishError, publishExportOutputs } from './export-publish.js'
import type { WaveformRequest } from '../../shared/types.js'
import { frameIndexForTime, timeUsForFrameIndex } from '../../shared/frame-time.js'
import { subtitleFrameImageIdentity } from '../../shared/subtitle-render.js'
import { frameIndexAtOrBeforeUs } from '../../shared/subtitle-timing.js'
import { projectFingerprint } from '../../shared/project.js'

export interface FfmpegServiceOptions {
  ffmpegPath?: string | null
  ffprobePath?: string | null
  executor?: ProcessExecutor
  platform?: NodeJS.Platform
  workspaceRoot?: string
  vaapiDevice?: string
  paths?: FfmpegPaths
  /** Overrides the subtitle overlay cache bounds (tests). */
  subtitleOverlayCacheLimits?: { entries?: number; bytes?: number }
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

export interface AccurateFrameOptions {
  width?: number
  height?: number
  signal?: AbortSignal
}

export interface SubtitleOverlayOptions {
  signal?: AbortSignal
  animationMode?: 'full' | 'base'
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

const subtitleOverlayRendererVersion = 'preview-parity-3'

/**
 * Identity of one overlay image. The visual state plus the animation phase
 * (see subtitleFrameImageIdentity) fully determines the pixels, so static
 * frames of the same cue state share one file and a cue moved on the timeline
 * keeps its images.
 */
const subtitleOverlayCacheKey = (
  project: ProjectFile,
  fps: { numerator: number; denominator: number },
  imageIdentity: string,
  base: boolean
): string => createHash('sha256').update(JSON.stringify({
  rendererVersion: subtitleOverlayRendererVersion,
  width: Math.max(16, Math.round(project.sequence.width)),
  height: Math.max(16, Math.round(project.sequence.height)),
  fps,
  imageIdentity,
  base
})).digest('hex')

/** Lookup table N -> value as a balanced `if(lt(N,k),..)` tree for setpts. */
const lookupExpression = (values: readonly number[], low = 0, high = values.length): string => {
  if (high - low <= 1) return String(values[low] ?? 0)
  const middle = Math.floor((low + high) / 2)
  return `if(lt(N,${middle}),${lookupExpression(values, low, middle)},${lookupExpression(values, middle, high)})`
}

/**
 * Straight-alpha libass images for several independent frames at once: frame
 * i of the source is stamped with presentationMs[i] (a millisecond clock) and
 * drawn by one `ass` instance per colour, so a whole batch costs one FFmpeg
 * start and one font load. libass is run over opaque black and opaque white,
 * exactly as in the burn-in: alpha = 1 - (white - black) / 255 and colour =
 * black / alpha. Running `ass` over a transparent canvas instead squares every
 * partial alpha (a 15% box becomes 2%), so cue backgrounds and soft edges
 * would not match Final.
 */
const subtitleSlotGraph = (
  width: number,
  height: number,
  presentationMs: readonly number[],
  assFileName: string
): string => {
  const duration = (presentationMs.length / 1000 + 0.0005).toFixed(4)
  const stamp = `setpts='${lookupExpression(presentationMs)}'`
  const render = (colour: string): string =>
    `color=c=${colour}:s=${width}x${height}:r=1000:d=${duration},format=rgba,${stamp},ass=filename='${assFileName}',setpts=N`
  return [
    `${render('black')},split[rb1][rb2]`,
    `${render('white')}[rw]`,
    '[rw][rb1]blend=all_mode=subtract,negate,format=gray,split[al1][al2]',
    '[rb2]format=gbrp[rbp]',
    '[rbp][al1]unpremultiply,format=rgb24[st]',
    '[st][al2]alphamerge,format=rgba[vout]'
  ].join(';\n')
}

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

/** ~300 cues with intro/outro animation frames fit; disk use is bounded by bytes as well. */
const MAX_SUBTITLE_OVERLAY_CACHE_ENTRIES = 1500
const MAX_SUBTITLE_OVERLAY_CACHE_BYTES = 384 * 1024 * 1024
/** Images drawn by one FFmpeg process; keeps a batch short so playhead-near work is not queued behind far work. */
const SUBTITLE_SLOTS_PER_PROCESS = 48

const trimSubtitleOverlayDiskCache = async (directory: string, maximum = MAX_SUBTITLE_OVERLAY_CACHE_ENTRIES, maximumBytes = MAX_SUBTITLE_OVERLAY_CACHE_BYTES): Promise<number> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = (await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map(async (entry) => {
      const path = join(directory, entry.name)
      try {
        const file = await stat(path)
        return { path, modifiedAt: file.mtimeMs, size: file.size }
      } catch {
        return null
      }
    }))).filter((entry): entry is { path: string; modifiedAt: number; size: number } => entry !== null)
  files.sort((left, right) => left.modifiedAt - right.modifiedAt)
  let totalBytes = files.reduce((total, entry) => total + (entry.size ?? 0), 0)
  const remove: typeof files = []
  while (files.length - remove.length > maximum || totalBytes > maximumBytes) {
    const entry = files[remove.length]
    if (!entry) break
    remove.push(entry)
    totalBytes -= entry.size ?? 0
  }
  await Promise.all(remove.map((entry) => rm(entry.path, { force: true })))
  return Math.max(0, totalBytes)
}

const assertInputFile = async (path: string): Promise<void> => {
  const file = await stat(path)
  if (!file.isFile()) throw new Error(`Input asset is not a regular file: ${path}`)
}

const isNonRetryableExportError = (error: unknown): boolean => {
  if (error instanceof ExportPublishError) return true
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

const assertSubtitleBurnInGraph = (plan: RenderPlan, graph: string): void => {
  if (!plan.burnSubtitles || plan.subtitleCueCount === 0) return
  if (!graph.includes(`ass=filename='${plan.assFileName}'`)) {
    throw new Error('Subtitle burn-in is enabled but the render graph has no ASS filter')
  }
}

const mediaFingerprint = async (project: ProjectFile): Promise<string> => {
  const entries = await Promise.all(project.media.map(async (asset) => {
    try {
      const metadata = await stat(asset.path)
      return [asset.id, asset.path, metadata.size, metadata.mtimeMs] as const
    } catch {
      return [asset.id, asset.path, 'missing'] as const
    }
  }))
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
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
  readonly #reservedOutputPaths = new Set<string>()
  readonly #caseInsensitiveOutputPaths: boolean
  readonly #accurateFrames = new Map<string, Promise<AccuratePreviewFrameResult> | AccuratePreviewFrameResult>()
  readonly #subtitleOverlays = new Map<string, Promise<SubtitleOverlayResult> | SubtitleOverlayResult>()
  readonly #accurateInFlight = new Set<Promise<AccuratePreviewFrameResult>>()
  readonly #subtitleInFlight = new Map<string, Promise<void>>()
  #subtitleDecision: Promise<void> = Promise.resolve()
  readonly #subtitleCacheEntries: number
  readonly #subtitleCacheBytes: number
  #subtitleOverlayCacheBytes = 0
  #accuratePreviewGeneration = 0
  #accuratePreviewCleanup: Promise<void> | null = null

  constructor(paths: FfmpegPaths, options: Omit<FfmpegServiceOptions, 'paths' | 'ffmpegPath' | 'ffprobePath'> = {}) {
    this.paths = paths
    this.#subtitleCacheEntries = options.subtitleOverlayCacheLimits?.entries ?? MAX_SUBTITLE_OVERLAY_CACHE_ENTRIES
    this.#subtitleCacheBytes = options.subtitleOverlayCacheLimits?.bytes ?? MAX_SUBTITLE_OVERLAY_CACHE_BYTES
    this.#caseInsensitiveOutputPaths = (options.platform ?? process.platform) === 'win32'
    // Thumbnails, waveforms and background subtitle images share a bounded number of FFmpeg processes.
    this.executor = new QueuedProcessExecutor(options.executor ?? defaultProcessExecutor)
    this.workspaceRoot = resolve(options.workspaceRoot ?? join(tmpdir(), 'cutline'))
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

  /** Test/smoke-only reset for the bounded subtitle overlay workspace. */
  async clearSubtitleOverlayCache(): Promise<void> {
    this.#subtitleOverlays.clear()
    this.#subtitleOverlayCacheBytes = 0
    await rm(join(this.workspaceRoot, 'subtitle-overlay'), { recursive: true, force: true })
  }

  async clearAccuratePreviewCache(): Promise<void> {
    this.#accuratePreviewGeneration += 1
    const inFlight = [...this.#accurateInFlight]
    this.#accurateFrames.clear()
    if (inFlight.length) {
      this.#accuratePreviewCleanup = Promise.allSettled(inFlight)
        .then(() => rm(join(this.workspaceRoot, 'accurate-preview'), { recursive: true, force: true }).catch(() => undefined))
      return
    }
    await rm(join(this.workspaceRoot, 'accurate-preview'), { recursive: true, force: true })
  }

  get subtitleOverlayCacheSize(): number {
    return this.#subtitleOverlays.size
  }

  get subtitleOverlayCacheBytes(): number {
    return this.#subtitleOverlayCacheBytes
  }

  async renderAccurateFrame(
    project: ProjectFile,
    requestedTimeUs: number,
    options: AccurateFrameOptions = {}
  ): Promise<AccuratePreviewFrameResult> {
    if (!Number.isFinite(requestedTimeUs) || requestedTimeUs < 0) throw new Error('Accurate preview time must be a finite non-negative number')
    const generation = this.#accuratePreviewGeneration
    const cleanup = this.#accuratePreviewCleanup
    if (cleanup) {
      await cleanup
      if (this.#accuratePreviewCleanup === cleanup) this.#accuratePreviewCleanup = null
    }
    const settings: ExportSettings = {
      outputPath: join(this.workspaceRoot, 'accurate-preview-placeholder.mp4'),
      width: options.width ?? project.sequence.width,
      height: options.height ?? project.sequence.height,
      frameRate: project.sequence.frameRate,
      videoBitrate: 2_000_000,
      audioBitrate: 128_000,
      encoderMode: 'software',
      burnSubtitles: true,
      exportSrt: false
    }
    const plan = createRenderPlan(project, settings)
    const fps = { numerator: plan.frameRateNumerator, denominator: plan.frameRateDenominator }
    const boundedTimeUs = Math.min(requestedTimeUs, Math.max(0, plan.durationUs - 1))
    const frameIndex = frameIndexForTime(boundedTimeUs, fps)
    const renderedTimeUs = timeUsForFrameIndex(frameIndex, fps)
    const fingerprint = projectFingerprint(project)
    const mediaHash = await mediaFingerprint(project)
    if (generation !== this.#accuratePreviewGeneration) throw new Error('Accurate preview was invalidated by a project change.')
    const cacheKey = createHash('sha256').update(JSON.stringify({
      fingerprint,
      mediaHash,
      frameIndex,
      width: plan.width,
      height: plan.height,
      fps
    })).digest('hex')
    const cached = this.#accurateFrames.get(cacheKey)
    if (cached) {
      const cachedFrame = await cached
      return { ...cachedFrame, requestedTimeUs, cacheHit: true, ffmpegStarted: false }
    }
    // Start a few frames early so every clip reaches the target on its own grid.
    const startFrame = Math.max(0, frameIndex - 2)
    const windowPlan = createRenderPlan(project, settings, { window: { startFrame, frameCount: frameIndex - startFrame + 1 } })
    const promise = this.#renderAccurateFrame(windowPlan, cacheKey, {
      windowFrameIndex: frameIndex - startFrame,
      requestedTimeUs,
      renderedTimeUs,
      frameIndex,
      projectFingerprint: fingerprint,
      generation,
      signal: options.signal
    })
    this.#accurateInFlight.add(promise)
    void promise.then(() => this.#accurateInFlight.delete(promise), () => this.#accurateInFlight.delete(promise))
    this.#accurateFrames.set(cacheKey, promise)
    while (this.#accurateFrames.size > 64) {
      const oldest = this.#accurateFrames.keys().next().value
      if (!oldest || oldest === cacheKey) break
      const evicted = this.#accurateFrames.get(oldest)
      this.#accurateFrames.delete(oldest)
      void Promise.resolve(evicted).then((result) => result ? rm(result.framePath, { force: true }) : undefined).catch(() => undefined)
    }
    try {
      const rendered = await promise
      return { ...rendered, cacheHit: rendered.ffmpegStarted === false }
    } catch (error) {
      if (this.#accurateFrames.get(cacheKey) === promise) this.#accurateFrames.delete(cacheKey)
      throw error
    }
  }

  async renderSubtitleOverlay(
    project: ProjectFile,
    requestedTimeUs: number,
    options: SubtitleOverlayOptions = {}
  ): Promise<SubtitleOverlayResult> {
    if (!Number.isFinite(requestedTimeUs) || requestedTimeUs < 0) throw new Error('Subtitle overlay time must be a finite non-negative number')
    const frameIndex = frameIndexAtOrBeforeUs(requestedTimeUs, project.sequence.frameRate)
    const result = await this.renderSubtitleFrames(project, [frameIndex], { signal: options.signal, base: options.animationMode === 'base' })
    const frame = result.frames[0]
    if (!frame) throw new Error('Subtitle overlay renderer returned no frame')
    return { ...frame, cacheHit: result.ffmpegStarted === false, ffmpegStarted: result.ffmpegStarted === true }
  }

  /** Exact libass images for a run of consecutive frames (see renderSubtitleFrames). */
  async renderSubtitleOverlaySequence(
    project: ProjectFile,
    startFrame: number,
    frameCount: number,
    options: { signal?: AbortSignal } = {}
  ): Promise<SubtitleOverlaySequenceResult> {
    if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 240) {
      throw new Error('Subtitle overlay sequence range is invalid')
    }
    return await this.renderSubtitleFrames(project, Array.from({ length: frameCount }, (_, offset) => startFrame + offset), options)
  }

  /**
   * Exact libass images of arbitrary frames, one FFmpeg process per batch of
   * up to SUBTITLE_SLOTS_PER_PROCESS missing images. Images are cached by
   * visual state and animation phase, so frames that share a look share a
   * file, and results come back in request order.
   */
  async renderSubtitleFrames(
    project: ProjectFile,
    frameIndices: readonly number[],
    options: { signal?: AbortSignal; base?: boolean; urgent?: boolean } = {}
  ): Promise<SubtitleOverlaySequenceResult> {
    if (frameIndices.length < 1 || frameIndices.length > 512 || frameIndices.some((frame) => !Number.isSafeInteger(frame) || frame < 0)) {
      throw new Error('Subtitle overlay frame list is invalid')
    }
    const base = options.base === true
    const fps = {
      numerator: Math.max(1, Math.round(project.sequence.frameRate.numerator)),
      denominator: Math.max(1, Math.round(project.sequence.frameRate.denominator))
    }
    const entries = frameIndices.map((frameIndex) => {
      const identity = subtitleFrameImageIdentity(project, frameIndex)
      const subtitleStateFingerprint = createHash('sha256').update(identity.state).digest('hex')
      return { frameIndex, subtitleStateFingerprint, cacheKey: subtitleOverlayCacheKey(project, fps, base ? identity.state : identity.image, base) }
    })
    const directory = join(this.workspaceRoot, 'subtitle-overlay')
    const pathOf = (cacheKey: string): string => join(directory, `${cacheKey}.png`)
    // Deciding what is missing and claiming it must not interleave with another caller.
    const decision = this.#subtitleDecision.then(async () => {
      await mkdir(directory, { recursive: true })
      const missing = new Map<string, number>()
      const waiting: Array<Promise<void>> = []
      for (const entry of entries) {
        if (missing.has(entry.cacheKey)) continue
        const inFlight = this.#subtitleInFlight.get(entry.cacheKey)
        if (inFlight) {
          waiting.push(inFlight)
          continue
        }
        const onDisk = await stat(pathOf(entry.cacheKey)).then((file) => file.isFile() && file.size > 0, () => false)
        if (onDisk) {
          void utimes(pathOf(entry.cacheKey), new Date(), new Date()).catch(() => undefined)
          continue
        }
        missing.set(entry.cacheKey, entry.frameIndex)
      }
      let run: Promise<void> | null = null
      if (missing.size > 0) {
        const todo = [...missing].map(([cacheKey, frameIndex]) => ({ cacheKey, frameIndex }))
        run = (async (): Promise<void> => {
          for (let offset = 0; offset < todo.length; offset += SUBTITLE_SLOTS_PER_PROCESS) {
            await this.#renderSubtitleSlots(project, todo.slice(offset, offset + SUBTITLE_SLOTS_PER_PROCESS), base, directory, options.signal, options.urgent === true)
          }
        })()
        const shared = run.then(() => undefined, () => undefined)
        for (const { cacheKey } of todo) {
          this.#subtitleInFlight.set(cacheKey, shared)
          void shared.then(() => { if (this.#subtitleInFlight.get(cacheKey) === shared) this.#subtitleInFlight.delete(cacheKey) })
        }
      }
      return { run, waiting }
    })
    this.#subtitleDecision = decision.then(() => undefined, () => undefined)
    const { run, waiting } = await decision
    const ffmpegStarted = run !== null
    if (run) {
      await run
      this.#subtitleOverlayCacheBytes = await trimSubtitleOverlayDiskCache(directory, this.#subtitleCacheEntries, this.#subtitleCacheBytes)
    }
    await Promise.all(waiting)
    const frames: SubtitleOverlaySequenceResult['frames'] = []
    for (const entry of entries) {
      const framePath = pathOf(entry.cacheKey)
      const info = await stat(framePath).catch(() => null)
      if (!info?.isFile() || info.size === 0) throw new Error('Subtitle overlay renderer produced no image')
      frames.push({ frameIndex: entry.frameIndex, framePath, subtitleStateFingerprint: entry.subtitleStateFingerprint })
      this.#subtitleOverlays.delete(entry.cacheKey)
      this.#subtitleOverlays.set(entry.cacheKey, { framePath, frameIndex: entry.frameIndex, subtitleStateFingerprint: entry.subtitleStateFingerprint, ffmpegStarted: false })
    }
    while (this.#subtitleOverlays.size > this.#subtitleCacheEntries) {
      const oldest = this.#subtitleOverlays.keys().next().value
      if (oldest === undefined) break
      this.#subtitleOverlays.delete(oldest)
    }
    return { frames, ffmpegStarted }
  }

  async #renderSubtitleSlots(
    project: ProjectFile,
    slots: Array<{ cacheKey: string; frameIndex: number }>,
    base: boolean,
    directory: string,
    signal?: AbortSignal,
    urgent = false
  ): Promise<void> {
    const token = randomUUID()
    const batchDirectory = join(directory, `.slots-${token}`)
    await mkdir(batchDirectory, { recursive: true })
    const assFileName = `${token}.ass`
    const width = Math.max(16, Math.round(project.sequence.width))
    const height = Math.max(16, Math.round(project.sequence.height))
    try {
      const { ass, presentationMs } = generateSubtitleSlotAss(project, slots.map((slot) => ({ frameIndex: slot.frameIndex, base })))
      const filterGraphPath = join(batchDirectory, 'graph.ffgraph')
      await Promise.all([
        writeFile(filterGraphPath, subtitleSlotGraph(width, height, presentationMs, assFileName), 'utf8'),
        writeFile(join(batchDirectory, assFileName), ass, 'utf8')
      ])
      await this.executor.run({
        command: this.paths.ffmpegPath,
        args: ['-hide_banner', '-y', '-loglevel', 'warning', '-filter_complex_script', filterGraphPath, '-map', '[vout]', '-frames:v', String(slots.length), '-an', '-c:v', 'png', '-pix_fmt', 'rgba', '-fps_mode', 'passthrough', '-f', 'image2', join(batchDirectory, 'f%05d.png')],
        cwd: batchDirectory,
        signal,
        priority: urgent ? 'high' : 'normal',
        lowOsPriority: false,
        timeoutMs: 120_000,
        maxOutputBytes: 32 * 1024 * 1024
      })
      for (const [offset, slot] of slots.entries()) {
        const produced = join(batchDirectory, `f${String(offset + 1).padStart(5, '0')}.png`)
        const info = await stat(produced)
        if (!info.isFile() || info.size === 0) throw new Error('Subtitle overlay renderer produced an empty frame')
        await moveIntoPlace(produced, join(directory, `${slot.cacheKey}.png`))
      }
    } finally {
      await rm(batchDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async #renderAccurateFrame(
    plan: RenderPlan,
    cacheKey: string,
    { windowFrameIndex, ...metadata }: Omit<AccuratePreviewFrameResult, 'framePath'> & { generation: number; signal?: AbortSignal; windowFrameIndex: number }
  ): Promise<AccuratePreviewFrameResult> {
    const directory = join(this.workspaceRoot, 'accurate-preview')
    const outputPath = join(directory, `${cacheKey}.png`)
    let existingFrame: Awaited<ReturnType<typeof stat>> | null = null
    try {
      existingFrame = await stat(outputPath)
    } catch {
      // The bounded cache is best effort; render a missing or invalid entry again.
    }
    if (existingFrame?.isFile() && existingFrame.size > 0) {
      if (metadata.generation !== this.#accuratePreviewGeneration) throw new Error('Accurate preview was invalidated by a project change.')
      return { framePath: outputPath, ...metadata, ffmpegStarted: false }
    }
    await mkdir(directory, { recursive: true })
    const token = randomUUID()
    const temporaryPath = join(directory, `.${cacheKey}.${token}.png`)
    const filterGraphPath = join(directory, `.${cacheKey}.${token}.ffgraph`)
    const assFileName = `${cacheKey}.ass`
    const assPath = join(directory, assFileName)
    try {
      await Promise.all([
        writeFile(filterGraphPath, buildAccurateFrameFilterGraph(plan, windowFrameIndex, assFileName), 'utf8'),
        writeFile(assPath, plan.ass, 'utf8')
      ])
      await this.executor.run({
        command: this.paths.ffmpegPath,
        args: [
          '-hide_banner',
          '-y',
          '-loglevel',
          'warning',
          ...plan.inputArgs,
          '-filter_complex_script',
          filterGraphPath,
          '-map',
          '[vout]',
          '-frames:v',
          '1',
          '-an',
          '-c:v',
          'png',
          '-f',
          'image2',
          temporaryPath
        ],
        cwd: directory,
        signal: metadata.signal,
        timeoutMs: 120_000,
        maxOutputBytes: 32 * 1024 * 1024
      })
      const rendered = await stat(temporaryPath)
      if (!rendered.isFile() || rendered.size === 0) throw new Error('Accurate preview renderer produced an empty frame')
      if (metadata.generation !== this.#accuratePreviewGeneration) throw new Error('Accurate preview was invalidated by a project change.')
      await moveIntoPlace(temporaryPath, outputPath)
      if (metadata.generation !== this.#accuratePreviewGeneration) {
        await rm(outputPath, { force: true })
        throw new Error('Accurate preview was invalidated by a project change.')
      }
      return { framePath: outputPath, ...metadata, ffmpegStarted: true }
    } finally {
      await Promise.all([
        rm(temporaryPath, { force: true }).catch(() => undefined),
        rm(filterGraphPath, { force: true }).catch(() => undefined),
        rm(assPath, { force: true }).catch(() => undefined)
      ])
      if (metadata.generation !== this.#accuratePreviewGeneration) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  createRenderPlan(project: ProjectFile, settings: ExportSettings): RenderPlan {
    return createRenderPlan(project, settings)
  }

  #reserveOutputPaths(paths: string[]): string[] {
    const keys = paths.map((path) => {
      const absolute = resolve(path)
      return this.#caseInsensitiveOutputPaths ? absolute.toLowerCase() : absolute
    })
    const conflict = keys.find((key) => this.#reservedOutputPaths.has(key))
    if (conflict) throw new Error(`Export output already in use: ${conflict}`)
    for (const key of keys) this.#reservedOutputPaths.add(key)
    return keys
  }

  async writeSrt(project: ProjectFile, outputPath: string): Promise<void> {
    const reserved = this.#reserveOutputPaths([outputPath])
    try {
      await mkdir(dirname(resolve(outputPath)), { recursive: true })
      await writeFile(resolve(outputPath), generateSrt(project), 'utf8')
    } finally {
      for (const key of reserved) this.#reservedOutputPaths.delete(key)
    }
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
    const sidecarPath = join(dirname(outputPath), `${basename(outputPath, extname(outputPath))}.srt`)
    const reserved = this.#reserveOutputPaths([outputPath, ...(settings.exportSrt ? [sidecarPath] : [])])
    const controller = new AbortController()
    this.#jobs.set(jobId, { controller })
    const result = this.#runExport(jobId, project, { ...settings, outputPath }, controller.signal, options.onProgress)
      .finally(() => {
        this.#jobs.delete(jobId)
        for (const key of reserved) this.#reservedOutputPaths.delete(key)
      })
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
      const debugArtifacts = process.env.SPECTRA_KEEP_EXPORT_DEBUG === '1'
      if (debugArtifacts) {
        const debugSettings = {
          ...settings,
          burnSubtitles: plan.burnSubtitles,
          subtitleCueCount: plan.subtitleCueCount,
          subtitleIds: plan.subtitleIds,
          assFileName: plan.assFileName,
          assFilterExpected: plan.burnSubtitles && plan.subtitleCueCount > 0
        }
        await Promise.all([
          writeFile(join(workspacePath, 'project-snapshot.json'), JSON.stringify(project, null, 2), 'utf8'),
          writeFile(join(workspacePath, 'export-settings.json'), JSON.stringify(debugSettings, null, 2), 'utf8'),
          writeFile(join(workspacePath, 'render.ffgraph'), buildRenderFilterGraph(plan, 'libx264'), 'utf8')
        ])
      }

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
          assertSubtitleBurnInGraph(plan, graph)
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
          if (settings.exportSrt) {
            // Detect permission/disk errors before replacing a valid existing video.
            await writeFile(temporarySrtPath, plan.srt, 'utf8')
          }
          await mkdir(dirname(outputPath), { recursive: true })
          await publishExportOutputs({
            temporaryPath,
            outputPath,
            ...(settings.exportSrt ? { temporarySrtPath, sidecarPath } : {})
          })
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
          if (!(error instanceof ExportPublishError) && (error instanceof ProcessCancelledError || signal.aborted)) throw new ProcessCancelledError()
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
      if (!(error instanceof ExportPublishError) && (error instanceof ProcessCancelledError || signal.aborted)) {
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
      if (workspacePath && process.env.SPECTRA_KEEP_EXPORT_DEBUG !== '1') {
        await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined)
      }
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
