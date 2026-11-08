import type { ProjectFile, TimelineClip } from './types'

export type VisualClip = Extract<TimelineClip, { kind: 'video' | 'image' }>

export interface VisualLayerItem {
  trackIndex: number
  clip: VisualClip
}

/**
 * Returns visual layers in the same order used by FFmpeg overlay composition:
 * background first, foreground last. Track index 0 is the topmost track in
 * the editor, so it must be applied last.
 */
export const visualLayerOrder = (project: ProjectFile): VisualLayerItem[] =>
  project.tracks.flatMap((track, trackIndex) => {
    // Track mute controls audio contributions. It must not hide visual layers.
    if (!['media', 'video'].includes(track.kind) || track.hidden) return []
    return track.clips.flatMap((clip) =>
      clip.enabled && (clip.kind === 'video' || clip.kind === 'image')
        ? [{ trackIndex, clip }]
        : []
    )
  }).sort((left, right) =>
    right.trackIndex - left.trackIndex ||
    left.clip.startUs - right.clip.startUs ||
    left.clip.id.localeCompare(right.clip.id)
  )
