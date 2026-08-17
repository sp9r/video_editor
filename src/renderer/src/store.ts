import { create } from 'zustand'
import {
  addClipToTrack,
  addMediaAssets,
  createClipForAsset,
  createSubtitleClip,
  createTrack,
  makeId,
  subtitleOverlaps,
  projectDurationUs,
  relinkMediaAsset,
  replaceTrack,
  shiftClipTimeline,
  SubtitleCollisionError,
  validateProject,
  updateClip,
  projectFingerprint
} from '../../shared/project'
import { deleteLinkedClips, EditingOperationError, isSubtitleWordBoundarySplitAvailable, mergeSubtitleWithNext, mergeSubtitleWithPrevious, moveLinkedClip, moveSubtitleBoundary, nearestSubtitleWordBoundaryIndex, splitLinkedClip, splitSelectedRoots, splitSubtitleAtWordBoundary, trimLinkedClip } from '../../shared/editing/operations'
import { linkedClipIds } from '../../shared/editing/links'
import { isMediaTrack } from '../../shared/types'
import type { AutoCaptionProgress, AutoCaptionResult, AutoCaptionSettings, AutoCaptionSilenceAnalysis } from '../../shared/auto-caption-contract'
import { applyAutoCaptionResultToProject } from '../../shared/auto-caption-adapter'
import { applySilenceCutToProject, canRestoreSilenceCut, DEFAULT_SILENCE_REAPPLY_PROFILE, createSilenceCutTimeMapper, restoreSilenceCutToProject, silenceCutOperationForClip, type SilenceReapplyProfile } from '../../shared/silence-cut'
import type { MediaAsset, ProjectFile, SubtitleStyle, TimelineClip, TimelineTrack, TimeUs } from '../../shared/types'
import type { UserSubtitleTemplate } from '../../shared/subtitle-templates'
import type { FullCorrectionSession } from '../../shared/full-correction'
import { describeAutoCaptionBackend } from '../../shared/auto-caption-ui'
import { createDemoProject } from './demo'
import { clampTimelineZoom, TIMELINE_ZOOM_DEFAULT } from './action-state'

type EditTool = 'select' | 'razor'
type Notice = { id: number; tone: 'info' | 'success' | 'warning' | 'error'; message: string }

interface EditorState {
  project: ProjectFile
  projectLoadVersion: number
  past: ProjectFile[]
  future: ProjectFile[]
  selectedClipIds: string[]
  selectedAssetId: string | null
  playheadUs: TimeUs
  playing: boolean
  tool: EditTool
  snapping: boolean
  rippleMode: boolean
  zoomPxPerSecond: number
  dirty: boolean
  lastSavedAt: Date | null
  notice: Notice | null
  autoCaptionProgress: AutoCaptionProgress | null
  autoCaptionJobId: string | null
  silenceCutReapplyJobId: string | null
  silenceCutReapplyCancelledJobId: string | null
  silenceCutReapplyBusy: boolean
  userSubtitleTemplates: UserSubtitleTemplate[]
  defaultSubtitleTemplateId: string
  autoCaptionSettingsSeed: Pick<AutoCaptionSettings, 'maxChars' | 'maxLines' | 'segmentationMode'>
  savedFingerprint: string
  transactionBase: ProjectFile | null
  clipboard: ClipboardItem[]
  fullCorrectionSession: FullCorrectionSession | null
  fullCorrectionResult: FullCorrectionSession | null
  applyProject(project: ProjectFile, options?: { selectClipId?: string; preserveHistory?: boolean }): void
  loadProject(project: ProjectFile): void
  markSaved(project?: ProjectFile): void
  beginEditTransaction(): void
  commitEditTransaction(): void
  cancelEditTransaction(): void
  selectClip(id: string | null, additive?: boolean): void
  selectAsset(id: string | null): void
  setPlayhead(value: TimeUs): void
  setPlaying(value: boolean): void
  setTool(value: EditTool): void
  setSnapping(value: boolean): void
  setRippleMode(value: boolean): void
  setZoom(value: number): void
  addAssets(assets: MediaAsset[]): void
  relinkAsset(assetId: string, asset: MediaAsset): void
  addAssetClip(assetId: string, trackId: string, atUs: TimeUs): void
  autoCaptionSelected(settings?: AutoCaptionSettings): Promise<AutoCaptionApplySummary | null>
  cancelAutoCaption(): Promise<void>
  reapplySilenceCut(profile?: SilenceReapplyProfile, minSilenceUs?: number): Promise<boolean>
  updateSilenceCutThreshold(minSilenceUs: number): Promise<boolean>
  restoreSilenceCut(): boolean
  cancelSilenceCutReapply(): Promise<void>
  setUserSubtitleTemplates(templates: UserSubtitleTemplate[]): void
  setDefaultSubtitleTemplateId(id: string): void
  setAutoCaptionSettingsSeed(settings: Pick<AutoCaptionSettings, 'maxChars' | 'maxLines' | 'segmentationMode'>): void
  hydrateFullCorrectionSessions(sessions: FullCorrectionSession[]): void
  startFullCorrection(): Promise<boolean>
  finishFullCorrection(): Promise<FullCorrectionSession | null>
  clearFullCorrectionResult(): void
  addSubtitle(): void
  patchClip(clipId: string, patcher: (clip: TimelineClip) => TimelineClip): void
  splitSubtitleAtWordBoundary(clipId: string, boundaryIndex: number): void
  moveSubtitleBoundary(leftClipId: string, rightClipId: string, boundaryIndex: number): void
  mergeSubtitleWithPrevious(clipId: string): void
  mergeSubtitleWithNext(clipId: string): void
  moveSelected(clipId: string, trackId: string, atUs: TimeUs): void
  trim(clipId: string, edge: 'start' | 'end', atUs: TimeUs): void
  splitSelectedAt(atUs: TimeUs): void
  splitSelected(): void
  deleteSelected(ripple?: boolean): void
  copySelected(): void
  pasteClipboard(atUs?: TimeUs): void
  duplicateSelected(): void
  applySubtitleStyleToAll(clipId: string): void
  applySubtitleStyleToTrack(clipId: string, style: SubtitleStyle): void
  patchTrack(track: TimelineTrack): void
  addMediaTrack(): void
  addSubtitleTrack(): void
  deleteTrack(trackId: string): void
  renameTrack(trackId: string, name: string): void
  reorderTrack(trackId: string, direction: -1 | 1): void
  undo(): void
  redo(): void
  showNotice(message: string, tone?: Notice['tone']): void
  clearNotice(): void
}

interface ClipboardItem {
  trackId: string
  clip: TimelineClip
}

export interface AutoCaptionApplySummary {
  captionCount: number
  rawWordCount: number
  wordBearingCaptionCount: number
  fallbackUsed: boolean
  silenceCount: number
  removedDurationUs: number
  whisperBackend: string
  templateId: string
  silenceCutSkipped?: boolean
  silenceStatus: 'executed' | 'off' | 'no-op' | 'skipped'
  silenceProfile: string
  silenceCandidateCount: number
  actualCutCount: number
  originalDurationUs: number
  editedDurationUs: number
}

const HISTORY_LIMIT = 80

const cloneProject = (project: ProjectFile): ProjectFile => structuredClone(project)
const initialProject = createDemoProject()

const compatibleTrack = (_asset: MediaAsset, track: TimelineTrack): boolean => {
  return isMediaTrack(track)
}

export const useEditorStore = create<EditorState>((set, get) => ({
  project: initialProject,
  projectLoadVersion: 0,
  past: [],
  future: [],
  selectedClipIds: [],
  selectedAssetId: null,
  playheadUs: 2_200_000,
  playing: false,
  tool: 'select',
  snapping: true,
  rippleMode: false,
  zoomPxPerSecond: TIMELINE_ZOOM_DEFAULT,
  dirty: false,
  lastSavedAt: null,
  savedFingerprint: projectFingerprint(initialProject),
  transactionBase: null,
  clipboard: [],
  fullCorrectionSession: null,
  fullCorrectionResult: null,
  notice: null,
  autoCaptionProgress: null,
  autoCaptionJobId: null,
  silenceCutReapplyJobId: null,
  silenceCutReapplyCancelledJobId: null,
  silenceCutReapplyBusy: false,
  userSubtitleTemplates: [],
  defaultSubtitleTemplateId: 'default',
  autoCaptionSettingsSeed: { maxChars: 32, maxLines: 2, segmentationMode: 'auto' },
  applyProject: (project, options = {}) => {
    const current = get().project
    if (project === current) return
    set((state) => ({
      project,
      past: options.preserveHistory || state.transactionBase ? state.past : [...state.past, cloneProject(current)].slice(-HISTORY_LIMIT),
      future: options.preserveHistory || state.transactionBase ? state.future : [],
      selectedClipIds: options.selectClipId ? [options.selectClipId] : state.selectedClipIds,
      dirty: projectFingerprint(project) !== state.savedFingerprint
    }))
  },
  loadProject: (project) => {
    const normalized = validateProject(project)
    set((state) => ({
      project: normalized,
      projectLoadVersion: state.projectLoadVersion + 1,
      past: [],
      future: [],
      selectedClipIds: [],
      selectedAssetId: null,
      playheadUs: 0,
      playing: false,
      dirty: false,
      lastSavedAt: new Date(),
      savedFingerprint: projectFingerprint(normalized),
      transactionBase: null,
      autoCaptionProgress: null,
      autoCaptionJobId: null,
      silenceCutReapplyJobId: null,
      silenceCutReapplyCancelledJobId: null,
      silenceCutReapplyBusy: false,
      fullCorrectionSession: null,
      fullCorrectionResult: null
    }))
  },
  markSaved: (project) => {
    const saved = project ? cloneProject(project) : get().project
    set({ project: saved, dirty: false, lastSavedAt: new Date(), savedFingerprint: projectFingerprint(saved), transactionBase: null })
  },
  beginEditTransaction: () => {
    if (!get().transactionBase) set({ transactionBase: cloneProject(get().project) })
  },
  commitEditTransaction: () => {
    const base = get().transactionBase
    if (!base) return
    const current = get().project
    const changed = projectFingerprint(base) !== projectFingerprint(current)
    set((state) => ({
      past: changed ? [...state.past, base].slice(-HISTORY_LIMIT) : state.past,
      future: changed ? [] : state.future,
      dirty: projectFingerprint(current) !== state.savedFingerprint,
      transactionBase: null
    }))
  },
  cancelEditTransaction: () => {
    const base = get().transactionBase
    if (!base) return
    set((state) => ({ project: base, dirty: projectFingerprint(base) !== state.savedFingerprint, transactionBase: null }))
  },
  selectClip: (id, additive = false) => {
    if (!id) return set({ selectedClipIds: [] })
    const selected = get().selectedClipIds
    const group = linkedClipIds(get().project, id)
    if (!additive) return set({ selectedClipIds: group })
    const toggledOff = group.some((item) => selected.includes(item))
    set({ selectedClipIds: toggledOff ? selected.filter((item) => !group.includes(item)) : [...selected, ...group.filter((item) => !selected.includes(item))] })
  },
  selectAsset: (id) => set({ selectedAssetId: id }),
  setPlayhead: (playheadUs) => set({ playheadUs: Math.max(0, playheadUs) }),
  setPlaying: (playing) => set({ playing }),
  setTool: (tool) => set({ tool }),
  setSnapping: (snapping) => set({ snapping }),
  setRippleMode: (rippleMode) => set({ rippleMode }),
  setZoom: (zoomPxPerSecond) => set({ zoomPxPerSecond: clampTimelineZoom(zoomPxPerSecond) }),
  addAssets: (assets) => get().applyProject(addMediaAssets(get().project, assets)),
  relinkAsset: (assetId, asset) => get().applyProject(relinkMediaAsset(get().project, assetId, asset)),
  addAssetClip: (assetId, trackId, atUs) => {
    const { project } = get()
    const asset = project.media.find((item) => item.id === assetId)
    const track = project.tracks.find((item) => item.id === trackId)
    if (!asset || !track || !compatibleTrack(asset, track)) {
      get().showNotice('この素材は選択したトラックへ配置できません。', 'warning')
      return
    }
    const clip = createClipForAsset(asset, Math.max(0, atUs))
    get().applyProject(addClipToTrack(project, trackId, clip), { selectClipId: clip.id })
  },
  autoCaptionSelected: async (settings) => {
    if (!window.spectra) {
      get().showNotice('自動字幕はElectronデスクトップ版で利用できます。', 'warning')
      return null
    }
    const selectedIds = [...get().selectedClipIds]
    const project = get().project
    const selectedClip = project.tracks.flatMap((track) => track.clips).find((clip) => selectedIds.includes(clip.id))
    if (selectedIds.length !== 1 || !selectedClip || (selectedClip.kind !== 'video' && selectedClip.kind !== 'audio')) {
      get().showNotice('動画または音声クリップを1つだけ選択してから自動字幕を実行してください。', 'warning')
      return null
    }
    const asset = 'assetId' in selectedClip ? project.media.find((item) => item.id === selectedClip.assetId) : undefined
    if (!asset || asset.offline || !asset.hasAudio) {
      get().showNotice('選択した素材の音声を利用できません。再リンクまたは音声付き素材を選択してください。', 'warning')
      return null
    }
    set({ autoCaptionProgress: { version: 'spectra.auto-caption.progress.v1', jobId: '', state: 'preparing', ratio: 0, message: '音声準備中…' }, autoCaptionJobId: null })
    try {
      const health = await window.spectra.autoCaptionHealth()
      if (!health.available) throw new Error(health.reason ?? '自動字幕エンジンを利用できません。')
      const completed = await new Promise<{ result: AutoCaptionResult; silenceAnalysis?: AutoCaptionSilenceAnalysis }>((resolve, reject) => {
        let startedJobId = ''
        let terminalBeforeStart: AutoCaptionProgress | undefined
        let settled = false
        const rejectFromProgress = (progress: AutoCaptionProgress): void => {
          set({ autoCaptionProgress: progress })
          settled = true
          unsubscribe()
          reject(new Error(progress.errorCode === 'CANCELLED'
            ? '自動字幕をキャンセルしました。'
            : `${progress.message} (${progress.errorCode ?? 'WORKER_FAILED'})`))
        }
        const unsubscribe = window.spectra!.onAutoCaptionProgress((progress) => {
          if (startedJobId && progress.jobId !== startedJobId) return
          if (!startedJobId) {
            if (progress.state === 'completed' || progress.state === 'failed') terminalBeforeStart = progress
            return
          }
          if (settled) return
          set({ autoCaptionProgress: progress })
          if (progress.state === 'failed') {
            rejectFromProgress(progress)
          } else if (progress.state === 'completed' && progress.result) {
            settled = true
            unsubscribe()
            resolve({ result: progress.result, silenceAnalysis: progress.silenceAnalysis })
          }
        })
        const start = settings
          ? window.spectra!.startAutoCaption(project, selectedIds, settings)
          : window.spectra!.startAutoCaption(project, selectedIds)
        void start.then(
          async (started) => {
            startedJobId = started.jobId
            set({ autoCaptionJobId: started.jobId })
            // IPC progress is a push notification. Reconcile once through
            // main-process state as well, so a completed result is not lost
            // when the renderer was busy, reloaded, or briefly absent.
            let terminal = terminalBeforeStart
            if (!terminal && typeof window.spectra?.getAutoCaptionStatus === 'function') {
              try {
                terminal = (await window.spectra.getAutoCaptionStatus(started.jobId))?.progress
              } catch {
                // The push subscription remains authoritative while the job
                // is running; a transient status query failure is retry-safe.
              }
            }
            if (terminal && terminal.jobId === started.jobId && !settled) {
              if (terminal.state === 'failed') {
                rejectFromProgress(terminal)
              } else if (terminal.result) {
                settled = true
                unsubscribe()
                resolve({ result: terminal.result, silenceAnalysis: terminal.silenceAnalysis })
              }
            }
          },
          (error) => {
            if (settled) return
            settled = true
            unsubscribe()
            reject(error)
          }
        )
      })
      const { result, silenceAnalysis } = completed
      if (projectFingerprint(get().project) !== projectFingerprint(project)) throw new Error('自動字幕の生成中にプロジェクトが変更されました。結果は適用されていません。')
      let applyProject = project
      let captionClip: Pick<TimelineClip, 'startUs' | 'sourceInUs' | 'durationUs'> = selectedClip
      let sourceTimeMapper: ReturnType<typeof createSilenceCutTimeMapper> | undefined
      let silenceSummary: ReturnType<typeof applySilenceCutToProject>['summary'] | undefined
      let silenceCutSkipped = false
      if (silenceAnalysis) {
        const hasExistingSubtitleClip = project.tracks.some((track) => track.kind === 'subtitle' && track.clips.some((clip) => clip.kind === 'subtitle' && clip.enabled && clip.durationUs > 0))
        const shouldSkipRepeatSilenceCut = hasExistingSubtitleClip
        if (shouldSkipRepeatSilenceCut) {
          // A rerun must not ripple a media clip through existing captions.
          // Keep the current timeline/source range authoritative and add the
          // new captions as an independent track instead.
          silenceCutSkipped = true
          silenceSummary = {
            selectedClipId: selectedClip.id,
            affectedClipIds: [selectedClip.id],
            segmentCount: 1,
            removedDurationUs: 0,
            keepRanges: [{ startUs: selectedClip.sourceInUs, endUs: selectedClip.sourceInUs + selectedClip.durationUs }]
          }
        } else {
          sourceTimeMapper = createSilenceCutTimeMapper(selectedClip, silenceAnalysis.keepRanges)
        }
        const isNoOpSilencePlan = !shouldSkipRepeatSilenceCut && silenceAnalysis.removedDurationUs === 0
          && silenceAnalysis.keepRanges.length === 1
          && silenceAnalysis.keepRanges[0]?.startUs === selectedClip.sourceInUs
          && silenceAnalysis.keepRanges[0]?.endUs === selectedClip.sourceInUs + selectedClip.durationUs
        if (!shouldSkipRepeatSilenceCut && isNoOpSilencePlan) {
          silenceSummary = {
            selectedClipId: selectedClip.id,
            affectedClipIds: [selectedClip.id],
            segmentCount: 1,
            removedDurationUs: 0,
            keepRanges: silenceAnalysis.keepRanges
          }
        } else if (!shouldSkipRepeatSilenceCut) {
          const silenceApplied = applySilenceCutToProject(project, selectedClip.id, silenceAnalysis, {
            timeMapper: sourceTimeMapper,
            protectedIntervals: result.rawWords.map((word) => ({ id: word.id, startUs: word.startUs, endUs: word.endUs })),
            profile: settings?.silenceCut && settings.silenceCut !== 'off' ? settings.silenceCut : undefined,
            minSilenceUs: silenceAnalysis.settings.minSilenceUs
          })
          applyProject = silenceApplied.project
          captionClip = silenceApplied.sourceClip
          silenceSummary = silenceApplied.summary
        }
      }
      const userSubtitleTemplates = get().userSubtitleTemplates
      const captionCoverageRanges = silenceAnalysis && silenceSummary
        ? silenceSummary.keepRanges.map((range) => ({
            startUs: sourceTimeMapper?.mapPoint(range.startUs) ?? selectedClip.startUs + (range.startUs - selectedClip.sourceInUs),
            endUs: sourceTimeMapper?.mapPoint(range.endUs) ?? selectedClip.startUs + (range.endUs - selectedClip.sourceInUs)
          }))
        : undefined
      const applied = applyAutoCaptionResultToProject(applyProject, captionClip, result, {
        maxChars: settings?.maxChars ?? 32,
        maxLines: settings?.maxLines ?? 2,
        sourceTimeMapper,
        subtitleTemplate: settings?.subtitleTemplate ?? 'default',
        userSubtitleTemplates,
        captionCoverageRanges,
        captionCoverageMaxGapUs: silenceAnalysis?.settings.minSilenceUs
      })
      set({ autoCaptionProgress: { version: 'spectra.auto-caption.progress.v1', jobId: result.jobId, state: 'completed', ratio: 0.96, progressMode: 'indeterminate', message: '字幕をTimelineへ適用中…', result } })
      const firstCaption = applied.project.tracks.find((track) => track.id === applied.trackId)?.clips[0]
      get().applyProject(applied.project, firstCaption ? { selectClipId: firstCaption.id } : undefined)
      const summary: AutoCaptionApplySummary = {
        ...applied,
        fallbackUsed: result.fallback.used,
        silenceCount: silenceAnalysis?.silences.length ?? 0,
        removedDurationUs: silenceSummary?.removedDurationUs ?? silenceAnalysis?.removedDurationUs ?? 0,
        whisperBackend: describeAutoCaptionBackend(result),
        templateId: settings?.subtitleTemplate ?? 'default',
        silenceCutSkipped,
        silenceStatus: silenceCutSkipped ? 'skipped' : !silenceAnalysis ? 'off' : (silenceSummary?.removedDurationUs ?? silenceAnalysis.removedDurationUs) > 0 ? 'executed' : 'no-op',
        silenceProfile: silenceAnalysis?.settings.profile ?? settings?.silenceCut ?? 'off',
        silenceCandidateCount: silenceAnalysis?.silences.length ?? 0,
        actualCutCount: silenceAnalysis?.silences.reduce((count, silence) => count + (silence.removedRanges?.filter((range) => range.endUs > range.startUs).length ?? ((silenceSummary?.removedDurationUs ?? 0) > 0 ? 1 : 0)), 0) ?? 0,
        originalDurationUs: projectDurationUs(project),
        editedDurationUs: projectDurationUs(applied.project)
      }
      set({ autoCaptionProgress: { version: 'spectra.auto-caption.progress.v1', jobId: result.jobId, state: 'completed', ratio: 1, message: '字幕を配置しました。', result }, autoCaptionJobId: null })
      const silenceNotice = silenceCutSkipped
        ? '・既存字幕を保持するため無音の再カットなし'
        : silenceSummary
          ? `・無音${(silenceSummary.removedDurationUs / 1_000_000).toFixed(2)}秒を短縮`
          : ''
      get().showNotice(`自動字幕を${summary.captionCount}件配置しました（raw word ${summary.rawWordCount}件${summary.fallbackUsed ? '・ルールfallback' : ''}${silenceNotice}）。`, 'success')
      return summary
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      set((state) => ({
        autoCaptionProgress: state.autoCaptionProgress?.state === 'failed'
          ? state.autoCaptionProgress
          : state.autoCaptionProgress
            ? { ...state.autoCaptionProgress, state: 'failed', ratio: 0, message: errorMessage || '自動字幕を完了できませんでした。', errorCode: 'AUTO_CAPTION_FAILED' }
            : null,
        autoCaptionJobId: null
      }))
      get().showNotice(`自動字幕を生成できませんでした: ${errorMessage}`, 'error')
      return null
    }
  },
  reapplySilenceCut: async (requestedProfile = DEFAULT_SILENCE_REAPPLY_PROFILE, minSilenceUs) => {
    const current = get()
    if (current.silenceCutReapplyBusy) return false
    if (!window.spectra) {
      current.showNotice('無音カットの再適用はElectron環境で利用できます。', 'warning')
      return false
    }
    const selected = current.project.tracks.flatMap((track) => track.clips).find((clip) => current.selectedClipIds.includes(clip.id) && (clip.kind === 'video' || clip.kind === 'audio'))
    if (!selected || (selected.kind !== 'video' && selected.kind !== 'audio')) {
      current.showNotice('映像または音声クリップを1つ選択してください。', 'warning')
      return false
    }
    const project = current.project
    const jobId = makeId('silence-reapply')
    set({ silenceCutReapplyJobId: jobId, silenceCutReapplyCancelledJobId: null, silenceCutReapplyBusy: true })
    try {
      const result = minSilenceUs === undefined
        ? await window.spectra.startSilenceCutReapply(project, selected.id, jobId, requestedProfile)
        : await window.spectra.startSilenceCutReapply(project, selected.id, jobId, requestedProfile, minSilenceUs)
      if (projectFingerprint(get().project) !== projectFingerprint(project)) throw new Error('無音解析中にプロジェクトが変更されました。結果は適用していません。')
      if (result.selectedClipId !== selected.id || result.jobId !== jobId) throw new Error('無音再適用の結果identityが不正です。')
      if (get().silenceCutReapplyCancelledJobId === jobId) throw new Error('無音再適用をキャンセルしました。')
      if (result.analysis.removedDurationUs === 0) {
        get().showNotice('現在のクリップに再適用できる無音区間はありません。', 'info')
        return true
      }
      const applied = applySilenceCutToProject(project, selected.id, result.analysis, { protectedIntervals: result.protectedIntervals, profile: requestedProfile, minSilenceUs: result.analysis.settings.minSilenceUs })
      if (applied.summary.removedDurationUs === 0 || applied.project === project) {
        get().showNotice('現在のクリップに再適用できる無音区間はありません。', 'info')
        return true
      }
      const firstTarget = applied.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === `${selected.id}:silence:1`)
      get().applyProject(applied.project, firstTarget ? { selectClipId: firstTarget.id } : undefined)
      get().showNotice(`無音カットを再適用しました（${(applied.summary.removedDurationUs / 1_000_000).toFixed(2)}秒短縮）。`, 'success')
      return true
    } catch (error) {
      get().showNotice(`無音カットを再適用できませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return false
    } finally {
      set((state) => state.silenceCutReapplyJobId === jobId
        ? { silenceCutReapplyJobId: null, silenceCutReapplyCancelledJobId: null, silenceCutReapplyBusy: false }
        : state)
    }
  },
  updateSilenceCutThreshold: async (minSilenceUs) => {
    const current = get()
    if (current.silenceCutReapplyBusy) return false
    if (!window.spectra) {
      current.showNotice('無音カットの更新はElectron環境で利用できます。', 'warning')
      return false
    }
    const selected = current.project.tracks.flatMap((track) => track.clips).find((clip) => current.selectedClipIds.includes(clip.id) && (clip.kind === 'video' || clip.kind === 'audio'))
    const operation = selected ? silenceCutOperationForClip(current.project, selected.id) : null
    if (!selected || !operation || !canRestoreSilenceCut(current.project, selected.id)) {
      current.showNotice('無音カット後のclipが変更されているため、安全に閾値を更新できません。', 'warning')
      return false
    }
    const requestedThresholdUs = Math.round(Math.max(0, Math.min(2_000_000, Number.isFinite(minSilenceUs) ? minSilenceUs : operation.minSilenceUs ?? 0)))
    const project = current.project
    const restored = restoreSilenceCutToProject(project, selected.id)
    const jobId = makeId('silence-update')
    set({ silenceCutReapplyJobId: jobId, silenceCutReapplyCancelledJobId: null, silenceCutReapplyBusy: true })
    try {
      const profile = operation.profile ?? DEFAULT_SILENCE_REAPPLY_PROFILE
      const result = await window.spectra.startSilenceCutReapply(restored.project, restored.restoredClipId, jobId, profile, requestedThresholdUs)
      if (projectFingerprint(get().project) !== projectFingerprint(project)) throw new Error('無音閾値の解析中にプロジェクトが変更されました。結果は適用していません。')
      if (result.jobId !== jobId || result.selectedClipId !== restored.restoredClipId) throw new Error('無音閾値更新の結果identityが不正です。')
      if (get().silenceCutReapplyCancelledJobId === jobId) throw new Error('無音閾値更新をキャンセルしました。')
      const applied = applySilenceCutToProject(restored.project, restored.restoredClipId, result.analysis, {
        protectedIntervals: result.protectedIntervals,
        profile,
        minSilenceUs: result.analysis.settings.minSilenceUs
      })
      const firstTarget = applied.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id.startsWith(`${restored.restoredClipId}:silence:`))
      get().applyProject(applied.project, firstTarget ? { selectClipId: firstTarget.id } : { selectClipId: restored.restoredClipId })
      get().showNotice(`無音カットを更新しました（最小${(result.analysis.settings.minSilenceUs / 1_000_000).toFixed(2)}秒）。`, 'success')
      return true
    } catch (error) {
      get().showNotice(`無音カットを更新できませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return false
    } finally {
      set((state) => state.silenceCutReapplyJobId === jobId
        ? { silenceCutReapplyJobId: null, silenceCutReapplyCancelledJobId: null, silenceCutReapplyBusy: false }
        : state)
    }
  },
  restoreSilenceCut: () => {
    const current = get()
    const selected = current.project.tracks.flatMap((track) => track.clips).find((clip) => current.selectedClipIds.includes(clip.id) && (clip.kind === 'video' || clip.kind === 'audio'))
    if (!selected || !canRestoreSilenceCut(current.project, selected.id)) {
      current.showNotice('無音カット後のclipが変更されているため、安全に解除できません。', 'warning')
      return false
    }
    try {
      const restored = restoreSilenceCutToProject(current.project, selected.id)
      get().beginEditTransaction()
      get().applyProject(restored.project, { selectClipId: restored.restoredClipId })
      get().commitEditTransaction()
      get().showNotice(`無音カットを解除しました（${(restored.restoredDurationUs / 1_000_000).toFixed(2)}秒復元）。`, 'success')
      return true
    } catch (error) {
      if (get().transactionBase) get().cancelEditTransaction()
      get().showNotice(`無音カットを解除できませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return false
    }
  },
  cancelSilenceCutReapply: async () => {
    const jobId = get().silenceCutReapplyJobId
    if (!jobId || !window.spectra) return
    set({ silenceCutReapplyCancelledJobId: jobId })
    await window.spectra.cancelSilenceCutReapply(jobId)
  },
  cancelAutoCaption: async () => {
    const jobId = get().autoCaptionJobId
    if (!jobId || !window.spectra) return
    const requested = await window.spectra.cancelAutoCaption(jobId)
    if (requested) set((state) => ({ autoCaptionProgress: state.autoCaptionProgress ? { ...state.autoCaptionProgress, message: 'キャンセル中…' } : null }))
  },
  setUserSubtitleTemplates: (templates) => set({ userSubtitleTemplates: structuredClone(templates) }),
  setDefaultSubtitleTemplateId: (id) => set({ defaultSubtitleTemplateId: id }),
  setAutoCaptionSettingsSeed: (settings) => set({ autoCaptionSettingsSeed: structuredClone(settings) }),
  hydrateFullCorrectionSessions: (sessions) => {
    const current = get().project
    const active = sessions
      .filter((session) => session.status === 'active' && session.projectId === current.id && current.tracks.some((track) => track.id === session.track.id && track.kind === 'subtitle'))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
    set({ fullCorrectionSession: active, fullCorrectionResult: null })
  },
  startFullCorrection: async () => {
    const current = get()
    if (current.fullCorrectionSession) return true
    if (!window.spectra) {
      current.showNotice('全文修正セッションはElectron環境で利用できます。', 'warning')
      return false
    }
    if (current.selectedClipIds.length !== 1) {
      current.showNotice('自動字幕trackの字幕を1つ選択してください。', 'warning')
      return false
    }
    const selected = current.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === current.selectedClipIds[0])
    const track = current.project.tracks.find((candidate) => candidate.kind === 'subtitle' && candidate.clips.some((clip) => clip.id === selected?.id))
    if (!selected || selected.kind !== 'subtitle' || !selected.sourceJobId || !track) {
      current.showNotice('全文修正の対象は自動字幕trackです。', 'warning')
      return false
    }
    try {
      const session = await window.spectra.startFullCorrectionSession(current.project, track.id)
      set({ fullCorrectionSession: session, fullCorrectionResult: null })
      current.showNotice('全文修正を開始しました。通常の編集操作で字幕を修正できます。', 'success')
      return true
    } catch (error) {
      current.showNotice(`全文修正を開始できませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return false
    }
  },
  finishFullCorrection: async () => {
    const current = get()
    if (!current.fullCorrectionSession || !window.spectra) return null
    try {
      const result = await window.spectra.finishFullCorrectionSession(current.project, current.fullCorrectionSession.sessionId)
      set({ fullCorrectionSession: null, fullCorrectionResult: result })
      current.showNotice(`修正差分を保存しました（${result.statistics.mixed}件の複合変更）。`, 'success')
      return result
    } catch (error) {
      current.showNotice(`修正差分を保存できませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return null
    }
  },
  clearFullCorrectionResult: () => set({ fullCorrectionResult: null }),
  addSubtitle: () => {
    const { project, playheadUs } = get()
    const clip = createSubtitleClip(playheadUs)
    const next = cloneProject(project)
    let track = next.tracks.find((item) => item.kind === 'subtitle' && !item.locked && item.clips.every((item) => item.kind !== 'subtitle' || !subtitleOverlaps(item, clip)))
    if (!track) {
      track = createTrack('subtitle', next.tracks.filter((item) => item.kind === 'subtitle').length + 1)
      next.tracks.push(track)
    }
    track.clips.push(clip)
    track.clips.sort((left, right) => left.startUs - right.startUs)
    get().applyProject(validateProject(next), { selectClipId: clip.id })
  },
  patchClip: (clipId, patcher) => get().applyProject(updateClip(get().project, clipId, patcher)),
  splitSubtitleAtWordBoundary: (clipId, boundaryIndex) => {
    try {
      const { project } = get()
      const next = splitSubtitleAtWordBoundary(project, clipId, boundaryIndex)
      const right = next.tracks.flatMap((track) => track.clips).find((clip) => clip.id.startsWith(`${clipId}:subtitle-right:`))
      if (!right) return get().showNotice('単語の境界を確認できませんでした。', 'warning')
      get().applyProject(next)
      set({ selectedClipIds: [clipId, right.id] })
    } catch (error) {
      if (error instanceof EditingOperationError) get().showNotice(error.message, 'warning')
      else throw error
    }
  },
  mergeSubtitleWithPrevious: (clipId) => {
    try {
      const { project } = get()
      const location = project.tracks.flatMap((track) => track.clips.map((clip, index) => ({ track, clip, index }))).find(({ clip }) => clip.id === clipId)
      const previous = location?.track.kind === 'subtitle' ? location.track.clips[location.index - 1] : undefined
      if (!previous) return get().showNotice('前に結合できる字幕がありません。', 'warning')
      get().applyProject(mergeSubtitleWithPrevious(project, clipId), { selectClipId: previous.id })
    } catch (error) {
      if (error instanceof EditingOperationError) get().showNotice(error.message, 'warning')
      else throw error
    }
  },
  mergeSubtitleWithNext: (clipId) => {
    try {
      const { project } = get()
      const location = project.tracks.flatMap((track) => track.clips.map((clip, index) => ({ track, clip, index }))).find(({ clip }) => clip.id === clipId)
      const next = location?.track.kind === 'subtitle' ? location.track.clips[location.index + 1] : undefined
      if (!next) return get().showNotice('後ろに結合できる字幕がありません。', 'warning')
      get().applyProject(mergeSubtitleWithNext(project, clipId), { selectClipId: clipId })
    } catch (error) {
      if (error instanceof EditingOperationError) get().showNotice(error.message, 'warning')
      else throw error
    }
  },
  moveSelected: (clipId, trackId, atUs) => {
    try { get().applyProject(moveLinkedClip(get().project, clipId, trackId, atUs)) }
    catch (error) {
      if (error instanceof EditingOperationError || error instanceof SubtitleCollisionError) get().showNotice(error.message, 'warning')
      else throw error
    }
  },
  moveSubtitleBoundary: (leftClipId, rightClipId, boundaryIndex) => {
    try {
      const { project } = get()
      const next = moveSubtitleBoundary(project, leftClipId, rightClipId, boundaryIndex)
      if (next === project) return
      get().applyProject(next)
      set({ selectedClipIds: [leftClipId, rightClipId] })
    } catch (error) {
      if (error instanceof EditingOperationError || error instanceof SubtitleCollisionError) get().showNotice(error.message, 'warning')
      else throw error
    }
  },
  trim: (clipId, edge, atUs) => {
    try { get().applyProject(trimLinkedClip(get().project, clipId, edge, atUs)) }
    catch (error) {
      if (error instanceof EditingOperationError || error instanceof SubtitleCollisionError) get().showNotice(error.message, 'warning')
      else throw error
    }
  },
  splitSelectedAt: (atUs) => {
    const { project, selectedClipIds } = get()
    const selected = project.tracks.flatMap((track) => track.clips).filter((clip) => selectedClipIds.includes(clip.id))
    const selectedSubtitles = selected.filter((clip) => clip.kind === 'subtitle')
    if (selectedSubtitles.length) {
      if (selected.length !== 1 || selectedSubtitles.length !== 1) {
        get().showNotice('単語境界字幕の分割は字幕を1つだけ選択して実行してください。', 'warning')
        return
      }
      const subtitle = selectedSubtitles[0]
      if (!subtitle) return
      if (subtitle.kind !== 'subtitle' || (!subtitle.words?.length && !subtitle.editUnits?.length)) {
        get().showNotice('単語境界情報がないため分割できません。', 'warning')
        return
      }
      if (!isSubtitleWordBoundarySplitAvailable(subtitle)) {
        get().showNotice('字幕本文と単語情報が一致しないため分割できません。', 'warning')
        return
      }
      const boundaryIndex = nearestSubtitleWordBoundaryIndex(subtitle, atUs)
      if (boundaryIndex === null) {
        get().showNotice('再生ヘッドを字幕の内側へ移動してください。', 'warning')
        return
      }
      get().splitSubtitleAtWordBoundary(subtitle.id, boundaryIndex)
      return
    }

    let next = project
    for (const id of splitSelectedRoots(project, selectedClipIds)) next = splitLinkedClip(next, id, atUs)
    if (next === project) get().showNotice('再生ヘッドをクリップの内側へ移動してください。', 'warning')
    else get().applyProject(next)
  },
  splitSelected: () => get().splitSelectedAt(get().playheadUs),
  deleteSelected: (ripple) => {
    const ids = get().selectedClipIds
    if (!ids.length) return
    try {
      get().applyProject(deleteLinkedClips(get().project, ids, ripple ?? get().rippleMode))
      set({ selectedClipIds: [] })
    } catch (error) {
      if (error instanceof EditingOperationError) get().showNotice(error.message, 'warning')
      else throw error
    }
  },
  copySelected: () => {
    const { project, selectedClipIds } = get()
    const selected = new Set<string>()
    for (const id of selectedClipIds) for (const linkedId of linkedClipIds(project, id)) selected.add(linkedId)
    const clipboard = project.tracks.flatMap((track) => track.clips
      .filter((clip) => selected.has(clip.id))
      .map((clip) => ({ trackId: track.id, clip: structuredClone(clip) })))
    set({ clipboard })
    if (clipboard.length) get().showNotice(`${clipboard.length}件をコピーしました。`, 'success')
  },
  pasteClipboard: (atUs) => {
    const { project, clipboard } = get()
    if (!clipboard.length) return get().showNotice('コピーしたクリップがありません。', 'warning')
    const baseUs = Math.min(...clipboard.map(({ clip }) => clip.startUs))
    const groupIds = new Map<string, string>()
    const next = cloneProject(project)
    const pastedIds: string[] = []
    for (const item of clipboard) {
      const track = next.tracks.find((candidate) => candidate.id === item.trackId)
      if (!track || track.locked) {
        get().showNotice('貼り付け先トラックがロックされています。', 'warning')
        return
      }
      const linkGroupId = item.clip.linkGroupId
        ? (groupIds.get(item.clip.linkGroupId) ?? (() => {
          const id = makeId('link')
          groupIds.set(item.clip.linkGroupId!, id)
          return id
        })())
        : undefined
      const clip = structuredClone(item.clip)
      const nextStart = Math.max(0, (atUs ?? get().playheadUs) + item.clip.startUs - baseUs)
      const shifted = shiftClipTimeline(clip, nextStart - clip.startUs)
      shifted.id = makeId('clip')
      if (linkGroupId) shifted.linkGroupId = linkGroupId
      track.clips.push(shifted)
      pastedIds.push(shifted.id)
    }
    for (const track of next.tracks) track.clips.sort((left, right) => left.startUs - right.startUs)
    next.updatedAt = new Date().toISOString()
    try {
      get().applyProject(validateProject(next))
    } catch (error) {
      get().showNotice(error instanceof Error ? error.message : '貼り付け先に字幕が重なっています。', 'warning')
      return
    }
    set({ selectedClipIds: pastedIds })
  },
  duplicateSelected: () => {
    if (!get().selectedClipIds.length) return
    get().copySelected()
    get().pasteClipboard()
  },
  applySubtitleStyleToAll: (clipId) => {
    const { project } = get()
    const source = project.tracks.flatMap((track) => track.clips).find((clip): clip is Extract<TimelineClip, { kind: 'subtitle' }> => clip.id === clipId && clip.kind === 'subtitle')
    if (!source) return
    const style: SubtitleStyle = structuredClone(source.style)
    const next = cloneProject(project)
    for (const track of next.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === 'subtitle') clip.style = structuredClone(style)
      }
    }
    next.updatedAt = new Date().toISOString()
    get().applyProject(next)
  },
  applySubtitleStyleToTrack: (clipId, style) => {
    const project = get().project
    const sourceTrack = project.tracks.find((track) => track.kind === 'subtitle' && track.clips.some((clip) => clip.id === clipId))
    if (!sourceTrack) return
    const next = cloneProject(project)
    const target = next.tracks.find((track) => track.id === sourceTrack.id)
    if (!target || target.kind !== 'subtitle') return
    target.clips = target.clips.map((clip) => clip.kind === 'subtitle' ? { ...clip, style: structuredClone(style) } : clip)
    next.updatedAt = new Date().toISOString()
    get().applyProject(next)
  },
  patchTrack: (track) => get().applyProject(replaceTrack(get().project, track)),
  addMediaTrack: () => {
    const project = cloneProject(get().project)
    project.tracks.push(createTrack('media', project.tracks.filter((track) => isMediaTrack(track)).length + 1))
    get().applyProject(project)
  },
  addSubtitleTrack: () => {
    const project = cloneProject(get().project)
    project.tracks.push(createTrack('subtitle', project.tracks.filter((track) => track.kind === 'subtitle').length + 1))
    get().applyProject(project)
  },
  deleteTrack: (trackId) => {
    const project = cloneProject(get().project)
    const track = project.tracks.find((candidate) => candidate.id === trackId)
    if (!track) return
    if (track.clips.length) return get().showNotice('クリップがあるトラックは削除できません。', 'warning')
    if (project.tracks.filter((candidate) => isMediaTrack(candidate)).length <= 1 && isMediaTrack(track)) return get().showNotice('最後のメディアトラックは削除できません。', 'warning')
    if (project.tracks.filter((candidate) => candidate.kind === 'subtitle').length <= 1 && track.kind === 'subtitle') return get().showNotice('最後の字幕トラックは削除できません。', 'warning')
    project.tracks = project.tracks.filter((candidate) => candidate.id !== trackId)
    get().applyProject(project)
  },
  renameTrack: (trackId, name) => {
    const project = cloneProject(get().project)
    const track = project.tracks.find((candidate) => candidate.id === trackId)
    if (!track) return
    track.name = name.trim().slice(0, 80) || track.name
    get().applyProject(project)
  },
  reorderTrack: (trackId, direction) => {
    const project = cloneProject(get().project)
    const index = project.tracks.findIndex((track) => track.id === trackId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= project.tracks.length) return
    const current = project.tracks[index]
    const adjacent = project.tracks[target]
    if (!current || !adjacent || isMediaTrack(current) !== isMediaTrack(adjacent)) return
    project.tracks[index] = adjacent
    project.tracks[target] = current
    get().applyProject(project)
  },
  undo: () => {
    if (get().transactionBase) get().commitEditTransaction()
    const { past, project } = get()
    const previous = past.at(-1)
    if (!previous) return
    set((state) => ({ project: cloneProject(previous), past: state.past.slice(0, -1), future: [cloneProject(project), ...state.future], dirty: projectFingerprint(previous) !== state.savedFingerprint, transactionBase: null }))
  },
  redo: () => {
    if (get().transactionBase) get().commitEditTransaction()
    const { future, project } = get()
    const next = future[0]
    if (!next) return
    set((state) => ({ project: cloneProject(next), past: [...state.past, cloneProject(project)].slice(-HISTORY_LIMIT), future: state.future.slice(1), dirty: projectFingerprint(next) !== state.savedFingerprint, transactionBase: null }))
  },
  showNotice: (message, tone = 'info') => set({ notice: { id: Date.now(), message, tone } }),
  clearNotice: () => set({ notice: null })
}))

export const findClip = (project: ProjectFile, ids: string[]): TimelineClip | null => {
  for (const id of ids) {
    for (const track of project.tracks) {
      const clip = track.clips.find((item) => item.id === id)
      if (clip) return clip
    }
  }
  return null
}

export const editorDurationUs = (project: ProjectFile): TimeUs => Math.max(30_000_000, projectDurationUs(project) + 3_000_000)
