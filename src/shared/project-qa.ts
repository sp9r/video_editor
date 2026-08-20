import type { AutoCaptionBaseline } from './auto-caption-contract'
import type { EncoderReport, ExportSettings, ProjectFile, TimeUs, TimelineClip } from './types'
import { canRestoreSilenceCut } from './silence-cut'

export type ProjectQaSeverity = 'error' | 'warning' | 'info'

export interface ProjectQaIssue {
  severity: ProjectQaSeverity
  code: string
  message: string
  relatedClipId?: string
  relatedMediaId?: string
  timelineUs?: TimeUs
}

export interface ProjectQaReport {
  issues: ProjectQaIssue[]
  errorCount: number
  warningCount: number
  infoCount: number
  canExport: boolean
}

export interface ProjectQaOptions {
  encoderReport?: EncoderReport | null
  outputSettings?: Pick<ExportSettings, 'width' | 'height' | 'frameRate'>
  autoCaptionBaselines?: readonly Pick<AutoCaptionBaseline, 'jobId' | 'fallback' | 'diagnostics'>[]
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const clipEnd = (clip: Pick<TimelineClip, 'startUs' | 'durationUs'>): number => clip.startUs + clip.durationUs

const frameDurationUs = (project: ProjectFile): number => {
  const numerator = project.sequence.frameRate.numerator
  const denominator = project.sequence.frameRate.denominator
  return numerator > 0 && denominator > 0 ? (1_000_000 * denominator) / numerator : 0
}

const addIssue = (
  issues: ProjectQaIssue[],
  severity: ProjectQaSeverity,
  code: string,
  message: string,
  relatedClipId?: string,
  relatedMediaId?: string,
  timelineUs?: number
): void => {
  issues.push({
    severity,
    code,
    message,
    ...(relatedClipId ? { relatedClipId } : {}),
    ...(relatedMediaId ? { relatedMediaId } : {}),
    ...(finite(timelineUs) ? { timelineUs } : {})
  })
}

const checkSilenceMetadata = (project: ProjectFile, issues: ProjectQaIssue[]): void => {
  const metadata = project.editorMetadata
  if (!metadata) return
  if (metadata.schemaVersion !== 1 || !Array.isArray(metadata.silenceCutOperations)) {
    addIssue(issues, 'error', 'AUTO_SILENCE_METADATA_INVALID', '無音カットの内部操作メタデータが不正です。')
    return
  }
  const clips = new Map(project.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]))
  for (const operation of metadata.silenceCutOperations) {
    if (!operation || typeof operation.operationId !== 'string' || !Array.isArray(operation.targets) || !Array.isArray(operation.keepRanges) || !Array.isArray(operation.removedRanges)) {
      addIssue(issues, 'error', 'AUTO_SILENCE_METADATA_INVALID', '無音カット操作の範囲または対象メタデータが不正です。')
      continue
    }
    for (const target of operation.targets) {
      const missing = target.generatedClipIds.filter((id) => !clips.has(id))
      if (missing.length) addIssue(issues, 'warning', 'AUTO_SILENCE_METADATA_STALE', '無音カット解除用の生成clip情報が現在のTimelineと一致しません。', target.clipId)
      const restoreAnchor = target.generatedClipIds[0]
      if (restoreAnchor && !canRestoreSilenceCut(project, restoreAnchor)) {
        addIssue(issues, 'warning', 'AUTO_SILENCE_RESTORE_UNAVAILABLE', '無音カットの解除/再構成ができない状態です。現在のProjectは引き続き書き出し可能ですが、生成clipの変更・分割・削除・link/source範囲・metadata不一致を確認してください。', target.clipId)
      }
    }
  }
}

export const runProjectQa = (project: ProjectFile, options: ProjectQaOptions = {}): ProjectQaReport => {
  const issues: ProjectQaIssue[] = []
  const assets = new Map(project.media.map((asset) => [asset.id, asset]))
  const clips = project.tracks.flatMap((track) => track.clips)
  const visualClips = clips.filter((clip) => clip.kind === 'video' || clip.kind === 'image')
  const visualEndUs = visualClips.reduce((max, clip) => Number.isFinite(clip.startUs) && Number.isFinite(clip.durationUs) ? Math.max(max, clipEnd(clip)) : max, 0)
  const checkedAudioAssets = new Set<string>()

  for (const asset of project.media) {
    if (asset.offline) addIssue(issues, 'error', 'MEDIA_OFFLINE', '素材がオフラインです。再リンクしてください。', undefined, asset.id)
    if (!asset.path || !asset.path.trim()) addIssue(issues, 'error', 'MEDIA_UNREADABLE', '素材パスがなく、読み込めません。', undefined, asset.id)
  }

  for (const track of project.tracks) {
    const mediaClips = track.clips.filter((clip) => clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'audio')
    const visualTrackClips = track.clips.filter((clip) => clip.kind === 'video' || clip.kind === 'image').filter((clip) => clip.enabled).sort((left, right) => left.startUs - right.startUs)
    for (let index = 1; index < visualTrackClips.length; index += 1) {
      const previous = visualTrackClips[index - 1]
      const current = visualTrackClips[index]
      if (previous && current && current.startUs > clipEnd(previous) + frameDurationUs(project)) {
        addIssue(issues, 'warning', 'TIMELINE_VISUAL_GAP', '映像clip間に空白区間があります。', current.id, undefined, clipEnd(previous))
      }
    }
    for (const clip of mediaClips) {
      if (!finite(clip.startUs) || !finite(clip.durationUs) || !finite(clip.sourceInUs) || clip.startUs < 0 || clip.durationUs <= 0 || clip.sourceInUs < 0) {
        addIssue(issues, 'error', 'TIMELINE_INVALID_DURATION', 'clipの時間またはsource位置が不正です。', clip.id, undefined, finite(clip.startUs) ? clip.startUs : undefined)
      }
      const asset = 'assetId' in clip ? assets.get(clip.assetId) : undefined
      if (!asset) {
        addIssue(issues, 'error', 'MEDIA_ASSET_MISSING', 'clipが参照する素材がProjectにありません。', clip.id, undefined, clip.startUs)
        continue
      }
      if ((clip.kind === 'video' || clip.kind === 'audio') && finite(asset.durationUs) && (clip.sourceInUs + clip.durationUs > asset.durationUs)) {
        addIssue(issues, 'error', 'TIMELINE_SOURCE_RANGE_OUTSIDE_ASSET', 'clipのsource範囲が素材の長さを超えています。', clip.id, asset.id, clip.startUs)
      }
      if (clip.kind === 'video' && !asset.hasAudio && !checkedAudioAssets.has(asset.id)) {
        addIssue(issues, 'warning', 'MEDIA_VIDEO_AUDIO_MISSING', '映像素材に音声がありません。自動字幕の対象にはできません。', clip.id, asset.id, clip.startUs)
        checkedAudioAssets.add(asset.id)
      }
    }
  }

  const linkedGroups = new Map<string, TimelineClip[]>()
  for (const clip of clips) {
    if (!clip.linkGroupId) continue
    const group = linkedGroups.get(clip.linkGroupId) ?? []
    group.push(clip)
    linkedGroups.set(clip.linkGroupId, group)
  }
  for (const group of linkedGroups.values()) {
    const videos = group.filter((clip) => clip.kind === 'video')
    const audios = group.filter((clip) => clip.kind === 'audio')
    if (!videos.length || !audios.length) continue
    if (videos.length !== 1 || audios.length !== 1) {
      addIssue(issues, 'error', 'TIMELINE_LINKED_AV_INVALID', 'linked A/Vが1組として解釈できません。')
      continue
    }
    const video = videos[0]
    const audio = audios[0]
    if (!video || !audio || video.startUs !== audio.startUs || video.durationUs !== audio.durationUs || video.sourceInUs !== audio.sourceInUs) {
      addIssue(issues, 'error', 'TIMELINE_LINKED_AV_MAPPING_INVALID', 'linked A/Vのtimeline/source範囲が一致しません。', video?.id, undefined, video?.startUs)
    }
  }

  const baselines = new Map((options.autoCaptionBaselines ?? []).map((baseline) => [baseline.jobId, baseline]))
  for (const track of project.tracks.filter((candidate) => candidate.kind === 'subtitle')) {
    const subtitleClips = track.clips.filter((clip) => clip.kind === 'subtitle')
    for (const clip of subtitleClips) {
      if (!clip.text.trim() && clip.enabled) addIssue(issues, 'warning', 'SUBTITLE_EMPTY_TEXT', '字幕本文が空です。', clip.id, undefined, clip.startUs)
      if (track.hidden || track.muted || !clip.enabled) addIssue(issues, 'info', 'SUBTITLE_DISABLED_HIDDEN', '字幕が非表示または無効になっています。', clip.id, undefined, clip.startUs)
      if (!finite(clip.maxLines ?? 2) || !Number.isSafeInteger(clip.maxLines ?? 2) || (clip.maxLines ?? 2) < 1 || (clip.maxLines ?? 2) > 16) {
        addIssue(issues, 'error', 'SUBTITLE_MAX_LINES_INVALID', '字幕の最大行数が不正です。', clip.id, undefined, clip.startUs)
      }
      const maxWidth = clip.style?.maxWidthPercent
      if (!finite(maxWidth)) addIssue(issues, 'error', 'SUBTITLE_MAX_WIDTH_INVALID', '字幕の最大幅が不正です。', clip.id, undefined, clip.startUs)
      else if (maxWidth <= 0 || maxWidth > 300) addIssue(issues, 'warning', 'SUBTITLE_MAX_WIDTH_OUT_OF_RANGE', '字幕の最大幅が推奨編集範囲外です。', clip.id, undefined, clip.startUs)
      if (visualEndUs > 0 && (clip.startUs >= visualEndUs || clipEnd(clip) > visualEndUs + frameDurationUs(project))) {
        addIssue(issues, 'warning', 'SUBTITLE_OUTSIDE_SEQUENCE', '字幕の時間範囲が映像シーケンス外です。', clip.id, undefined, clip.startUs)
      }
      if (clip.words) {
        const wordIds = new Set<string>()
        let previousEnd = clip.startUs
        let malformed = false
        for (const word of clip.words) {
          if (!word.id || wordIds.has(word.id) || typeof word.text !== 'string' || !finite(word.startUs) || !finite(word.endUs) || word.startUs < clip.startUs || word.endUs < word.startUs || word.endUs > clipEnd(clip) || word.startUs < previousEnd) malformed = true
          wordIds.add(word.id)
          previousEnd = word.endUs
        }
        if (malformed) addIssue(issues, 'error', 'SUBTITLE_WORD_TIMING_INVALID', '字幕の単語タイミングが不正です。', clip.id, undefined, clip.startUs)
        if (clip.words.map((word) => word.text).join('') !== clip.text) addIssue(issues, 'warning', 'SUBTITLE_WORD_TEXT_MISMATCH', '字幕本文と単語ownershipの連結結果が一致しません。', clip.id, undefined, clip.startUs)
      }
      if (clip.sourceJobId && options.autoCaptionBaselines) {
        const baseline = baselines.get(clip.sourceJobId)
        if (!baseline) addIssue(issues, 'info', 'AUTO_CAPTION_DIAGNOSTIC_MISSING', '自動字幕のfallback診断を読み込めませんでした。', clip.id, undefined, clip.startUs)
        else if (baseline.fallback.used && (!baseline.fallback.reason || !baseline.diagnostics.length)) addIssue(issues, 'warning', 'AUTO_CAPTION_FALLBACK_DIAGNOSTIC_MISSING', '自動字幕fallbackの診断情報が不完全です。', clip.id, undefined, clip.startUs)
      }
    }
  }

  checkSilenceMetadata(project, issues)

  const output = options.outputSettings ?? project.sequence
  if (!Number.isInteger(output.width) || !Number.isInteger(output.height) || output.width < 16 || output.height < 16 || output.width % 2 !== 0 || output.height % 2 !== 0) addIssue(issues, 'error', 'EXPORT_DIMENSIONS_INVALID', '書き出し解像度が不正です。')
  if (!output.frameRate || !Number.isFinite(output.frameRate.numerator) || !Number.isFinite(output.frameRate.denominator) || output.frameRate.numerator <= 0 || output.frameRate.denominator <= 0) addIssue(issues, 'error', 'EXPORT_FRAMERATE_INVALID', '書き出しフレームレートが不正です。')
  if (options.encoderReport && !options.encoderReport.capabilities.some((encoder) => encoder.available)) addIssue(issues, 'error', 'EXPORT_ENCODER_UNAVAILABLE', '利用可能な映像エンコーダーがありません。')
  else if (!options.encoderReport) addIssue(issues, 'info', 'EXPORT_ENCODER_NOT_CHECKED', '映像エンコーダーの検出結果はまだありません。')

  return {
    issues,
    errorCount: issues.filter((issue) => issue.severity === 'error').length,
    warningCount: issues.filter((issue) => issue.severity === 'warning').length,
    infoCount: issues.filter((issue) => issue.severity === 'info').length,
    canExport: !issues.some((issue) => issue.severity === 'error')
  }
}
