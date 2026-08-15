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
  updateClip
} from '../../shared/project'
import { deleteLinkedClips, EditingOperationError, isSubtitleWordBoundarySplitAvailable, mergeSubtitleWithNext, mergeSubtitleWithPrevious, moveLinkedClip, moveSubtitleBoundary, nearestSubtitleWordBoundaryIndex, splitLinkedClip, splitSelectedRoots, splitSubtitleAtWordBoundary, trimLinkedClip } from '../../shared/editing/operations'
import { linkedClipIds } from '../../shared/editing/links'
import { isMediaTrack } from '../../shared/types'
import type { AutoCaptionProgress, AutoCaptionResult, AutoCaptionSettings } from '../../shared/auto-caption-contract'
import { applyAutoCaptionResultToProject } from '../../shared/auto-caption-adapter'
import type { MediaAsset, ProjectFile, SubtitleStyle, TimelineClip, TimelineTrack, TimeUs } from '../../shared/types'
import { createDemoProject } from './demo'

type EditTool = 'select' | 'razor'
type Notice = { id: number; tone: 'info' | 'success' | 'warning' | 'error'; message: string }

interface EditorState {
  project: ProjectFile
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
  savedFingerprint: string
  transactionBase: ProjectFile | null
  clipboard: ClipboardItem[]
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
}

const HISTORY_LIMIT = 80

const cloneProject = (project: ProjectFile): ProjectFile => structuredClone(project)
const projectFingerprint = (project: ProjectFile): string => {
  const normalized = cloneProject(project)
  normalized.updatedAt = ''
  return JSON.stringify(normalized)
}
const initialProject = createDemoProject()

const compatibleTrack = (_asset: MediaAsset, track: TimelineTrack): boolean => {
  return isMediaTrack(track)
}

export const useEditorStore = create<EditorState>((set, get) => ({
  project: initialProject,
  past: [],
  future: [],
  selectedClipIds: [],
  selectedAssetId: null,
  playheadUs: 2_200_000,
  playing: false,
  tool: 'select',
  snapping: true,
  rippleMode: false,
  zoomPxPerSecond: 72,
  dirty: false,
  lastSavedAt: null,
  savedFingerprint: projectFingerprint(initialProject),
  transactionBase: null,
  clipboard: [],
  notice: null,
  autoCaptionProgress: null,
  autoCaptionJobId: null,
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
    set({
      project: normalized,
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
      autoCaptionJobId: null
    })
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
  setZoom: (zoomPxPerSecond) => set({ zoomPxPerSecond: Math.min(220, Math.max(28, zoomPxPerSecond)) }),
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
    set({ autoCaptionProgress: { version: 'spectra.auto-caption.progress.v1', jobId: '', state: 'preparing', ratio: 0, message: '音声準備中…' }, autoCaptionJobId: null })
    try {
      const health = await window.spectra.autoCaptionHealth()
      if (!health.available) throw new Error(health.reason ?? '自動字幕エンジンを利用できません。')
      const result = await new Promise<AutoCaptionResult>((resolve, reject) => {
        let startedJobId = ''
        let terminalBeforeStart: AutoCaptionProgress | undefined
        let settled = false
        const unsubscribe = window.spectra!.onAutoCaptionProgress((progress) => {
          if (startedJobId && progress.jobId !== startedJobId) return
          if (!startedJobId) {
            if (progress.state === 'completed' || progress.state === 'failed') terminalBeforeStart = progress
            return
          }
          set({ autoCaptionProgress: progress })
          if (settled) return
          if (progress.state === 'failed') {
            settled = true
            unsubscribe()
            reject(new Error(progress.errorCode === 'CANCELLED' ? '自動字幕をキャンセルしました。' : progress.message))
          } else if (progress.state === 'completed' && progress.result) {
            settled = true
            unsubscribe()
            resolve(progress.result)
          }
        })
        const start = settings
          ? window.spectra!.startAutoCaption(project, selectedIds, settings)
          : window.spectra!.startAutoCaption(project, selectedIds)
        void start.then(
          (started) => {
            startedJobId = started.jobId
            set({ autoCaptionJobId: started.jobId })
            if (terminalBeforeStart && !settled) {
              const terminal = terminalBeforeStart
              if (terminal.state === 'failed') {
                settled = true
                unsubscribe()
                reject(new Error(terminal.errorCode === 'CANCELLED' ? '自動字幕をキャンセルしました。' : terminal.message))
              } else if (terminal.result) {
                settled = true
                unsubscribe()
                resolve(terminal.result)
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
      const applied = applyAutoCaptionResultToProject(project, selectedClip, result)
      if (projectFingerprint(get().project) !== projectFingerprint(project)) throw new Error('自動字幕の生成中にプロジェクトが変更されました。結果は適用されていません。')
      const firstCaption = applied.project.tracks.find((track) => track.id === applied.trackId)?.clips[0]
      get().applyProject(applied.project, firstCaption ? { selectClipId: firstCaption.id } : undefined)
      const summary = { ...applied, fallbackUsed: result.fallback.used }
      set({ autoCaptionProgress: { version: 'spectra.auto-caption.progress.v1', jobId: result.jobId, state: 'completed', ratio: 1, message: '字幕を配置しました。', result }, autoCaptionJobId: null })
      get().showNotice(`自動字幕を${summary.captionCount}件配置しました（raw word ${summary.rawWordCount}件${summary.fallbackUsed ? '・ルールfallback' : ''}）。`, 'success')
      return summary
    } catch (error) {
      set((state) => ({ autoCaptionProgress: state.autoCaptionProgress ? { ...state.autoCaptionProgress, state: 'failed', ratio: 0, message: '自動字幕を配置できませんでした。' } : null, autoCaptionJobId: null }))
      get().showNotice(`自動字幕を生成できませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return null
    }
  },
  cancelAutoCaption: async () => {
    const jobId = get().autoCaptionJobId
    if (!jobId || !window.spectra) return
    await window.spectra.cancelAutoCaption(jobId)
    set((state) => ({ autoCaptionProgress: state.autoCaptionProgress ? { ...state.autoCaptionProgress, message: 'キャンセル中…' } : null }))
  },
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
