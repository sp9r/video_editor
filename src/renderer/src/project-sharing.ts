import type { MediaAsset, ProjectFile, TimelineClip, TimelineTrack } from '../../shared/types'

/** Structural equality for plain JSON-like data (project clips, tracks and media contain nothing else). */
export const sameJsonValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const other = b as unknown[]
    if (a.length !== other.length) return false
    for (let index = 0; index < a.length; index += 1) if (!sameJsonValue(a[index], other[index])) return false
    return true
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left).filter((key) => left[key] !== undefined)
  if (keys.length !== Object.keys(right).filter((key) => right[key] !== undefined).length) return false
  for (const key of keys) if (!sameJsonValue(left[key], right[key])) return false
  return true
}

/**
 * Edit operations return a deep copy of the project, so every clip gets a new identity even when
 * its content is unchanged. This substitutes the previous object wherever the content is equal, so
 * memoised views (timeline clips) only re-render what actually changed. Neither project is mutated;
 * the result is content-identical to `next`.
 */
export const shareUnchangedProjectParts = (previous: ProjectFile, next: ProjectFile): ProjectFile => {
  const previousClips = new Map<string, TimelineClip>()
  for (const track of previous.tracks) for (const clip of track.clips) previousClips.set(clip.id, clip)
  const previousTracks = new Map(previous.tracks.map((track) => [track.id, track]))

  let tracksChanged = next.tracks.length !== previous.tracks.length
  const tracks = next.tracks.map((track, trackIndex): TimelineTrack => {
    let clipsChanged = false
    const clips = track.clips.map((clip) => {
      const old = previousClips.get(clip.id)
      if (old && sameJsonValue(old, clip)) return old
      clipsChanged = true
      return clip
    })
    const old = previousTracks.get(track.id)
    if (!old) { tracksChanged = true; return clipsChanged ? { ...track, clips } : track }
    if (previous.tracks[trackIndex] !== old) tracksChanged = true
    const sameClipList = !clipsChanged && clips.length === old.clips.length && clips.every((clip, index) => clip === old.clips[index])
    const { clips: _newClips, ...newRest } = track
    const { clips: _oldClips, ...oldRest } = old
    if (sameClipList && sameJsonValue(newRest, oldRest)) return old
    tracksChanged = true
    return { ...track, clips }
  })

  const previousMedia = new Map(previous.media.map((asset) => [asset.id, asset]))
  let mediaChanged = next.media.length !== previous.media.length
  const media = next.media.map((asset, index): MediaAsset => {
    const old = previousMedia.get(asset.id)
    if (old && sameJsonValue(old, asset)) {
      if (previous.media[index] !== old) mediaChanged = true
      return old
    }
    mediaChanged = true
    return asset
  })

  return { ...next, tracks: tracksChanged ? tracks : previous.tracks, media: mediaChanged ? media : previous.media }
}
