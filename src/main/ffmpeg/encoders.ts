import { access } from 'node:fs/promises'
import type {
  EncoderCapability,
  EncoderMode,
  EncoderReport,
  EncoderVendor
} from '../../shared/types.js'
import type { FfmpegPaths } from './binaries.js'
import {
  CommandExecutionError,
  defaultProcessExecutor,
  type ProcessExecutor
} from './process.js'

export type H264EncoderId =
  | 'h264_nvenc'
  | 'h264_qsv'
  | 'h264_amf'
  | 'h264_videotoolbox'
  | 'h264_vaapi'
  | 'libx264'

interface EncoderDefinition {
  id: H264EncoderId
  name: string
  vendor: EncoderVendor
  hardware: boolean
  platforms: NodeJS.Platform[]
}

export const H264_ENCODERS: readonly EncoderDefinition[] = [
  { id: 'h264_nvenc', name: 'NVIDIA NVENC', vendor: 'nvidia', hardware: true, platforms: ['win32', 'linux'] },
  { id: 'h264_qsv', name: 'Intel Quick Sync', vendor: 'intel', hardware: true, platforms: ['win32', 'linux'] },
  { id: 'h264_amf', name: 'AMD AMF', vendor: 'amd', hardware: true, platforms: ['win32', 'linux'] },
  { id: 'h264_videotoolbox', name: 'Apple VideoToolbox', vendor: 'apple', hardware: true, platforms: ['darwin'] },
  { id: 'h264_vaapi', name: 'VAAPI', vendor: 'vaapi', hardware: true, platforms: ['linux'] },
  { id: 'libx264', name: 'CPU (libx264)', vendor: 'cpu', hardware: false, platforms: ['win32', 'linux', 'darwin'] }
] as const

export const parseEncoderNames = (text: string): Set<string> => {
  const names = new Set<string>()
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*[VAS\.][F\.][S\.][X\.][B\.][D\.]\s+(\S+)/u.exec(line)
    if (match?.[1]) names.add(match[1])
  }
  return names
}

const conciseFailure = (error: unknown): string => {
  const message = error instanceof CommandExecutionError
    ? error.result.stderr.trim() || error.result.stdout.trim()
    : error instanceof Error
      ? error.message
      : String(error)
  const lines = message.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  const useful = lines.find((line) => /cannot|failed|error|device|driver|unsupported|unavailable/iu.test(line))
    ?? lines.at(-1)
    ?? message
  return useful.slice(0, 500)
}

const findVaapiDevice = async (preferred?: string): Promise<string | null> => {
  const candidates = preferred ? [preferred] : ['/dev/dri/renderD128', '/dev/dri/renderD129']
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next common render node.
    }
  }
  return null
}

export interface EncoderProbeOptions {
  executor?: ProcessExecutor
  width?: number
  height?: number
  timeoutMs?: number
  vaapiDevice?: string
  signal?: AbortSignal
}

export const encoderGlobalInputArgs = (id: H264EncoderId, vaapiDevice?: string): string[] => {
  if (id === 'h264_vaapi') return ['-vaapi_device', vaapiDevice ?? '/dev/dri/renderD128']
  return []
}

export const encoderRequiresHardwareUpload = (id: H264EncoderId): boolean => id === 'h264_vaapi'

export const encoderPixelFormat = (id: H264EncoderId): 'nv12' | 'yuv420p' =>
  id === 'libx264' ? 'yuv420p' : 'nv12'

export const buildEncoderOutputArgs = (id: H264EncoderId, bitrate: number): string[] => {
  const target = String(Math.max(100_000, Math.round(bitrate)))
  const maxRate = String(Math.round(Math.max(100_000, bitrate) * 1.5))
  const bufferSize = String(Math.round(Math.max(100_000, bitrate) * 2))
  switch (id) {
    case 'h264_nvenc':
      return ['-c:v', id, '-preset', 'p5', '-b:v', target, '-maxrate', maxRate, '-bufsize', bufferSize]
    case 'h264_qsv':
      return ['-c:v', id, '-preset', 'medium', '-b:v', target, '-maxrate', maxRate, '-bufsize', bufferSize]
    case 'h264_amf':
      return ['-c:v', id, '-quality', 'quality', '-b:v', target, '-maxrate', maxRate, '-bufsize', bufferSize]
    case 'h264_videotoolbox':
      return ['-c:v', id, '-b:v', target]
    case 'h264_vaapi':
      return ['-c:v', id, '-b:v', target, '-maxrate', maxRate, '-bufsize', bufferSize]
    case 'libx264':
      return ['-c:v', id, '-preset', 'medium', '-crf', '20']
  }
}

export const probeEncoder = async (
  paths: FfmpegPaths,
  id: H264EncoderId,
  options: EncoderProbeOptions = {}
): Promise<void> => {
  const executor = options.executor ?? defaultProcessExecutor
  const width = Math.max(16, Math.round((options.width ?? 128) / 2) * 2)
  const height = Math.max(16, Math.round((options.height ?? 128) / 2) * 2)
  const vaapiDevice = id === 'h264_vaapi' ? await findVaapiDevice(options.vaapiDevice) : null
  if (id === 'h264_vaapi' && !vaapiDevice) throw new Error('No accessible VAAPI render device was found')
  const filter = id === 'h264_vaapi' ? 'format=nv12,hwupload' : `format=${encoderPixelFormat(id)}`
  await executor.run({
    command: paths.ffmpegPath,
    args: [
      '-hide_banner',
      '-loglevel',
      'error',
      ...encoderGlobalInputArgs(id, vaapiDevice ?? undefined),
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=${width}x${height}:r=30:d=0.1`,
      '-frames:v',
      '1',
      '-vf',
      filter,
      '-c:v',
      id,
      '-f',
      'null',
      '-'
    ],
    timeoutMs: options.timeoutMs ?? 15_000,
    signal: options.signal
  })
}

export interface EncoderDetectorOptions {
  executor?: ProcessExecutor
  platform?: NodeJS.Platform
  vaapiDevice?: string
}

export class EncoderDetector {
  readonly paths: FfmpegPaths
  readonly executor: ProcessExecutor
  readonly platform: NodeJS.Platform
  readonly vaapiDevice?: string
  #cached: EncoderReport | null = null

  constructor(paths: FfmpegPaths, options: EncoderDetectorOptions = {}) {
    this.paths = paths
    this.executor = options.executor ?? defaultProcessExecutor
    this.platform = options.platform ?? process.platform
    this.vaapiDevice = options.vaapiDevice
  }

  async detect(force = false): Promise<EncoderReport> {
    if (this.#cached && !force) return structuredClone(this.#cached)
    const [versionResult, encodersResult] = await Promise.all([
      this.executor.run({ command: this.paths.ffmpegPath, args: ['-hide_banner', '-version'], timeoutMs: 15_000 }),
      this.executor.run({ command: this.paths.ffmpegPath, args: ['-hide_banner', '-encoders'], timeoutMs: 15_000 })
    ])
    const compiled = parseEncoderNames(`${encodersResult.stdout}\n${encodersResult.stderr}`)
    const capabilities: EncoderCapability[] = []
    for (const definition of H264_ENCODERS) {
      let available = false
      let reason: string | undefined
      if (!definition.platforms.includes(this.platform)) {
        reason = `Not supported on ${this.platform}`
      } else if (!compiled.has(definition.id)) {
        reason = 'Encoder is not included in this FFmpeg build'
      } else {
        try {
          await probeEncoder(this.paths, definition.id, {
            executor: this.executor,
            vaapiDevice: this.vaapiDevice
          })
          available = true
        } catch (error) {
          reason = conciseFailure(error)
        }
      }
      capabilities.push({
        id: definition.id,
        name: definition.name,
        codec: 'h264',
        vendor: definition.vendor,
        hardware: definition.hardware,
        available,
        ...(reason ? { reason } : {})
      })
    }
    const selected = capabilities.find((capability) => capability.hardware && capability.available)
      ?? capabilities.find((capability) => capability.id === 'libx264' && capability.available)
    const versionLine = `${versionResult.stdout}\n${versionResult.stderr}`.split(/\r?\n/u).find(Boolean)
    this.#cached = {
      ffmpegPath: this.paths.ffmpegPath,
      ffmpegVersion: versionLine?.replace(/^ffmpeg version\s+/u, '') ?? null,
      platform: this.platform,
      capabilities,
      selectedId: selected?.id ?? null,
      checkedAt: new Date().toISOString()
    }
    return structuredClone(this.#cached)
  }
}

export const selectEncoderCandidates = (
  report: EncoderReport,
  mode: EncoderMode,
  preferredEncoderId?: string
): H264EncoderId[] => {
  const available = report.capabilities.filter((capability) => capability.available)
  const cpu = available.filter((capability) => capability.id === 'libx264')
  const hardware = available.filter((capability) => capability.hardware)
  const ordered = mode === 'software' ? cpu : [...hardware, ...cpu]
  if (preferredEncoderId && mode !== 'software') {
    ordered.sort((left, right) => Number(right.id === preferredEncoderId) - Number(left.id === preferredEncoderId))
  }
  return ordered.map((capability) => capability.id as H264EncoderId)
}
