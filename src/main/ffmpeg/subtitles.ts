import type { ProjectFile, SubtitleClip, SubtitleStyle } from '../../shared/types.js'

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

const assTime = (timeUs: number, end = false): string => {
  const centiseconds = end ? Math.ceil(Math.max(0, timeUs) / 10_000) : Math.floor(Math.max(0, timeUs) / 10_000)
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
  clip: SubtitleClip,
  x: number,
  y: number
): string => {
  const maximum = Math.max(0, Math.floor(clip.durationUs / 2))
  const durationMs = Math.round(clamp(clip.style.animationDurationUs, 0, maximum) / 1_000)
  if (durationMs <= 0 || clip.style.animation === 'none') return `\\pos(${x},${y})`
  switch (clip.style.animation) {
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

const styleLine = (style: SubtitleStyle, index: number): string => {
  const hasBackground = clamp(style.backgroundOpacity, 0, 1) > 0
  const backColor = hasBackground
    ? assColor(style.backgroundColor, style.backgroundOpacity)
    : assColor(style.shadowColor)
  return [
    `Style: Cue${index}`,
    safeFont(style.fontFamily),
    Math.round(clamp(style.fontSize, 1, 500)),
    assColor(style.color),
    assColor(style.color),
    assColor(style.outlineColor),
    backColor,
    style.bold ? -1 : 0,
    style.italic ? -1 : 0,
    0,
    0,
    100,
    100,
    clamp(style.letterSpacing, -100, 100).toFixed(2),
    0,
    hasBackground ? 3 : 1,
    clamp(style.outlineWidth, 0, 20).toFixed(2),
    clamp(style.shadowBlur / 2, 0, 20).toFixed(2),
    assAlignment(style.alignment),
    10,
    10,
    10,
    1
  ].join(',')
}

export const generateAss = (project: ProjectFile): string => {
  const cues = collectSubtitleCues(project)
  const width = Math.max(16, Math.round(project.sequence.width))
  const height = Math.max(16, Math.round(project.sequence.height))
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    ...cues.map(({ clip }, index) => styleLine(clip.style, index)),
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'
  ]
  const events = cues.map(({ clip, layer }, index) => {
    const start = Math.max(0, clip.startUs)
    const end = Math.max(start + 10_000, start + clip.durationUs)
    const x = Math.round(width * clamp(clip.style.positionX, 0, 100) / 100)
    const y = Math.round(height * clamp(clip.style.positionY, 0, 100) / 100)
    const override = animationOverride(clip, x, y)
    const blur = clamp(clip.style.shadowBlur, 0, 100)
    const text = `{${override}\\blur${blur.toFixed(2)}}${escapeAssText(clip.text)}`
    return `Dialogue: ${layer},${assTime(start)},${assTime(end, true)},Cue${index},,0,0,0,,${text}`
  })
  return `${[...header, ...events].join('\n')}\n`
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
