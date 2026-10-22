import { layoutSubtitleText, normalizeSubtitleMaxLines, subtitleMaxWidthPercent, subtitleMaxWidthPx, type SubtitleLayoutDiagnostic } from './subtitle-layout.js'
import { frameIndexAtOrBeforeUs, subtitleCueFrameState, subtitleFrameRange, type SubtitleFrameRange } from './subtitle-timing.js'
import type { ProjectFile, SequenceSettings, SubtitleClip, SubtitleStyle } from './types.js'

export type SubtitleAnchor = SubtitleStyle['alignment']

export interface SubtitleRenderSpec {
  xPx: number
  yPx: number
  anchor: SubtitleAnchor
  wrappedText: string
  lineCount: number
  maxLines: number
  layoutDiagnostics: SubtitleLayoutDiagnostic[]
  maxWidthPx: number
  fontFamily: string
  fontSizePx: number
  bold: boolean
  italic: boolean
  letterSpacingPx: number
  lineHeight: number
  color: string
  outlineColor: string
  outlineWidthPx: number
  shadowColor: string
  shadowBlurPx: number
  shadowOffsetXPx: number
  shadowOffsetYPx: number
  backgroundColor: string
  backgroundOpacity: number
  animation: SubtitleStyle['animation']
  animationDurationUs: number
}

const finiteOr = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback

export const buildSubtitleRenderSpec = (clip: SubtitleClip, sequence: Pick<SequenceSettings, 'width' | 'height'>): SubtitleRenderSpec => {
  const width = Math.max(16, finiteOr(sequence.width, 1920))
  const height = Math.max(16, finiteOr(sequence.height, 1080))
  const style = clip.style
  const maxWidthPercent = subtitleMaxWidthPercent(style)
  const fontSizePx = Math.max(1, finiteOr(style.fontSize, 54))
  const xPercent = finiteOr(style.positionX, 50)
  const yPercent = finiteOr(style.positionY, 86)
  const layout = layoutSubtitleText(clip.text, { ...style, maxWidthPercent }, width, clip.maxLines)
  return {
    xPx: width * xPercent / 100,
    yPx: height * yPercent / 100,
    anchor: style.alignment,
    wrappedText: layout.wrappedText,
    lineCount: layout.lineCount,
    maxLines: normalizeSubtitleMaxLines(clip.maxLines),
    layoutDiagnostics: layout.diagnostics,
    maxWidthPx: subtitleMaxWidthPx({ maxWidthPercent }, width),
    fontFamily: style.fontFamily.trim() || 'Arial',
    fontSizePx,
    bold: style.bold,
    italic: style.italic,
    letterSpacingPx: finiteOr(style.letterSpacing, 0),
    lineHeight: Math.max(0.1, finiteOr(style.lineHeight, 1.15)),
    color: style.color,
    outlineColor: style.outlineColor,
    outlineWidthPx: Math.max(0, finiteOr(style.outlineWidth, 0)),
    shadowColor: style.shadowColor,
    shadowBlurPx: Math.max(0, finiteOr(style.shadowBlur, 0)),
    // Canonical default until editable shadow offsets are introduced in the model.
    shadowOffsetXPx: 0,
    shadowOffsetYPx: 2,
    backgroundColor: style.backgroundColor,
    backgroundOpacity: Math.min(1, Math.max(0, finiteOr(style.backgroundOpacity, 0))),
    animation: style.animation,
    animationDurationUs: Math.max(0, finiteOr(style.animationDurationUs, 0))
  }
}

export const subtitleAnchorTransform = (anchor: SubtitleAnchor): string => {
  if (anchor === 'top') return 'translate(-50%, 0)'
  if (anchor === 'middle') return 'translate(-50%, -50%)'
  return 'translate(-50%, -100%)'
}

export interface ActiveSubtitleCue {
  clip: SubtitleClip
  trackIndex: number
  /** Milliseconds from the cue's ASS start to this frame (libass clock). */
  offsetMs: number
  /** Milliseconds from this frame to the cue's ASS end. */
  remainingMs: number
  /** Animation length in the milliseconds the ASS override uses; 0 when not animated. */
  animationMs: number
  /** libass still draws the intro animation on this frame. */
  intro: boolean
  /** libass is fading the cue out on this frame. */
  outro: boolean
}

export const subtitleAnimationMs = (style: SubtitleStyle): number =>
  style.animation === 'none' ? 0 : Math.max(0, Math.round(Math.max(0, finiteOr(style.animationDurationUs, 0)) / 1_000))

/**
 * The cues visible on a frame under the shared frame-range rule
 * (subtitle-timing.ts), with their position inside the animation windows.
 */
/** Cues that can ever be visible, with their frame range, in drawing order. */
export interface PreparedSubtitleCue {
  clip: SubtitleClip
  trackIndex: number
  range: SubtitleFrameRange
  animationMs: number
}

export const prepareSubtitleCues = (project: ProjectFile): PreparedSubtitleCue[] => {
  const fps = project.sequence.frameRate
  const cues: PreparedSubtitleCue[] = []
  project.tracks.forEach((track, trackIndex) => {
    if (track.kind !== 'subtitle' || track.hidden || track.muted) return
    for (const clip of track.clips) {
      if (clip.kind !== 'subtitle' || !clip.enabled || !(clip.durationUs > 0) || clip.text.trim().length === 0) continue
      const range = subtitleFrameRange(clip.startUs, clip.durationUs, fps)
      if (range) cues.push({ clip, trackIndex, range, animationMs: subtitleAnimationMs(clip.style) })
    }
  })
  return cues.sort((left, right) => left.clip.startUs - right.clip.startUs || left.trackIndex - right.trackIndex || left.clip.id.localeCompare(right.clip.id))
}

export const activeSubtitleCuesFrom = (project: ProjectFile, prepared: readonly PreparedSubtitleCue[], frameIndex: number): ActiveSubtitleCue[] => {
  const fps = project.sequence.frameRate
  const cues: ActiveSubtitleCue[] = []
  for (const { clip, trackIndex, range, animationMs } of prepared) {
    if (frameIndex < range.firstFrame || frameIndex >= range.endFrame) continue
    const state = subtitleCueFrameState(range, frameIndex, fps)
    if (!state) continue
    cues.push({
      clip,
      trackIndex,
      offsetMs: state.offsetMs,
      remainingMs: state.remainingMs,
      animationMs,
      intro: animationMs > 0 && state.offsetMs < animationMs,
      // fade is the only animation that also fades out at the end of the cue
      outro: animationMs > 0 && clip.style.animation === 'fade' && state.remainingMs < animationMs
    })
  }
  return cues
}

export const activeSubtitleCuesAtFrame = (project: ProjectFile, frameIndex: number): ActiveSubtitleCue[] =>
  activeSubtitleCuesFrom(project, prepareSubtitleCues(project), frameIndex)

export const subtitleAnimatedAtFrame = (project: ProjectFile, frameIndex: number): boolean =>
  activeSubtitleCuesAtFrame(project, frameIndex).some((cue) => cue.intro || cue.outro)

/** Suffix that makes the image identity depend on the animation phase of each cue. */
const animationSignature = (cues: ActiveSubtitleCue[]): string => cues
  .map((cue, index) => cue.intro || cue.outro ? `${index}:${cue.intro ? `i${cue.offsetMs}` : ''}${cue.outro ? `o${cue.remainingMs}` : ''}` : '')
  .filter((part) => part.length > 0)
  .join(',')

const visualStateKeyOf = (project: ProjectFile, cues: ActiveSubtitleCue[]): string => JSON.stringify({
  sequence: {
    width: project.sequence.width,
    height: project.sequence.height,
    frameRate: project.sequence.frameRate
  },
  active: cues.map(({ clip, trackIndex }) => ({
    clipId: clip.id,
    trackIndex,
    text: clip.text,
    style: clip.style,
    maxLines: clip.maxLines ?? 2
  }))
})

/**
 * Cache identity for the active subtitle visual state on a frame. Media assets
 * are deliberately excluded: a subtitle-only overlay is independent of the
 * video source, and so is the cue's absolute position on the timeline.
 */
export const subtitleVisualStateKeyAtFrame = (project: ProjectFile, frameIndex: number): string =>
  visualStateKeyOf(project, activeSubtitleCuesAtFrame(project, frameIndex))

/**
 * Identity of the image libass draws on a frame: the visual state, plus the
 * animation phase of every cue that is still animating (static frames share).
 */
export const subtitleFrameImageIdentity = (
  project: ProjectFile,
  frameIndex: number,
  prepared?: readonly PreparedSubtitleCue[]
): { state: string; image: string; animated: boolean; cues: ActiveSubtitleCue[] } => {
  const cues = prepared ? activeSubtitleCuesFrom(project, prepared, frameIndex) : activeSubtitleCuesAtFrame(project, frameIndex)
  const state = visualStateKeyOf(project, cues)
  const signature = animationSignature(cues)
  return { state, image: signature ? `${state}#${signature}` : state, animated: signature.length > 0, cues }
}

/** Preview and export both show frame floor(time): the last frame at or before the playhead. */
const frameOfTime = (project: ProjectFile, timeUs: number): number => frameIndexAtOrBeforeUs(timeUs, project.sequence.frameRate)

/**
 * True when libass draws a different image on each frame of the active cues
 * (fade/pop/slide-up/typewriter inside their animation windows). Static states
 * can share one image per visual state; animated frames need one per phase.
 */
export const subtitleAnimatedAt = (project: ProjectFile, timeUs: number): boolean =>
  subtitleAnimatedAtFrame(project, frameOfTime(project, timeUs))

export const activeSubtitleClips = (project: ProjectFile, timeUs: number): Array<{ clip: SubtitleClip; trackIndex: number }> =>
  activeSubtitleCuesAtFrame(project, frameOfTime(project, timeUs)).map(({ clip, trackIndex }) => ({ clip, trackIndex }))

export const subtitleVisualStateKey = (project: ProjectFile, timeUs: number): string =>
  subtitleVisualStateKeyAtFrame(project, frameOfTime(project, timeUs))
