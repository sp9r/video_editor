import type { ProjectFile, SubtitleClip, SubtitleStyle } from '../../shared/types.js'
import { activeSubtitleCuesAtFrame, buildSubtitleRenderSpec, type SubtitleRenderSpec } from '../../shared/subtitle-render.js'
import { frameTimeMs, subtitleAssWindow, subtitleFrameRange } from '../../shared/subtitle-timing.js'
import { canonicalShadowBlurRadius } from '../../shared/subtitle-shadow.js'

export interface SubtitleCue {
  clip: SubtitleClip
  layer: number
}

export interface ParsedSubtitleCue {
  startUs: number
  endUs: number
  text: string
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum))

export const collectSubtitleCues = (project: ProjectFile): SubtitleCue[] => {
  const cues: SubtitleCue[] = []
  project.tracks.forEach((track, trackIndex) => {
    if (track.kind !== 'subtitle' || track.hidden || track.muted) return
    for (const clip of track.clips) {
      if (clip.kind === 'subtitle' && clip.enabled && clip.durationUs > 0 && clip.text.trim()) {
        cues.push({ clip, layer: trackIndex })
      }
    }
  })
  return cues.sort((left, right) => left.clip.startUs - right.clip.startUs || left.layer - right.layer)
}

const parseHexColor = (value: string): { red: number; green: number; blue: number; alpha: number } => {
  const clean = value.trim().replace(/^#/u, '')
  const expanded = clean.length === 3 || clean.length === 4
    ? clean.split('').map((character) => character.repeat(2)).join('')
    : clean
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/iu.test(expanded)) return { red: 255, green: 255, blue: 255, alpha: 255 }
  return {
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16),
    alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) : 255
  }
}

const assColor = (value: string, opacity = 1): string => {
  const color = parseHexColor(value)
  const visibleAlpha = clamp((color.alpha / 255) * opacity, 0, 1)
  const assAlpha = Math.round((1 - visibleAlpha) * 255)
  return `&H${assAlpha.toString(16).padStart(2, '0')}${color.blue.toString(16).padStart(2, '0')}${color.green.toString(16).padStart(2, '0')}${color.red.toString(16).padStart(2, '0')}`.toUpperCase()
}

const assTimeMs = (milliseconds: number): string => {
  const centiseconds = Math.floor(Math.max(0, milliseconds) / 10)
  const hours = Math.floor(centiseconds / 360_000)
  const minutes = Math.floor(centiseconds / 6_000) % 60
  const seconds = Math.floor(centiseconds / 100) % 60
  const fraction = centiseconds % 100
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`
}

const srtTime = (timeUs: number): string => {
  const milliseconds = Math.round(Math.max(0, timeUs) / 1_000)
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds / 60_000) % 60
  const seconds = Math.floor(milliseconds / 1_000) % 60
  const fraction = milliseconds % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(fraction).padStart(3, '0')}`
}

const assAlignment = (alignment: SubtitleStyle['alignment']): number => {
  if (alignment === 'top') return 8
  if (alignment === 'middle') return 5
  return 2
}

const safeFont = (value: string): string => value.replace(/[,\r\n]/gu, ' ').trim() || 'Arial'

export const escapeAssText = (value: string): string => value
  .replace(/\\/gu, '\\\\')
  .replace(/\{/gu, '\\{')
  .replace(/\}/gu, '\\}')
  .replace(/\r\n|\r|\n/gu, '\\N')

const animationOverride = (
  spec: SubtitleRenderSpec,
  x: number,
  y: number
): string => {
  const durationMs = Math.round(spec.animationDurationUs / 1_000)
  if (durationMs <= 0 || spec.animation === 'none') return `\\pos(${x},${y})`
  switch (spec.animation) {
    case 'fade':
      return `\\pos(${x},${y})\\fad(${durationMs},${durationMs})`
    case 'pop':
      return `\\pos(${x},${y})\\fscx75\\fscy75\\t(0,${durationMs},\\fscx100\\fscy100)`
    case 'slide-up':
      return `\\move(${x},${y + 40},${x},${y},0,${durationMs})`
    case 'typewriter':
      // ASS has no portable grapheme-by-grapheme reveal; fading preserves every Unicode grapheme safely.
      return `\\pos(${x},${y})\\fad(${durationMs},0)`
  }
}

type AssStyleRole = 'main' | 'shadow' | 'background'

const styleLine = (spec: SubtitleRenderSpec, index: number, role: AssStyleRole = 'main'): string => {
  const isShadow = role === 'shadow'
  const isBackground = role === 'background'
  const backgroundColor = assColor(spec.backgroundColor, spec.backgroundOpacity)
  const primaryColor = isShadow ? assColor(spec.shadowColor) : isBackground ? backgroundColor : assColor(spec.color)
  const outlineColor = isBackground ? backgroundColor : isShadow ? assColor('#00000000') : assColor(spec.outlineColor)
  const backColor = isBackground ? backgroundColor : assColor('#00000000')
  return [
    `Style: Cue${index}${isShadow ? 'Shadow' : isBackground ? 'Background' : ''}`,
    safeFont(spec.fontFamily),
    Math.round(spec.fontSizePx),
    primaryColor,
    primaryColor,
    outlineColor,
    backColor,
    spec.bold ? -1 : 0,
    spec.italic ? -1 : 0,
    0,
    0,
    100,
    100,
    spec.letterSpacingPx.toFixed(2),
    0,
    isBackground ? 3 : 1,
    isShadow ? '0.00' : isBackground ? Math.max(1, spec.outlineWidthPx).toFixed(2) : spec.outlineWidthPx.toFixed(2),
    '0.00',
    assAlignment(spec.anchor),
    10,
    10,
    10,
    1
  ].join(',')
}

const hasVisibleColor = (value: string): boolean => parseHexColor(value).alpha > 0

/**
 * CSS text-shadow blur is a visual spread, while ASS \\blur is a libass
 * filter radius. A half-radius is the current conservative approximation;
 * the mapping is deliberately applied only to the duplicate shadow event.
 */
export const assShadowBlurFromCss = canonicalShadowBlurRadius

export const generateAss = (project: ProjectFile, options: { disableAnimations?: boolean } = {}): string => {
  const cues = collectSubtitleCues(project)
  const events = cues.flatMap(({ clip, layer }, index) => {
    const range = subtitleFrameRange(clip.startUs, clip.durationUs, project.sequence.frameRate)
    // A cue that falls between two frames is never visible, in Preview or here.
    if (!range) return []
    const window = subtitleAssWindow(range, project.sequence.frameRate)
    return cueDialogueLines(project, clip, layer, index, window.startMs, window.endMs, options.disableAnimations === true)
  })
  return `${[...assHeader(project, cues), ...events].join('\n')}\n`
}

const assHeader = (project: ProjectFile, cues: SubtitleCue[], only?: ReadonlySet<number>): string[] => {
  const width = Math.max(16, Math.round(project.sequence.width))
  const height = Math.max(16, Math.round(project.sequence.height))
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    ...cues.flatMap(({ clip }, index) => {
      if (only && !only.has(index)) return []
      const spec = buildSubtitleRenderSpec(clip, { width, height })
      return [
        ...(spec.backgroundOpacity > 0 ? [styleLine(spec, index, 'background')] : []),
        styleLine(spec, index),
        ...(hasVisibleColor(spec.shadowColor) ? [styleLine(spec, index, 'shadow')] : [])
      ]
    }),
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'
  ]
}

/** Dialogue lines (background, shadow, main) of one cue between two centisecond-aligned times. */
const cueDialogueLines = (
  project: ProjectFile,
  clip: SubtitleClip,
  layer: number,
  index: number,
  startMs: number,
  endMs: number,
  disableAnimations: boolean
): string[] => {
  const width = Math.max(16, Math.round(project.sequence.width))
  const height = Math.max(16, Math.round(project.sequence.height))
  const spec = buildSubtitleRenderSpec(clip, { width, height })
  const x = Math.round(spec.xPx)
  const y = Math.round(spec.yPx)
  const renderEvent = (styleName: string, eventX: number, eventY: number, eventLayer: number, shadow = false): string => {
    const override = disableAnimations ? `\\pos(${eventX},${eventY})` : animationOverride(spec, eventX, eventY)
    const assBlur = shadow ? assShadowBlurFromCss(spec.shadowBlurPx) : 0
    const blurOverride = assBlur > 0 ? `\\blur${assBlur}` : ''
    const text = `{${override}${blurOverride}}${escapeAssText(spec.wrappedText)}`
    return `Dialogue: ${eventLayer},${assTimeMs(startMs)},${assTimeMs(endMs)},${styleName},,0,0,0,,${text}`
  }
  const background = spec.backgroundOpacity > 0 ? renderEvent(`Cue${index}Background`, x, y, layer) : undefined
  const shadow = hasVisibleColor(spec.shadowColor)
    ? renderEvent(`Cue${index}Shadow`, x + Math.round(spec.shadowOffsetXPx), y + Math.round(spec.shadowOffsetYPx), layer + (background ? 1 : 0), true)
    : undefined
  const main = renderEvent(`Cue${index}`, x, y, layer + (shadow ? 1 : 0) + (background ? 1 : 0))
  return [background, shadow, main].filter((event): event is string => event !== undefined)
}

export interface SubtitleSlotRequest {
  frameIndex: number
  /** Draw the cue without its animation (static look). */
  base?: boolean
}

export interface SubtitleSlotAss {
  ass: string
  /** Presentation time (ms) at which libass must be asked to draw each requested slot. */
  presentationMs: number[]
}

const ceilToCentisecond = (milliseconds: number): number => Math.ceil(milliseconds / 10) * 10

/**
 * One ASS file whose slot i, when rendered at presentationMs[i], looks exactly
 * like the export on frame requests[i].frameIndex. Each slot is a short-lived
 * copy of the active cues placed so that, relative to its own start, the
 * render time equals the real frame's offset into the cue (animations depend
 * on nothing else), and slots never overlap. Static frames are shortened to
 * just past the animation window so slots stay close together.
 */
export const generateSubtitleSlotAss = (project: ProjectFile, requests: readonly SubtitleSlotRequest[]): SubtitleSlotAss => {
  const cues = collectSubtitleCues(project)
  const indexOfClip = new Map(cues.map(({ clip }, index) => [clip, index]))
  const fps = project.sequence.frameRate
  interface SlotEvent { clip: SubtitleClip; layer: number; index: number; backMs: number; durationMs: number }
  const slots = requests.map((request) => {
    const residue = frameTimeMs(request.frameIndex, fps) % 10
    const events: SlotEvent[] = []
    for (const cue of activeSubtitleCuesAtFrame(project, request.frameIndex)) {
      const index = indexOfClip.get(cue.clip)
      if (index === undefined) continue
      const animationMs = request.base ? 0 : cue.animationMs
      const settledMs = ceilToCentisecond(animationMs) + 10 + residue
      let backMs: number
      let durationMs: number
      if (!request.base && cue.intro) {
        backMs = cue.offsetMs
        durationMs = cue.outro ? cue.offsetMs + cue.remainingMs : ceilToCentisecond(cue.offsetMs + animationMs + 200)
      } else if (!request.base && cue.outro) {
        backMs = settledMs
        durationMs = settledMs + cue.remainingMs
      } else {
        backMs = settledMs
        durationMs = ceilToCentisecond(settledMs + animationMs + 200)
      }
      events.push({ clip: cue.clip, layer: cues[index]?.layer ?? 0, index, backMs, durationMs })
    }
    return { residue, events }
  })
  const maxBack = Math.max(0, ...slots.flatMap((slot) => slot.events.map((event) => event.backMs)))
  const maxAhead = Math.max(0, ...slots.flatMap((slot) => slot.events.map((event) => event.durationMs - event.backMs)))
  const origin = ceilToCentisecond(maxBack) + 10
  const stride = ceilToCentisecond(maxBack + maxAhead + 30)
  const presentationMs = slots.map((slot, slotIndex) => origin + slotIndex * stride + slot.residue)
  const dialogue = slots.flatMap((slot, slotIndex) => slot.events.flatMap((event) => {
    const startMs = (presentationMs[slotIndex] ?? 0) - event.backMs
    return cueDialogueLines(project, event.clip, event.layer, event.index, startMs, startMs + event.durationMs, requests[slotIndex]?.base === true)
  }))
  const used = new Set(slots.flatMap((slot) => slot.events.map((event) => event.index)))
  return { ass: `${[...assHeader(project, cues, used), ...dialogue].join('\n')}\n`, presentationMs }
}

const normalizeSrtText = (value: string): string => value.replace(/\r\n|\r/gu, '\n').trim()

export const generateSrt = (project: ProjectFile): string => {
  const cues = collectSubtitleCues(project)
  if (cues.length === 0) return ''
  return `${cues.map(({ clip }, index) => {
    const start = Math.max(0, clip.startUs)
    const end = Math.max(start + 1_000, start + clip.durationUs)
    return `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${normalizeSrtText(clip.text)}`
  }).join('\n\n')}\n`
}

const parseTimestampUs = (value: string, source: 'SRT' | 'VTT', cueNumber: number): number => {
  const normalized = value.trim().replace(',', '.')
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u.exec(normalized)
  if (!match) throw new Error(`${source} cue ${cueNumber} has an invalid timestamp: ${value}`)
  const hours = Number.parseInt(match[1] ?? '0', 10)
  const minutes = Number.parseInt(match[2] ?? '0', 10)
  const seconds = Number.parseInt(match[3] ?? '0', 10)
  if (minutes > 59 || seconds > 59) throw new Error(`${source} cue ${cueNumber} has an out-of-range timestamp`)
  const milliseconds = Number.parseInt((match[4] ?? '').padEnd(3, '0') || '0', 10)
  return ((hours * 3600 + minutes * 60 + seconds) * 1_000 + milliseconds) * 1_000
}

const parseCueTiming = (
  line: string,
  source: 'SRT' | 'VTT',
  cueNumber: number
): { startUs: number; endUs: number } => {
  const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/u.exec(line.trim())
  if (!match?.[1] || !match[2]) throw new Error(`${source} cue ${cueNumber} has no valid timing line`)
  const startUs = parseTimestampUs(match[1], source, cueNumber)
  const endUs = parseTimestampUs(match[2], source, cueNumber)
  if (endUs <= startUs) throw new Error(`${source} cue ${cueNumber} must end after it starts`)
  return { startUs, endUs }
}

const normalizedSubtitleLines = (text: string): string[] => text
  .replace(/^\uFEFF/u, '')
  .replace(/\r\n|\r/gu, '\n')
  .split('\n')

export const parseSrt = (text: string): ParsedSubtitleCue[] => {
  const blocks = normalizedSubtitleLines(text).join('\n').split(/\n{2,}/u)
  const cues: ParsedSubtitleCue[] = []
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trimEnd())
    while (lines.length > 0 && !lines[0]?.trim()) lines.shift()
    if (lines.length === 0) continue
    if (/^\d+$/u.test(lines[0]?.trim() ?? '')) lines.shift()
    const cueNumber = cues.length + 1
    const timingLine = lines.shift()
    if (!timingLine) throw new Error(`SRT cue ${cueNumber} is missing its timing line`)
    const { startUs, endUs } = parseCueTiming(timingLine, 'SRT', cueNumber)
    const cueText = lines.join('\n').trim()
    if (!cueText) throw new Error(`SRT cue ${cueNumber} has no text`)
    cues.push({ startUs, endUs, text: cueText })
  }
  return cues
}

export const parseVtt = (text: string): ParsedSubtitleCue[] => {
  const lines = normalizedSubtitleLines(text)
  if (!/^WEBVTT(?:\s|$)/u.test(lines[0]?.trim() ?? '')) throw new Error('VTT input must begin with WEBVTT')
  const cues: ParsedSubtitleCue[] = []
  let index = 1
  while (index < lines.length && lines[index]?.trim()) index += 1
  while (index < lines.length) {
    while (index < lines.length && !lines[index]?.trim()) index += 1
    if (index >= lines.length) break
    const heading = lines[index]?.trim() ?? ''
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/u.test(heading)) {
      index += 1
      while (index < lines.length && lines[index]?.trim()) index += 1
      continue
    }
    let timingLine = heading
    if (!timingLine.includes('-->')) {
      index += 1
      timingLine = lines[index]?.trim() ?? ''
    }
    const cueNumber = cues.length + 1
    const { startUs, endUs } = parseCueTiming(timingLine, 'VTT', cueNumber)
    index += 1
    const body: string[] = []
    while (index < lines.length && lines[index]?.trim()) {
      body.push(lines[index] ?? '')
      index += 1
    }
    const cueText = body.join('\n').trim()
    if (!cueText) throw new Error(`VTT cue ${cueNumber} has no text`)
    cues.push({ startUs, endUs, text: cueText })
  }
  return cues
}
