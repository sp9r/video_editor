import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import type { WaveformRequest } from '../../shared/types.js'
import type { FfmpegPaths } from './binaries.js'
import { defaultProcessExecutor, type ProcessExecutor } from './process.js'

const MIN_PEAK_COUNT = 1
const MAX_PEAK_COUNT = 4096
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export interface WaveformCacheEntry {
  key: string
  promise: Promise<number[]>
}

const finite = (value: number): boolean => Number.isFinite(value)
const seconds = (timeUs: number): string => (Math.max(0, timeUs) / 1_000_000).toFixed(6)

export const waveformSampleRate = (durationUs: number, peakCount: number): number => {
  const durationSeconds = Math.max(0.001, durationUs / 1_000_000)
  const maxSamples = Math.floor(MAX_OUTPUT_BYTES / 4)
  // Keep enough bandwidth for ordinary speech/music while bounding the raw
  // PCM response. For extremely long ranges the rate is reduced further so
  // memory use remains bounded by MAX_OUTPUT_BYTES.
  const desiredRate = Math.max(1_000, Math.ceil((peakCount * 8) / durationSeconds))
  const boundedRate = Math.floor(maxSamples / durationSeconds)
  return Math.max(20, Math.min(8_000, desiredRate, boundedRate))
}

const validateRequest = (request: WaveformRequest): void => {
  if (!request || typeof request.mediaPath !== 'string' || !isAbsolute(request.mediaPath)) {
    throw new Error('Waveform media path must be absolute')
  }
  if (!finite(request.sourceInUs) || request.sourceInUs < 0) throw new Error('Waveform sourceInUs must be finite and non-negative')
  if (!finite(request.durationUs) || request.durationUs <= 0) throw new Error('Waveform durationUs must be finite and positive')
  if (!Number.isInteger(request.peakCount) || request.peakCount < MIN_PEAK_COUNT || request.peakCount > MAX_PEAK_COUNT) {
    throw new Error(`Waveform peakCount must be an integer between ${MIN_PEAK_COUNT} and ${MAX_PEAK_COUNT}`)
  }
}

const canonicalPath = (value: string): string => {
  const normalized = normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const makeCacheKey = (mediaPath: string, fileSize: number, modifiedAtMs: number, request: WaveformRequest): string =>
  [canonicalPath(mediaPath), fileSize, modifiedAtMs, request.sourceInUs, request.durationUs, request.peakCount].join('|')

export const peaksFromFloat32 = (bytes: Buffer, peakCount: number): number[] => {
  const sampleCount = Math.floor(bytes.byteLength / 4)
  if (sampleCount <= 0) return Array.from({ length: peakCount }, () => 0)
  const peaks = Array.from({ length: peakCount }, () => 0)
  for (let index = 0; index < peakCount; index += 1) {
    const from = Math.floor(sampleCount * index / peakCount)
    const to = Math.max(from + 1, Math.floor(sampleCount * (index + 1) / peakCount))
    let peak = 0
    for (let sample = from; sample < Math.min(to, sampleCount); sample += 1) {
      const value = Math.abs(bytes.readFloatLE(sample * 4))
      if (Number.isFinite(value)) peak = Math.max(peak, value)
    }
    peaks[index] = Math.min(1, peak)
  }
  return peaks
}

export class WaveformExtractor {
  readonly paths: FfmpegPaths
  readonly executor: ProcessExecutor
  readonly #cache = new Map<string, WaveformCacheEntry>()

  constructor(paths: FfmpegPaths, executor: ProcessExecutor = defaultProcessExecutor) {
    this.paths = paths
    this.executor = executor
  }

  get cacheSize(): number { return this.#cache.size }

  async getPeaks(request: WaveformRequest): Promise<number[]> {
    validateRequest(request)
    const resolvedPath = await realpath(request.mediaPath)
    const file = await stat(resolvedPath)
    if (!file.isFile()) throw new Error(`Waveform media path is not a regular file: ${request.mediaPath}`)
    const key = makeCacheKey(resolvedPath, file.size, file.mtimeMs, request)
    const cached = this.#cache.get(key)
    if (cached) return await cached.promise

    const promise = this.#decode(resolvedPath, request).catch((error) => {
      this.#cache.delete(key)
      throw error
    })
    this.#cache.set(key, { key, promise })
    return await promise
  }

  async #decode(mediaPath: string, request: WaveformRequest): Promise<number[]> {
    const sampleRate = waveformSampleRate(request.durationUs, request.peakCount)
    const chunks: Buffer[] = []
    await this.executor.run({
      command: this.paths.ffmpegPath,
      // -ss/-t before the input bounds the decode work to the requested range.
      args: [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-ss', seconds(request.sourceInUs),
        '-t', seconds(request.durationUs),
        '-i', mediaPath,
        '-map', '0:a:0',
        '-vn', '-ac', '1', '-ar', String(sampleRate),
        '-f', 'f32le', 'pipe:1'
      ],
      timeoutMs: 60_000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      onStdoutBytes: (chunk) => chunks.push(Buffer.from(chunk))
    })
    return peaksFromFloat32(Buffer.concat(chunks), request.peakCount)
  }
}
