import {
  APP_VERSION,
  DEFAULT_AUDIO,
  DEFAULT_SUBTITLE_STYLE,
  DEFAULT_TRANSFORM,
  PROJECT_SCHEMA_VERSION,
  type AudioClip,
  type ImageClip,
  type MediaAsset,
  type ProjectFile,
  type SubtitleClip,
  type TimelineClip,
  type TimelineTrack,
  type TimeUs,
  type VideoClip
} from './types'
import { isSubtitleTrack } from './types'

const clone = <T>(value: T): T => structuredClone(value)

export class SubtitleCollisionError extends Error {
  readonly trackId: string
  readonly clipId: string
  constructor(trackId: string, clipId: string) {
    super(`字幕クリップ ${clipId} が同じ字幕トラック上の別クリップと重なっています。`)
    this.name = 'SubtitleCollisionError'
    this.trackId = trackId
    this.clipId = clipId
  }
}

export const subtitleOverlaps = (left: SubtitleClip, right: SubtitleClip): boolean =>
  left.startUs < right.startUs + right.durationUs && right.startUs < left.startUs + left.durationUs

export const assertSubtitleTrackHasNoOverlap = (track: TimelineTrack): void => {
  if (!isSubtitleTrack(track)) return
  const captions = track.clips.filter((clip): clip is SubtitleClip => clip.kind === 'subtitle')
    .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
  for (let index = 1; index < captions.length; index += 1) {
    const previous = captions[index - 1]
    const current = captions[index]
    if (previous && current && subtitleOverlaps(previous, current)) throw new SubtitleCollisionError(track.id, current.id)
  }
}

export const subtitleWordsMatchText = (clip: SubtitleClip): boolean =>
  Boolean(clip.words?.length) && clip.words!.map((word) => word.text).join('') === clip.text

export const findSubtitleContext = (project: ProjectFile, clipId: string): {
  previous?: SubtitleClip
  current?: SubtitleClip
  next?: SubtitleClip
} => {
  for (const track of project.tracks) {
    if (track.kind !== 'subtitle') continue
    const captions = track.clips
      .filter((clip): clip is SubtitleClip => clip.kind === 'subtitle')
      .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
    const index = captions.findIndex((clip) => clip.id === clipId)
    if (index < 0) continue
    return { previous: captions[index - 1], current: captions[index], next: captions[index + 1] }
  }
  return {}
}

export const createTrack = (kind: 'media' | 'subtitle', index: number): TimelineTrack => ({
  id: makeId('track'),
  name: `${kind === 'media' ? 'V' : 'C'}${index}`,
  kind,
  clips: [],
  locked: false,
  muted: false,
  hidden: false
})

/** Places all captions into the minimum number of non-overlapping subtitle tracks. */
export const layoutSubtitleTracks = (project: ProjectFile): ProjectFile => {
  const next = clone(project)
  const subtitleTracks = next.tracks.filter(isSubtitleTrack)
  const captions = subtitleTracks.flatMap((track) => track.clips.filter((clip): clip is SubtitleClip => clip.kind === 'subtitle'))
    .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
  for (const track of subtitleTracks) track.clips = []
  for (const caption of captions) {
    const target = subtitleTracks.find((track) => {
      const last = track.clips.at(-1)
      return !last || !subtitleOverlaps(last as SubtitleClip, caption)
    }) ?? (() => {
      const created = createTrack('subtitle', subtitleTracks.length + 1)
      subtitleTracks.push(created)
      next.tracks.push(created)
      return created
    })()
    target.clips.push(caption)
  }
  next.updatedAt = new Date().toISOString()
  return next
}

export const makeId = (prefix: string): string => {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  return `${prefix}-${random}`
}

export const createEmptyProject = (name = '無題のプロジェクト'): ProjectFile => {
  const now = new Date().toISOString()
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    id: makeId('project'),
    name,
    createdAt: now,
    updatedAt: now,
    sequence: {
      width: 1920,
      height: 1080,
      frameRate: { numerator: 30, denominator: 1 },
      sampleRate: 48_000,
      backgroundColor: '#000000'
    },
    media: [],
    tracks: [createTrack('media', 1), createTrack('subtitle', 1)]
  }
}

export const projectDurationUs = (project: ProjectFile): TimeUs =>
  project.tracks.reduce(
    (max, track) => track.clips.reduce((trackMax, clip) => Math.max(trackMax, clip.startUs + clip.durationUs), max),
    0
  )

export const framesToUs = (frames: number, numerator: number, denominator = 1): TimeUs =>
  Math.round((frames * denominator * 1_000_000) / numerator)

export const usToFrames = (timeUs: TimeUs, numerator: number, denominator = 1): number =>
  Math.round((timeUs * numerator) / (denominator * 1_000_000))

export const snapUsToFrame = (timeUs: TimeUs, project: ProjectFile): TimeUs => {
  const { numerator, denominator } = project.sequence.frameRate
  return framesToUs(usToFrames(timeUs, numerator, denominator), numerator, denominator)
}

export const formatTimecode = (timeUs: TimeUs, project: ProjectFile): string => {
  const fps = project.sequence.frameRate.numerator / project.sequence.frameRate.denominator
  const nominalFps = Math.max(1, Math.round(fps))
  const totalFrames = Math.max(0, Math.round((timeUs / 1_000_000) * fps))
  const frames = totalFrames % nominalFps
  const totalSeconds = Math.floor(totalFrames / nominalFps)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return [hours, minutes, seconds, frames].map((value) => String(value).padStart(2, '0')).join(':')
}

export const addMediaAssets = (project: ProjectFile, assets: MediaAsset[]): ProjectFile => ({
  ...clone(project),
  updatedAt: new Date().toISOString(),
  media: [...project.media.filter((item) => !assets.some((asset) => asset.path === item.path)), ...assets]
})

/**
 * Replaces an offline asset's file metadata without changing its identity.
 * Timeline clips keep referring to the same asset ID after relinking.
 */
export const relinkMediaAsset = (project: ProjectFile, assetId: string, replacement: MediaAsset): ProjectFile => {
  const current = project.media.find((asset) => asset.id === assetId)
  if (!current || replacement.offline) return project
  return {
    ...clone(project),
    updatedAt: new Date().toISOString(),
    media: project.media.map((asset) => asset.id === assetId
      ? { ...clone(replacement), id: current.id, relativePath: undefined, offline: false }
      : clone(asset))
  }
}

export const createClipForAsset = (
  asset: MediaAsset,
  startUs: TimeUs,
  durationUs = asset.durationUs || 5_000_000
): VideoClip | ImageClip | AudioClip => {
  const common = {
    id: makeId('clip'),
    name: asset.name,
    startUs,
    durationUs: Math.max(1, durationUs),
    sourceInUs: 0,
    enabled: true,
    assetId: asset.id
  }
  if (asset.kind === 'audio') {
    return { ...common, kind: 'audio', audio: clone(DEFAULT_AUDIO) }
  }
  if (asset.kind === 'image') {
    return { ...common, kind: 'image', transform: clone(DEFAULT_TRANSFORM) }
  }
  return { ...common, kind: 'video', transform: clone(DEFAULT_TRANSFORM), audio: clone(DEFAULT_AUDIO) }
}

export const createSubtitleClip = (startUs: TimeUs, durationUs = 3_000_000): SubtitleClip => ({
  id: makeId('caption'),
  name: '新しい字幕',
  kind: 'subtitle',
  startUs,
  durationUs,
  sourceInUs: 0,
  enabled: true,
  text: '字幕を入力',
  style: clone(DEFAULT_SUBTITLE_STYLE)
})

export const addClipToTrack = (project: ProjectFile, trackId: string, clip: TimelineClip): ProjectFile => {
  const next = clone(project)
  const track = next.tracks.find((item) => item.id === trackId)
  if (!track || track.locked) return project
  track.clips.push(clip)
  track.clips.sort((a, b) => a.startUs - b.startUs)
  assertSubtitleTrackHasNoOverlap(track)
  next.updatedAt = new Date().toISOString()
  return next
}

export const updateClip = (
  project: ProjectFile,
  clipId: string,
  updater: (clip: TimelineClip) => TimelineClip
): ProjectFile => {
  const next = clone(project)
  for (const track of next.tracks) {
    const index = track.clips.findIndex((clip) => clip.id === clipId)
    if (index >= 0 && !track.locked) {
      const current = track.clips[index]
      if (!current) return project
      track.clips[index] = updater(current)
      track.clips.sort((a, b) => a.startUs - b.startUs)
      next.updatedAt = new Date().toISOString()
      validateProject(next)
      return next
    }
  }
  return project
}

/** Shift a clip and any absolute subtitle word timestamps by the same timeline delta. */
export const shiftClipTimeline = <T extends TimelineClip>(clip: T, deltaUs: TimeUs): T => ({
  ...clip,
  startUs: clip.startUs + deltaUs,
  ...(clip.kind === 'subtitle' && clip.words
    ? { words: clip.words.map((word) => ({ ...word, startUs: word.startUs + deltaUs, endUs: word.endUs + deltaUs })) }
    : {}),
  ...(clip.kind === 'subtitle' && clip.editUnits
    ? { editUnits: clip.editUnits.map((unit) => ({ ...unit, startUs: unit.startUs + deltaUs, endUs: unit.endUs + deltaUs })) }
    : {})
}) as T

export const subtitleTrimKeepsWordTiming = (
  project: ProjectFile,
  clip: TimelineClip,
  edge: 'start' | 'end',
  timelineUs: TimeUs
): boolean => {
  if (clip.kind !== 'subtitle' || (!clip.words?.length && !clip.editUnits?.length)) return true
  const snapped = snapUsToFrame(timelineUs, project)
  const firstWord = clip.editUnits?.[0] ?? clip.words?.[0]
  const lastWord = clip.editUnits?.at(-1) ?? clip.words?.at(-1)
  if (!firstWord || !lastWord) return true
  return edge === 'start' ? snapped <= firstWord.startUs : snapped >= lastWord.endUs
}

export const moveClip = (project: ProjectFile, clipId: string, startUs: TimeUs): ProjectFile =>
  updateClip(project, clipId, (clip) => {
    const nextStart = Math.max(0, snapUsToFrame(startUs, project))
    return shiftClipTimeline(clip, nextStart - clip.startUs)
  })

export const trimClip = (
  project: ProjectFile,
  clipId: string,
  edge: 'start' | 'end',
  timelineUs: TimeUs
): ProjectFile =>
  updateClip(project, clipId, (clip) => {
    const snapped = snapUsToFrame(timelineUs, project)
    const frameUs = framesToUs(1, project.sequence.frameRate.numerator, project.sequence.frameRate.denominator)
    if (edge === 'start') {
      if (!subtitleTrimKeepsWordTiming(project, clip, edge, timelineUs)) throw new Error('単語タイミングより内側には字幕を縮められません。')
      const delta = Math.min(clip.durationUs - frameUs, Math.max(-clip.sourceInUs, snapped - clip.startUs))
      return {
        ...clip,
        startUs: clip.startUs + delta,
        sourceInUs: clip.sourceInUs + delta,
        durationUs: clip.durationUs - delta
      }
    }
    if (!subtitleTrimKeepsWordTiming(project, clip, edge, timelineUs)) throw new Error('単語タイミングより内側には字幕を縮められません。')
    const asset = 'assetId' in clip ? project.media.find((item) => item.id === clip.assetId) : undefined
    const maximumDuration = asset && asset.kind !== 'image' ? asset.durationUs - clip.sourceInUs : Number.MAX_SAFE_INTEGER
    return { ...clip, durationUs: Math.min(maximumDuration, Math.max(frameUs, snapped - clip.startUs)) }
  })

export const splitClip = (project: ProjectFile, clipId: string, atUs: TimeUs): ProjectFile => {
  const next = clone(project)
  const frameUs = framesToUs(1, project.sequence.frameRate.numerator, project.sequence.frameRate.denominator)
  for (const track of next.tracks) {
    if (track.locked) continue
    const index = track.clips.findIndex((clip) => clip.id === clipId)
    const clip = track.clips[index]
    if (!clip) continue
    const splitAt = snapUsToFrame(atUs, project)
    const leftDuration = splitAt - clip.startUs
    const rightDuration = clip.durationUs - leftDuration
    if (leftDuration < frameUs || rightDuration < frameUs) return project
    const left = { ...clip, durationUs: leftDuration }
    const right = {
      ...clone(clip),
      id: makeId('clip'),
      name: `${clip.name} (後半)`,
      startUs: splitAt,
      durationUs: rightDuration,
      sourceInUs: clip.sourceInUs + leftDuration
    }
    track.clips.splice(index, 1, left, right)
    next.updatedAt = new Date().toISOString()
    return next
  }
  return project
}

export const deleteClips = (project: ProjectFile, clipIds: string[], ripple = false): ProjectFile => {
  const next = clone(project)
  const selected = new Set(clipIds)
  const removed = next.tracks.flatMap((track) => track.clips.filter((clip) => selected.has(clip.id)))
  if (removed.length === 0) return project
  if (next.tracks.some((track) => track.locked && track.clips.some((clip) => selected.has(clip.id)))) return project
  const intervals = removed
    .map((clip) => [clip.startUs, clip.startUs + clip.durationUs] as const)
    .sort(([left], [right]) => left - right)
    .reduce<Array<readonly [number, number]>>((merged, interval) => {
      const previous = merged.at(-1)
      if (!previous || interval[0] > previous[1]) merged.push(interval)
      else merged[merged.length - 1] = [previous[0], Math.max(previous[1], interval[1])]
      return merged
    }, [])
  for (const track of next.tracks) {
    if (track.locked) continue
    track.clips = track.clips.filter((clip) => !selected.has(clip.id))
    if (ripple) {
      for (const clip of track.clips) {
        const shift = intervals.reduce((total, [start, end]) => total + (clip.startUs >= end ? end - start : 0), 0)
        if (shift > 0) {
          const index = track.clips.indexOf(clip)
          track.clips[index] = shiftClipTimeline(clip, -shift)
        }
      }
    }
  }
  next.updatedAt = new Date().toISOString()
  return next
}

export const replaceTrack = (project: ProjectFile, nextTrack: TimelineTrack): ProjectFile => ({
  ...clone(project),
  updatedAt: new Date().toISOString(),
  tracks: project.tracks.map((track) => (track.id === nextTrack.id ? clone(nextTrack) : clone(track)))
})

export const validateProject = (input: unknown): ProjectFile => {
  if (!input || typeof input !== 'object') throw new Error('プロジェクトJSONがオブジェクトではありません。')
  const project = clone(input as Partial<ProjectFile>)
  if (project.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error(`未対応のプロジェクト形式です: ${String(project.schemaVersion)}`)
  }
  if (!project.id || !project.name || !project.sequence || !Array.isArray(project.media) || !Array.isArray(project.tracks)) {
    throw new Error('プロジェクトに必須項目がありません。')
  }
  const { width, height, frameRate, sampleRate } = project.sequence
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16) {
    throw new Error('シーケンス解像度が不正です。')
  }
  if (!frameRate || frameRate.numerator <= 0 || frameRate.denominator <= 0 || sampleRate <= 0) {
    throw new Error('シーケンスの時間設定が不正です。')
  }
  for (const track of project.tracks) {
    if (track.kind === 'video' || track.kind === 'audio') track.kind = 'media'
    if (!track.id || !Array.isArray(track.clips)) throw new Error('トラック形式が不正です。')
    assertSubtitleTrackHasNoOverlap(track)
    for (const clip of track.clips) {
      if (!clip.id || !Number.isFinite(clip.startUs) || !Number.isFinite(clip.durationUs) || !Number.isFinite(clip.sourceInUs) || clip.startUs < 0 || clip.durationUs <= 0 || clip.sourceInUs < 0) {
        throw new Error(`クリップ形式が不正です: ${clip.id ?? 'unknown'}`)
      }
      if ((clip.kind === 'video' || clip.kind === 'image') && (
        !Number.isFinite(clip.transform.positionX) || !Number.isFinite(clip.transform.positionY) ||
        !Number.isFinite(clip.transform.scale) || clip.transform.scale <= 0 ||
        !Number.isFinite(clip.transform.rotation) || !Number.isFinite(clip.transform.opacity) ||
        clip.transform.opacity < 0 || clip.transform.opacity > 1 ||
        Object.values(clip.transform.crop).some((value) => !Number.isFinite(value) || value < 0 || value >= 0.5)
      )) throw new Error(`クリップの変形値が不正です: ${clip.id}`)
      if ((clip.kind === 'video' || clip.kind === 'audio') && (
        !Number.isFinite(clip.audio.volumeDb) || !Number.isFinite(clip.audio.pan) ||
        !Number.isFinite(clip.audio.fadeInUs) || !Number.isFinite(clip.audio.fadeOutUs) ||
        clip.audio.fadeInUs < 0 || clip.audio.fadeOutUs < 0
      )) throw new Error(`クリップの音声値が不正です: ${clip.id}`)
      if (clip.kind === 'subtitle' && clip.words) {
        const wordIds = new Set<string>()
        let previousEnd = clip.startUs
        for (const word of clip.words) {
          if (!word.id || wordIds.has(word.id) || typeof word.text !== 'string' || !Number.isFinite(word.startUs) || !Number.isFinite(word.endUs) || word.startUs < clip.startUs || word.endUs <= word.startUs || word.endUs > clip.startUs + clip.durationUs || word.startUs < previousEnd) {
            throw new Error(`字幕の単語タイミングが不正です: ${clip.id}`)
          }
          wordIds.add(word.id)
          previousEnd = word.endUs
        }
      }
      if (clip.kind === 'subtitle' && clip.editUnits) {
        const unitIds = new Set<string>()
        let previousEnd = clip.startUs
        let reconstructed = ''
        for (const unit of clip.editUnits) {
          if (!unit.id || unitIds.has(unit.id) || !unit.parentSourceWordId || typeof unit.text !== 'string' || !Number.isFinite(unit.startUs) || !Number.isFinite(unit.endUs) || unit.startUs < clip.startUs || unit.endUs < unit.startUs || unit.endUs > clip.startUs + clip.durationUs || unit.startUs < previousEnd || !['source', 'estimated', 'point'].includes(unit.timingProvenance)) {
            throw new Error(`字幕の編集単位が不正です: ${clip.id}`)
          }
          unitIds.add(unit.id)
          reconstructed += unit.text
          previousEnd = unit.endUs
        }
        if (!clip.editUnits.length || reconstructed !== clip.text) throw new Error(`字幕の編集単位が本文と一致しません: ${clip.id}`)
      }
    }
  }
  return clone(project as ProjectFile)
}
