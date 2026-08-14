import { subtitleMaxWidthPercent, wrapSubtitleText } from './subtitle-layout.js'
import type { ProjectFile, SequenceSettings, SubtitleClip, SubtitleStyle } from './types.js'

export type SubtitleAnchor = SubtitleStyle['alignment']

export interface SubtitleRenderSpec {
  xPx: number
  yPx: number
  anchor: SubtitleAnchor
  wrappedText: string
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
  return {
    xPx: width * xPercent / 100,
    yPx: height * yPercent / 100,
    anchor: style.alignment,
    wrappedText: wrapSubtitleText(clip.text, { ...style, maxWidthPercent }, width),
    maxWidthPx: width * maxWidthPercent / 100,
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

export const activeSubtitleClips = (project: ProjectFile, timeUs: number): Array<{ clip: SubtitleClip; trackIndex: number }> => project.tracks
  .flatMap((track, trackIndex) => track.kind === 'subtitle' && !track.hidden && !track.muted
    ? track.clips
      .filter((clip): clip is SubtitleClip => clip.kind === 'subtitle' && clip.enabled && clip.durationUs > 0 && clip.startUs <= timeUs && timeUs < clip.startUs + clip.durationUs && clip.text.trim().length > 0)
      .map((clip) => ({ clip, trackIndex }))
    : [])
  .sort((left, right) => left.clip.startUs - right.clip.startUs || left.trackIndex - right.trackIndex || left.clip.id.localeCompare(right.clip.id))

/**
 * Cache identity for the active subtitle visual state. Media assets are deliberately
 * excluded: a subtitle-only overlay is independent of the video source.
 */
export const subtitleVisualStateKey = (project: ProjectFile, timeUs: number): string => JSON.stringify({
  sequence: {
    width: project.sequence.width,
    height: project.sequence.height,
    frameRate: project.sequence.frameRate
  },
  active: activeSubtitleClips(project, timeUs).map(({ clip, trackIndex }) => ({
    clipId: clip.id,
    trackIndex,
    text: clip.text,
    style: clip.style
  }))
})
