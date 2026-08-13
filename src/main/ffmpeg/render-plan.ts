import { isAbsolute } from 'node:path'
import type {
  AudioSettings,
  ExportSettings,
  MediaAsset,
  ProjectFile,
  TimelineClip,
  TransformSettings
} from '../../shared/types.js'
import {
  buildEncoderOutputArgs,
  encoderGlobalInputArgs,
  encoderPixelFormat,
  encoderRequiresHardwareUpload,
  type H264EncoderId
} from './encoders.js'
import { generateAss, generateSrt } from './subtitles.js'

export interface RenderInput {
  index: number
  clipId: string
  assetId: string
  path: string
  inputArgs: string[]
  useVideo: boolean
  useAudio: boolean
}

export interface RenderPlan {
  durationUs: number
  width: number
  height: number
  frameRateNumerator: number
  frameRateDenominator: number
  sampleRate: number
  inputs: RenderInput[]
  inputArgs: string[]
  graphStatements: string[]
  compositedVideoLabel: string
  audioOutputLabel: string
  filterGraph: string
  ass: string
  srt: string
  burnSubtitles: boolean
  assFileName: string
}

export interface RenderCommandOptions {
  filterGraphPath: string
  outputPath: string
  encoderId: H264EncoderId
  videoBitrate: number
  audioBitrate: number
  vaapiDevice?: string
  supportsFileOption?: boolean
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum))

const even = (value: number): number => Math.max(16, Math.floor(value / 2) * 2)
const seconds = (timeUs: number): string => (Math.max(0, timeUs) / 1_000_000).toFixed(6)
const fpsText = (numerator: number, denominator: number): string => `${numerator}/${denominator}`
const safeNumber = (value: number, digits = 6): string => Number(value.toFixed(digits)).toString()

const safeBackgroundColor = (value: string): string => {
  const match = /^#?([0-9a-f]{6})$/iu.exec(value.trim())
  return match?.[1] ? `0x${match[1]}` : '0x000000'
}

export const ffmpegSupportsFileBackedOptions = (version: string | null): boolean => {
  const major = /^(\d+)(?:\.|$)/u.exec(version?.trim() ?? '')?.[1]
  return major !== undefined && Number.parseInt(major, 10) >= 7
}

const assertFiniteTimelineValue = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`)
}

const validateClip = (clip: TimelineClip): void => {
  assertFiniteTimelineValue(clip.startUs, `Clip ${clip.id} start`)
  assertFiniteTimelineValue(clip.sourceInUs, `Clip ${clip.id} source in`)
  if (!Number.isFinite(clip.durationUs) || clip.durationUs <= 0) {
    throw new Error(`Clip ${clip.id} duration must be positive`)
  }
}

const cropFilter = (transform: TransformSettings): string => {
  const left = clamp(transform.crop.left, 0, 0.49)
  const right = clamp(transform.crop.right, 0, 0.49)
  const top = clamp(transform.crop.top, 0, 0.49)
  const bottom = clamp(transform.crop.bottom, 0, 0.49)
  const widthRatio = 1 - left - right
  const heightRatio = 1 - top - bottom
  if (widthRatio <= 0.01 || heightRatio <= 0.01) throw new Error('Crop leaves no visible pixels')
  const width = `max(2\\,trunc(iw*${safeNumber(widthRatio)}/2)*2)`
  const height = `max(2\\,trunc(ih*${safeNumber(heightRatio)}/2)*2)`
  const x = `trunc(iw*${safeNumber(left)}/2)*2`
  const y = `trunc(ih*${safeNumber(top)}/2)*2`
  return `crop=w='${width}':h='${height}':x='${x}':y='${y}'`
}

const visualFilter = (
  input: RenderInput,
  clip: Extract<TimelineClip, { kind: 'video' | 'image' }>,
  width: number,
  height: number,
  fps: string,
  label: string
): string => {
  const transform = clip.transform
  const scale = clamp(transform.scale, 0.01, 20)
  const targetWidth = even(width * scale)
  const targetHeight = even(height * scale)
  const rotationRadians = clamp(transform.rotation, -360_000, 360_000) * Math.PI / 180
  const opacity = clamp(transform.opacity, 0, 1)
  const filters = [
    `trim=duration=${seconds(clip.durationUs)}`,
    'settb=AVTB',
    'setpts=PTS-STARTPTS',
    cropFilter(transform)
  ]
  if (Math.abs(rotationRadians) > 0.000001) {
    filters.push(`rotate=${safeNumber(rotationRadians)}:ow=rotw(iw):oh=roth(ih):c=black@0`)
  }
  filters.push(
    `scale=w=${targetWidth}:h=${targetHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    'setsar=1',
    `fps=${fps}`,
    'format=rgba',
    `colorchannelmixer=aa=${safeNumber(opacity)}`,
    `setpts=PTS-STARTPTS+${seconds(clip.startUs)}/TB`
  )
  return `[${input.index}:v:0]${filters.join(',')}[${label}]`
}

const audioFilter = (
  input: RenderInput,
  clip: Extract<TimelineClip, { kind: 'video' | 'audio' }>,
  sampleRate: number,
  label: string
): string => {
  const settings: AudioSettings = clip.audio
  const volume = 10 ** (clamp(settings.volumeDb, -96, 24) / 20)
  const pan = clamp(settings.pan, -1, 1)
  const left = pan <= 0 ? 1 : 1 - pan
  const right = pan >= 0 ? 1 : 1 + pan
  const fadeInUs = clamp(settings.fadeInUs, 0, clip.durationUs)
  const fadeOutUs = clamp(settings.fadeOutUs, 0, clip.durationUs)
  const filters = [
    `atrim=duration=${seconds(clip.durationUs)}`,
    'asetpts=PTS-STARTPTS',
    `aresample=${sampleRate}`,
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
    `volume=${safeNumber(volume)}`,
    `pan=stereo|c0=${safeNumber(left)}*c0|c1=${safeNumber(right)}*c1`
  ]
  if (fadeInUs > 0) filters.push(`afade=t=in:st=0:d=${seconds(fadeInUs)}`)
  if (fadeOutUs > 0) {
    filters.push(`afade=t=out:st=${seconds(Math.max(0, clip.durationUs - fadeOutUs))}:d=${seconds(fadeOutUs)}`)
  }
  filters.push(`adelay=${Math.round(clip.startUs / 1_000)}:all=1`)
  return `[${input.index}:a:0]${filters.join(',')}[${label}]`
}

const projectDuration = (project: ProjectFile): number => {
  let maximum = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.enabled) maximum = Math.max(maximum, clip.startUs + clip.durationUs)
    }
  }
  return maximum
}

const getAsset = (assets: Map<string, MediaAsset>, clip: TimelineClip): MediaAsset => {
  if (clip.kind === 'subtitle') throw new Error('Subtitles do not have media assets')
  const asset = assets.get(clip.assetId)
  if (!asset) throw new Error(`Clip ${clip.id} references missing asset ${clip.assetId}`)
  if (asset.offline) throw new Error(`Asset is offline: ${asset.name}`)
  if (!isAbsolute(asset.path)) throw new Error(`Asset path must be absolute: ${asset.path}`)
  return asset
}

const makeInputArgs = (
  clip: Extract<TimelineClip, { kind: 'video' | 'image' | 'audio' }>,
  asset: MediaAsset,
  fps: string
): string[] => {
  if (clip.kind === 'image') {
    return ['-loop', '1', '-framerate', fps, '-t', seconds(clip.durationUs), '-i', asset.path]
  }
  return ['-ss', seconds(clip.sourceInUs), '-t', seconds(clip.durationUs), '-i', asset.path]
}

export const buildRenderFilterGraph = (
  plan: Omit<RenderPlan, 'filterGraph'> | RenderPlan,
  encoderId: H264EncoderId,
  assFileName = plan.assFileName
): string => {
  if (!/^[A-Za-z0-9_.-]+$/u.test(assFileName)) throw new Error('ASS filename must be a safe workspace basename')
  const statements = [...plan.graphStatements]
  let videoLabel = plan.compositedVideoLabel
  if (plan.burnSubtitles && plan.srt.trim()) {
    statements.push(`[${videoLabel}]ass=filename='${assFileName}'[subtitled]`)
    videoLabel = 'subtitled'
  }
  const format = encoderPixelFormat(encoderId)
  const terminalFilter = encoderRequiresHardwareUpload(encoderId)
    ? `format=${format},hwupload`
    : `format=${format}`
  statements.push(`[${videoLabel}]${terminalFilter}[vout]`)
  return statements.join(';\n')
}

export const createRenderPlan = (project: ProjectFile, settings: ExportSettings): RenderPlan => {
  const width = even(settings.width)
  const height = even(settings.height)
  const numerator = Math.round(settings.frameRate.numerator)
  const denominator = Math.round(settings.frameRate.denominator)
  if (numerator <= 0 || denominator <= 0) throw new Error('Export frame rate must be positive')
  const sampleRate = Math.max(8_000, Math.round(project.sequence.sampleRate || 48_000))
  const frameDurationUs = Math.ceil(denominator * 1_000_000 / numerator)
  const durationUs = Math.max(frameDurationUs, projectDuration(project))
  const fps = fpsText(numerator, denominator)
  const assets = new Map(project.media.map((asset) => [asset.id, asset]))
  const inputs: RenderInput[] = []
  const visualItems: Array<{ trackIndex: number; clip: Extract<TimelineClip, { kind: 'video' | 'image' }>; input: RenderInput }> = []
  const audioItems: Array<{ clip: Extract<TimelineClip, { kind: 'video' | 'audio' }>; input: RenderInput }> = []

  project.tracks.forEach((track, trackIndex) => {
    for (const timelineClip of track.clips) {
      if (!timelineClip.enabled || timelineClip.kind === 'subtitle') continue
      validateClip(timelineClip)
      const useVideo = (timelineClip.kind === 'video' || timelineClip.kind === 'image') && !track.hidden
      const asset = getAsset(assets, timelineClip)
      const useAudio = (timelineClip.kind === 'audio' || (timelineClip.kind === 'video' && asset.hasAudio)) && !track.muted
      if (!useVideo && !useAudio) continue
      const input: RenderInput = {
        index: inputs.length,
        clipId: timelineClip.id,
        assetId: asset.id,
        path: asset.path,
        inputArgs: makeInputArgs(timelineClip, asset, fps),
        useVideo,
        useAudio
      }
      inputs.push(input)
      if (useVideo && (timelineClip.kind === 'video' || timelineClip.kind === 'image')) {
        visualItems.push({ trackIndex, clip: timelineClip, input })
      }
      if (useAudio && (timelineClip.kind === 'video' || timelineClip.kind === 'audio')) {
        audioItems.push({ clip: timelineClip, input })
      }
    }
  })

  const statements: string[] = [
    `color=c=${safeBackgroundColor(project.sequence.backgroundColor)}:s=${width}x${height}:r=${fps}:d=${seconds(durationUs)},format=rgba[canvas]`
  ]
  let currentVideo = 'canvas'
  const orderedVisuals = visualItems.sort((left, right) =>
    right.trackIndex - left.trackIndex || left.clip.startUs - right.clip.startUs
  )
  orderedVisuals.forEach(({ clip, input }, index) => {
    const sourceLabel = `visual${index}`
    const nextLabel = `composite${index}`
    statements.push(visualFilter(input, clip, width, height, fps, sourceLabel))
    const x = safeNumber(clip.transform.positionX)
    const y = safeNumber(clip.transform.positionY)
    statements.push(
      `[${currentVideo}][${sourceLabel}]overlay=x='(W-w)/2+${x}':y='(H-h)/2+${y}':eof_action=pass:repeatlast=0:shortest=0[${nextLabel}]`
    )
    currentVideo = nextLabel
  })

  const audioLabels: string[] = []
  audioItems.forEach(({ clip, input }, index) => {
    const label = `audio${index}`
    statements.push(audioFilter(input, clip, sampleRate, label))
    audioLabels.push(`[${label}]`)
  })
  const audioOutputLabel = 'aout'
  if (audioLabels.length === 0) {
    statements.push(`anullsrc=r=${sampleRate}:cl=stereo:d=${seconds(durationUs)}[${audioOutputLabel}]`)
  } else {
    statements.push(
      `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,alimiter=limit=0.95,atrim=duration=${seconds(durationUs)},apad=whole_dur=${seconds(durationUs)}[${audioOutputLabel}]`
    )
  }

  const partial = {
    durationUs,
    width,
    height,
    frameRateNumerator: numerator,
    frameRateDenominator: denominator,
    sampleRate,
    inputs,
    inputArgs: inputs.flatMap((input) => input.inputArgs),
    graphStatements: statements,
    compositedVideoLabel: currentVideo,
    audioOutputLabel,
    ass: generateAss(project),
    srt: generateSrt(project),
    burnSubtitles: settings.burnSubtitles,
    assFileName: 'captions.ass'
  }
  return {
    ...partial,
    filterGraph: buildRenderFilterGraph(partial, 'libx264')
  }
}

export const buildRenderCommandArgs = (plan: RenderPlan, options: RenderCommandOptions): string[] => {
  const fps = fpsText(plan.frameRateNumerator, plan.frameRateDenominator)
  const graphOption = options.supportsFileOption === true ? '-/filter_complex' : '-filter_complex_script'
  return [
    '-hide_banner',
    '-y',
    '-loglevel',
    'warning',
    '-progress',
    'pipe:1',
    '-nostats',
    ...encoderGlobalInputArgs(options.encoderId, options.vaapiDevice),
    ...plan.inputArgs,
    graphOption,
    options.filterGraphPath,
    '-map',
    '[vout]',
    '-map',
    `[${plan.audioOutputLabel}]`,
    '-t',
    seconds(plan.durationUs),
    '-r',
    fps,
    ...buildEncoderOutputArgs(options.encoderId, options.videoBitrate),
    '-c:a',
    'aac',
    '-b:a',
    String(Math.max(32_000, Math.round(options.audioBitrate))),
    '-ar',
    String(plan.sampleRate),
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-map_metadata',
    '-1',
    options.outputPath
  ]
}
