import { describe, expect, it } from 'vitest'
import {
  collectSubtitleCues,
  escapeAssText,
  assShadowBlurFromCss,
  generateAss,
  generateSrt,
  parseSrt,
  parseVtt
} from '../../src/main/ffmpeg/subtitles.js'
import { makeProject } from './ffmpeg-fixtures.js'
import { buildSubtitleRenderSpec } from '../../src/shared/subtitle-render.js'

describe('subtitle serialization', () => {
  it('creates escaped ASS with style, placement, and animation', () => {
    const project = makeProject()
    const ass = generateAss(project)

    expect(collectSubtitleCues(project)).toHaveLength(1)
    expect(ass).toContain('PlayResX: 1920')
    expect(ass).toContain('PlayResY: 1080')
    expect(ass).toContain('Style: Cue0,Noto Sans JP,54')
    expect(ass).toContain('0:00:01.25,0:00:03.75,Cue0')
    expect(ass).toContain('\\pos(922,907)')
    expect(ass).toContain('\\fscx75\\fscy75\\t(0,180,\\fscx100\\fscy100)')
    expect(ass).toContain('日本語 \\{字幕\\}\\\\line\\N2行目')
  })

  it('creates UTF-8 compatible SRT with millisecond timing', () => {
    const srt = generateSrt(makeProject())
    expect(srt).toBe(
      '1\n00:00:01,250 --> 00:00:03,750\n日本語 {字幕}\\line\n2行目\n'
    )
  })

  it('escapes ASS control characters without losing Unicode', () => {
    expect(escapeAssText('A\\B{C}\n日本語')).toBe('A\\\\B\\{C\\}\\N日本語')
  })

  it('uses the same conservative line wrapping policy as Preview', () => {
    const project = makeProject()
    const subtitle = project.tracks.find((track) => track.kind === 'subtitle')?.clips[0]
    if (!subtitle || subtitle.kind !== 'subtitle') throw new Error('subtitle fixture missing')
    subtitle.text = 'あ'.repeat(50)
    const ass = generateAss(project)
    expect(ass).toContain('WrapStyle: 2')
    expect(ass).toMatch(/あ{20,}\\Nあ+/u)
  })

  it('keeps Preview geometry values, anchors, and expanded positions in ASS', () => {
    const project = makeProject()
    const subtitle = project.tracks.find((track) => track.kind === 'subtitle')?.clips[0]
    if (!subtitle || subtitle.kind !== 'subtitle') throw new Error('subtitle fixture missing')
    subtitle.style = { ...subtitle.style, alignment: 'top', positionX: -25, positionY: 150, maxWidthPercent: 150, animation: 'none', animationDurationUs: 0 }
    subtitle.text = 'alpha beta gamma\n日本語'
    const spec = buildSubtitleRenderSpec(subtitle, project.sequence)
    const ass = generateAss(project)
    expect(spec).toMatchObject({ xPx: -480, yPx: 1620, maxWidthPx: 2880, anchor: 'top' })
    expect(ass).toContain('\\pos(-480,1620)')
    expect(ass).toContain(',8,10,10,10,1')
    expect(ass).toContain('alpha beta gamma\\N日本語')
  })

  it.each([
    ['A', { outlineWidth: 0, shadowColor: '#00000000', shadowBlur: 0, backgroundOpacity: 0 }],
    ['B', { outlineWidth: 14, shadowColor: '#00000000', shadowBlur: 0, backgroundOpacity: 0 }],
    ['C', { outlineWidth: 14, shadowColor: '#d60000', shadowBlur: 0, backgroundOpacity: 0 }],
    ['D', { outlineWidth: 14, shadowColor: '#d60000', shadowBlur: 24, backgroundOpacity: 0 }],
    ['E', { outlineWidth: 14, shadowColor: '#00000000', shadowBlur: 0, backgroundOpacity: 0.15 }],
    ['F', { outlineWidth: 14, shadowColor: '#d60000', shadowBlur: 24, backgroundOpacity: 0.15 }]
  ])('keeps main glyph invariants in the Final ASS style matrix %s', (_name, stylePatch) => {
    const project = makeProject()
    const subtitle = project.tracks.find((track) => track.kind === 'subtitle')?.clips[0]
    if (!subtitle || subtitle.kind !== 'subtitle') throw new Error('subtitle fixture missing')
    subtitle.text = '字幕を入力'
    subtitle.style = {
      ...subtitle.style,
      fontFamily: 'Noto Sans JP ExtraBold',
      fontSize: 123,
      animation: 'none',
      animationDurationUs: 0,
      positionX: 50,
      positionY: 86,
      alignment: 'bottom',
      ...stylePatch
    }

    const ass = generateAss(project)
    const spec = buildSubtitleRenderSpec(subtitle, project.sequence)
    const mainStyle = ass.split('\n').find((line) => line.startsWith('Style: Cue0,'))
    const mainEvent = ass.split('\n').find((line) => line.includes(',Cue0,,0,0,0,,{') && !line.includes('Cue0Shadow'))
    expect(mainStyle).toContain('Noto Sans JP ExtraBold,123')
    expect(mainStyle).toContain(`,${spec.outlineWidthPx.toFixed(2)},0.00,2,`)
    expect(mainEvent).toContain(`\\pos(${Math.round(spec.xPx)},${Math.round(spec.yPx)})`)
    expect(mainEvent).toContain('字幕を入力')
    const shadowEvent = ass.split('\n').find((line) => line.includes(',Cue0Shadow,'))
    expect(mainEvent).not.toContain('\\blur')
    if (stylePatch.shadowColor === '#00000000') expect(ass).not.toContain('Cue0Shadow')
    else {
      expect(ass).toContain('Style: Cue0Shadow,')
      expect(shadowEvent).toContain(`\\pos(${Math.round(spec.xPx)},${Math.round(spec.yPx + 2)})`)
      expect(shadowEvent).toContain(stylePatch.shadowBlur > 0 ? `\\blur${assShadowBlurFromCss(stylePatch.shadowBlur)}` : `\\pos(${Math.round(spec.xPx)},${Math.round(spec.yPx + 2)})`)
    }
    if (stylePatch.backgroundOpacity > 0) {
      const backgroundStyle = ass.split('\n').find((line) => line.startsWith('Style: Cue0Background,'))
      expect(backgroundStyle).toContain(',3,0.00,0.00,2,')
      expect(mainStyle).toContain(',1,')
    } else expect(mainStyle).toContain(',1,')
  })

  it('keeps the exact user style in the shared spec and separates red shadow from the main glyph', () => {
    const project = makeProject()
    const subtitle = project.tracks.find((track) => track.kind === 'subtitle')?.clips[0]
    if (!subtitle || subtitle.kind !== 'subtitle') throw new Error('subtitle fixture missing')
    subtitle.text = '字幕を入力'
    subtitle.style = {
      ...subtitle.style,
      fontFamily: 'Noto Sans JP ExtraBold',
      fontSize: 123,
      color: '#ffffff',
      outlineColor: '#111318',
      outlineWidth: 14,
      shadowColor: '#d60000',
      shadowBlur: 24,
      backgroundColor: '#000000',
      backgroundOpacity: 0.15,
      bold: true,
      alignment: 'bottom',
      positionX: 50,
      positionY: 86,
      maxWidthPercent: 80,
      animation: 'none',
      animationDurationUs: 0
    }
    const spec = buildSubtitleRenderSpec(subtitle, project.sequence)
    const ass = generateAss(project)
    const mainStyle = ass.split('\n').find((line) => line.startsWith('Style: Cue0,'))
    expect(spec).toMatchObject({ fontSizePx: 123, xPx: 960, yPx: 928.8, outlineWidthPx: 14, shadowBlurPx: 24, backgroundOpacity: 0.15 })
    const backgroundStyle = ass.split('\n').find((line) => line.startsWith('Style: Cue0Background,'))
    expect(backgroundStyle).toContain(',3,0.00,0.00,2,')
    expect(mainStyle).toContain(',1,14.00,0.00,2,')
    expect(ass).toContain('Style: Cue0Shadow,')
    expect(ass.match(/Dialogue:/gu)).toHaveLength(3)
    expect(ass).toContain(`\\blur${assShadowBlurFromCss(24)}`)
    const mainEvent = ass.split('\n').find((line) => line.includes(',Cue0,,0,0,0,,{'))
    expect(mainEvent).not.toContain('\\blur')
  })
})

describe('subtitle parsing', () => {
  it('parses BOM, cue numbers, CRLF, and multiline SRT cues', () => {
    const cues = parseSrt('\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\n一行目\r\n二行目\r\n\r\n2\r\n00:00:04.000 --> 00:00:05.100\r\nNext')
    expect(cues).toEqual([
      { startUs: 1_250_000, endUs: 3_500_000, text: '一行目\n二行目' },
      { startUs: 4_000_000, endUs: 5_100_000, text: 'Next' }
    ])
  })

  it('parses VTT headers, cue identifiers, settings, and NOTE blocks', () => {
    const cues = parseVtt(`WEBVTT - test
Kind: captions
Language: ja

NOTE generated by test
ignored

intro
00:01.000 --> 00:03.250 align:start position:10%
こんにちは
世界

00:04.000 --> 00:05.000
Next
`)
    expect(cues).toEqual([
      { startUs: 1_000_000, endUs: 3_250_000, text: 'こんにちは\n世界' },
      { startUs: 4_000_000, endUs: 5_000_000, text: 'Next' }
    ])
  })

  it('rejects reversed or malformed cue timing', () => {
    expect(() => parseSrt('1\n00:00:02,000 --> 00:00:01,000\nBad')).toThrow(/end after/u)
    expect(() => parseVtt('not vtt')).toThrow(/WEBVTT/u)
  })
})
