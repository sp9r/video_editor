import { create } from 'zustand'
import {
  addClipToTrack,
  addMediaAssets,
  createClipForAsset,
  createSubtitleClip,
  deleteClips,
  moveClip,
  projectDurationUs,
  relinkMediaAsset,
  replaceTrack,
  splitClip,
  trimClip,
  updateClip
} from '../../shared/project'
import type { MediaAsset, ProjectFile, TimelineClip, TimelineTrack, TimeUs } from '../../shared/types'
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
  applyProject(project: ProjectFile, options?: { selectClipId?: string; preserveHistory?: boolean }): void
  loadProject(project: ProjectFile): void
  markSaved(project?: ProjectFile): void
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
  patchTrack(track: TimelineTrack): void
  undo(): void
  redo(): void
  showNotice(message: string, tone?: Notice['tone']): void
  clearNotice(): void
}

const HISTORY_LIMIT = 80

const cloneProject = (project: ProjectFile): ProjectFile => structuredClone(project)

const compatibleTrack = (asset: MediaAsset, track: TimelineTrack): boolean => {
  if (asset.kind === 'audio') return track.kind === 'audio'
  return track.kind === 'video'
}

export const useEditorStore = create<EditorState>((set, get) => ({
  project: createDemoProject(),
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
  notice: null,
  applyProject: (project, options = {}) => {
    const current = get().project
    if (project === current) return
    set((state) => ({
      project,
      past: options.preserveHistory ? state.past : [...state.past, cloneProject(current)].slice(-HISTORY_LIMIT),
      future: options.preserveHistory ? state.future : [],
      selectedClipIds: options.selectClipId ? [options.selectClipId] : state.selectedClipIds,
      dirty: true
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
      lastSavedAt: new Date()
    }),
  markSaved: (project) => set({ project: project ? cloneProject(project) : get().project, dirty: false, lastSavedAt: new Date() }),
  selectClip: (id, additive = false) => {
    if (!id) return set({ selectedClipIds: [] })
    const selected = get().selectedClipIds
    if (!additive) return set({ selectedClipIds: [id] })
    set({ selectedClipIds: selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id] })
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
    const { project } = get()
    const sourceTrack = project.tracks.find((track) => track.clips.some((clip) => clip.id === clipId))
    const targetTrack = project.tracks.find((track) => track.id === trackId)
    const clip = sourceTrack?.clips.find((item) => item.id === clipId)
    if (!sourceTrack || !targetTrack || !clip || sourceTrack.locked || targetTrack.locked) return
    if ((clip.kind === 'audio' && targetTrack.kind !== 'audio') ||
      ((clip.kind === 'video' || clip.kind === 'image') && targetTrack.kind !== 'video') ||
      (clip.kind === 'subtitle' && targetTrack.kind !== 'subtitle')) return
    let next = moveClip(project, clipId, atUs)
    if (sourceTrack.id !== targetTrack.id) {
      const copy = cloneProject(next)
      const from = copy.tracks.find((track) => track.id === sourceTrack.id)
      const to = copy.tracks.find((track) => track.id === targetTrack.id)
      const moved = from?.clips.find((item) => item.id === clipId)
      if (from && to && moved) {
        from.clips = from.clips.filter((item) => item.id !== clipId)
        to.clips.push(moved)
        to.clips.sort((a, b) => a.startUs - b.startUs)
        next = copy
      }
    }
    get().applyProject(next)
  },
  trim: (clipId, edge, atUs) => get().applyProject(trimClip(get().project, clipId, edge, atUs)),
  splitSelected: () => {
    const { project, selectedClipIds, playheadUs } = get()
    let next = project
    for (const id of selectedClipIds) next = splitClip(next, id, playheadUs)
    if (next === project) get().showNotice('再生ヘッドをクリップの内側へ移動してください。', 'warning')
    else get().applyProject(next)
  },
  deleteSelected: (ripple) => {
    const ids = get().selectedClipIds
    if (!ids.length) return
    get().applyProject(deleteClips(get().project, ids, ripple ?? get().rippleMode))
    set({ selectedClipIds: [] })
  },
  patchTrack: (track) => get().applyProject(replaceTrack(get().project, track)),
  undo: () => {
    const { past, project } = get()
    const previous = past.at(-1)
    if (!previous) return
    set((state) => ({ project: cloneProject(previous), past: state.past.slice(0, -1), future: [cloneProject(project), ...state.future], dirty: true }))
  },
  redo: () => {
    const { future, project } = get()
    const next = future[0]
    if (!next) return
    set((state) => ({ project: cloneProject(next), past: [...state.past, cloneProject(project)].slice(-HISTORY_LIMIT), future: state.future.slice(1), dirty: true }))
  },
  showNotice: (message, tone = 'info') => set({ notice: { id: Date.now(), message, tone } }),
  clearNotice: () => set({ notice: null })
}))

export const findClip = (project: ProjectFile, ids: string[]): TimelineClip | null => {
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => ids.includes(item.id))
    if (clip) return clip
  }
  return null
}

export const editorDurationUs = (project: ProjectFile): TimeUs => Math.max(30_000_000, projectDurationUs(project) + 3_000_000)
