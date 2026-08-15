import type { AutoCaptionBaseline, AutoCaptionProgress, AutoCaptionSettings } from './auto-caption-contract'
import type { SubtitleTemplateDraft, SubtitleTemplateLoadResult, UserSubtitleTemplate } from './subtitle-templates'
import type { AppSettings } from './app-settings'

export const PROJECT_SCHEMA_VERSION = 1 as const
export const APP_VERSION = '0.1.0'

export type TimeUs = number
export type MediaKind = 'video' | 'audio' | 'image'
/** Internal track families. video/audio are accepted only as legacy input. */
export type TrackKind = 'media' | 'subtitle' | 'video' | 'audio'
export type EncoderMode = 'auto' | 'hardware' | 'software'
export type EncoderVendor = 'nvidia' | 'intel' | 'amd' | 'apple' | 'vaapi' | 'cpu'

export interface Rational {
  numerator: number
  denominator: number
}

export interface MediaAsset {
  id: string
  name: string
  path: string
  relativePath?: string
  kind: MediaKind
  durationUs: TimeUs
  width?: number
  height?: number
  frameRate?: Rational
  sampleRate?: number
  channels?: number
  hasAudio: boolean
  fileSize: number
  modifiedAt: string
  offline: boolean
}

export interface CropSettings {
  left: number
  top: number
  right: number
  bottom: number
}

export interface TransformSettings {
  positionX: number
  positionY: number
  scale: number
  rotation: number
  opacity: number
  crop: CropSettings
}

export interface AudioSettings {
  volumeDb: number
  pan: number
  fadeInUs: TimeUs
  fadeOutUs: TimeUs
}

export interface SubtitleStyle {
  fontFamily: string
  fontSize: number
  color: string
  outlineColor: string
  outlineWidth: number
  shadowColor: string
  shadowBlur: number
  backgroundColor: string
  backgroundOpacity: number
  bold: boolean
  italic: boolean
  letterSpacing: number
  lineHeight: number
  alignment: 'top' | 'middle' | 'bottom'
  positionX: number
  positionY: number
  /** Maximum line box width as a percentage of the sequence width. */
  maxWidthPercent: number
  animation: 'none' | 'fade' | 'pop' | 'slide-up' | 'typewriter'
  animationDurationUs: TimeUs
}

interface BaseClip {
  id: string
  name: string
  startUs: TimeUs
  durationUs: TimeUs
  sourceInUs: TimeUs
  enabled: boolean
  /** Internal .spectra relationship; never serialized into edit_project.v1. */
  linkGroupId?: string
}

export interface VideoClip extends BaseClip {
  kind: 'video'
  assetId: string
  transform: TransformSettings
  audio: AudioSettings
  /** Whether this video clip contributes audio from the source asset. Omitted legacy values mean enabled. */
  sourceAudioEnabled?: boolean
}

export interface ImageClip extends BaseClip {
  kind: 'image'
  assetId: string
  transform: TransformSettings
}

export interface AudioClip extends BaseClip {
  kind: 'audio'
  assetId: string
  audio: AudioSettings
}

/** Optional internal word timing metadata for subtitle editing.
 * This is a .spectra editor extension and is not part of edit_project.v1.
 */
export interface SubtitleWord {
  id: string
  text: string
  startUs: TimeUs
  endUs: TimeUs
}

/**
 * Internal editor boundary metadata derived from SubtitleWord text.
 * This is intentionally not part of edit_project.v1: the contract words remain
 * source/transcript metadata, while these units are safe UI edit candidates.
 */
export type SubtitleEditUnitTimingProvenance = 'source' | 'estimated' | 'point'

export interface SubtitleEditUnit {
  id: string
  text: string
  parentSourceWordId: string
  startUs: TimeUs
  endUs: TimeUs
  timingProvenance: SubtitleEditUnitTimingProvenance
}

export interface SubtitleClip extends BaseClip {
  kind: 'subtitle'
  text: string
  style: SubtitleStyle
  /** Internal .spectra display constraint; missing legacy values default to two lines. */
  maxLines?: number
  /** Optional lineage from the auto-caption worker; source IDs remain stable across reruns/review. */
  sourceCaptionId?: string
  sourceJobId?: string
  words?: SubtitleWord[]
  /** Internal .spectra edit units; never serialized into edit_project.v1. */
  editUnits?: SubtitleEditUnit[]
}

export type TimelineClip = VideoClip | ImageClip | AudioClip | SubtitleClip

export interface TimelineTrack {
  id: string
  name: string
  kind: TrackKind
  clips: TimelineClip[]
  locked: boolean
  muted: boolean
  hidden: boolean
}

export const isMediaTrack = (track: Pick<TimelineTrack, 'kind'>): boolean =>
  track.kind === 'media' || track.kind === 'video' || track.kind === 'audio'

export const isSubtitleTrack = (track: Pick<TimelineTrack, 'kind'>): boolean => track.kind === 'subtitle'

export interface SequenceSettings {
  width: number
  height: number
  frameRate: Rational
  sampleRate: number
  backgroundColor: string
}

export interface ProjectFile {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION
  appVersion: string
  id: string
  name: string
  createdAt: string
  updatedAt: string
  projectPath?: string
  projectFormat?: 'spectra' | 'edit_project_v1'
  sequence: SequenceSettings
  media: MediaAsset[]
  tracks: TimelineTrack[]
}

export interface ProbeResult {
  path: string
  name: string
  kind: MediaKind
  durationUs: TimeUs
  width?: number
  height?: number
  frameRate?: Rational
  sampleRate?: number
  channels?: number
  hasAudio: boolean
  fileSize: number
  modifiedAt: string
  error?: string
}

export interface PreviewPlanClip {
  clipId: string
  kind: 'video' | 'audio' | 'caption'
  startUs: TimeUs
  durationUs: TimeUs
  sourceInUs: TimeUs
  enabled: boolean
  sourceMediaId?: string
  text?: string
  volumeDb?: number
  pan?: number
}

export interface PreviewPlan {
  durationUs: TimeUs
  width: number
  height: number
  frameRate: Rational
  videoClips: PreviewPlanClip[]
  audioClips: PreviewPlanClip[]
  captions: PreviewPlanClip[]
}

export interface AccuratePreviewFrameResult {
  framePath: string
  requestedTimeUs: TimeUs
  renderedTimeUs: TimeUs
  frameIndex: number
  projectFingerprint: string
}

export interface SubtitleOverlayResult {
  framePath: string
  frameIndex: number
  subtitleStateFingerprint: string
}

export interface WaveformRequest {
  mediaPath: string
  sourceInUs: TimeUs
  durationUs: TimeUs
  peakCount: number
}

export interface ImportedSubtitleCue {
  startUs: TimeUs
  endUs: TimeUs
  text: string
}

export interface EncoderCapability {
  id: string
  name: string
  codec: 'h264'
  vendor: EncoderVendor
  hardware: boolean
  available: boolean
  reason?: string
}

export interface EncoderReport {
  ffmpegPath: string | null
  ffmpegVersion: string | null
  platform: string
  capabilities: EncoderCapability[]
  selectedId: string | null
  checkedAt: string
}

export interface ExportSettings {
  outputPath: string
  width: number
  height: number
  frameRate: Rational
  videoBitrate: number
  audioBitrate: number
  encoderMode: EncoderMode
  preferredEncoderId?: string
  burnSubtitles: boolean
  exportSrt: boolean
}

export type ExportStage =
  | 'queued'
  | 'probing'
  | 'rendering'
  | 'validating'
  | 'fallback'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface ExportProgress {
  jobId: string
  stage: ExportStage
  ratio: number
  encodedUs: TimeUs
  totalUs: TimeUs
  encoderId?: string
  message: string
  fallbackReason?: string
  outputPath?: string
  error?: string
}

export interface SaveProjectResult {
  cancelled: boolean
  projectPath?: string
  project?: ProjectFile
}

export interface OpenProjectResult {
  cancelled: boolean
  projectPath?: string
  project?: ProjectFile
  warnings: string[]
}

export interface StartExportResult {
  cancelled: boolean
  jobId?: string
  outputPath?: string
}

export interface AppInfo {
  name: string
  version: string
  platform: string
  arch: string
  packaged: boolean
  smokeMode?: boolean
}

export interface AutoCaptionHealth {
  available: boolean
  checkedAt: string
  provider: 'clip_automation' | 'unavailable'
  reason?: string
}

export interface AutoCaptionStartResult {
  jobId: string
  clipId: string
}

export interface AutoCaptionJobStatus {
  jobId: string
  clipId: string
  progress: AutoCaptionProgress
}

export interface AutoCaptionBaselineLoadResult {
  records: AutoCaptionBaseline[]
  malformedCount: number
}

export interface DesktopApi {
  getAppInfo(): Promise<AppInfo>
  loadAppSettings(): Promise<AppSettings>
  setLastUsedSubtitleTemplateId(id: string): Promise<AppSettings>
  pickMedia(): Promise<ProbeResult[]>
  probeMedia(paths: string[]): Promise<ProbeResult[]>
  getPathForFile(file: unknown): string
  saveProject(project: ProjectFile, saveAs?: boolean): Promise<SaveProjectResult>
  openProject(): Promise<OpenProjectResult>
  writeRecovery(project: ProjectFile): Promise<void>
  loadRecovery(): Promise<ProjectFile | null>
  relinkMedia(assetId: string, expectedName: string): Promise<ProbeResult | null>
  importSubtitles(): Promise<ImportedSubtitleCue[] | null>
  mediaUrl(path: string): string
  getWaveformPeaks(request: WaveformRequest): Promise<number[]>
  listFontFamilies(): Promise<string[]>
  createPreviewPlan(project: ProjectFile): Promise<PreviewPlan>
  renderAccuratePreviewFrame(project: ProjectFile, timeUs: TimeUs): Promise<AccuratePreviewFrameResult>
  renderSubtitleOverlay(project: ProjectFile, timeUs: TimeUs): Promise<SubtitleOverlayResult>
  autoCaptionHealth(): Promise<AutoCaptionHealth>
  startAutoCaption(project: ProjectFile, selectedClipIds: string[], settings?: AutoCaptionSettings): Promise<AutoCaptionStartResult>
  cancelAutoCaption(jobId: string): Promise<boolean>
  getAutoCaptionStatus(jobId: string): Promise<AutoCaptionJobStatus | null>
  loadAutoCaptionBaselines(): Promise<AutoCaptionBaselineLoadResult>
  loadSubtitleTemplates(): Promise<SubtitleTemplateLoadResult>
  setDefaultSubtitleTemplate(id: string): Promise<SubtitleTemplateLoadResult>
  createSubtitleTemplate(input: SubtitleTemplateDraft): Promise<UserSubtitleTemplate>
  updateSubtitleTemplate(id: string, input: SubtitleTemplateDraft): Promise<UserSubtitleTemplate>
  duplicateSubtitleTemplate(input: SubtitleTemplateDraft): Promise<UserSubtitleTemplate>
  deleteSubtitleTemplate(id: string): Promise<boolean>
  onAutoCaptionProgress(callback: (progress: AutoCaptionProgress) => void): () => void
  detectEncoders(force?: boolean): Promise<EncoderReport>
  chooseExportPath(defaultName: string): Promise<string | null>
  startExport(project: ProjectFile, settings: ExportSettings): Promise<StartExportResult>
  cancelExport(jobId: string): Promise<boolean>
  exportSrt(project: ProjectFile, suggestedName: string): Promise<string | null>
  loadExperimentalReviewRecords(): Promise<import('./review/types').ExperimentalReviewRecord[]>
  upsertExperimentalReviewRecord(record: import('./review/types').ExperimentalReviewRecord): Promise<{ path: string; records: import('./review/types').ExperimentalReviewRecord[] }>
  loadFullCorrectionSessions(): Promise<import('./full-correction').FullCorrectionSession[]>
  startFullCorrectionSession(project: ProjectFile, trackId: string): Promise<import('./full-correction').FullCorrectionSession>
  finishFullCorrectionSession(project: ProjectFile, sessionId: string): Promise<import('./full-correction').FullCorrectionSession>
  onExportProgress(callback: (progress: ExportProgress) => void): () => void
}

export const DEFAULT_TRANSFORM: TransformSettings = {
  positionX: 0,
  positionY: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
  crop: { left: 0, top: 0, right: 0, bottom: 0 }
}

export const DEFAULT_AUDIO: AudioSettings = {
  volumeDb: 0,
  pan: 0,
  fadeInUs: 0,
  fadeOutUs: 0
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: 'Noto Sans JP',
  fontSize: 54,
  color: '#ffffff',
  outlineColor: '#111318',
  outlineWidth: 3,
  shadowColor: '#000000',
  shadowBlur: 4,
  backgroundColor: '#000000',
  backgroundOpacity: 0,
  bold: true,
  italic: false,
  letterSpacing: 0,
  lineHeight: 1.15,
  alignment: 'bottom',
  positionX: 50,
  positionY: 86,
  maxWidthPercent: 80,
  animation: 'none',
  animationDurationUs: 0
}
