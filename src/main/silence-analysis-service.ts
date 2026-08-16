import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { AutoCaptionDiagnostic, AutoCaptionSilenceAnalysis } from '../shared/auto-caption-contract.js'
import { buildSilenceReapplyTarget, type SilenceCutRange, type SilenceReapplyTarget, type SourceTimeInterval } from '../shared/silence-cut.js'
import type { ProjectFile } from '../shared/types.js'
import { DEFAULT_SILENCE_REAPPLY_PROFILE, silenceCutProfileSettings, type SilenceCutProfileSettings, type SilenceReapplyProfile } from '../shared/silence-cut.js'
import type { FfmpegPaths } from './ffmpeg/binaries.js'
import { defaultProcessExecutor, ProcessCancelledError, type ProcessExecutor } from './ffmpeg/process.js'

const seconds = (value: number): string => (value / 1_000_000).toFixed(6)

export interface SilenceReapplyResult {
  jobId: string
  analysis: AutoCaptionSilenceAnalysis
  protectedIntervals: SourceTimeInterval[]
  alreadyRemovedSourceRanges: SilenceCutRange[]
  selectedClipId: string
}

export interface SilenceAnalysisServiceOptions {
  executor?: ProcessExecutor
  timeoutMs?: number
}

interface SilenceEvent {
  startUs: number
  endUs: number
}

const diagnostic = (level: AutoCaptionDiagnostic['level'], code: string, message: string): AutoCaptionDiagnostic => ({ level, code, message })

const mergeIntervals = (intervals: readonly SourceTimeInterval[]): SourceTimeInterval[] => {
  const sorted = intervals.filter((item) => item.endUs > item.startUs).map((item) => ({ startUs: item.startUs, endUs: item.endUs })).sort((left, right) => left.startUs - right.startUs)
  const merged: SourceTimeInterval[] = []
  for (const interval of sorted) {
    const previous = merged.at(-1)
    if (!previous || interval.startUs > previous.endUs) merged.push(interval)
    else previous.endUs = Math.max(previous.endUs, interval.endUs)
  }
  return merged
}

export const parseSilencedetectOutput = (output: string, durationUs: number, sourceInUs = 0, minSilenceUs = silenceCutProfileSettings().minSilenceUs): SilenceEvent[] => {
  const events: SilenceEvent[] = []
  let silenceStartUs: number | undefined
  for (const line of output.split(/\r?\n/u)) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/u.exec(line)
    if (start) {
      const value = Math.round(Number(start[1]) * 1_000_000)
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('FFmpegの無音解析結果の形式が不正です。')
      silenceStartUs = value
      continue
    }
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/u.exec(line)
    if (!end || silenceStartUs === undefined) continue
    const endUs = Math.round(Number(end[1]) * 1_000_000)
    if (!Number.isSafeInteger(endUs) || endUs <= silenceStartUs) throw new Error('FFmpegの無音解析結果の形式が不正です。')
    if (endUs - silenceStartUs >= minSilenceUs) events.push({ startUs: sourceInUs + silenceStartUs, endUs: sourceInUs + Math.min(durationUs, endUs) })
    silenceStartUs = undefined
  }
  if (silenceStartUs !== undefined) {
    const endUs = durationUs
    if (endUs - silenceStartUs >= minSilenceUs) events.push({ startUs: sourceInUs + silenceStartUs, endUs: sourceInUs + endUs })
  }
  return events.filter((event) => event.endUs > event.startUs)
}

const subtractProtected = (candidate: SourceTimeInterval, protectedIntervals: readonly SourceTimeInterval[]): SourceTimeInterval[] => {
  let pieces: SourceTimeInterval[] = [{ ...candidate }]
  for (const guard of protectedIntervals) {
    const next: SourceTimeInterval[] = []
    for (const piece of pieces) {
      if (guard.endUs <= piece.startUs || guard.startUs >= piece.endUs) next.push(piece)
      else {
        if (piece.startUs < guard.startUs) next.push({ startUs: piece.startUs, endUs: guard.startUs })
        if (guard.endUs < piece.endUs) next.push({ startUs: guard.endUs, endUs: piece.endUs })
      }
    }
    pieces = next
  }
  return pieces.filter((piece) => piece.endUs > piece.startUs)
}

const keepRanges = (sourceInUs: number, sourceEndUs: number, removed: readonly SourceTimeInterval[]): Array<{ startUs: number; endUs: number; durationUs: number }> => {
  const ranges: Array<{ startUs: number; endUs: number; durationUs: number }> = []
  let cursor = sourceInUs
  for (const interval of mergeIntervals(removed)) {
    if (interval.startUs > cursor) ranges.push({ startUs: cursor, endUs: interval.startUs, durationUs: interval.startUs - cursor })
    cursor = Math.max(cursor, interval.endUs)
  }
  if (cursor < sourceEndUs) ranges.push({ startUs: cursor, endUs: sourceEndUs, durationUs: sourceEndUs - cursor })
  return ranges
}

const makeAnalysis = (
  events: readonly SilenceEvent[],
  target: SilenceReapplyTarget,
  output: string,
  profile: SilenceCutProfileSettings
): AutoCaptionSilenceAnalysis => {
  const sourceEndUs = target.sourceInUs + target.durationUs
  const protectedIntervals = [
    ...target.alreadyRemovedSourceRanges,
    ...target.protectedIntervals.map((interval) => ({
      startUs: Math.max(target.sourceInUs, interval.startUs - profile.speechProtectionUs),
      endUs: Math.min(sourceEndUs, interval.endUs + profile.speechProtectionUs)
    }))
  ]
  const removed: SourceTimeInterval[] = []
  const silences = events.map((event) => {
    const candidate = {
      startUs: Math.max(target.sourceInUs, event.startUs + profile.retainPauseUs / 2),
      endUs: Math.min(sourceEndUs, event.endUs - (profile.retainPauseUs - profile.retainPauseUs / 2))
    }
    const removable = subtractProtected(candidate, protectedIntervals)
    removed.push(...removable)
    return {
      startUs: event.startUs,
      endUs: event.endUs,
      durationUs: event.endUs - event.startUs,
      removedRanges: removable.map((range) => ({ ...range, durationUs: range.endUs - range.startUs })),
      speechProtected: removable.length !== (candidate.endUs > candidate.startUs ? 1 : 0)
    }
  })
  const mergedRemoved = mergeIntervals(removed)
  return {
    silences,
    keepRanges: keepRanges(target.sourceInUs, sourceEndUs, mergedRemoved),
    removedDurationUs: mergedRemoved.reduce((sum, range) => sum + range.endUs - range.startUs, 0),
    settings: profile,
    diagnostics: [
      diagnostic('info', 'AUDIO_SIGNAL_AUTHORITY', 'Silences came from FFmpeg silencedetect.'),
      diagnostic('info', 'WHISPER_WORD_PROTECTION', `Protected ${target.protectedIntervals.length} raw Whisper word intervals.`),
      diagnostic('info', 'ALREADY_REMOVED_SOURCE_RANGES', `Ignored ${target.alreadyRemovedSourceRanges.length} previously removed source ranges.`),
      diagnostic('info', 'FILLER_REMOVAL_DISABLED', 'Filler classification and deletion were not run.'),
      ...(output.includes('silence_start') ? [] : [diagnostic('info', 'NO_SIGNAL_SILENCE', 'FFmpeg found no silence interval meeting the profile.')])
    ]
  }
}

export class SilenceAnalysisService {
  readonly paths: FfmpegPaths
  readonly executor: ProcessExecutor
  readonly timeoutMs: number
  readonly #jobs = new Map<string, AbortController>()

  constructor(paths: FfmpegPaths, options: SilenceAnalysisServiceOptions = {}) {
    this.paths = paths
    this.executor = options.executor ?? defaultProcessExecutor
    this.timeoutMs = options.timeoutMs ?? 120_000
  }

  async start(project: ProjectFile, selectedClipId: string, requestedJobId?: string, requestedProfile: SilenceReapplyProfile = DEFAULT_SILENCE_REAPPLY_PROFILE): Promise<SilenceReapplyResult> {
    const jobId = requestedJobId ?? `silence-reapply-${randomUUID()}`
    if (!/^[A-Za-z0-9_-]{1,160}$/u.test(jobId)) throw new Error('無音再適用のjob IDが不正です。')
    if (this.#jobs.has(jobId)) throw new Error('無音再適用がすでに実行中です。')
    const controller = new AbortController()
    this.#jobs.set(jobId, controller)
    try {
      const profile = silenceCutProfileSettings(requestedProfile)
      const target = buildSilenceReapplyTarget(project, selectedClipId)
      const asset = project.media.find((candidate) => candidate.id === target.assetId)
      if (!asset || asset.offline || !asset.hasAudio || !isAbsolute(asset.path)) throw new Error('無音再適用の音声素材が利用できません。')
      const result = await this.executor.run({
        command: this.paths.ffmpegPath,
        args: [
          '-hide_banner', '-loglevel', 'info', '-ss', seconds(target.sourceInUs), '-t', seconds(target.durationUs),
          '-i', asset.path, '-map', '0:a:0', '-vn', '-af', `silencedetect=noise=${profile.noiseDb.toFixed(2)}dB:d=${seconds(profile.minSilenceUs)}`,
          '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'
        ],
        signal: controller.signal,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: 8 * 1024 * 1024
      })
      const analysis = makeAnalysis(parseSilencedetectOutput(`${result.stdout}\n${result.stderr}`, target.durationUs, target.sourceInUs, profile.minSilenceUs), target, `${result.stdout}\n${result.stderr}`, profile)
      return { jobId, analysis, protectedIntervals: target.protectedIntervals, alreadyRemovedSourceRanges: target.alreadyRemovedSourceRanges, selectedClipId }
    } catch (error) {
      if (error instanceof ProcessCancelledError) throw new Error('無音再適用をキャンセルしました。')
      throw error
    } finally {
      this.#jobs.delete(jobId)
    }
  }

  cancel(jobId: string): boolean {
    const controller = this.#jobs.get(jobId)
    if (!controller) return false
    controller.abort()
    return true
  }
}
