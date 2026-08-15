import type { TimelineClip } from './types.js'

export const AUTO_CAPTION_REQUEST_VERSION = 'spectra.auto-caption.request.v1' as const
export const AUTO_CAPTION_RESULT_VERSION = 'spectra.auto-caption.result.v1' as const
export const AUTO_CAPTION_BASELINE_VERSION = 'experimental.auto-caption-baseline.v1' as const
export const AUTO_CAPTION_MAPPING_FORMULA = 'timelineUs = clip.startUs + (sourceUs - clip.sourceInUs)' as const
export const AUTO_CAPTION_PROGRESS_VERSION = 'spectra.auto-caption.progress.v1' as const

const MAX_ITEMS = 100_000
const MAX_TEXT_LENGTH = 100_000
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SEGMENTATION_MODES = ['auto', 'rule', 'llm'] as const
const TEXT_STATUSES = ['as_transcribed', 'display_normalized', 'manually_corrected'] as const
const PROVENANCES = ['caption_algorithm', 'rule_fallback', 'llm', 'unknown'] as const
const FORBIDDEN_KEYS = new Set([
  'absolutePath', 'accessToken', 'clientSecret', 'credential', 'credentials',
  'mediaPath', 'path', 'paths', 'projectPath', 'refreshToken', 'sourcePath', 'token'
])

export type SegmentationMode = typeof SEGMENTATION_MODES[number]
export type AutoCaptionTextStatus = typeof TEXT_STATUSES[number]
export type AutoCaptionProvenance = typeof PROVENANCES[number]

export interface AutoCaptionSettings {
  language: string
  maxChars: number
  maxLines?: number
  segmentationMode: SegmentationMode
}

export type AutoCaptionProgressState = 'preparing' | 'transcribing' | 'segmenting' | 'completed' | 'failed'

export interface AutoCaptionProgress {
  version: typeof AUTO_CAPTION_PROGRESS_VERSION
  jobId: string
  state: AutoCaptionProgressState
  ratio: number
  message: string
  errorCode?: string
  result?: AutoCaptionResult
}

export interface AutoCaptionRequest {
  version: typeof AUTO_CAPTION_REQUEST_VERSION
  jobId: string
  mediaPath: string
  sourceStartUs: number
  sourceEndUs: number
  language: string
  maxChars: number
  maxLines?: number
  segmentationMode: SegmentationMode
}

export interface AutoCaptionRawWord {
  id: string
  text: string
  startUs: number
  endUs: number
  confidence?: number
}

export interface AutoCaptionCaption {
  id: string
  text: string
  sourceWordIds: string[]
  startUs: number
  endUs: number
  textStatus: AutoCaptionTextStatus
  provenance: AutoCaptionProvenance
}

export interface AutoCaptionDiagnostic {
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
}

export interface AutoCaptionFallback {
  used: boolean
  reason?: string
}

export interface AutoCaptionResult {
  version: typeof AUTO_CAPTION_RESULT_VERSION
  jobId: string
  sourceStartUs: number
  sourceEndUs: number
  language: string
  provider: string
  model: string
  rawWords: AutoCaptionRawWord[]
  captions: AutoCaptionCaption[]
  diagnostics: AutoCaptionDiagnostic[]
  fallback: AutoCaptionFallback
}

export interface AutoCaptionSourceClipIdentity {
  clipId: string
  assetId: string
  startUs: number
  sourceInUs: number
  durationUs: number
}

export interface AutoCaptionBaseline {
  version: typeof AUTO_CAPTION_BASELINE_VERSION
  jobId: string
  createdAt: string
  projectFingerprint: string
  mediaFingerprint: string
  sourceClip: AutoCaptionSourceClipIdentity
  timelineMapping: {
    formula: typeof AUTO_CAPTION_MAPPING_FORMULA
    clipStartUs: number
    sourceInUs: number
  }
  rawWords: AutoCaptionRawWord[]
  captions: AutoCaptionCaption[]
  settings: AutoCaptionSettings
  provider: string
  model: string
  diagnostics: AutoCaptionDiagnostic[]
  fallback: AutoCaptionFallback
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const assertKeys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${label} has an unsupported field: ${key}`)
  }
}

const own = (value: Record<string, unknown>, key: string): unknown => {
  if (!(key in value)) throw new Error(`${key} is required`)
  return value[key]
}

const requiredString = (value: unknown, label: string, maxLength = 4096): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw new Error(`${label} must be a non-empty string`)
  return value
}

const identifier = (value: unknown, label: string): string => {
  const result = requiredString(value, label, 128)
  if (!ID_PATTERN.test(result)) throw new Error(`${label} has an invalid identifier`)
  return result
}

const integerUs = (value: unknown, label: string, allowZero = true): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (!allowZero && value <= 0) || (allowZero && value < 0)) {
    throw new Error(`${label} must be an integer microsecond value`)
  }
  return value
}

const finiteUnit = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`)
  return value
}

const boundedCount = (value: unknown, label: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is out of range`)
  return value
}

const assertNoForbiddenFields = (value: unknown, label = 'contract'): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFields(item, `${label}[${index}]`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${label}.${key} is not allowed in this contract`)
    assertNoForbiddenFields(child, `${label}.${key}`)
  }
}

const parseRawWord = (value: unknown, label: string): AutoCaptionRawWord => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertKeys(value, ['id', 'text', 'startUs', 'endUs', 'confidence'], label)
  const startUs = integerUs(own(value, 'startUs'), `${label}.startUs`)
  const endUs = integerUs(own(value, 'endUs'), `${label}.endUs`)
  if (endUs < startUs) throw new Error(`${label} has a reversed time range`)
  const confidence = value.confidence === undefined ? undefined : finiteUnit(value.confidence, `${label}.confidence`)
  return {
    id: identifier(own(value, 'id'), `${label}.id`),
    text: requiredString(own(value, 'text'), `${label}.text`, MAX_TEXT_LENGTH),
    startUs,
    endUs,
    ...(confidence === undefined ? {} : { confidence })
  }
}

const parseCaption = (value: unknown, label: string, wordIds: ReadonlySet<string>): AutoCaptionCaption => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertKeys(value, ['id', 'text', 'sourceWordIds', 'startUs', 'endUs', 'textStatus', 'provenance'], label)
  const startUs = integerUs(own(value, 'startUs'), `${label}.startUs`)
  const endUs = integerUs(own(value, 'endUs'), `${label}.endUs`, false)
  if (endUs <= startUs) throw new Error(`${label} must have a positive duration`)
  const sourceWordIds = own(value, 'sourceWordIds')
  if (!Array.isArray(sourceWordIds) || sourceWordIds.length === 0 || sourceWordIds.length > MAX_ITEMS) throw new Error(`${label}.sourceWordIds must be a non-empty array`)
  const parsedWordIds = sourceWordIds.map((id, index) => identifier(id, `${label}.sourceWordIds[${index}]`))
  if (new Set(parsedWordIds).size !== parsedWordIds.length || parsedWordIds.some((id) => !wordIds.has(id))) throw new Error(`${label}.sourceWordIds reference unknown or duplicate words`)
  const textStatus = requiredString(own(value, 'textStatus'), `${label}.textStatus`, 64) as AutoCaptionTextStatus
  const provenance = requiredString(own(value, 'provenance'), `${label}.provenance`, 64) as AutoCaptionProvenance
  if (!TEXT_STATUSES.includes(textStatus) || !PROVENANCES.includes(provenance)) throw new Error(`${label} has an unsupported status`)
  return { id: identifier(own(value, 'id'), `${label}.id`), text: requiredString(own(value, 'text'), `${label}.text`, MAX_TEXT_LENGTH), sourceWordIds: parsedWordIds, startUs, endUs, textStatus, provenance }
}

const parseDiagnostics = (value: unknown): AutoCaptionDiagnostic[] => {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error('diagnostics must be an array')
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`diagnostics[${index}] must be an object`)
    assertKeys(item, ['level', 'code', 'message'], `diagnostics[${index}]`)
    const level = requiredString(own(item, 'level'), `diagnostics[${index}].level`, 16)
    if (!['info', 'warning', 'error'].includes(level)) throw new Error(`diagnostics[${index}].level is invalid`)
    return { level: level as AutoCaptionDiagnostic['level'], code: identifier(own(item, 'code'), `diagnostics[${index}].code`), message: requiredString(own(item, 'message'), `diagnostics[${index}].message`, MAX_TEXT_LENGTH) }
  })
}

const parseFallback = (value: unknown): AutoCaptionFallback => {
  if (!isRecord(value)) throw new Error('fallback must be an object')
  assertKeys(value, ['used', 'reason'], 'fallback')
  if (typeof value.used !== 'boolean') throw new Error('fallback.used must be boolean')
  return { used: value.used, ...(value.reason === undefined ? {} : { reason: requiredString(value.reason, 'fallback.reason', MAX_TEXT_LENGTH) }) }
}

const parseSourceClip = (value: unknown, label: string): AutoCaptionSourceClipIdentity => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertKeys(value, ['clipId', 'assetId', 'startUs', 'sourceInUs', 'durationUs'], label)
  const durationUs = integerUs(own(value, 'durationUs'), `${label}.durationUs`, false)
  return {
    clipId: identifier(own(value, 'clipId'), `${label}.clipId`),
    assetId: identifier(own(value, 'assetId'), `${label}.assetId`),
    startUs: integerUs(own(value, 'startUs'), `${label}.startUs`),
    sourceInUs: integerUs(own(value, 'sourceInUs'), `${label}.sourceInUs`),
    durationUs
  }
}

const parseSettings = (value: unknown): AutoCaptionBaseline['settings'] => {
  if (!isRecord(value)) throw new Error('settings must be an object')
  assertKeys(value, ['language', 'maxChars', 'maxLines', 'segmentationMode'], 'settings')
  const maxLines = value.maxLines === undefined ? undefined : boundedCount(value.maxLines, 'settings.maxLines', 1, 16)
  const segmentationMode = requiredString(own(value, 'segmentationMode'), 'settings.segmentationMode', 16) as SegmentationMode
  if (!SEGMENTATION_MODES.includes(segmentationMode)) throw new Error('settings.segmentationMode is invalid')
  return {
    language: requiredString(own(value, 'language'), 'settings.language', 35),
    maxChars: boundedCount(own(value, 'maxChars'), 'settings.maxChars', 1, 10_000),
    ...(maxLines === undefined ? {} : { maxLines }),
    segmentationMode
  }
}

export const parseAutoCaptionSettings = (value: unknown): AutoCaptionSettings => parseSettings(value)

export const parseAutoCaptionRequest = (input: unknown): AutoCaptionRequest => {
  if (!isRecord(input)) throw new Error('auto-caption request must be an object')
  assertKeys(input, ['version', 'jobId', 'mediaPath', 'sourceStartUs', 'sourceEndUs', 'language', 'maxChars', 'maxLines', 'segmentationMode'], 'auto-caption request')
  if (own(input, 'version') !== AUTO_CAPTION_REQUEST_VERSION) throw new Error('unsupported auto-caption request version')
  const sourceStartUs = integerUs(own(input, 'sourceStartUs'), 'sourceStartUs')
  const sourceEndUs = integerUs(own(input, 'sourceEndUs'), 'sourceEndUs', false)
  if (sourceEndUs <= sourceStartUs) throw new Error('sourceEndUs must be greater than sourceStartUs')
  const segmentationMode = requiredString(own(input, 'segmentationMode'), 'segmentationMode', 16) as SegmentationMode
  if (!SEGMENTATION_MODES.includes(segmentationMode)) throw new Error('unsupported segmentationMode')
  const maxLines = input.maxLines === undefined ? undefined : boundedCount(input.maxLines, 'maxLines', 1, 16)
  return {
    version: AUTO_CAPTION_REQUEST_VERSION,
    jobId: identifier(own(input, 'jobId'), 'jobId'),
    mediaPath: requiredString(own(input, 'mediaPath'), 'mediaPath', 32_000),
    sourceStartUs,
    sourceEndUs,
    language: requiredString(own(input, 'language'), 'language', 35),
    maxChars: boundedCount(own(input, 'maxChars'), 'maxChars', 1, 10_000),
    ...(maxLines === undefined ? {} : { maxLines }),
    segmentationMode
  }
}

export const parseAutoCaptionProgress = (input: unknown): AutoCaptionProgress => {
  if (!isRecord(input)) throw new Error('auto-caption progress must be an object')
  assertKeys(input, ['version', 'jobId', 'state', 'ratio', 'message', 'errorCode'], 'auto-caption progress')
  if (own(input, 'version') !== AUTO_CAPTION_PROGRESS_VERSION) throw new Error('unsupported auto-caption progress version')
  const state = requiredString(own(input, 'state'), 'progress.state', 32) as AutoCaptionProgressState
  if (!['preparing', 'transcribing', 'segmenting', 'completed', 'failed'].includes(state)) throw new Error('progress.state is invalid')
  const ratio = own(input, 'ratio')
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error('progress.ratio is invalid')
  const errorCode = input.errorCode === undefined ? undefined : identifier(input.errorCode, 'progress.errorCode')
  return {
    version: AUTO_CAPTION_PROGRESS_VERSION,
    jobId: identifier(own(input, 'jobId'), 'progress.jobId'),
    state,
    ratio,
    message: requiredString(own(input, 'message'), 'progress.message', 4096),
    ...(errorCode ? { errorCode } : {})
  }
}

export const parseAutoCaptionResult = (input: unknown): AutoCaptionResult => {
  if (!isRecord(input)) throw new Error('auto-caption result must be an object')
  assertNoForbiddenFields(input)
  assertKeys(input, ['version', 'jobId', 'sourceStartUs', 'sourceEndUs', 'language', 'provider', 'model', 'rawWords', 'captions', 'diagnostics', 'fallback'], 'auto-caption result')
  if (own(input, 'version') !== AUTO_CAPTION_RESULT_VERSION) throw new Error('unsupported auto-caption result version')
  const sourceStartUs = integerUs(own(input, 'sourceStartUs'), 'sourceStartUs')
  const sourceEndUs = integerUs(own(input, 'sourceEndUs'), 'sourceEndUs', false)
  if (sourceEndUs <= sourceStartUs) throw new Error('result source range is invalid')
  const rawWords = own(input, 'rawWords')
  if (!Array.isArray(rawWords) || rawWords.length > MAX_ITEMS) throw new Error('rawWords must be an array')
  const parsedWords = rawWords.map((word, index) => parseRawWord(word, `rawWords[${index}]`))
  if (new Set(parsedWords.map((word) => word.id)).size !== parsedWords.length) throw new Error('rawWords IDs must be unique')
  if (parsedWords.some((word) => word.startUs < sourceStartUs || word.endUs > sourceEndUs)) throw new Error('rawWords exceed the requested source range')
  const captions = own(input, 'captions')
  if (!Array.isArray(captions) || captions.length > MAX_ITEMS) throw new Error('captions must be an array')
  const parsedCaptions = captions.map((caption, index) => parseCaption(caption, `captions[${index}]`, new Set(parsedWords.map((word) => word.id))))
  if (new Set(parsedCaptions.map((caption) => caption.id)).size !== parsedCaptions.length) throw new Error('caption IDs must be unique')
  if (parsedCaptions.some((caption) => caption.startUs < sourceStartUs || caption.endUs > sourceEndUs)) throw new Error('captions exceed the requested source range')
  return {
    version: AUTO_CAPTION_RESULT_VERSION,
    jobId: identifier(own(input, 'jobId'), 'jobId'),
    sourceStartUs,
    sourceEndUs,
    language: requiredString(own(input, 'language'), 'language', 35),
    provider: requiredString(own(input, 'provider'), 'provider', 128),
    model: requiredString(own(input, 'model'), 'model', 256),
    rawWords: parsedWords,
    captions: parsedCaptions,
    diagnostics: parseDiagnostics(own(input, 'diagnostics')),
    fallback: parseFallback(own(input, 'fallback'))
  }
}

export const mapAutoCaptionSourceTimeToTimelineUs = (
  clip: Pick<TimelineClip, 'startUs' | 'sourceInUs' | 'durationUs'>,
  sourceUs: number
): number => {
  const source = integerUs(sourceUs, 'sourceUs')
  if (source < clip.sourceInUs || source > clip.sourceInUs + clip.durationUs) throw new Error('source time is outside the selected clip')
  return clip.startUs + (source - clip.sourceInUs)
}

export const createAutoCaptionBaseline = ({
  result,
  jobId,
  createdAt,
  projectFingerprint,
  mediaFingerprint,
  sourceClip,
  settings
}: {
  result: AutoCaptionResult
  jobId: string
  createdAt: string
  projectFingerprint: string
  mediaFingerprint: string
  sourceClip: AutoCaptionSourceClipIdentity
  settings: AutoCaptionBaseline['settings']
}): AutoCaptionBaseline => {
  if (result.jobId !== jobId) throw new Error('baseline jobId does not match result')
  if (sourceClip.durationUs <= 0) throw new Error('baseline source clip duration must be positive')
  return {
    version: AUTO_CAPTION_BASELINE_VERSION,
    jobId: identifier(jobId, 'jobId'),
    createdAt: requiredString(createdAt, 'createdAt', 128),
    projectFingerprint: requiredString(projectFingerprint, 'projectFingerprint', 256),
    mediaFingerprint: requiredString(mediaFingerprint, 'mediaFingerprint', 256),
    sourceClip: { ...sourceClip },
    timelineMapping: { formula: AUTO_CAPTION_MAPPING_FORMULA, clipStartUs: sourceClip.startUs, sourceInUs: sourceClip.sourceInUs },
    rawWords: result.rawWords.map((word) => ({ ...word })),
    captions: result.captions.map((caption) => ({ ...caption, sourceWordIds: [...caption.sourceWordIds] })),
    settings: { ...settings },
    provider: result.provider,
    model: result.model,
    diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    fallback: { ...result.fallback }
  }
}

export const parseAutoCaptionBaseline = (input: unknown): AutoCaptionBaseline => {
  if (!isRecord(input)) throw new Error('auto-caption baseline must be an object')
  assertNoForbiddenFields(input)
  assertKeys(input, ['version', 'jobId', 'createdAt', 'projectFingerprint', 'mediaFingerprint', 'sourceClip', 'timelineMapping', 'rawWords', 'captions', 'settings', 'provider', 'model', 'diagnostics', 'fallback'], 'auto-caption baseline')
  if (own(input, 'version') !== AUTO_CAPTION_BASELINE_VERSION) throw new Error('unsupported auto-caption baseline version')
  const sourceClip = parseSourceClip(own(input, 'sourceClip'), 'sourceClip')
  const mapping = own(input, 'timelineMapping')
  if (!isRecord(mapping)) throw new Error('timelineMapping must be an object')
  assertKeys(mapping, ['formula', 'clipStartUs', 'sourceInUs'], 'timelineMapping')
  if (own(mapping, 'formula') !== AUTO_CAPTION_MAPPING_FORMULA) throw new Error('unsupported baseline mapping formula')
  if (integerUs(own(mapping, 'clipStartUs'), 'timelineMapping.clipStartUs') !== sourceClip.startUs || integerUs(own(mapping, 'sourceInUs'), 'timelineMapping.sourceInUs') !== sourceClip.sourceInUs) throw new Error('baseline mapping does not match sourceClip')
  const settings = parseSettings(own(input, 'settings'))
  const parsedResult = parseAutoCaptionResult({
    version: AUTO_CAPTION_RESULT_VERSION,
    jobId: own(input, 'jobId'),
    sourceStartUs: sourceClip.sourceInUs,
    sourceEndUs: sourceClip.sourceInUs + sourceClip.durationUs,
    language: settings.language,
    provider: own(input, 'provider'),
    model: own(input, 'model'),
    rawWords: own(input, 'rawWords'),
    captions: own(input, 'captions'),
    diagnostics: own(input, 'diagnostics'),
    fallback: own(input, 'fallback')
  })
  return {
    version: AUTO_CAPTION_BASELINE_VERSION,
    jobId: identifier(own(input, 'jobId'), 'jobId'),
    createdAt: requiredString(own(input, 'createdAt'), 'createdAt', 128),
    projectFingerprint: requiredString(own(input, 'projectFingerprint'), 'projectFingerprint', 256),
    mediaFingerprint: requiredString(own(input, 'mediaFingerprint'), 'mediaFingerprint', 256),
    sourceClip,
    timelineMapping: { formula: AUTO_CAPTION_MAPPING_FORMULA, clipStartUs: sourceClip.startUs, sourceInUs: sourceClip.sourceInUs },
    rawWords: parsedResult.rawWords,
    captions: parsedResult.captions,
    settings,
    provider: parsedResult.provider,
    model: parsedResult.model,
    diagnostics: parsedResult.diagnostics,
    fallback: parsedResult.fallback
  }
}
