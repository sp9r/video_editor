import { isAbsolute } from 'node:path'
import type {
  AudioSettings,
  ExportSettings,
  MediaAsset,
  ProjectFile,
  PreviewPlan,
  TimelineClip
} from '../../shared/types.js'
import {
  buildEncoderOutputArgs,
  encoderGlobalInputArgs,
  encoderPixelFormat,
  encoderRequiresHardwareUpload,
  type H264EncoderId
} from './encoders.js'
import { collectSubtitleCues, generateAss, generateSrt } from './subtitles.js'
import { visualLayerOrder } from '../../shared/render-order.js'
import { computeVisualLayout, type VisualLayout } from '../../shared/visual-layout.js'

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
  backgroundColor: string
  /** Encoded output size. */
  width: number
  height: number
  /** Sequence-space size used for layout, subtitles and Preview parity. */
  compositionWidth: number
  compositionHeight: number
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
  subtitleCueCount: number
  subtitleIds: string[]
}

/**
 * A short span of the timeline, in output frames. Accurate Preview renders
 * only this span instead of compositing every frame from the start.
 */
export interface RenderWindow {
  startFrame: number
  frameCount: number
}

export interface RenderPlanOptions {
  window?: RenderWindow
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

export interface AuthoritativeVideoGraph {
  statements: string[]
  videoLabel: string
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum))

const even = (value: number): number => Math.max(16, Math.floor(value / 2) * 2)
const TO_VIDEO_RANGE = 'scale=out_color_matrix=bt709:out_range=tv:flags=bicubic'
const SEEK_GUARD_US = 2_000
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

/**
 * Chromium and most players assume BT.709 for untagged HD and BT.601 for SD.
 * Naming the matrix explicitly keeps the export from guessing differently.
 */
export const inputColorMatrix = (asset: Pick<MediaAsset, 'colorSpace' | 'height'> | undefined): string => {
  switch (asset?.colorSpace) {
    case 'bt709': return 'bt709'
    case 'smpte170m':
    case 'bt470bg': return 'bt601'
    case 'bt2020nc':
    case 'bt2020c': return 'bt2020'
    default: return (asset?.height ?? 0) >= 720 ? 'bt709' : 'bt601'
  }
}

/**
 * setpts truncates its result to a whole tick, so 0.433333/TB (12.99999 ticks)
 * would land a frame early. Round up to the first frame at or after the start,
 * with a tiny tolerance for values that are exact on the frame grid.
 */
const startOffsetExpression = (startSeconds: string): string => `ceil(${startSeconds}/TB-0.0001)`

/** Crop hides edges in place, so cropped sides become transparent instead of being cut off. */
const cropFilters = (layout: VisualLayout): string[] => {
  const { crop, boxWidth, boxHeight } = layout
  const box = (x: string, y: string, w: number | string, h: number | string): string =>
    `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@0:t=fill:replace=1`
  const filters: string[] = []
  if (crop.left > 0) filters.push(box('0', '0', crop.left, boxHeight))
  if (crop.right > 0) filters.push(box(String(boxWidth - crop.right), '0', crop.right, boxHeight))
  if (crop.top > 0) filters.push(box('0', '0', boxWidth, crop.top))
  if (crop.bottom > 0) filters.push(box('0', String(boxHeight - crop.bottom), boxWidth, crop.bottom))
  return filters
}

// Every size and position comes from the shared layout, so Preview draws the
// same rectangles. Order: scale into the box, hide cropped edges, rotate.
const visualFilter = (
  input: RenderInput,
  clip: Extract<TimelineClip, { kind: 'video' | 'image' }>,
  layout: VisualLayout,
  asset: MediaAsset,
  fps: string,
  label: string
): string => {
  const colorArgs = clip.kind === 'video'
    ? `:in_color_matrix=${inputColorMatrix(asset)}:in_range=${asset.colorRange ?? 'tv'}`
    : ''
  const filters = [
    `trim=duration=${seconds(clip.durationUs)}`,
    'settb=AVTB',
    'setpts=PTS-STARTPTS',
    `scale=w=${layout.boxWidth}:h=${layout.boxHeight}:flags=bicubic${colorArgs}`,
    'setsar=1',
    `fps=${fps}`,
    'format=rgba',
    ...cropFilters(layout)
  ]
  if (layout.rotationRadians !== 0) {
    filters.push(`rotate=${safeNumber(layout.rotationRadians)}:ow=${layout.rotatedWidth}:oh=${layout.rotatedHeight}:c=black@0`)
  }
  filters.push(
    `colorchannelmixer=aa=${safeNumber(layout.opacity)}`,
    `setpts=PTS-STARTPTS+${startOffsetExpression(seconds(clip.startUs))}`
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
  // Container timestamps are rounded (Matroska uses milliseconds), so a frame
  // exactly on the seek point can land just before it and be skipped.
  const seekUs = clip.kind === 'video' && clip.sourceInUs > 0 ? Math.max(0, clip.sourceInUs - SEEK_GUARD_US) : clip.sourceInUs
  return ['-ss', seconds(seekUs), '-t', seconds(clip.durationUs), '-i', asset.path]
}

const validateAssFileName = (assFileName: string): void => {
  if (!/^[A-Za-z0-9_.-]+$/u.test(assFileName)) throw new Error('ASS filename must be a safe workspace basename')
}

export const buildAuthoritativeVideoGraph = (
  plan: Omit<RenderPlan, 'filterGraph'> | RenderPlan,
  assFileName = plan.assFileName
): AuthoritativeVideoGraph => {
  validateAssFileName(assFileName)
  const statements = [...plan.graphStatements]
  let videoLabel = plan.compositedVideoLabel
  if (plan.burnSubtitles && plan.subtitleCueCount > 0 && plan.srt.trim()) {
    statements.push(`[${videoLabel}]ass=filename='${assFileName}'[subtitled]`)
    videoLabel = 'subtitled'
  }
  if (plan.width !== plan.compositionWidth || plan.height !== plan.compositionHeight) {
    // Positions are sequence pixels. Resize the finished frame instead of
    // laying out again at the output size, and letterbox other aspect ratios.
    statements.push(
      `[${videoLabel}]scale=w=${plan.width}:h=${plan.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,`
      + `pad=w=${plan.width}:h=${plan.height}:x='(ow-iw)/2':y='(oh-ih)/2':color=${plan.backgroundColor},setsar=1[outputsized]`
    )
    videoLabel = 'outputsized'
  }
  return { statements, videoLabel }
}

export const buildRenderFilterGraph = (
  plan: Omit<RenderPlan, 'filterGraph'> | RenderPlan,
  encoderId: H264EncoderId,
  assFileName = plan.assFileName
): string => {
  const authoritative = buildAuthoritativeVideoGraph(plan, assFileName)
  const statements = authoritative.statements
  const videoLabel = authoritative.videoLabel
  const format = encoderPixelFormat(encoderId)
  const terminalFilter = encoderRequiresHardwareUpload(encoderId)
    ? `${TO_VIDEO_RANGE},format=${format},hwupload`
    : `${TO_VIDEO_RANGE},format=${format}`
  statements.push(`[${videoLabel}]${terminalFilter}[vout]`)
  return statements.join(';\n')
}

// Final stores 4:2:0 BT.709 limited-range video, and the MP4 is tagged to say
// so. Passing the single Accurate Preview frame through the same conversion
// shows the chroma softening the export will have.
const CHROMA_ROUND_TRIP = `${TO_VIDEO_RANGE},format=yuv420p,scale=in_color_matrix=bt709:in_range=tv:flags=bicubic,format=rgba`

export const buildAccurateFrameFilterGraph = (
  plan: Omit<RenderPlan, 'filterGraph'> | RenderPlan,
  frameIndex: number,
  assFileName = plan.assFileName
): string => {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) throw new Error('Accurate frame index must be a non-negative integer')
  const authoritative = buildAuthoritativeVideoGraph(plan, assFileName)
  authoritative.statements.push(
    `[${authoritative.videoLabel}]select='eq(n\\,${frameIndex})',setpts=PTS-STARTPTS,${CHROMA_ROUND_TRIP}[vout]`
  )
  // The authoritative plan still builds its audio semantics. Consume that
  // branch explicitly because a PNG frame has no audio output stream.
  authoritative.statements.push(`[${plan.audioOutputLabel}]anullsink`)
  return authoritative.statements.join(';\n')
}

/**
 * Cut each media clip so it starts inside the window. The cut stays on the
 * clip's own frame grid, so the frame shown at a time is the same as Final.
 */
const clipForWindow = <T extends Extract<TimelineClip, { kind: 'video' | 'image' | 'audio' }>>(
  clip: T,
  windowStartUs: number,
  windowEndUs: number,
  frameDurationUs: number
): T | null => {
  const endUs = clip.startUs + clip.durationUs
  if (clip.startUs >= windowEndUs || endUs <= windowStartUs) return null
  const skippedFrames = Math.max(0, Math.floor((windowStartUs - clip.startUs) / frameDurationUs))
  const cutUs = Math.min(endUs - 1, clip.startUs + Math.round(skippedFrames * frameDurationUs))
  const durationUs = Math.max(1, Math.min(endUs, windowEndUs + frameDurationUs) - cutUs)
  return {
    ...clip,
    startUs: cutUs,
    sourceInUs: clip.kind === 'image' ? clip.sourceInUs : clip.sourceInUs + (cutUs - clip.startUs),
    durationUs
  }
}

export const createRenderPlan = (project: ProjectFile, settings: ExportSettings, options: RenderPlanOptions = {}): RenderPlan => {
  const width = even(settings.width)
  const height = even(settings.height)
  const compositionWidth = even(project.sequence.width || width)
  const compositionHeight = even(project.sequence.height || height)
  const backgroundColor = safeBackgroundColor(project.sequence.backgroundColor)
  const numerator = Math.round(settings.frameRate.numerator)
  const denominator = Math.round(settings.frameRate.denominator)
  if (numerator <= 0 || denominator <= 0) throw new Error('Export frame rate must be positive')
  const sampleRate = Math.max(8_000, Math.round(project.sequence.sampleRate || 48_000))
  const frameDurationUs = Math.ceil(denominator * 1_000_000 / numerator)
  const durationUs = Math.max(frameDurationUs, projectDuration(project))
  const fps = fpsText(numerator, denominator)
  const window = options.window
  if (window && (!Number.isInteger(window.startFrame) || window.startFrame < 0 || !Number.isInteger(window.frameCount) || window.frameCount <= 0)) {
    throw new Error('Render window must be a non-negative frame range')
  }
  const exactFrameUs = denominator * 1_000_000 / numerator
  const windowStartUs = window ? window.startFrame * exactFrameUs : 0
  const windowEndUs = window ? (window.startFrame + window.frameCount) * exactFrameUs : durationUs
  const subtitleCues = collectSubtitleCues(project)
  const assets = new Map(project.media.map((asset) => [asset.id, asset]))
  const inputs: RenderInput[] = []
  const visualItems: Array<{ trackIndex: number; clip: Extract<TimelineClip, { kind: 'video' | 'image' }>; input: RenderInput }> = []
  const audioItems: Array<{ clip: Extract<TimelineClip, { kind: 'video' | 'audio' }>; input: RenderInput }> = []

  project.tracks.forEach((track, trackIndex) => {
    for (const originalClip of track.clips) {
      if (!originalClip.enabled || originalClip.kind === 'subtitle') continue
      validateClip(originalClip)
      const timelineClip = window ? clipForWindow(originalClip, windowStartUs, windowEndUs, exactFrameUs) : originalClip
      if (!timelineClip) continue
      const useVideo = (timelineClip.kind === 'video' || timelineClip.kind === 'image') && !track.hidden
      const asset = getAsset(assets, timelineClip)
      // A still frame has no audio output; skip decoding it in a window.
      const useAudio = !window && (timelineClip.kind === 'audio' || (timelineClip.kind === 'video' && timelineClip.sourceAudioEnabled !== false && asset.hasAudio)) && !track.muted
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
    window
      ? `color=c=${backgroundColor}:s=${compositionWidth}x${compositionHeight}:r=${fps}:d=${seconds(window.frameCount * exactFrameUs)},format=rgba,setpts=PTS+${startOffsetExpression(`${window.startFrame}*${denominator}/${numerator}`)}[canvas]`
      : `color=c=${backgroundColor}:s=${compositionWidth}x${compositionHeight}:r=${fps}:d=${seconds(durationUs)},format=rgba[canvas]`
  ]
  let currentVideo = 'canvas'
  const visualInputById = new Map(visualItems.map((item) => [item.clip.id, item] as const))
  const orderedVisuals = visualLayerOrder(project)
    .map(({ clip }) => visualInputById.get(clip.id))
    .filter((item): item is (typeof visualItems)[number] => item !== undefined)
  orderedVisuals.forEach(({ clip, input }, index) => {
    const sourceLabel = `visual${index}`
    const nextLabel = `composite${index}`
    const asset = getAsset(assets, clip)
    const layout = computeVisualLayout(clip, asset, compositionWidth, compositionHeight)
    statements.push(visualFilter(input, clip, layout, asset, fps, sourceLabel))
    statements.push(
      `[${currentVideo}][${sourceLabel}]overlay=x=${layout.x}:y=${layout.y}:eof_action=pass:repeatlast=0:shortest=0:format=auto[${nextLabel}]`
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
    statements.push(`anullsrc=r=${sampleRate}:cl=stereo:d=${seconds(window ? windowEndUs - windowStartUs : durationUs)}[${audioOutputLabel}]`)
  } else {
    statements.push(
      `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,alimiter=limit=0.95,atrim=duration=${seconds(durationUs)},apad=whole_dur=${seconds(durationUs)}[${audioOutputLabel}]`
    )
  }

  const partial = {
    durationUs,
    width,
    height,
    compositionWidth,
    compositionHeight,
    backgroundColor,
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
    assFileName: 'captions.ass',
    subtitleCueCount: subtitleCues.length,
    subtitleIds: subtitleCues.map(({ clip }) => clip.id)
  }
  return {
    ...partial,
    filterGraph: buildRenderFilterGraph(partial, 'libx264')
  }
}

/**
 * Fast Preview consumes the same validated ProjectFile and subtitle ASS
 * authority as Final, while its video/image presentation remains approximate.
 * Accurate Preview and Final render use buildAuthoritativeVideoGraph for the
 * complete frame; subtitle-only Fast overlays use generateAss plus libass.
 */
export const createPreviewPlan = (project: ProjectFile, settings: ExportSettings): PreviewPlan => {
  const renderPlan = createRenderPlan(project, settings)
  const videoClips: PreviewPlan['videoClips'] = []
  const audioClips: PreviewPlan['audioClips'] = []
  const captions: PreviewPlan['captions'] = []
  const clipsById = new Map(project.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)))
  for (const input of renderPlan.inputs) {
    const clip = clipsById.get(input.clipId)
    if (!clip) continue
    const common = {
      clipId: clip.id,
      startUs: clip.startUs,
      durationUs: clip.durationUs,
      sourceInUs: clip.sourceInUs,
      enabled: clip.enabled
    }
    if (input.useVideo && (clip.kind === 'video' || clip.kind === 'image')) {
      videoClips.push({ ...common, kind: 'video', sourceMediaId: clip.assetId })
    }
    if (input.useAudio && (clip.kind === 'video' || clip.kind === 'audio')) {
      audioClips.push({
        ...common,
        kind: 'audio',
        sourceMediaId: clip.assetId,
        volumeDb: clip.audio.volumeDb,
        pan: clip.audio.pan,
        fadeInUs: clip.audio.fadeInUs,
        fadeOutUs: clip.audio.fadeOutUs
      })
    }
  }
  for (const track of project.tracks) {
    if (track.hidden) continue
    for (const clip of track.clips) {
      if (clip.enabled && clip.kind === 'subtitle') {
        captions.push({ clipId: clip.id, kind: 'caption', startUs: clip.startUs, durationUs: clip.durationUs, sourceInUs: clip.sourceInUs, enabled: clip.enabled, text: clip.text })
      }
    }
  }
  return {
    durationUs: renderPlan.durationUs,
    width: renderPlan.width,
    height: renderPlan.height,
    frameRate: { numerator: renderPlan.frameRateNumerator, denominator: renderPlan.frameRateDenominator },
    videoClips: visualLayerOrder(project)
      .map(({ clip }) => videoClips.find((item) => item.clipId === clip.id))
      .filter((item): item is PreviewPlan['videoClips'][number] => item !== undefined),
    audioClips: audioClips.sort((left, right) => left.startUs - right.startUs),
    captions: captions.sort((left, right) => left.startUs - right.startUs)
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
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
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
