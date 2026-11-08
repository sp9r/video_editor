import { extname, basename } from 'node:path'
import { stat } from 'node:fs/promises'
import type { ProbeResult, Rational } from '../../shared/types.js'
import type { FfmpegPaths } from './binaries.js'
import { defaultProcessExecutor, type ProcessExecutor } from './process.js'

interface FfprobeStream {
  codec_type?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  sample_rate?: string
  channels?: number
  duration?: string
  disposition?: { attached_pic?: number }
  color_space?: string
  color_range?: string
  tags?: { rotate?: string }
  side_data_list?: Array<{ rotation?: number }>
}

interface FfprobeDocument {
  streams?: FfprobeStream[]
  format?: { duration?: string }
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.avif'])
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.aiff', '.aif'])

const finiteNumber = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : undefined
}

export const parseRational = (value: string | undefined): Rational | undefined => {
  if (!value) return undefined
  const [numeratorText, denominatorText] = value.split('/')
  const numerator = Number.parseInt(numeratorText ?? '', 10)
  const denominator = Number.parseInt(denominatorText ?? '', 10)
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    return undefined
  }
  return { numerator, denominator }
}

export const parseFfprobeJson = (text: string): FfprobeDocument => {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object') throw new Error('ffprobe returned an invalid JSON document')
  return parsed as FfprobeDocument
}

const durationFromDocument = (document: FfprobeDocument): number => {
  const durations = [finiteNumber(document.format?.duration)]
  for (const stream of document.streams ?? []) durations.push(finiteNumber(stream.duration))
  const durationSeconds = Math.max(0, ...durations.filter((value): value is number => value !== undefined))
  return Math.round(durationSeconds * 1_000_000)
}

const detectKind = (path: string, document: FfprobeDocument): ProbeResult['kind'] => {
  const extension = extname(path).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  const streams = document.streams ?? []
  const video = streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
  if (video) return 'video'
  if (streams.some((stream) => stream.codec_type === 'audio') || AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (streams.some((stream) => stream.codec_type === 'video')) return 'image'
  throw new Error(`No supported audio or video stream was found in ${path}`)
}

/** Display rotation in degrees (0/90/180/270). FFmpeg and Chromium both autorotate, so sizes must follow it. */
const displayRotation = (stream: FfprobeStream | undefined): number => {
  const raw = stream?.side_data_list?.find((entry) => typeof entry.rotation === 'number')?.rotation ?? finiteNumber(stream?.tags?.rotate) ?? 0
  return ((Math.round(raw / 90) * 90) % 360 + 360) % 360
}

const colorFields = (video: FfprobeStream | undefined): { colorSpace?: string; colorRange?: 'tv' | 'pc' } => {
  const space = video?.color_space?.trim()
  const range = video?.color_range === 'pc' || video?.color_range === 'tv' ? video.color_range : undefined
  return {
    ...(space && space !== 'unknown' ? { colorSpace: space } : {}),
    ...(range ? { colorRange: range } : {})
  }
}

export interface ProbeMediaOptions {
  executor?: ProcessExecutor
}

export const probeMediaFile = async (
  paths: FfmpegPaths,
  mediaPath: string,
  options: ProbeMediaOptions = {}
): Promise<ProbeResult> => {
  const executor = options.executor ?? defaultProcessExecutor
  const [result, file] = await Promise.all([
    executor.run({
      command: paths.ffprobePath,
      args: ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', mediaPath],
      timeoutMs: 30_000
    }),
    stat(mediaPath)
  ])
  if (!file.isFile()) throw new Error(`Media path is not a regular file: ${mediaPath}`)
  const document = parseFfprobeJson(result.stdout)
  const streams = document.streams ?? []
  const video = streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1)
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  const kind = detectKind(mediaPath, document)
  const frameRate = parseRational(video?.avg_frame_rate) ?? parseRational(video?.r_frame_rate)
  const swapSides = displayRotation(video) % 180 === 90
  const width = swapSides ? video?.height : video?.width
  const height = swapSides ? video?.width : video?.height
  return {
    path: mediaPath,
    name: basename(mediaPath),
    kind,
    durationUs: kind === 'image' ? 0 : durationFromDocument(document),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(frameRate ? { frameRate } : {}),
    ...(kind === 'video' ? colorFields(video) : {}),
    ...(audio?.sample_rate ? { sampleRate: Number.parseInt(audio.sample_rate, 10) } : {}),
    ...(audio?.channels ? { channels: audio.channels } : {}),
    hasAudio: Boolean(audio),
    fileSize: file.size,
    modifiedAt: file.mtime.toISOString()
  }
}

export const probeMediaFileSafe = async (
  paths: FfmpegPaths,
  mediaPath: string,
  options: ProbeMediaOptions = {}
): Promise<ProbeResult> => {
  try {
    return await probeMediaFile(paths, mediaPath, options)
  } catch (error) {
    let fileSize = 0
    let modifiedAt = new Date(0).toISOString()
    try {
      const file = await stat(mediaPath)
      fileSize = file.size
      modifiedAt = file.mtime.toISOString()
    } catch {
      // The error field below is the useful result for missing paths.
    }
    const extension = extname(mediaPath).toLowerCase()
    const kind: ProbeResult['kind'] = IMAGE_EXTENSIONS.has(extension)
      ? 'image'
      : AUDIO_EXTENSIONS.has(extension)
        ? 'audio'
        : 'video'
    return {
      path: mediaPath,
      name: basename(mediaPath),
      kind,
      durationUs: 0,
      hasAudio: false,
      fileSize,
      modifiedAt,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export interface ValidationExpectation {
  durationUs: number
  width: number
  height: number
  requireAudio?: boolean
  frameDurationUs?: number
}

export interface OutputValidationResult {
  durationUs: number
  width: number
  height: number
  hasAudio: boolean
}

export const validateRenderedOutput = async (
  paths: FfmpegPaths,
  outputPath: string,
  expected: ValidationExpectation,
  executor: ProcessExecutor = defaultProcessExecutor,
  signal?: AbortSignal
): Promise<OutputValidationResult> => {
  const probe = await executor.run({
    command: paths.ffprobePath,
    args: ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', outputPath],
    timeoutMs: 30_000,
    signal
  })
  const document = parseFfprobeJson(probe.stdout)
  const video = (document.streams ?? []).find((stream) => stream.codec_type === 'video')
  const hasAudio = (document.streams ?? []).some((stream) => stream.codec_type === 'audio')
  const durationUs = durationFromDocument(document)
  if (!video?.width || !video.height) throw new Error('Rendered file has no decodable video stream')
  if (video.width !== expected.width || video.height !== expected.height) {
    throw new Error(`Rendered size is ${video.width}x${video.height}; expected ${expected.width}x${expected.height}`)
  }
  if (expected.requireAudio !== false && !hasAudio) throw new Error('Rendered file has no audio stream')
  const toleranceUs = Math.max(250_000, (expected.frameDurationUs ?? 33_334) * 3)
  if (Math.abs(durationUs - expected.durationUs) > toleranceUs) {
    throw new Error(`Rendered duration ${durationUs}us differs from expected ${expected.durationUs}us`)
  }

  const decodeFrame = async (seekSeconds?: number): Promise<void> => {
    const seekArgs = seekSeconds === undefined ? [] : ['-ss', seekSeconds.toFixed(6)]
    await executor.run({
      command: paths.ffmpegPath,
      args: ['-hide_banner', '-loglevel', 'error', ...seekArgs, '-i', outputPath, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'],
      timeoutMs: 30_000,
      signal
    })
  }
  await decodeFrame()
  await decodeFrame(Math.max(0, durationUs / 1_000_000 - 0.5))
  return { durationUs, width: video.width, height: video.height, hasAudio }
}
