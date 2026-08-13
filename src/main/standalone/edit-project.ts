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
  type TimelineClip,
  type TimelineTrack,
  type VideoClip
} from '../../shared/types.js'
import { validateProject } from '../../shared/project.js'

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

export interface EditProjectCaption {
  id: string
  track_id?: string
  text: string
  timeline: EditProjectTimeRange
  source: EditProjectTimeRange
  style?: EditProjectCaptionStyle
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
const positive = (value: unknown): value is number => finite(value) && value > 0
const nonNegative = (value: unknown): value is number => finite(value) && value >= 0
const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

const invalid = (message: string, details?: Record<string, unknown>): never => {
  throw new EditProjectError('invalid_contract', message, { details })
}

const requiredString = (value: unknown, label: string): string => {
  if (!nonEmptyString(value)) invalid(`${label} must be a non-empty string`)
  return value
}

const requiredNumber = (value: unknown, label: string, minimum = 0): number => {
  if (!finite(value) || value < minimum) invalid(`${label} must be a finite number >= ${minimum}`)
  return value
}

const requiredBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`)
  return value
}

const range = (value: unknown, label: string): EditProjectTimeRange => {
  if (!isRecord(value)) invalid(`${label} must be an object`)
  const start = requiredNumber(value.start, `${label}.start`)
  const duration = requiredNumber(value.duration, `${label}.duration`, Number.MIN_VALUE)
  return { start, duration }
}

const parseTransform = (value: unknown, label: string): EditProjectTransform => {
  if (!isRecord(value)) invalid(`${label} must be an object`)
  return {
    x: requiredNumber(value.x, `${label}.x`),
    y: requiredNumber(value.y, `${label}.y`),
    scale_x: requiredNumber(value.scale_x, `${label}.scale_x`, Number.MIN_VALUE),
    scale_y: requiredNumber(value.scale_y, `${label}.scale_y`, Number.MIN_VALUE),
    rotation: requiredNumber(value.rotation, `${label}.rotation`),
    opacity: requiredNumber(value.opacity, `${label}.opacity`),
    ...(value.anchor_x === undefined ? {} : { anchor_x: requiredNumber(value.anchor_x, `${label}.anchor_x`) }),
    ...(value.anchor_y === undefined ? {} : { anchor_y: requiredNumber(value.anchor_y, `${label}.anchor_y`) })
  }
}

const parseClip = (value: unknown, label: string): EditProjectClip => {
  if (!isRecord(value)) invalid(`${label} must be an object`)
  const id = requiredString(value.id, `${label}.id`)
  const type = requiredString(value.type, `${label}.type`)
  const sourceMediaId = requiredString(value.source_media_id, `${label}.source_media_id`)
  const timeline = range(value.timeline, `${label}.timeline`)
  const source = range(value.source, `${label}.source`)
  const enabled = requiredBoolean(value.enabled, `${label}.enabled`)
  if (type === 'video_clip') {
    return {
      id,
      type,
      source_media_id: sourceMediaId,
      timeline,
      source,
      transform: parseTransform(value.transform, `${label}.transform`),
      enabled
    }
  }
  if (type === 'audio_clip') {
    return { id, type, source_media_id: sourceMediaId, timeline, source, volume: requiredNumber(value.volume, `${label}.volume`), enabled }
  }
  invalid(`${label}.type is unsupported: ${type}`)
}

const parseCaption = (value: unknown, label: string): EditProjectCaption => {
  if (!isRecord(value)) invalid(`${label} must be an object`)
  const style = value.style
  if (style !== undefined && !isRecord(style)) invalid(`${label}.style must be an object`)
  return {
    id: requiredString(value.id, `${label}.id`),
    ...(value.track_id === undefined ? {} : { track_id: requiredString(value.track_id, `${label}.track_id`) }),
    text: typeof value.text === 'string' ? value.text : invalid(`${label}.text must be a string`),
    timeline: range(value.timeline, `${label}.timeline`),
    source: range(value.source, `${label}.source`),
    ...(style ? { style: style as EditProjectCaptionStyle } : {}),
    enabled: requiredBoolean(value.enabled, `${label}.enabled`)
  }
}

const isAbsoluteContractPath = (value: string): boolean => path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)

export const validateEditProject = (input: unknown): EditProjectDocument => {
  if (!isRecord(input)) invalid('edit_project must be a JSON object')
  const schema = input.schema_version
  if (schema !== EDIT_PROJECT_SCHEMA_VERSION) {
    const message = typeof schema === 'string' && /^edit_project\.\d+$/u.test(schema)
      ? `unsupported edit_project schema: ${schema}`
      : `schema_version must be ${EDIT_PROJECT_SCHEMA_VERSION}`
    throw new EditProjectError('unsupported_schema', message, { details: { schema_version: schema } })
  }
  const project = input.project
  if (!isRecord(project)) invalid('project metadata is required')
  const sourceMediaInput = input.source_media
  const tracksInput = input.tracks
  const captionsInput = input.captions
  if (!Array.isArray(sourceMediaInput) || sourceMediaInput.length === 0) invalid('source_media must be a non-empty array')
  if (!Array.isArray(tracksInput)) invalid('tracks must be an array')
  if (!Array.isArray(captionsInput)) invalid('captions must be an array')
  if (!isRecord(input.sequence)) invalid('sequence is required')
  const sequence: EditProjectSequence = {
    ...(input.sequence.id === undefined ? {} : { id: requiredString(input.sequence.id, 'sequence.id') }),
    width: requiredNumber(input.sequence.width, 'sequence.width', 1),
    height: requiredNumber(input.sequence.height, 'sequence.height', 1),
    fps: requiredNumber(input.sequence.fps, 'sequence.fps', Number.MIN_VALUE),
    ...(input.sequence.timebase === undefined ? {} : { timebase: input.sequence.timebase as EditProjectSequence['timebase'] }),
    duration: requiredNumber(input.sequence.duration, 'sequence.duration', Number.MIN_VALUE)
  }
  if (!Number.isInteger(sequence.width) || !Number.isInteger(sequence.height)) invalid('sequence width and height must be integers')

  const sourceIds = new Set<string>()
  const sourceMedia = sourceMediaInput.map((value, index): EditProjectSourceMedia => {
    if (!isRecord(value)) invalid(`source_media[${index}] must be an object`)
    const id = requiredString(value.id, `source_media[${index}].id`)
    if (sourceIds.has(id)) invalid(`duplicate source media id: ${id}`)
    sourceIds.add(id)
    const mediaPath = requiredString(value.path, `source_media[${index}].path`)
    if (!isAbsoluteContractPath(mediaPath) && mediaPath.includes('\\')) invalid(`source_media[${index}].path must use / separators`)
    const kind = value.kind
    if (kind !== 'video' && kind !== 'audio') invalid(`source_media[${index}].kind is unsupported`)
    const result: EditProjectSourceMedia = {
      id,
      path: mediaPath,
      kind,
      ...(value.sha256 === undefined ? {} : { sha256: requiredString(value.sha256, `source_media[${index}].sha256`).toLowerCase() }),
      duration: requiredNumber(value.duration, `source_media[${index}].duration`, Number.MIN_VALUE),
      ...(value.width === undefined ? {} : { width: requiredNumber(value.width, `source_media[${index}].width`, 1) }),
      ...(value.height === undefined ? {} : { height: requiredNumber(value.height, `source_media[${index}].height`, 1) }),
      ...(value.fps === undefined ? {} : { fps: requiredNumber(value.fps, `source_media[${index}].fps`, Number.MIN_VALUE) }),
      ...(value.sample_rate === undefined ? {} : { sample_rate: requiredNumber(value.sample_rate, `source_media[${index}].sample_rate`, 1) }),
      ...(value.channels === undefined ? {} : { channels: requiredNumber(value.channels, `source_media[${index}].channels`, 1) })
    }
    if (result.sha256 && !/^[0-9a-f]{64}$/u.test(result.sha256)) invalid(`source_media[${index}].sha256 must be SHA-256 hex`)
    return result
  })

  const trackIds = new Set<string>()
  const clipIds = new Set<string>()
  const tracks = tracksInput.map((value, index): EditProjectTrack => {
    if (!isRecord(value)) invalid(`tracks[${index}] must be an object`)
    const id = requiredString(value.id, `tracks[${index}].id`)
    if (trackIds.has(id)) invalid(`duplicate track id: ${id}`)
    trackIds.add(id)
    const kind = value.kind
    if (kind !== 'video' && kind !== 'audio' && kind !== 'caption' && kind !== 'text') invalid(`tracks[${index}].kind is unsupported`)
    if (!Array.isArray(value.clips)) invalid(`tracks[${index}].clips must be an array`)
    const clips = value.clips.map((clip, clipIndex) => {
      const parsed = parseClip(clip, `tracks[${index}].clips[${clipIndex}]`)
      if (clipIds.has(parsed.id)) invalid(`duplicate clip id: ${parsed.id}`)
      clipIds.add(parsed.id)
      if (kind === 'video' && parsed.type !== 'video_clip') invalid(`video track contains ${parsed.type}`)
      if (kind === 'audio' && parsed.type !== 'audio_clip') invalid(`audio track contains ${parsed.type}`)
      return parsed
    })
    return {
      id,
      kind,
      ...(value.name === undefined ? {} : { name: requiredString(value.name, `tracks[${index}].name`) }),
      ...(value.enabled === undefined ? {} : { enabled: requiredBoolean(value.enabled, `tracks[${index}].enabled`) }),
      ...(value.locked === undefined ? {} : { locked: requiredBoolean(value.locked, `tracks[${index}].locked`) }),
      clips
    }
  })
  const captions = captionsInput.map((value, index) => {
    const caption = parseCaption(value, `captions[${index}]`)
    if (clipIds.has(caption.id)) invalid(`duplicate clip/caption id: ${caption.id}`)
    clipIds.add(caption.id)
    if (caption.track_id && !trackIds.has(caption.track_id)) invalid(`caption ${caption.id} references missing track ${caption.track_id}`)
    return caption
  })

  for (const track of tracks) {
    for (const clip of track.clips) {
      const source = sourceMedia.find((item) => item.id === clip.source_media_id)
      if (!source) invalid(`clip ${clip.id} references missing source media ${clip.source_media_id}`)
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
      ...(project.generator === undefined ? {} : { generator: project.generator })
    },
    source_media: sourceMedia,
    sequence,
    tracks,
    captions,
    ...(input.metadata === undefined ? {} : { metadata: isRecord(input.metadata) ? input.metadata : invalid('metadata must be an object') })
  }
  return structuredClone(result)
}

const resolveSourcePath = (projectPath: string, mediaPath: string): string =>
  isAbsoluteContractPath(mediaPath) ? path.normalize(mediaPath) : path.resolve(path.dirname(projectPath), mediaPath)

const sha256File = async (filePath: string): Promise<string> => {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

const toMilliseconds = (seconds: number): number => Math.round(seconds * 1_000_000)
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
      kind: 'video',
      durationUs: toMilliseconds(source.duration),
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
    kind: track.kind === 'caption' || track.kind === 'text' ? 'subtitle' : track.kind,
    clips: track.clips.map((clip): TimelineClip => {
      const common = {
        id: clip.id,
        name: clip.id,
        startUs: toMilliseconds(clip.timeline.start),
        durationUs: toMilliseconds(clip.timeline.duration),
        sourceInUs: toMilliseconds(clip.source.start),
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
        const video: VideoClip = { ...common, kind: 'video', assetId: clip.source_media_id, transform, audio: structuredClone(DEFAULT_AUDIO) }
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
    const subtitle: SubtitleClip = {
      id: caption.id,
      name: caption.text.slice(0, 32) || caption.id,
      kind: 'subtitle',
      startUs: toMilliseconds(caption.timeline.start),
      durationUs: toMilliseconds(caption.timeline.duration),
      sourceInUs: toMilliseconds(caption.source.start),
      enabled: caption.enabled,
      text: caption.text,
      style: captionStyle(caption.style)
    }
    const destination = tracks.find((track) => track.id === (caption.track_id ?? targetCaptionTrack.id)) ?? targetCaptionTrack
    destination.clips.push(subtitle)
  }
  return validateProject({
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
  })
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
  const diagnostics: string[] = []
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
  const project = await buildProjectModel(document, projectPath, resolved)
  return { projectPath, document, resolvedSourceMedia: resolved, project, diagnostics }
}

export const isEditProjectDocument = (input: unknown): boolean => isRecord(input) && input.schema_version === EDIT_PROJECT_SCHEMA_VERSION
