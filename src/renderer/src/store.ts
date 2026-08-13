import { create } from 'zustand'
import {
  addClipToTrack,
  addMediaAssets,
  createClipForAsset,
  createSubtitleClip,
  makeId,
  projectDurationUs,
  relinkMediaAsset,
  replaceTrack,
  updateClip
} from '../../shared/project'
import { deleteLinkedClips, EditingOperationError, moveLinkedClip, splitLinkedClip, splitSelectedRoots, trimLinkedClip } from '../../shared/editing/operations'
import { linkedClipIds } from '../../shared/editing/links'
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
  addSubtitle(): void
  patchClip(clipId: string, patcher: (clip: TimelineClip) => TimelineClip): void
  moveSelected(clipId: string, trackId: string, atUs: TimeUs): void
  trim(clipId: string, edge: 'start' | 'end', atUs: TimeUs): void
  splitSelected(): void
  deleteSelected(ripple?: boolean): void
  copySelected(): void
  pasteClipboard(atUs?: TimeUs): void
  duplicateSelected(): void
  applySubtitleStyleToAll(clipId: string): void
  patchTrack(track: TimelineTrack): void
  undo(): void
  redo(): void
  showNotice(message: string, tone?: Notice['tone']): void
  clearNotice(): void
}

interface ClipboardItem {
  trackId: string
  clip: TimelineClip
}

const HISTORY_LIMIT = 80

const cloneProject = (project: ProjectFile): ProjectFile => structuredClone(project)
const projectFingerprint = (project: ProjectFile): string => {
  const normalized = cloneProject(project)
  normalized.updatedAt = ''
  return JSON.stringify(normalized)
}
const initialProject = createDemoProject()

const compatibleTrack = (asset: MediaAsset, track: TimelineTrack): boolean => {
  if (asset.kind === 'audio') return track.kind === 'audio'
  return track.kind === 'video'
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
  loadProject: (project) =>
    set({
      project: cloneProject(project),
      past: [],
      future: [],
      selectedClipIds: [],
      selectedAssetId: null,
      playheadUs: 0,
      playing: false,
      dirty: false,
      lastSavedAt: new Date(),
      savedFingerprint: projectFingerprint(project),
      transactionBase: null
    }),
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
  addSubtitle: () => {
    const { project, playheadUs } = get()
    const track = project.tracks.find((item) => item.kind === 'subtitle')
    if (!track) return get().showNotice('字幕トラックがありません。', 'error')
    const clip = createSubtitleClip(playheadUs)
    get().applyProject(addClipToTrack(project, track.id, clip), { selectClipId: clip.id })
  },
  patchClip: (clipId, patcher) => get().applyProject(updateClip(get().project, clipId, patcher)),
  moveSelected: (clipId, trackId, atUs) => {
    try { get().applyProject(moveLinkedClip(get().project, clipId, trackId, atUs)) }
    catch (error) { if (error instanceof EditingOperationError) get().showNotice(error.message, 'warning'); else throw error }
  },
  trim: (clipId, edge, atUs) => {
    try { get().applyProject(trimLinkedClip(get().project, clipId, edge, atUs)) }
    catch (error) { if (error instanceof EditingOperationError) get().showNotice(error.message, 'warning'); else throw error }
  },
  splitSelected: () => {
    const { project, selectedClipIds, playheadUs } = get()
    let next = project
    for (const id of splitSelectedRoots(project, selectedClipIds)) next = splitLinkedClip(next, id, playheadUs)
    if (next === project) get().showNotice('再生ヘッドをクリップの内側へ移動してください。', 'warning')
    else get().applyProject(next)
  },
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
      clip.id = makeId('clip')
      clip.startUs = Math.max(0, (atUs ?? get().playheadUs) + item.clip.startUs - baseUs)
      if (linkGroupId) clip.linkGroupId = linkGroupId
      track.clips.push(clip)
      pastedIds.push(clip.id)
    }
    for (const track of next.tracks) track.clips.sort((left, right) => left.startUs - right.startUs)
    next.updatedAt = new Date().toISOString()
    get().applyProject(next)
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
