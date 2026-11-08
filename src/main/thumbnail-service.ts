import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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

interface ThumbnailManifest {
  version: 1
  candidates: Array<{ id: string; timeUs: number; fileName: string }>
}

const MAX_CACHE_ENTRIES = 64

const seconds = (value: number): string => (value / 1_000_000).toFixed(6)

export class ThumbnailService {
  readonly paths: FfmpegPaths
  readonly executor: ProcessExecutor
  readonly cacheRoot: string
  readonly #cache = new Map<string, ThumbnailFrameCandidate[]>()
  readonly #inflight = new Map<string, Promise<ThumbnailFrameCandidate[]>>()
  #generation = 0

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
    const cached = this.#cache.get(key)
    if (cached) {
      this.#cache.delete(key)
      this.#cache.set(key, cached)
      return structuredClone(cached)
    }
    const running = this.#inflight.get(key)
    if (running) return structuredClone(await running)
    const generation = this.#generation
    const promise = this.#extractCandidates(request, key, directory, generation)
      .catch(async (error) => {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
        throw error
      })
      .then(async (candidates) => {
        if (generation === this.#generation) {
          this.#cache.delete(key)
          this.#cache.set(key, candidates)
          while (this.#cache.size > MAX_CACHE_ENTRIES) {
            const oldest = this.#cache.keys().next().value
            if (!oldest) break
            const oldCandidates = this.#cache.get(oldest)
            this.#cache.delete(oldest)
            const oldDirectory = oldCandidates?.[0] ? path.dirname(oldCandidates[0].framePath) : path.join(this.cacheRoot, oldest)
            await rm(oldDirectory, { recursive: true, force: true }).catch(() => undefined)
          }
        }
        return candidates
      })
      .finally(() => { if (this.#inflight.get(key) === promise) this.#inflight.delete(key) })
    this.#inflight.set(key, promise)
    return structuredClone(await promise)
  }

  async #extractCandidates(request: ExtractRequest, key: string, directory: string, generation: number): Promise<ThumbnailFrameCandidate[]> {
    const manifestPath = path.join(directory, 'manifest.json')
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ThumbnailManifest
      if (manifest.version !== 1 || !Array.isArray(manifest.candidates)) throw new Error('invalid thumbnail manifest')
      const candidates = manifest.candidates.map((candidate) => ({ ...candidate, framePath: path.join(directory, candidate.fileName) }))
      await Promise.all(candidates.map(async (candidate) => {
        const frame = await stat(candidate.framePath)
        if (!frame.isFile() || frame.size <= 0) throw new Error('thumbnail frame is incomplete')
      }))
      return candidates
    } catch {
      await rm(directory, { recursive: true, force: true })
    }
    if (generation !== this.#generation) throw new Error('Thumbnail cache was invalidated.')
    await mkdir(directory, { recursive: true })
    const candidates: ThumbnailFrameCandidate[] = []
    for (const [index, offsetUs] of thumbnailCandidateTimesUs(request.durationUs).entries()) {
      if (generation !== this.#generation) throw new Error('Thumbnail cache was invalidated.')
      const timeUs = request.sourceInUs + offsetUs
      const framePath = path.join(directory, `frame-${index + 1}.png`)
      const temporaryPath = path.join(directory, `.${index + 1}.${randomUUID()}.tmp.png`)
      await this.executor.run({
        command: this.paths.ffmpegPath,
        args: ['-hide_banner', '-loglevel', 'error', '-y', '-ss', seconds(timeUs), '-i', request.mediaPath, '-frames:v', '1', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black', '-f', 'image2', temporaryPath],
        timeoutMs: 60_000,
        maxOutputBytes: 8 * 1024 * 1024
      })
      try {
        const rendered = await stat(temporaryPath)
        if (!rendered.isFile() || rendered.size <= 0) throw new Error('thumbnail frame is incomplete')
        if (generation !== this.#generation) throw new Error('Thumbnail cache was invalidated.')
        await rename(temporaryPath, framePath)
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
      }
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
    if (generation !== this.#generation) throw new Error('Thumbnail cache was invalidated.')
    const manifest: ThumbnailManifest = {
      version: 1,
      candidates: candidates.map((candidate) => ({ id: candidate.id, timeUs: candidate.timeUs, fileName: path.basename(candidate.framePath) }))
    }
    const temporaryManifest = `${manifestPath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      if (generation !== this.#generation) throw new Error('Thumbnail cache was invalidated.')
      await rename(temporaryManifest, manifestPath)
    } finally {
      await rm(temporaryManifest, { force: true }).catch(() => undefined)
    }
    return candidates
  }

  async clearCache(): Promise<void> {
    this.#generation += 1
    this.#cache.clear()
    await rm(this.cacheRoot, { recursive: true, force: true })
  }
}
