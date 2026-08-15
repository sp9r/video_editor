import {
  DEFAULT_SUBTITLE_STYLE,
  type AudioSettings,
  type ProjectFile,
  type TimelineClip,
  type TimelineTrack,
  type TransformSettings
} from './types.js'
import { isMediaTrack } from './types.js'
import { deriveSubtitleEditUnits } from './editing/edit-units.js'

/**
 * The automation boundary is deliberately narrower than ProjectFile. Providers
 * receive this path-free summary and may only return the edit commands below.
 */
export const AUTOMATION_SCHEMA_VERSION = 1 as const
export const MAX_AUTOMATION_COMMANDS = 20_000
export const MAX_AUTOMATION_TEXT_LENGTH = 100_000

const MAX_TIME_US = 7 * 24 * 60 * 60 * 1_000_000
const MAX_CONTEXT_ITEMS = 20_000
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export type AiProviderKind = 'whisper' | 'local-llm' | 'openai-compatible' | 'codex' | 'mock' | 'custom'
export type AiCapability = 'transcription' | 'edit-suggestion' | 'text-generation'
export type AiHealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'unknown'

export interface AiProviderDescriptor {
  id: string
  displayName: string
  kind: AiProviderKind
  capabilities: readonly AiCapability[]
  local: boolean
  description?: string
}

export interface AiProviderHealth {
  providerId: string
  status: AiHealthStatus
  checkedAt: string
  latencyMs?: number
  message?: string
  details?: Readonly<Record<string, string | number | boolean | null>>
}

export interface AutomationTimeRange {
  startUs: number
  endUs: number
}

export interface AutomationClipContext {
  id: string
  trackId: string
  name: string
  kind: TimelineClip['kind']
  startUs: number
  durationUs: number
  sourceInUs: number
  enabled: boolean
  assetId?: string
  text?: string
}

export interface AutomationProjectContext {
  projectId: string
  projectName: string
  updatedAt: string
  sequence: {
    width: number
    height: number
    frameRate: { numerator: number; denominator: number }
    sampleRate: number
  }
  tracks: ReadonlyArray<{
    id: string
    name: string
    kind: TimelineTrack['kind']
    locked: boolean
    muted: boolean
    hidden: boolean
  }>
  clips: readonly AutomationClipContext[]
  assets: ReadonlyArray<{
    id: string
    name: string
    kind: 'video' | 'audio' | 'image'
    durationUs: number
    offline: boolean
  }>
}

interface AiJobBase {
  jobId: string
  capability: AiCapability
  providerId?: string
}

export interface TranscriptionJobRequest extends AiJobBase {
  capability: 'transcription'
  input: {
    assetId: string
    language?: string
    range?: AutomationTimeRange
    prompt?: string
  }
}

export interface EditSuggestionJobRequest extends AiJobBase {
  capability: 'edit-suggestion'
  input: {
    instruction: string
    project: AutomationProjectContext
    selection?: { clipIds: readonly string[]; range?: AutomationTimeRange }
  }
}

export interface TextGenerationJobRequest extends AiJobBase {
  capability: 'text-generation'
  input: {
    instruction: string
    context?: string
  }
}

export type AiJobRequest = TranscriptionJobRequest | EditSuggestionJobRequest | TextGenerationJobRequest

export interface TranscriptSegment {
  startUs: number
  endUs: number
  text: string
  confidence?: number
  speaker?: string
  words?: readonly TranscriptWord[]
}

export interface TranscriptWord {
  id: string
  text: string
  startUs: number
  endUs: number
}

export interface TranscriptAiOutput {
  kind: 'transcript'
  language?: string
  text?: string
  segments: readonly TranscriptSegment[]
}

export interface TextAiOutput {
  kind: 'text'
  text: string
}

export interface InsertSubtitleCommand {
  type: 'insert-subtitle'
  trackId: string
  clipId: string
  startUs: number
  durationUs: number
  text: string
  words?: readonly TranscriptWord[]
}

export interface UpdateSubtitleCommand {
  type: 'update-subtitle'
  clipId: string
  text: string
}

export interface DeleteClipsCommand {
  type: 'delete-clips'
  clipIds: readonly string[]
}

export interface MoveClipCommand {
  type: 'move-clip'
  clipId: string
  targetTrackId: string
  startUs: number
}

export interface TrimClipCommand {
  type: 'trim-clip'
  clipId: string
  startUs: number
  durationUs: number
  sourceInUs: number
}

export interface SplitClipCommand {
  type: 'split-clip'
  clipId: string
  rightClipId: string
  atUs: number
}

export interface SetTransformCommand {
  type: 'set-transform'
  clipId: string
  patch: Partial<Omit<TransformSettings, 'crop'>> & { crop?: Partial<TransformSettings['crop']> }
}

export interface SetAudioCommand {
  type: 'set-audio'
  clipId: string
  patch: Partial<AudioSettings>
}

export type AutomationEditCommand =
  | InsertSubtitleCommand
  | UpdateSubtitleCommand
  | DeleteClipsCommand
  | MoveClipCommand
  | TrimClipCommand
  | SplitClipCommand
  | SetTransformCommand
  | SetAudioCommand

export interface AutomationProposal {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  title: string
  commands: readonly AutomationEditCommand[]
}

export interface AiAutomationProposal {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  title: string
  /** Untrusted model data; validateAutomationProposal turns these into project-aware commands. */
  commands: readonly unknown[]
}

export interface EditProposalAiOutput {
  kind: 'edit-proposal'
  proposal: AiAutomationProposal
}

export type AiProviderOutput = TranscriptAiOutput | EditProposalAiOutput | TextAiOutput

export interface AutomationPreview {
  previewId: string
  baseProjectId: string
  baseUpdatedAt: string
  plan: AutomationProposal
  project: ProjectFile
  summaries: readonly string[]
}

export interface AutomationUndoToken {
  changeId: string
  projectId: string
  expectedUpdatedAt: string
  previousProject: ProjectFile
}

export interface AutomationApplyResult {
  project: ProjectFile
  undo: AutomationUndoToken
}

const clone = <T>(value: T): T => structuredClone(value)

const newId = (prefix: string): string => {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${suffix}`
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => 'value' in descriptor && typeof descriptor.value !== 'function'
  )
}

const ownValue = (record: Record<string, unknown>, key: string): unknown =>
  Object.getOwnPropertyDescriptor(record, key)?.value

const assertKeys = (record: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains unsupported field: ${key}`)
  }
}

const requiredString = (value: unknown, label: string, maxLength = 10_000): string => {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) throw new Error(`${label} has an invalid length`)
  return trimmed
}

const optionalString = (value: unknown, label: string, maxLength = 10_000): string | undefined => {
  if (value === undefined) return undefined
  return requiredString(value, label, maxLength)
}

const identifier = (value: unknown, label: string): string => {
  const result = requiredString(value, label, 128)
  if (!ID_PATTERN.test(result)) throw new Error(`${label} is not a valid identifier`)
  return result
}

const integer = (value: unknown, label: string, minimum = 0, maximum = MAX_TIME_US): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value as number
}

const finiteNumber = (value: unknown, label: string, minimum: number, maximum: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`)
  }
  return value
}

const requiredBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

const parseRange = (value: unknown, label: string): AutomationTimeRange => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertKeys(value, ['startUs', 'endUs'], label)
  const startUs = integer(ownValue(value, 'startUs'), `${label}.startUs`)
  const endUs = integer(ownValue(value, 'endUs'), `${label}.endUs`, 1)
  if (endUs <= startUs) throw new Error(`${label} has an invalid range`)
  return { startUs, endUs }
}

const parseProjectContext = (value: unknown): AutomationProjectContext => {
  if (!isRecord(value)) throw new Error('job.input.project must be an object')
  assertKeys(value, ['projectId', 'projectName', 'updatedAt', 'sequence', 'tracks', 'clips', 'assets'], 'job.input.project')
  const sequenceValue = ownValue(value, 'sequence')
  if (!isRecord(sequenceValue)) throw new Error('job.input.project.sequence must be an object')
  assertKeys(sequenceValue, ['width', 'height', 'frameRate', 'sampleRate'], 'job.input.project.sequence')
  const frameRateValue = ownValue(sequenceValue, 'frameRate')
  if (!isRecord(frameRateValue)) throw new Error('job.input.project.sequence.frameRate must be an object')
  assertKeys(frameRateValue, ['numerator', 'denominator'], 'job.input.project.sequence.frameRate')

  const rawTracks = ownValue(value, 'tracks')
  const rawClips = ownValue(value, 'clips')
  const rawAssets = ownValue(value, 'assets')
  if (!Array.isArray(rawTracks) || rawTracks.length > MAX_CONTEXT_ITEMS) throw new Error('job project tracks are invalid')
  if (!Array.isArray(rawClips) || rawClips.length > MAX_CONTEXT_ITEMS) throw new Error('job project clips are invalid')
  if (!Array.isArray(rawAssets) || rawAssets.length > MAX_CONTEXT_ITEMS) throw new Error('job project assets are invalid')

  const tracks = rawTracks.map((raw, index): AutomationProjectContext['tracks'][number] => {
    if (!isRecord(raw)) throw new Error(`job project tracks[${index}] must be an object`)
    assertKeys(raw, ['id', 'name', 'kind', 'locked', 'muted', 'hidden'], `job project tracks[${index}]`)
    const kind = ownValue(raw, 'kind')
    if (kind !== 'video' && kind !== 'audio' && kind !== 'subtitle') throw new Error(`job project tracks[${index}].kind is invalid`)
    return {
      id: identifier(ownValue(raw, 'id'), `job project tracks[${index}].id`),
      name: requiredString(ownValue(raw, 'name'), `job project tracks[${index}].name`, 500),
      kind,
      locked: requiredBoolean(ownValue(raw, 'locked'), `job project tracks[${index}].locked`),
      muted: requiredBoolean(ownValue(raw, 'muted'), `job project tracks[${index}].muted`),
      hidden: requiredBoolean(ownValue(raw, 'hidden'), `job project tracks[${index}].hidden`)
    }
  })
  const trackIds = new Set(tracks.map((track) => track.id))

  const clips = rawClips.map((raw, index): AutomationClipContext => {
    if (!isRecord(raw)) throw new Error(`job project clips[${index}] must be an object`)
    assertKeys(
      raw,
      ['id', 'trackId', 'name', 'kind', 'startUs', 'durationUs', 'sourceInUs', 'enabled', 'assetId', 'text'],
      `job project clips[${index}]`
    )
    const kind = ownValue(raw, 'kind')
    if (kind !== 'video' && kind !== 'audio' && kind !== 'image' && kind !== 'subtitle') {
      throw new Error(`job project clips[${index}].kind is invalid`)
    }
    const trackId = identifier(ownValue(raw, 'trackId'), `job project clips[${index}].trackId`)
    if (!trackIds.has(trackId)) throw new Error(`job project clips[${index}] references an unknown track`)
    const assetId = optionalString(ownValue(raw, 'assetId'), `job project clips[${index}].assetId`, 128)
    const text = optionalString(ownValue(raw, 'text'), `job project clips[${index}].text`, MAX_AUTOMATION_TEXT_LENGTH)
    if (kind === 'subtitle' && !text) throw new Error(`job project clips[${index}] is missing subtitle text`)
    if (kind !== 'subtitle' && !assetId) throw new Error(`job project clips[${index}] is missing assetId`)
    return {
      id: identifier(ownValue(raw, 'id'), `job project clips[${index}].id`),
      trackId,
      name: requiredString(ownValue(raw, 'name'), `job project clips[${index}].name`, 500),
      kind,
      startUs: integer(ownValue(raw, 'startUs'), `job project clips[${index}].startUs`),
      durationUs: integer(ownValue(raw, 'durationUs'), `job project clips[${index}].durationUs`, 1),
      sourceInUs: integer(ownValue(raw, 'sourceInUs'), `job project clips[${index}].sourceInUs`),
      enabled: requiredBoolean(ownValue(raw, 'enabled'), `job project clips[${index}].enabled`),
      ...(assetId ? { assetId: identifier(assetId, `job project clips[${index}].assetId`) } : {}),
      ...(text ? { text } : {})
    }
  })

  const assets = rawAssets.map((raw, index): AutomationProjectContext['assets'][number] => {
    if (!isRecord(raw)) throw new Error(`job project assets[${index}] must be an object`)
    assertKeys(raw, ['id', 'name', 'kind', 'durationUs', 'offline'], `job project assets[${index}]`)
    const kind = ownValue(raw, 'kind')
    if (kind !== 'video' && kind !== 'audio' && kind !== 'image') throw new Error(`job project assets[${index}].kind is invalid`)
    return {
      id: identifier(ownValue(raw, 'id'), `job project assets[${index}].id`),
      name: requiredString(ownValue(raw, 'name'), `job project assets[${index}].name`, 500),
      kind,
      durationUs: integer(ownValue(raw, 'durationUs'), `job project assets[${index}].durationUs`),
      offline: requiredBoolean(ownValue(raw, 'offline'), `job project assets[${index}].offline`)
    }
  })

  return {
    projectId: identifier(ownValue(value, 'projectId'), 'job.input.project.projectId'),
    projectName: requiredString(ownValue(value, 'projectName'), 'job.input.project.projectName', 500),
    updatedAt: requiredString(ownValue(value, 'updatedAt'), 'job.input.project.updatedAt', 100),
    sequence: {
      width: integer(ownValue(sequenceValue, 'width'), 'job project width', 16, 16_384),
      height: integer(ownValue(sequenceValue, 'height'), 'job project height', 16, 16_384),
      frameRate: {
        numerator: integer(ownValue(frameRateValue, 'numerator'), 'job project frame rate numerator', 1, 1_000_000),
        denominator: integer(ownValue(frameRateValue, 'denominator'), 'job project frame rate denominator', 1, 1_000_000)
      },
      sampleRate: integer(ownValue(sequenceValue, 'sampleRate'), 'job project sample rate', 1, 384_000)
    },
    tracks,
    clips,
    assets
  }
}

/** Runtime validation for IPC/config input before a request reaches any provider. */
export const validateAiJobRequest = (input: unknown): AiJobRequest => {
  if (!isRecord(input)) throw new Error('AI job request must be an object')
  assertKeys(input, ['jobId', 'capability', 'providerId', 'input'], 'AI job request')
  const jobId = identifier(ownValue(input, 'jobId'), 'jobId')
  const providerIdValue = ownValue(input, 'providerId')
  const providerId = providerIdValue === undefined ? undefined : identifier(providerIdValue, 'providerId')
  const capability = ownValue(input, 'capability')
  const jobInput = ownValue(input, 'input')
  if (!isRecord(jobInput)) throw new Error('job.input must be an object')

  if (capability === 'transcription') {
    assertKeys(jobInput, ['assetId', 'language', 'range', 'prompt'], 'transcription input')
    const rangeValue = ownValue(jobInput, 'range')
    return {
      jobId,
      capability,
      ...(providerId ? { providerId } : {}),
      input: {
        assetId: identifier(ownValue(jobInput, 'assetId'), 'job.input.assetId'),
        ...(ownValue(jobInput, 'language') === undefined
          ? {}
          : { language: requiredString(ownValue(jobInput, 'language'), 'job.input.language', 35) }),
        ...(rangeValue === undefined ? {} : { range: parseRange(rangeValue, 'job.input.range') }),
        ...(ownValue(jobInput, 'prompt') === undefined
          ? {}
          : { prompt: requiredString(ownValue(jobInput, 'prompt'), 'job.input.prompt', 10_000) })
      }
    }
  }
  if (capability === 'edit-suggestion') {
    assertKeys(jobInput, ['instruction', 'project', 'selection'], 'edit suggestion input')
    const selectionValue = ownValue(jobInput, 'selection')
    let selection: EditSuggestionJobRequest['input']['selection']
    if (selectionValue !== undefined) {
      if (!isRecord(selectionValue)) throw new Error('job.input.selection must be an object')
      assertKeys(selectionValue, ['clipIds', 'range'], 'job.input.selection')
      const rawClipIds = ownValue(selectionValue, 'clipIds')
      if (!Array.isArray(rawClipIds) || rawClipIds.length > MAX_CONTEXT_ITEMS) throw new Error('selection.clipIds is invalid')
      const rangeValue = ownValue(selectionValue, 'range')
      selection = {
        clipIds: [...new Set(rawClipIds.map((id, index) => identifier(id, `selection.clipIds[${index}]`)))],
        ...(rangeValue === undefined ? {} : { range: parseRange(rangeValue, 'job.input.selection.range') })
      }
    }
    return {
      jobId,
      capability,
      ...(providerId ? { providerId } : {}),
      input: {
        instruction: requiredString(ownValue(jobInput, 'instruction'), 'job.input.instruction', MAX_AUTOMATION_TEXT_LENGTH),
        project: parseProjectContext(ownValue(jobInput, 'project')),
        ...(selection ? { selection } : {})
      }
    }
  }
  if (capability === 'text-generation') {
    assertKeys(jobInput, ['instruction', 'context'], 'text generation input')
    return {
      jobId,
      capability,
      ...(providerId ? { providerId } : {}),
      input: {
        instruction: requiredString(ownValue(jobInput, 'instruction'), 'job.input.instruction', MAX_AUTOMATION_TEXT_LENGTH),
        ...(ownValue(jobInput, 'context') === undefined
          ? {}
          : { context: requiredString(ownValue(jobInput, 'context'), 'job.input.context', MAX_AUTOMATION_TEXT_LENGTH) })
      }
    }
  }
  throw new Error(`Unsupported AI capability: ${String(capability)}`)
}

const assertProjectShape = (project: ProjectFile): void => {
  if (!isRecord(project) || !identifier(project.id, 'project.id') || !Array.isArray(project.tracks)) {
    throw new Error('Project is invalid')
  }
  if (!Array.isArray(project.media) || !isRecord(project.sequence)) throw new Error('Project is invalid')
  const clipIds = new Set<string>()
  for (const track of project.tracks) {
    if (!isRecord(track) || !identifier(track.id, 'track.id') || !Array.isArray(track.clips)) {
      throw new Error('Project track is invalid')
    }
    for (const clip of track.clips) {
      if (!isRecord(clip)) throw new Error('Project clip is invalid')
      const clipId = identifier(clip.id, 'clip.id')
      if (clipIds.has(clipId)) throw new Error(`Duplicate clip id: ${clipId}`)
      clipIds.add(clipId)
      integer(clip.startUs, `${clipId}.startUs`)
      integer(clip.durationUs, `${clipId}.durationUs`, 1)
      integer(clip.sourceInUs, `${clipId}.sourceInUs`)
    }
  }
}

const findTrack = (project: ProjectFile, trackId: string): TimelineTrack => {
  const track = project.tracks.find((candidate) => candidate.id === trackId)
  if (!track) throw new Error(`Track does not exist: ${trackId}`)
  return track
}

const findClip = (project: ProjectFile, clipId: string): { track: TimelineTrack; index: number; clip: TimelineClip } => {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((candidate) => candidate.id === clipId)
    const clip = track.clips[index]
    if (clip) return { track, index, clip }
  }
  throw new Error(`Clip does not exist: ${clipId}`)
}

const assertUnlocked = (track: TimelineTrack): void => {
  if (track.locked) throw new Error(`Track is locked: ${track.id}`)
}

const trackAcceptsClip = (track: TimelineTrack, clip: TimelineClip): boolean =>
  (isMediaTrack(track) && clip.kind !== 'subtitle') ||
  (track.kind === 'subtitle' && clip.kind === 'subtitle')

const ensureNoClipId = (project: ProjectFile, clipId: string): void => {
  if (project.tracks.some((track) => track.clips.some((clip) => clip.id === clipId))) {
    throw new Error(`Clip id already exists: ${clipId}`)
  }
}

const parseTransformPatch = (value: unknown): SetTransformCommand['patch'] => {
  if (!isRecord(value)) throw new Error('set-transform.patch must be an object')
  assertKeys(value, ['positionX', 'positionY', 'scale', 'rotation', 'opacity', 'crop'], 'set-transform.patch')
  const patch: SetTransformCommand['patch'] = {}
  if (ownValue(value, 'positionX') !== undefined) patch.positionX = finiteNumber(ownValue(value, 'positionX'), 'positionX', -100_000, 100_000)
  if (ownValue(value, 'positionY') !== undefined) patch.positionY = finiteNumber(ownValue(value, 'positionY'), 'positionY', -100_000, 100_000)
  if (ownValue(value, 'scale') !== undefined) patch.scale = finiteNumber(ownValue(value, 'scale'), 'scale', 0.001, 100)
  if (ownValue(value, 'rotation') !== undefined) patch.rotation = finiteNumber(ownValue(value, 'rotation'), 'rotation', -36_000, 36_000)
  if (ownValue(value, 'opacity') !== undefined) patch.opacity = finiteNumber(ownValue(value, 'opacity'), 'opacity', 0, 1)
  const cropValue = ownValue(value, 'crop')
  if (cropValue !== undefined) {
    if (!isRecord(cropValue)) throw new Error('crop must be an object')
    assertKeys(cropValue, ['left', 'top', 'right', 'bottom'], 'crop')
    const crop: Partial<TransformSettings['crop']> = {}
    for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
      const edgeValue = ownValue(cropValue, edge)
      if (edgeValue !== undefined) crop[edge] = finiteNumber(edgeValue, `crop.${edge}`, 0, 1)
    }
    if (Object.keys(crop).length === 0) throw new Error('crop patch is empty')
    patch.crop = crop
  }
  if (Object.keys(patch).length === 0) throw new Error('set-transform.patch is empty')
  return patch
}

const parseAudioPatch = (value: unknown): SetAudioCommand['patch'] => {
  if (!isRecord(value)) throw new Error('set-audio.patch must be an object')
  assertKeys(value, ['volumeDb', 'pan', 'fadeInUs', 'fadeOutUs'], 'set-audio.patch')
  const patch: SetAudioCommand['patch'] = {}
  if (ownValue(value, 'volumeDb') !== undefined) patch.volumeDb = finiteNumber(ownValue(value, 'volumeDb'), 'volumeDb', -96, 24)
  if (ownValue(value, 'pan') !== undefined) patch.pan = finiteNumber(ownValue(value, 'pan'), 'pan', -1, 1)
  if (ownValue(value, 'fadeInUs') !== undefined) patch.fadeInUs = integer(ownValue(value, 'fadeInUs'), 'fadeInUs')
  if (ownValue(value, 'fadeOutUs') !== undefined) patch.fadeOutUs = integer(ownValue(value, 'fadeOutUs'), 'fadeOutUs')
  if (Object.keys(patch).length === 0) throw new Error('set-audio.patch is empty')
  return patch
}

const parseCommand = (value: unknown, project: ProjectFile): AutomationEditCommand => {
  if (!isRecord(value)) throw new Error('Automation command must be an object')
  const type = requiredString(ownValue(value, 'type'), 'command.type', 64)

  switch (type) {
    case 'insert-subtitle': {
      assertKeys(value, ['type', 'trackId', 'clipId', 'startUs', 'durationUs', 'text', 'words'], type)
      const trackId = identifier(ownValue(value, 'trackId'), 'trackId')
      const track = findTrack(project, trackId)
      assertUnlocked(track)
      if (track.kind !== 'subtitle') throw new Error(`${trackId} is not a subtitle track`)
      const suppliedId = ownValue(value, 'clipId')
      const clipId = suppliedId === undefined ? newId('ai-caption') : identifier(suppliedId, 'clipId')
      ensureNoClipId(project, clipId)
      const startUs = integer(ownValue(value, 'startUs'), 'startUs')
      const durationUs = integer(ownValue(value, 'durationUs'), 'durationUs', 1)
      const wordsValue = ownValue(value, 'words')
      let words: TranscriptWord[] | undefined
      if (wordsValue !== undefined) {
        if (!Array.isArray(wordsValue) || wordsValue.length === 0) throw new Error('words must be a non-empty array')
        words = wordsValue.map((rawWord, index) => parseTranscriptWord(rawWord, `words[${index}]`))
        if (words.map((word) => word.text).join('') !== requiredString(ownValue(value, 'text'), 'text', MAX_AUTOMATION_TEXT_LENGTH)) {
          throw new Error('words must reconstruct subtitle text')
        }
        const endUs = startUs + durationUs
        if (words.some((word) => word.startUs < startUs || word.endUs > endUs)) {
          throw new Error('words must fit inside subtitle timing')
        }
      }
      return {
        type,
        trackId,
        clipId,
        startUs,
        durationUs,
        text: requiredString(ownValue(value, 'text'), 'text', MAX_AUTOMATION_TEXT_LENGTH),
        ...(words ? { words } : {})
      }
    }
    case 'update-subtitle': {
      assertKeys(value, ['type', 'clipId', 'text'], type)
      const clipId = identifier(ownValue(value, 'clipId'), 'clipId')
      const { track, clip } = findClip(project, clipId)
      assertUnlocked(track)
      if (clip.kind !== 'subtitle') throw new Error(`${clipId} is not a subtitle clip`)
      return { type, clipId, text: requiredString(ownValue(value, 'text'), 'text', MAX_AUTOMATION_TEXT_LENGTH) }
    }
    case 'delete-clips': {
      assertKeys(value, ['type', 'clipIds'], type)
      const rawIds = ownValue(value, 'clipIds')
      if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MAX_AUTOMATION_COMMANDS) {
        throw new Error('clipIds must be a non-empty array')
      }
      const clipIds = [...new Set(rawIds.map((id, index) => identifier(id, `clipIds[${index}]`)))]
      for (const clipId of clipIds) assertUnlocked(findClip(project, clipId).track)
      return { type, clipIds }
    }
    case 'move-clip': {
      assertKeys(value, ['type', 'clipId', 'targetTrackId', 'startUs'], type)
      const clipId = identifier(ownValue(value, 'clipId'), 'clipId')
      const targetTrackId = identifier(ownValue(value, 'targetTrackId'), 'targetTrackId')
      const source = findClip(project, clipId)
      const target = findTrack(project, targetTrackId)
      assertUnlocked(source.track)
      assertUnlocked(target)
      if (!trackAcceptsClip(target, source.clip)) throw new Error(`${targetTrackId} cannot contain ${source.clip.kind} clips`)
      return { type, clipId, targetTrackId, startUs: integer(ownValue(value, 'startUs'), 'startUs') }
    }
    case 'trim-clip': {
      assertKeys(value, ['type', 'clipId', 'startUs', 'durationUs', 'sourceInUs'], type)
      const clipId = identifier(ownValue(value, 'clipId'), 'clipId')
      const { track, clip } = findClip(project, clipId)
      assertUnlocked(track)
      const startUs = integer(ownValue(value, 'startUs'), 'startUs')
      const durationUs = integer(ownValue(value, 'durationUs'), 'durationUs', 1)
      const sourceInUs = integer(ownValue(value, 'sourceInUs'), 'sourceInUs')
      if (startUs + durationUs > MAX_TIME_US || sourceInUs + durationUs > MAX_TIME_US) throw new Error('Trim range is too large')
      if ('assetId' in clip) {
        const asset = project.media.find((candidate) => candidate.id === clip.assetId)
        if (asset && asset.durationUs > 0 && sourceInUs + durationUs > asset.durationUs) {
          throw new Error(`Trim exceeds source media: ${clip.assetId}`)
        }
      }
      return { type, clipId, startUs, durationUs, sourceInUs }
    }
    case 'split-clip': {
      assertKeys(value, ['type', 'clipId', 'rightClipId', 'atUs'], type)
      const clipId = identifier(ownValue(value, 'clipId'), 'clipId')
      const { track, clip } = findClip(project, clipId)
      assertUnlocked(track)
      const atUs = integer(ownValue(value, 'atUs'), 'atUs')
      if (atUs <= clip.startUs || atUs >= clip.startUs + clip.durationUs) throw new Error('Split point must be inside the clip')
      const suppliedId = ownValue(value, 'rightClipId')
      const rightClipId = suppliedId === undefined ? newId('ai-split') : identifier(suppliedId, 'rightClipId')
      ensureNoClipId(project, rightClipId)
      return { type, clipId, rightClipId, atUs }
    }
    case 'set-transform': {
      assertKeys(value, ['type', 'clipId', 'patch'], type)
      const clipId = identifier(ownValue(value, 'clipId'), 'clipId')
      const { track, clip } = findClip(project, clipId)
      assertUnlocked(track)
      if (clip.kind !== 'video' && clip.kind !== 'image') throw new Error(`${clipId} has no transform`)
      return { type, clipId, patch: parseTransformPatch(ownValue(value, 'patch')) }
    }
    case 'set-audio': {
      assertKeys(value, ['type', 'clipId', 'patch'], type)
      const clipId = identifier(ownValue(value, 'clipId'), 'clipId')
      const { track, clip } = findClip(project, clipId)
      assertUnlocked(track)
      if (clip.kind !== 'video' && clip.kind !== 'audio') throw new Error(`${clipId} has no audio settings`)
      const patch = parseAudioPatch(ownValue(value, 'patch'))
      if ((patch.fadeInUs ?? 0) > clip.durationUs || (patch.fadeOutUs ?? 0) > clip.durationUs) {
        throw new Error('Audio fade cannot exceed clip duration')
      }
      return { type, clipId, patch }
    }
    default:
      throw new Error(`Unsupported automation command: ${type}`)
  }
}

const applyCommandMutable = (project: ProjectFile, command: AutomationEditCommand): void => {
  switch (command.type) {
    case 'insert-subtitle': {
      const track = findTrack(project, command.trackId)
      track.clips.push({
        id: command.clipId,
        name: command.text.slice(0, 40),
        kind: 'subtitle',
        startUs: command.startUs,
        durationUs: command.durationUs,
        sourceInUs: 0,
        enabled: true,
        text: command.text,
        style: clone(DEFAULT_SUBTITLE_STYLE),
        ...(command.words?.length
          ? {
              words: command.words.map((word) => ({ ...word })),
              editUnits: deriveSubtitleEditUnits(command.words.map((word) => ({ ...word })))
            }
          : {})
      })
      track.clips.sort((left, right) => left.startUs - right.startUs)
      return
    }
    case 'update-subtitle': {
      const { clip } = findClip(project, command.clipId)
      if (clip.kind !== 'subtitle') throw new Error(`${command.clipId} is not a subtitle clip`)
      clip.text = command.text
      clip.name = command.text.slice(0, 40)
      return
    }
    case 'delete-clips': {
      const ids = new Set(command.clipIds)
      for (const track of project.tracks) track.clips = track.clips.filter((clip) => !ids.has(clip.id))
      return
    }
    case 'move-clip': {
      const { track: sourceTrack, index, clip } = findClip(project, command.clipId)
      const targetTrack = findTrack(project, command.targetTrackId)
      sourceTrack.clips.splice(index, 1)
      clip.startUs = command.startUs
      targetTrack.clips.push(clip)
      targetTrack.clips.sort((left, right) => left.startUs - right.startUs)
      return
    }
    case 'trim-clip': {
      const { clip } = findClip(project, command.clipId)
      clip.startUs = command.startUs
      clip.durationUs = command.durationUs
      clip.sourceInUs = command.sourceInUs
      return
    }
    case 'split-clip': {
      const { track, index, clip } = findClip(project, command.clipId)
      const leftDuration = command.atUs - clip.startUs
      const right = clone(clip)
      clip.durationUs = leftDuration
      right.id = command.rightClipId
      right.name = `${clip.name} (AI split)`
      right.startUs = command.atUs
      right.durationUs -= leftDuration
      right.sourceInUs += leftDuration
      track.clips.splice(index + 1, 0, right)
      return
    }
    case 'set-transform': {
      const { clip } = findClip(project, command.clipId)
      if (clip.kind !== 'video' && clip.kind !== 'image') throw new Error(`${command.clipId} has no transform`)
      const crop = command.patch.crop ? { ...clip.transform.crop, ...command.patch.crop } : clip.transform.crop
      clip.transform = { ...clip.transform, ...command.patch, crop }
      return
    }
    case 'set-audio': {
      const { clip } = findClip(project, command.clipId)
      if (clip.kind !== 'video' && clip.kind !== 'audio') throw new Error(`${command.clipId} has no audio settings`)
      clip.audio = { ...clip.audio, ...command.patch }
    }
  }
}

const proposalRecord = (input: unknown): Record<string, unknown> => {
  if (!isRecord(input)) throw new Error('Automation proposal must be an object')
  assertKeys(input, ['schemaVersion', 'title', 'commands'], 'Automation proposal')
  if (ownValue(input, 'schemaVersion') !== AUTOMATION_SCHEMA_VERSION) {
    throw new Error(`Unsupported automation schema: ${String(ownValue(input, 'schemaVersion'))}`)
  }
  return input
}

export const createAutomationProjectContext = (project: ProjectFile): AutomationProjectContext => {
  assertProjectShape(project)
  return {
    projectId: project.id,
    projectName: project.name,
    updatedAt: project.updatedAt,
    sequence: {
      width: project.sequence.width,
      height: project.sequence.height,
      frameRate: clone(project.sequence.frameRate),
      sampleRate: project.sequence.sampleRate
    },
    tracks: project.tracks.map(({ id, name, kind, locked, muted, hidden }) => ({ id, name, kind, locked, muted, hidden })),
    clips: project.tracks.flatMap((track) =>
      track.clips.map((clip) => ({
        id: clip.id,
        trackId: track.id,
        name: clip.name,
        kind: clip.kind,
        startUs: clip.startUs,
        durationUs: clip.durationUs,
        sourceInUs: clip.sourceInUs,
        enabled: clip.enabled,
        ...('assetId' in clip ? { assetId: clip.assetId } : {}),
        ...(clip.kind === 'subtitle' ? { text: clip.text } : {})
      }))
    ),
    assets: project.media.map(({ id, name, kind, durationUs, offline }) => ({ id, name, kind, durationUs, offline }))
  }
}

export const validateAutomationProposal = (project: ProjectFile, input: unknown): AutomationProposal => {
  assertProjectShape(project)
  const proposal = proposalRecord(input)
  const rawCommands = ownValue(proposal, 'commands')
  if (!Array.isArray(rawCommands) || rawCommands.length === 0 || rawCommands.length > MAX_AUTOMATION_COMMANDS) {
    throw new Error(`Automation commands must contain 1-${MAX_AUTOMATION_COMMANDS} items`)
  }

  const working = clone(project)
  const commands: AutomationEditCommand[] = []
  for (const rawCommand of rawCommands) {
    const command = parseCommand(rawCommand, working)
    applyCommandMutable(working, command)
    commands.push(command)
  }
  assertProjectShape(working)
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    title: requiredString(ownValue(proposal, 'title'), 'proposal.title', 200),
    commands
  }
}

const parseTranscript = (input: Record<string, unknown>): TranscriptAiOutput => {
  assertKeys(input, ['kind', 'language', 'text', 'segments'], 'transcript output')
  const rawSegments = ownValue(input, 'segments')
  if (!Array.isArray(rawSegments) || rawSegments.length > MAX_AUTOMATION_COMMANDS) {
    throw new Error(`Transcript segments must contain at most ${MAX_AUTOMATION_COMMANDS} items`)
  }
  const segments = rawSegments.map((raw, index): TranscriptSegment => {
    if (!isRecord(raw)) throw new Error(`segments[${index}] must be an object`)
    assertKeys(raw, ['startUs', 'endUs', 'text', 'confidence', 'speaker', 'words'], `segments[${index}]`)
    const startUs = integer(ownValue(raw, 'startUs'), `segments[${index}].startUs`)
    const endUs = integer(ownValue(raw, 'endUs'), `segments[${index}].endUs`, 1)
    if (endUs <= startUs) throw new Error(`segments[${index}] has an invalid range`)
    const confidenceValue = ownValue(raw, 'confidence')
    const wordsValue = ownValue(raw, 'words')
    let words: TranscriptWord[] | undefined
    if (wordsValue !== undefined) {
      if (!Array.isArray(wordsValue) || wordsValue.length === 0) throw new Error(`segments[${index}].words must be a non-empty array`)
      words = wordsValue.map((word, wordIndex) => parseTranscriptWord(word, `segments[${index}].words[${wordIndex}]`))
      if (words.map((word) => word.text).join('') !== requiredString(ownValue(raw, 'text'), `segments[${index}].text`, MAX_AUTOMATION_TEXT_LENGTH)) {
        throw new Error(`segments[${index}].words do not reconstruct the segment text`)
      }
      if (words.some((word) => word.startUs < startUs || word.endUs > endUs)) throw new Error(`segments[${index}].words exceed segment timing`)
    }
    return {
      startUs,
      endUs,
      text: requiredString(ownValue(raw, 'text'), `segments[${index}].text`, MAX_AUTOMATION_TEXT_LENGTH),
      ...(confidenceValue === undefined ? {} : { confidence: finiteNumber(confidenceValue, 'confidence', 0, 1) }),
      ...(ownValue(raw, 'speaker') === undefined
        ? {}
        : { speaker: requiredString(ownValue(raw, 'speaker'), `segments[${index}].speaker`, 100) }),
      ...(words ? { words } : {})
    }
  })
  return {
    kind: 'transcript',
    segments,
    ...(optionalString(ownValue(input, 'language'), 'language', 35) ? { language: optionalString(ownValue(input, 'language'), 'language', 35) } : {}),
    ...(optionalString(ownValue(input, 'text'), 'text', MAX_AUTOMATION_TEXT_LENGTH)
      ? { text: optionalString(ownValue(input, 'text'), 'text', MAX_AUTOMATION_TEXT_LENGTH) }
      : {})
  }
}

const parseTranscriptWord = (value: unknown, label: string): TranscriptWord => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertKeys(value, ['id', 'text', 'startUs', 'endUs'], label)
  const startUs = integer(ownValue(value, 'startUs'), `${label}.startUs`)
  const endUs = integer(ownValue(value, 'endUs'), `${label}.endUs`)
  if (endUs < startUs) throw new Error(`${label} has an invalid range`)
  return {
    id: identifier(ownValue(value, 'id'), `${label}.id`),
    text: requiredString(ownValue(value, 'text'), `${label}.text`, MAX_AUTOMATION_TEXT_LENGTH),
    startUs,
    endUs
  }
}

export const validateAiProviderOutput = (input: unknown, expectedCapability?: AiCapability): AiProviderOutput => {
  if (!isRecord(input)) throw new Error('AI provider output must be an object')
  const kind = requiredString(ownValue(input, 'kind'), 'output.kind', 64)
  let output: AiProviderOutput
  if (kind === 'transcript') {
    output = parseTranscript(input)
  } else if (kind === 'text') {
    assertKeys(input, ['kind', 'text'], 'text output')
    output = { kind, text: requiredString(ownValue(input, 'text'), 'text', MAX_AUTOMATION_TEXT_LENGTH) }
  } else if (kind === 'edit-proposal') {
    assertKeys(input, ['kind', 'proposal'], 'edit proposal output')
    const rawProposal = ownValue(input, 'proposal')
    const record = proposalRecord(rawProposal)
    const rawCommands = ownValue(record, 'commands')
    if (!Array.isArray(rawCommands) || rawCommands.length === 0 || rawCommands.length > MAX_AUTOMATION_COMMANDS) {
      throw new Error(`Automation commands must contain 1-${MAX_AUTOMATION_COMMANDS} items`)
    }
    // Project-aware command validation happens when a preview is requested.
    output = {
      kind,
      proposal: {
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        title: requiredString(ownValue(record, 'title'), 'proposal.title', 200),
        commands: clone(rawCommands)
      }
    }
  } else {
    throw new Error(`Unsupported AI provider output: ${kind}`)
  }

  if (expectedCapability === 'transcription' && output.kind !== 'transcript') {
    throw new Error('Transcription provider returned a non-transcript result')
  }
  if (expectedCapability === 'edit-suggestion' && output.kind !== 'edit-proposal') {
    throw new Error('Edit provider returned a non-edit result')
  }
  if (expectedCapability === 'text-generation' && output.kind !== 'text') {
    throw new Error('Text provider returned a non-text result')
  }
  return output
}

export const createAutomationPlanFromOutput = (
  project: ProjectFile,
  input: unknown,
  options: { subtitleTrackId?: string; title?: string } = {}
): AutomationProposal => {
  const output = validateAiProviderOutput(input)
  if (output.kind === 'text') throw new Error('Text output cannot be applied to a project')
  if (output.kind === 'edit-proposal') return validateAutomationProposal(project, output.proposal)

  const subtitleTrack = options.subtitleTrackId
    ? findTrack(project, options.subtitleTrackId)
    : project.tracks.find((track) => track.kind === 'subtitle' && !track.locked)
  if (!subtitleTrack || subtitleTrack.kind !== 'subtitle') throw new Error('An unlocked subtitle track is required')

  const proposal = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    title: options.title ?? 'AI transcription',
    commands: output.segments.map((segment) => ({
      type: 'insert-subtitle',
      trackId: subtitleTrack.id,
      clipId: newId('ai-caption'),
      startUs: segment.startUs,
      durationUs: segment.endUs - segment.startUs,
      text: segment.text,
      ...(segment.words ? { words: segment.words.map((word) => ({ ...word })) } : {})
    }))
  }
  if (proposal.commands.length === 0) throw new Error('Transcript contains no segments')
  return validateAutomationProposal(project, proposal)
}

const applyValidatedPlan = (project: ProjectFile, plan: AutomationProposal, updatedAt: string): ProjectFile => {
  const next = clone(project)
  for (const command of plan.commands) applyCommandMutable(next, command)
  next.updatedAt = updatedAt
  assertProjectShape(next)
  return next
}

const summarizeCommand = (command: AutomationEditCommand): string => {
  switch (command.type) {
    case 'insert-subtitle': return `Insert subtitle ${command.clipId}`
    case 'update-subtitle': return `Update subtitle ${command.clipId}`
    case 'delete-clips': return `Delete ${command.clipIds.length} clip(s)`
    case 'move-clip': return `Move ${command.clipId}`
    case 'trim-clip': return `Trim ${command.clipId}`
    case 'split-clip': return `Split ${command.clipId}`
    case 'set-transform': return `Change transform for ${command.clipId}`
    case 'set-audio': return `Change audio for ${command.clipId}`
  }
}

export const previewAutomationProposal = (project: ProjectFile, input: unknown): AutomationPreview => {
  const plan = validateAutomationProposal(project, input)
  const previewTimestamp = new Date().toISOString()
  return {
    previewId: newId('automation-preview'),
    baseProjectId: project.id,
    baseUpdatedAt: project.updatedAt,
    plan,
    project: applyValidatedPlan(project, plan, previewTimestamp),
    summaries: plan.commands.map(summarizeCommand)
  }
}

export const applyAutomationPreview = (currentProject: ProjectFile, preview: AutomationPreview): AutomationApplyResult => {
  assertProjectShape(currentProject)
  if (currentProject.id !== preview.baseProjectId || currentProject.updatedAt !== preview.baseUpdatedAt) {
    throw new Error('Project changed after the AI preview was created')
  }
  const plan = validateAutomationProposal(currentProject, preview.plan)
  const updatedAt = new Date().toISOString()
  const project = applyValidatedPlan(currentProject, plan, updatedAt)
  return {
    project,
    undo: {
      changeId: preview.previewId,
      projectId: currentProject.id,
      expectedUpdatedAt: updatedAt,
      previousProject: clone(currentProject)
    }
  }
}

export const undoAutomationChange = (currentProject: ProjectFile, token: AutomationUndoToken): ProjectFile => {
  assertProjectShape(currentProject)
  assertProjectShape(token.previousProject)
  if (currentProject.id !== token.projectId || token.previousProject.id !== token.projectId) {
    throw new Error('Undo token belongs to another project')
  }
  if (currentProject.updatedAt !== token.expectedUpdatedAt) {
    throw new Error('Project changed after the automation edit was applied')
  }
  const previous = clone(token.previousProject)
  previous.updatedAt = new Date().toISOString()
  return previous
}
