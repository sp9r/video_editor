import type { ProjectFile, TimelineClip } from '../types'

export interface LinkDiagnostic {
  code: 'ambiguous_link'
  message: string
  clipIds: string[]
}

export interface LinkInferenceResult {
  project: ProjectFile
  diagnostics: LinkDiagnostic[]
}

const clipsOfKind = (project: ProjectFile, kind: TimelineClip['kind']): TimelineClip[] =>
  project.tracks.flatMap((track) => track.clips.filter((clip) => clip.kind === kind))

const signature = (clip: Extract<TimelineClip, { kind: 'video' | 'audio' }>): string =>
  [clip.assetId, clip.startUs, clip.durationUs, clip.sourceInUs].join('|')

const stableLinkGroupId = (videoId: string, audioId: string): string => `link:${videoId}:${audioId}`

/** Returns the clicked clip first, followed by its persisted linked peers. */
export const linkedClipIds = (project: ProjectFile, clipId: string): string[] => {
  const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId)
  if (!clip?.linkGroupId) return clip ? [clip.id] : []
  const peers = project.tracks
    .flatMap((track) => track.clips)
    .filter((item) => item.linkGroupId === clip.linkGroupId && item.id !== clipId)
    .map((item) => item.id)
  return [clipId, ...peers]
}

export const uniqueLinkedRoots = (project: ProjectFile, clipIds: readonly string[]): string[] => {
  const seen = new Set<string>()
  const roots: string[] = []
  for (const clipId of clipIds) {
    const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId)
    const key = clip?.linkGroupId ?? `clip:${clipId}`
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(clipId)
  }
  return roots
}

/**
 * Contract import deliberately infers links only from the complete media and
 * interval identity. Names, track names, and array order are not used.
 */
export const inferLinkedAudioPairs = (project: ProjectFile): LinkInferenceResult => {
  const videos = clipsOfKind(project, 'video') as Array<Extract<TimelineClip, { kind: 'video' }>>
  const audios = clipsOfKind(project, 'audio') as Array<Extract<TimelineClip, { kind: 'audio' }>>
  const groups = new Map<string, { videos: typeof videos; audios: typeof audios }>()
  for (const video of videos) {
    const group = groups.get(signature(video)) ?? { videos: [], audios: [] }
    group.videos.push(video)
    groups.set(signature(video), group)
  }
  for (const audio of audios) {
    const group = groups.get(signature(audio)) ?? { videos: [], audios: [] }
    group.audios.push(audio)
    groups.set(signature(audio), group)
  }

  const next = structuredClone(project)
  const diagnostics: LinkDiagnostic[] = []
  let changed = false
  for (const [key, group] of groups) {
    if (group.videos.length === 1 && group.audios.length === 1) {
      const video = group.videos[0]
      const audio = group.audios[0]
      if (!video || !audio) continue
      if (video.linkGroupId || audio.linkGroupId) continue
      const linkGroupId = stableLinkGroupId(video.id, audio.id)
      for (const track of next.tracks) {
        for (const clip of track.clips) {
          if (clip.id === video.id || clip.id === audio.id) {
            clip.linkGroupId = linkGroupId
            changed = true
          }
        }
      }
      continue
    }
    if (group.videos.length > 0 && group.audios.length > 0) {
      const clipIds = [...group.videos, ...group.audios].map((clip) => clip.id)
      diagnostics.push({
        code: 'ambiguous_link',
        clipIds,
        message: `Linked A/V inference is ambiguous for interval ${key}; clips remain unlinked.`
      })
    }
  }
  return { project: changed ? next : project, diagnostics }
}
