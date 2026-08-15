import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  APP_VERSION,
  DEFAULT_AUDIO,
  DEFAULT_SUBTITLE_STYLE,
  DEFAULT_TRANSFORM,
  PROJECT_SCHEMA_VERSION,
  type AudioClip,
  type MediaAsset,
  type ProjectFile,
  type SubtitleClip,
  type SubtitleWord,
  type TimelineClip,
  type TimelineTrack,
  type VideoClip
} from '../../shared/types.js'
import { layoutSubtitleTracks, validateProject } from '../../shared/project.js'
import { inferLinkedAudioPairs } from '../../shared/editing/links.js'
import { deriveSubtitleEditUnits } from '../../shared/editing/edit-units.js'

export const EDIT_PROJECT_SCHEMA_VERSION = 'edit_project.v1' as const

export type EditProjectErrorCode =
  | 'invalid_contract'
  | 'unsupported_schema'
  | 'source_missing'
  | 'source_hash_mismatch'
  | 'unsupported_feature'

export class EditProjectError extends Error {
  readonly code: EditProjectErrorCode
  readonly projectPath?: string
  readonly details?: Record<string, unknown>

  constructor(code: EditProjectErrorCode, message: string, options: { projectPath?: string; details?: Record<string, unknown> } = {}) {
    super(message)
    this.name = 'EditProjectError'
    this.code = code
    this.projectPath = options.projectPath
    this.details = options.details
  }
}

export interface EditProjectMetadata {
  id: string
  name: string
  created_at?: string
  updated_at?: string
  generator?: Record<string, unknown>
}

export interface EditProjectSourceMedia {
  id: string
  path: string
  kind: 'video' | 'audio'
  sha256?: string
  duration: number
  width?: number
  height?: number
  fps?: number
  sample_rate?: number
  channels?: number
}

export interface EditProjectSequence {
  id?: string
  width: number
  height: number
  fps: number
  timebase?: { numerator: number; denominator: number }
  duration: number
}

export interface EditProjectTimeRange {
  start: number
  duration: number
}

export interface EditProjectTransform {
  x: number
  y: number
  scale_x: number
  scale_y: number
  rotation: number
  opacity: number
  anchor_x?: number
  anchor_y?: number
}

export interface EditProjectVideoClip {
  id: string
  type: 'video_clip'
  source_media_id: string
  timeline: EditProjectTimeRange
  source: EditProjectTimeRange
  transform: EditProjectTransform
  enabled: boolean
}

export interface EditProjectAudioClip {
  id: string
  type: 'audio_clip'
  source_media_id: string
  timeline: EditProjectTimeRange
  source: EditProjectTimeRange
  volume: number
  enabled: boolean
}

export type EditProjectClip = EditProjectVideoClip | EditProjectAudioClip

export interface EditProjectTrack {
  id: string
  kind: 'video' | 'audio' | 'caption' | 'text'
  name?: string
  enabled?: boolean
  locked?: boolean
  clips: EditProjectClip[]
}

export interface EditProjectCaptionStyle {
  template_id?: string
  font_name?: string
  font_size?: number
  primary_color?: string
  outline_color?: string
  outline?: number
  alignment?: number
  position_x?: number | null
  position_y?: number | null
}

export interface EditProjectCaptionWord {
  id: string
  text: string
  timeline: EditProjectTimeRange
}

export interface EditProjectCaption {
  id: string
  track_id?: string
  text: string
  timeline: EditProjectTimeRange
  source?: EditProjectTimeRange
  style?: EditProjectCaptionStyle
  source_word_ids?: number[]
  words?: EditProjectCaptionWord[]
  enabled: boolean
}

export interface EditProjectDocument {
  schema_version: typeof EDIT_PROJECT_SCHEMA_VERSION
  project: EditProjectMetadata
  source_media: EditProjectSourceMedia[]
  sequence: EditProjectSequence
  tracks: EditProjectTrack[]
  captions: EditProjectCaption[]
  metadata?: Record<string, unknown>
}

export interface LoadedEditProject {
  projectPath: string
  document: EditProjectDocument
  resolvedSourceMedia: ReadonlyMap<string, string>
  project: ProjectFile
  diagnostics: readonly string[]
}

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

const invalid = (message: string, details?: Record<string, unknown>): never => {
  throw new EditProjectError('invalid_contract', message, { details })
}

const record = (value: unknown, label: string): UnknownRecord => {
  if (!isRecord(value)) invalid(`${label} must be an object`)
  return value as UnknownRecord
}

const requiredString = (value: unknown, label: string): string => {
  if (!nonEmptyString(value)) invalid(`${label} must be a non-empty string`)
  return value as string
}

const requiredFinite = (value: unknown, label: string): number => {
  if (!finite(value)) invalid(`${label} must be a finite number`)
  return value as number
}

export type DecimalValue = Readonly<{
  coefficient: bigint
  scale: number
}>

const normalizeDecimal = (value: DecimalValue): DecimalValue => {
  let coefficient = value.coefficient
  let scale = value.scale
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n
    scale -= 1
  }
  return { coefficient, scale }
}

/** Decimal value semantics for finite JSON numbers, based on Number.toString(). */
export const decimalFromNumber = (value: number, label = 'value'): DecimalValue => {
  if (!Number.isFinite(value)) invalid(`${label} must be a finite number`)
  const text = value.toString()
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/iu.exec(text)
  const parsedMatch = match ?? invalid(`${label} must be a finite decimal number`)
  const sign = parsedMatch[1] ?? ''
  const integerPart = parsedMatch[2] ?? ''
  const fractionPart = parsedMatch[3] ?? ''
  const exponentText = parsedMatch[4] ?? '0'
  const digits = `${integerPart}${fractionPart}`
  const unsignedCoefficient = BigInt(digits || '0')
  const coefficient = sign === '-' ? -unsignedCoefficient : unsignedCoefficient
  const scale = fractionPart.length - Number(exponentText)
  if (scale >= 0) return normalizeDecimal({ coefficient, scale })
  return normalizeDecimal({ coefficient: coefficient * (10n ** BigInt(-scale)), scale: 0 })
}

export const decimalAdd = (left: DecimalValue, right: DecimalValue): DecimalValue => {
  const scale = Math.max(left.scale, right.scale)
  const leftCoefficient = left.coefficient * (10n ** BigInt(scale - left.scale))
  const rightCoefficient = right.coefficient * (10n ** BigInt(scale - right.scale))
  return normalizeDecimal({ coefficient: leftCoefficient + rightCoefficient, scale })
}

export const decimalCompare = (left: DecimalValue, right: DecimalValue): -1 | 0 | 1 => {
  const scale = Math.max(left.scale, right.scale)
  const leftCoefficient = left.coefficient * (10n ** BigInt(scale - left.scale))
  const rightCoefficient = right.coefficient * (10n ** BigInt(scale - right.scale))
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0
}

const requiredPositive = (value: unknown, label: string): number => {
  const number = requiredFinite(value, label)
  if (number <= 0) invalid(`${label} must be > 0`)
  return number
}

const requiredNonNegative = (value: unknown, label: string): number => {
  const number = requiredFinite(value, label)
  if (number < 0) invalid(`${label} must be >= 0`)
  return number
}

const requiredOpacity = (value: unknown, label: string): number => {
  const number = requiredFinite(value, label)
  if (number < 0 || number > 1) invalid(`${label} must be between 0 and 1`)
  return number
}

const requiredBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`)
  return value as boolean
}

const range = (value: unknown, label: string): EditProjectTimeRange => {
  const object = record(value, label)
  const start = requiredNonNegative(object.start, `${label}.start`)
  const duration = requiredPositive(object.duration, `${label}.duration`)
  return { start, duration }
}

const parseTransform = (value: unknown, label: string): EditProjectTransform => {
  const object = record(value, label)
  return {
    x: requiredFinite(object.x, `${label}.x`),
    y: requiredFinite(object.y, `${label}.y`),
    scale_x: requiredPositive(object.scale_x, `${label}.scale_x`),
    scale_y: requiredPositive(object.scale_y, `${label}.scale_y`),
    rotation: requiredFinite(object.rotation, `${label}.rotation`),
    opacity: requiredOpacity(object.opacity, `${label}.opacity`),
    ...(object.anchor_x === undefined ? {} : { anchor_x: requiredFinite(object.anchor_x, `${label}.anchor_x`) }),
    ...(object.anchor_y === undefined ? {} : { anchor_y: requiredFinite(object.anchor_y, `${label}.anchor_y`) })
  }
}

const parseClip = (value: unknown, label: string): EditProjectClip => {
  const object = record(value, label)
  const id = requiredString(object.id, `${label}.id`)
  const type = requiredString(object.type, `${label}.type`)
  const sourceMediaId = requiredString(object.source_media_id, `${label}.source_media_id`)
  const timeline = range(object.timeline, `${label}.timeline`)
  const source = range(object.source, `${label}.source`)
  const enabled = requiredBoolean(object.enabled, `${label}.enabled`)
  if (type === 'video_clip') {
    return {
      id,
      type,
      source_media_id: sourceMediaId,
      timeline,
      source,
      transform: parseTransform(object.transform, `${label}.transform`),
      enabled
    }
  }
  if (type === 'audio_clip') {
    return { id, type, source_media_id: sourceMediaId, timeline, source, volume: requiredNonNegative(object.volume, `${label}.volume`), enabled }
  }
  return invalid(`${label}.type is unsupported: ${type}`)
}

const parseCaption = (value: unknown, label: string): EditProjectCaption => {
  const object = record(value, label)
  const style = object.style
  if (style !== undefined && !isRecord(style)) invalid(`${label}.style must be an object`)
  const id = requiredString(object.id, `${label}.id`)
  const text = typeof object.text === 'string' ? object.text : invalid(`${label}.text must be a string`)
  const timeline = range(object.timeline, `${label}.timeline`)
  const captionStartDecimal = decimalFromNumber(timeline.start, `${label}.timeline.start`)
  const captionDurationDecimal = decimalFromNumber(timeline.duration, `${label}.timeline.duration`)
  const captionEndDecimal = decimalAdd(captionStartDecimal, captionDurationDecimal)
  const words = object.words === undefined ? undefined : (() => {
    const rawWords = object.words
    if (!Array.isArray(rawWords) || rawWords.length === 0) invalid(`${label}.words must be a non-empty array when present`)
    const wordArray = rawWords as unknown[]
    const wordIds = new Set<string>()
    let previousEnd = captionStartDecimal
    const parsed = wordArray.map((value: unknown, index: number): EditProjectCaptionWord => {
      const word = record(value, `${label}.words[${index}]`)
      const wordId = requiredString(word.id, `${label}.words[${index}].id`)
      if (wordIds.has(wordId)) invalid(`${label}.words contains duplicate id: ${wordId}`)
      wordIds.add(wordId)
      const wordText = typeof word.text === 'string' ? word.text : invalid(`${label}.words[${index}].text must be a string`)
      const wordTimeline = range(word.timeline, `${label}.words[${index}].timeline`)
      const wordStartDecimal = decimalFromNumber(wordTimeline.start, `${label}.words[${index}].timeline.start`)
      const wordDurationDecimal = decimalFromNumber(wordTimeline.duration, `${label}.words[${index}].timeline.duration`)
      const wordEndDecimal = decimalAdd(wordStartDecimal, wordDurationDecimal)
      if (decimalCompare(wordStartDecimal, captionStartDecimal) < 0) invalid(`${label}.words[${index}] starts before the caption`)
      if (decimalCompare(wordEndDecimal, captionEndDecimal) > 0) invalid(`${label}.words[${index}] ends after the caption`)
      if (decimalCompare(wordStartDecimal, previousEnd) < 0) invalid(`${label}.words[${index}] overlaps or reverses the previous word`)
      previousEnd = wordEndDecimal
      return { id: wordId, text: wordText, timeline: wordTimeline }
    })
    if (parsed.map((word) => word.text).join('') !== text) invalid(`${label}.words text does not reconstruct caption.text`)
    return parsed
  })()
  const sourceWordIds = object.source_word_ids === undefined ? undefined : (() => {
    const rawSourceWordIds = object.source_word_ids
    if (!Array.isArray(rawSourceWordIds) || rawSourceWordIds.length !== 2 || rawSourceWordIds.some((item) => !Number.isInteger(item) || (item as number) < 0)) {
      invalid(`${label}.source_word_ids must contain the first and last non-negative integer word id`)
    }
    return [...(rawSourceWordIds as unknown[])] as number[]
  })()
  if (words && sourceWordIds && (
    words[0]?.id !== `source-word:${sourceWordIds[0]}` ||
    words.at(-1)?.id !== `source-word:${sourceWordIds[1]}`
  )) invalid(`${label}.source_word_ids does not match the first and last words`)
  return {
    id,
    ...(object.track_id === undefined ? {} : { track_id: requiredString(object.track_id, `${label}.track_id`) }),
    text,
    timeline,
    ...(object.source === undefined ? {} : { source: range(object.source, `${label}.source`) }),
    ...(style ? { style: style as EditProjectCaptionStyle } : {}),
    ...(sourceWordIds ? { source_word_ids: sourceWordIds } : {}),
    ...(words ? { words } : {}),
    enabled: requiredBoolean(object.enabled, `${label}.enabled`)
  }
}

const isPortableRelativeContractPath = (value: string): boolean =>
  !path.isAbsolute(value) &&
  !path.win32.isAbsolute(value) &&
  !path.posix.isAbsolute(value) &&
  !/^[A-Za-z]:/u.test(value) &&
  !value.startsWith('/') &&
  !value.startsWith('\\') &&
  !value.includes('\\')

export const validateEditProject = (input: unknown): EditProjectDocument => {
  const inputObject = record(input, 'edit_project')
  const schema = inputObject.schema_version
  if (schema !== EDIT_PROJECT_SCHEMA_VERSION) {
    const message = typeof schema === 'string' && /^edit_project\.v\d+$/u.test(schema)
      ? `unsupported edit_project schema: ${schema}`
      : `schema_version must be ${EDIT_PROJECT_SCHEMA_VERSION}`
    throw new EditProjectError('unsupported_schema', message, { details: { schema_version: schema } })
  }
  const project = record(inputObject.project, 'project metadata')
  const sourceMediaInput = inputObject.source_media
  const tracksInput = inputObject.tracks
  const captionsInput = inputObject.captions
  if (!Array.isArray(sourceMediaInput) || sourceMediaInput.length === 0) invalid('source_media must be a non-empty array')
  if (!Array.isArray(tracksInput)) invalid('tracks must be an array')
  if (!Array.isArray(captionsInput)) invalid('captions must be an array')
  const sequenceInput = record(inputObject.sequence, 'sequence')
  const timebase = sequenceInput.timebase === undefined ? undefined : record(sequenceInput.timebase, 'sequence.timebase')
  if (timebase && (!finite(timebase.numerator) || !finite(timebase.denominator) || timebase.numerator <= 0 || timebase.denominator <= 0)) {
    invalid('sequence.timebase numerator and denominator must be positive finite numbers')
  }
  const sequence: EditProjectSequence = {
    ...(sequenceInput.id === undefined ? {} : { id: requiredString(sequenceInput.id, 'sequence.id') }),
    width: requiredPositive(sequenceInput.width, 'sequence.width'),
    height: requiredPositive(sequenceInput.height, 'sequence.height'),
    fps: requiredPositive(sequenceInput.fps, 'sequence.fps'),
    ...(timebase === undefined ? {} : { timebase: { numerator: timebase.numerator as number, denominator: timebase.denominator as number } }),
    duration: requiredPositive(sequenceInput.duration, 'sequence.duration')
  }
  if (!Number.isInteger(sequence.width) || !Number.isInteger(sequence.height)) invalid('sequence width and height must be integers')

  const sourceIds = new Set<string>()
  const sourceMedia = (sourceMediaInput as unknown[]).map((value: unknown, index: number): EditProjectSourceMedia => {
    const object = record(value, `source_media[${index}]`)
    const id = requiredString(object.id, `source_media[${index}].id`)
    if (sourceIds.has(id)) invalid(`duplicate source media id: ${id}`)
    sourceIds.add(id)
    const mediaPath = requiredString(object.path, `source_media[${index}].path`)
    if (!isPortableRelativeContractPath(mediaPath)) invalid(`source_media[${index}].path must be a portable relative path using / separators`)
    const kind = object.kind as unknown
    if (kind !== 'video' && kind !== 'audio') invalid(`source_media[${index}].kind is unsupported`)
    const result: EditProjectSourceMedia = {
      id,
      path: mediaPath,
      kind: kind as EditProjectSourceMedia['kind'],
      ...(object.sha256 === undefined ? {} : { sha256: requiredString(object.sha256, `source_media[${index}].sha256`).toLowerCase() }),
      duration: requiredPositive(object.duration, `source_media[${index}].duration`),
      ...(object.width === undefined ? {} : { width: requiredPositive(object.width, `source_media[${index}].width`) }),
      ...(object.height === undefined ? {} : { height: requiredPositive(object.height, `source_media[${index}].height`) }),
      ...(object.fps === undefined ? {} : { fps: requiredPositive(object.fps, `source_media[${index}].fps`) }),
      ...(object.sample_rate === undefined ? {} : { sample_rate: requiredPositive(object.sample_rate, `source_media[${index}].sample_rate`) }),
      ...(object.channels === undefined ? {} : { channels: requiredPositive(object.channels, `source_media[${index}].channels`) })
    }
    if (result.sha256 && !/^[0-9a-f]{64}$/u.test(result.sha256)) invalid(`source_media[${index}].sha256 must be SHA-256 hex`)
    return result
  })

  const trackIds = new Set<string>()
  const clipIds = new Set<string>()
  const tracks = (tracksInput as unknown[]).map((value: unknown, index: number): EditProjectTrack => {
    const object = record(value, `tracks[${index}]`)
    const id = requiredString(object.id, `tracks[${index}].id`)
    if (trackIds.has(id)) invalid(`duplicate track id: ${id}`)
    trackIds.add(id)
    const kind = object.kind as unknown
    if (kind !== 'video' && kind !== 'audio' && kind !== 'caption' && kind !== 'text') invalid(`tracks[${index}].kind is unsupported`)
    if (!Array.isArray(object.clips)) invalid(`tracks[${index}].clips must be an array`)
    const clips = (object.clips as unknown[]).map((clip: unknown, clipIndex: number) => {
      const parsed = parseClip(clip, `tracks[${index}].clips[${clipIndex}]`)
      if (clipIds.has(parsed.id)) invalid(`duplicate clip id: ${parsed.id}`)
      clipIds.add(parsed.id)
      if (kind === 'video' && parsed.type !== 'video_clip') invalid(`video track contains ${parsed.type}`)
      if (kind === 'audio' && parsed.type !== 'audio_clip') invalid(`audio track contains ${parsed.type}`)
      return parsed
    })
    return {
      id,
      kind: kind as EditProjectTrack['kind'],
      ...(object.name === undefined ? {} : { name: requiredString(object.name, `tracks[${index}].name`) }),
      ...(object.enabled === undefined ? {} : { enabled: requiredBoolean(object.enabled, `tracks[${index}].enabled`) }),
      ...(object.locked === undefined ? {} : { locked: requiredBoolean(object.locked, `tracks[${index}].locked`) }),
      clips
    }
  })
  const captions = (captionsInput as unknown[]).map((value: unknown, index: number) => {
    const caption = parseCaption(value, `captions[${index}]`)
    if (clipIds.has(caption.id)) invalid(`duplicate clip/caption id: ${caption.id}`)
    clipIds.add(caption.id)
    if (caption.track_id && !trackIds.has(caption.track_id)) invalid(`caption ${caption.id} references missing track ${caption.track_id}`)
    return caption
  })

  for (const track of tracks) {
    for (const clip of track.clips) {
      const source = sourceMedia.find((item) => item.id === clip.source_media_id)
      if (!source) throw new EditProjectError('invalid_contract', `clip ${clip.id} references missing source media ${clip.source_media_id}`)
      if (Math.abs(clip.timeline.duration - clip.source.duration) > 0.000001) invalid(`clip ${clip.id} changes speed, which edit_project.v1 does not support`)
      if (clip.source.start + clip.source.duration > source.duration + 0.000001) invalid(`clip ${clip.id} exceeds source media duration`)
      if (clip.timeline.start + clip.timeline.duration > sequence.duration + 0.000001) invalid(`clip ${clip.id} exceeds sequence duration`)
      if (clip.type === 'video_clip' && (clip.transform.opacity < 0 || clip.transform.opacity > 1)) invalid(`clip ${clip.id} opacity must be between 0 and 1`)
      if (clip.type === 'audio_clip' && clip.volume < 0) invalid(`clip ${clip.id} volume must be >= 0`)
    }
  }
  for (const caption of captions) {
    if (caption.timeline.start + caption.timeline.duration > sequence.duration + 0.000001) invalid(`caption ${caption.id} exceeds sequence duration`)
  }

  const result: EditProjectDocument = {
    schema_version: EDIT_PROJECT_SCHEMA_VERSION,
    project: {
      id: requiredString(project.id, 'project.id'),
      name: requiredString(project.name, 'project.name'),
      ...(project.created_at === undefined ? {} : { created_at: requiredString(project.created_at, 'project.created_at') }),
      ...(project.updated_at === undefined ? {} : { updated_at: requiredString(project.updated_at, 'project.updated_at') }),
      ...(project.generator === undefined ? {} : { generator: isRecord(project.generator) ? project.generator : invalid('project.generator must be an object') })
    },
    source_media: sourceMedia,
    sequence,
    tracks,
    captions,
    ...(inputObject.metadata === undefined ? {} : { metadata: isRecord(inputObject.metadata) ? inputObject.metadata : invalid('metadata must be an object') })
  }
  return structuredClone(result)
}

const resolveSourcePath = (projectPath: string, mediaPath: string): string =>
  path.resolve(path.dirname(projectPath), mediaPath)

const sha256File = async (filePath: string): Promise<string> => {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

const toMicroseconds = (seconds: number): number => Math.round(seconds * 1_000_000)
const volumeToDb = (volume: number): number => volume <= 0 ? -96 : Math.max(-96, Math.min(24, 20 * Math.log10(volume)))

const captionStyle = (style: EditProjectCaptionStyle | undefined): SubtitleClip['style'] => ({
  ...structuredClone(DEFAULT_SUBTITLE_STYLE),
  ...(style?.font_name ? { fontFamily: style.font_name } : {}),
  ...(style?.font_size !== undefined ? { fontSize: style.font_size } : {}),
  ...(style?.primary_color ? { color: style.primary_color } : {}),
  ...(style?.outline_color ? { outlineColor: style.outline_color } : {}),
  ...(style?.outline !== undefined ? { outlineWidth: style.outline } : {}),
  ...(style?.position_x !== undefined && style.position_x !== null ? { positionX: style.position_x } : {}),
  ...(style?.position_y !== undefined && style.position_y !== null ? { positionY: style.position_y } : {}),
  ...(style?.alignment === 8 ? { alignment: 'top' as const } : style?.alignment === 5 ? { alignment: 'middle' as const } : {})
})

const supportedCaptionStyleKeys = new Set([
  'font_name', 'font_size', 'primary_color', 'outline_color', 'outline',
  'alignment', 'position_x', 'position_y'
])

const collectDiagnostics = (document: EditProjectDocument): string[] => document.captions.flatMap((caption) => {
  if (!caption.style) return []
  return Object.keys(caption.style)
    .filter((key) => !supportedCaptionStyleKeys.has(key))
    .map((key) => `Unsupported caption style key: ${caption.id}.${key}`)
})

const buildProjectModel = async (
  document: EditProjectDocument,
  projectPath: string,
  resolvedSourceMedia: ReadonlyMap<string, string>
): Promise<ProjectFile> => {
  const media = await Promise.all(document.source_media.map(async (source): Promise<MediaAsset> => {
    const sourcePath = resolvedSourceMedia.get(source.id)
    if (!sourcePath) throw new EditProjectError('source_missing', `Resolved source is missing: ${source.id}`, { projectPath })
    const file = await stat(sourcePath)
    return {
      id: source.id,
      name: path.basename(sourcePath),
      path: sourcePath,
      kind: source.kind,
      durationUs: toMicroseconds(source.duration),
      ...(source.width === undefined ? {} : { width: source.width }),
      ...(source.height === undefined ? {} : { height: source.height }),
      ...(source.fps === undefined ? {} : { frameRate: { numerator: Math.round(source.fps), denominator: 1 } }),
      ...(source.sample_rate === undefined ? {} : { sampleRate: Math.round(source.sample_rate) }),
      ...(source.channels === undefined ? {} : { channels: Math.round(source.channels) }),
      hasAudio: source.kind === 'video',
      fileSize: file.size,
      modifiedAt: file.mtime.toISOString(),
      offline: false
    }
  }))
  const tracks: TimelineTrack[] = document.tracks.map((track): TimelineTrack => ({
    id: track.id,
    name: track.name ?? track.id,
    kind: track.kind === 'caption' || track.kind === 'text' ? 'subtitle' : 'media',
    clips: track.clips.map((clip): TimelineClip => {
      const common = {
        id: clip.id,
        name: clip.id,
        startUs: toMicroseconds(clip.timeline.start),
        durationUs: toMicroseconds(clip.timeline.duration),
        sourceInUs: toMicroseconds(clip.source.start),
        enabled: clip.enabled
      }
      if (clip.type === 'video_clip') {
        if (Math.abs(clip.transform.scale_x - clip.transform.scale_y) > 0.000001) {
          throw new EditProjectError('unsupported_feature', `Non-uniform transform is not supported for clip ${clip.id}`, { projectPath })
        }
        const transform = {
          ...structuredClone(DEFAULT_TRANSFORM),
          positionX: clip.transform.x,
          positionY: clip.transform.y,
          scale: clip.transform.scale_x,
          rotation: clip.transform.rotation,
          opacity: clip.transform.opacity
        }
        const video: VideoClip = {
          ...common,
          kind: 'video',
          assetId: clip.source_media_id,
          transform,
          audio: structuredClone(DEFAULT_AUDIO),
          sourceAudioEnabled: false
        }
        return video
      }
      const audio: AudioClip = { ...common, kind: 'audio', assetId: clip.source_media_id, audio: { ...structuredClone(DEFAULT_AUDIO), volumeDb: volumeToDb(clip.volume) } }
      return audio
    }),
    locked: track.locked ?? false,
    muted: false,
    hidden: track.enabled === false
  }))
  const captionTrack = tracks.find((track) => track.kind === 'subtitle')
  const targetCaptionTrack: TimelineTrack = captionTrack ?? { id: 'C1', name: 'C1', kind: 'subtitle', clips: [], locked: false, muted: false, hidden: false }
  if (!captionTrack) tracks.push(targetCaptionTrack)
  for (const caption of document.captions) {
    const subtitleWords = caption.words?.map((word): SubtitleWord => ({
      id: word.id,
      text: word.text,
      startUs: toMicroseconds(word.timeline.start),
      endUs: toMicroseconds(word.timeline.start + word.timeline.duration)
    }))
    const subtitle: SubtitleClip = {
      id: caption.id,
      name: caption.text.slice(0, 32) || caption.id,
      kind: 'subtitle',
      startUs: toMicroseconds(caption.timeline.start),
      durationUs: toMicroseconds(caption.timeline.duration),
      sourceInUs: toMicroseconds(caption.source?.start ?? 0),
      enabled: caption.enabled,
      text: caption.text,
      style: captionStyle(caption.style),
      ...(subtitleWords ? { words: subtitleWords, editUnits: deriveSubtitleEditUnits(subtitleWords) } : {})
    }
    const destination = tracks.find((track) => track.id === (caption.track_id ?? targetCaptionTrack.id)) ?? targetCaptionTrack
    destination.clips.push(subtitle)
  }
  return validateProject(layoutSubtitleTracks({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    id: document.project.id,
    name: document.project.name,
    createdAt: document.project.created_at ?? new Date(0).toISOString(),
    updatedAt: document.project.updated_at ?? new Date(0).toISOString(),
    projectPath,
    projectFormat: 'edit_project_v1',
    sequence: {
      width: Math.round(document.sequence.width),
      height: Math.round(document.sequence.height),
      frameRate: { numerator: Math.round(document.sequence.fps), denominator: 1 },
      sampleRate: 48_000,
      backgroundColor: '#000000'
    },
    media,
    tracks
  }))
}

export const loadEditProject = async (projectPathInput: string, options: { verifyHashes?: boolean } = {}): Promise<LoadedEditProject> => {
  const projectPath = path.resolve(projectPathInput)
  const source = await readFile(projectPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(source) as unknown
  } catch (error) {
    throw new EditProjectError('invalid_contract', `edit_project JSON is invalid: ${error instanceof Error ? error.message : String(error)}`, { projectPath })
  }
  let document: EditProjectDocument
  try {
    document = validateEditProject(parsed)
  } catch (error) {
    if (error instanceof EditProjectError) throw new EditProjectError(error.code, error.message, { projectPath, details: error.details })
    throw error
  }
  const resolved = new Map<string, string>()
  const diagnostics = collectDiagnostics(document)
  for (const media of document.source_media) {
    const resolvedPath = resolveSourcePath(projectPath, media.path)
    try {
      const info = await stat(resolvedPath)
      if (!info.isFile()) throw new Error('not a regular file')
    } catch {
      throw new EditProjectError('source_missing', `Source media does not exist: ${resolvedPath}`, { projectPath, details: { media_id: media.id, path: resolvedPath } })
    }
    if (options.verifyHashes !== false && media.sha256) {
      const actual = await sha256File(resolvedPath)
      if (actual !== media.sha256) {
        throw new EditProjectError('source_hash_mismatch', `Source media SHA-256 mismatch: ${resolvedPath}`, {
          projectPath,
          details: { media_id: media.id, expected: media.sha256, actual }
        })
      }
    }
    resolved.set(media.id, resolvedPath)
  }
  const builtProject = await buildProjectModel(document, projectPath, resolved)
  const linked = inferLinkedAudioPairs(builtProject)
  return {
    projectPath,
    document,
    resolvedSourceMedia: resolved,
    project: linked.project,
    diagnostics: [...diagnostics, ...linked.diagnostics.map((item) => item.message)]
  }
}

export const isEditProjectDocument = (input: unknown): boolean => isRecord(input) && input.schema_version === EDIT_PROJECT_SCHEMA_VERSION
