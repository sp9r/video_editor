import { createHash } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FfmpegPaths } from './ffmpeg/binaries.js'
import { defaultProcessExecutor, type ProcessExecutor } from './ffmpeg/process.js'
import { isNearBlackLuma, thumbnailCandidateTimesUs, type ThumbnailFrameCandidate } from '../shared/thumbnail.js'

export interface ThumbnailServiceOptions {
  executor?: ProcessExecutor
  cacheRoot: string
}

interface ExtractRequest {
  mediaPath: string
  sourceInUs: number
  durationUs: number
}

const seconds = (value: number): string => (value / 1_000_000).toFixed(6)

export class ThumbnailService {
  readonly paths: FfmpegPaths
  readonly executor: ProcessExecutor
  readonly cacheRoot: string

  constructor(paths: FfmpegPaths, options: ThumbnailServiceOptions) {
    this.paths = paths
    this.executor = options.executor ?? defaultProcessExecutor
    this.cacheRoot = path.resolve(options.cacheRoot)
  }

  async extractCandidates(request: ExtractRequest): Promise<ThumbnailFrameCandidate[]> {
    if (!path.isAbsolute(request.mediaPath)) throw new Error('thumbnail media path must be absolute')
    if (!Number.isSafeInteger(request.sourceInUs) || !Number.isSafeInteger(request.durationUs) || request.durationUs <= 0) throw new Error('thumbnail source range is invalid')
    const info = await stat(request.mediaPath)
    const key = createHash('sha256').update(`${request.mediaPath}|${info.size}|${info.mtimeMs}|${request.sourceInUs}|${request.durationUs}`).digest('hex').slice(0, 24)
    const directory = path.join(this.cacheRoot, key)
    await mkdir(directory, { recursive: true })
    const candidates: ThumbnailFrameCandidate[] = []
    for (const [index, offsetUs] of thumbnailCandidateTimesUs(request.durationUs).entries()) {
      const timeUs = request.sourceInUs + offsetUs
      const framePath = path.join(directory, `frame-${index + 1}.png`)
      await this.executor.run({
        command: this.paths.ffmpegPath,
        args: ['-hide_banner', '-loglevel', 'error', '-y', '-ss', seconds(timeUs), '-i', request.mediaPath, '-frames:v', '1', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black', '-f', 'image2', framePath],
        timeoutMs: 60_000,
        maxOutputBytes: 8 * 1024 * 1024
      })
      const luminance = await this.executor.run({
        command: this.paths.ffmpegPath,
        args: ['-hide_banner', '-loglevel', 'info', '-i', framePath, '-vf', 'scale=1:1,format=gray,signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-'],
        timeoutMs: 30_000,
        maxOutputBytes: 2 * 1024 * 1024
      })
      const values = [...`${luminance.stdout}\n${luminance.stderr}`.matchAll(/YAVG[=:]([0-9]+(?:\.[0-9]+)?)/gu)].map((match) => Number(match[1]))
      if (values.length > 0 && isNearBlackLuma(values)) continue
      candidates.push({ id: `thumbnail-${key}-${index + 1}`, timeUs, framePath })
    }
    return candidates
  }

  async clearCache(): Promise<void> {
    await rm(this.cacheRoot, { recursive: true, force: true })
  }
}
