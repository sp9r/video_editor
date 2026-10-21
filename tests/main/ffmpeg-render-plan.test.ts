import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildRenderCommandArgs,
  buildRenderFilterGraph,
  createPreviewPlan,
  createRenderPlan,
  ffmpegSupportsFileBackedOptions,
  inputColorMatrix
} from '../../src/main/ffmpeg/render-plan.js'
import { makeExportSettings, makeProject } from './ffmpeg-fixtures.js'

describe('FFmpeg render planning', () => {
  it('builds deterministic inputs and a compositing/audio graph', () => {
    const project = makeProject()
    const outputPath = join(process.cwd(), 'out', '完成動画.mp4')
    const plan = createRenderPlan(project, makeExportSettings(outputPath))

    expect(plan.durationUs).toBe(5_000_000)
    expect(plan.width).toBe(1280)
    expect(plan.height).toBe(720)
    expect(plan.inputs).toHaveLength(2)
    expect(plan.inputArgs).toEqual([
      '-loop', '1', '-framerate', '30/1', '-t', '3.000000', '-i', project.media[1]?.path,
      '-ss', '0.998000', '-t', '5.000000', '-i', project.media[0]?.path
    ])
    // Layout is composed at the sequence size and resized to the export size at the end.
    expect(plan.compositionWidth).toBe(1920)
    expect(plan.compositionHeight).toBe(1080)
    expect(plan.graphStatements[0]).toContain('color=c=0x102030:s=1920x1080:r=30/1:d=5.000000')
    expect(plan.filterGraph).toContain('scale=w=1280:h=720:force_original_aspect_ratio=decrease')
    // Image: 800x600 fitted into 1920x1080 (x1.8), then scale 0.4, gives a 576x432 box.
    const graph = plan.graphStatements.join('\n')
    expect(graph).toContain('scale=w=576:h=432:flags=bicubic,setsar=1')
    expect(graph).toContain('drawbox=x=0:y=0:w=58:h=432:color=black@0:t=fill:replace=1')
    expect(graph).toContain('drawbox=x=461:y=0:w=115:h=432:color=black@0:t=fill:replace=1')
    expect(graph).toContain('overlay=x=792:y=294:eof_action=pass')
    expect(plan.graphStatements.join('\n')).toContain('adelay=0:all=1')
    expect(plan.graphStatements.join('\n')).toContain('amix=inputs=1:duration=longest:normalize=0')
    expect(plan.srt).toContain('日本語')
    expect(plan.burnSubtitles).toBe(true)
    expect(plan.subtitleCueCount).toBe(1)
    expect(plan.subtitleIds).toEqual(['caption-1'])
  })

  it('generates CPU and VAAPI terminal filters without interpolating paths into the graph', () => {
    const project = makeProject()
    const plan = createRenderPlan(project, makeExportSettings(join(process.cwd(), 'out.mp4')))
    const cpu = buildRenderFilterGraph(plan, 'libx264')
    const vaapi = buildRenderFilterGraph(plan, 'h264_vaapi')

    expect(cpu).toContain("ass=filename='captions.ass'")
    expect(plan.subtitleCueCount).toBe(1)
    expect(cpu).toMatch(/\]scale=out_color_matrix=bt709:out_range=tv:flags=bicubic,format=yuv420p\[vout\]$/u)
    expect(vaapi).toMatch(/\]scale=out_color_matrix=bt709:out_range=tv:flags=bicubic,format=nv12,hwupload\[vout\]$/u)
    expect(cpu).not.toContain(project.media[0]?.path ?? 'missing')
    expect(cpu).not.toContain(project.media[1]?.path ?? 'missing')
  })

  it('names the input colour matrix and tags the output as BT.709', () => {
    expect(inputColorMatrix({ colorSpace: 'bt709', height: 480 })).toBe('bt709')
    expect(inputColorMatrix({ colorSpace: 'smpte170m', height: 1080 })).toBe('bt601')
    expect(inputColorMatrix({ colorSpace: 'bt2020nc', height: 2160 })).toBe('bt2020')
    expect(inputColorMatrix({ height: 1080 })).toBe('bt709')
    expect(inputColorMatrix({ height: 480 })).toBe('bt601')

    const project = makeProject()
    const asset = project.media[0]
    if (asset) Object.assign(asset, { colorSpace: 'bt470bg', colorRange: 'pc' })
    const plan = createRenderPlan(project, makeExportSettings(join(process.cwd(), 'out.mp4')))
    expect(plan.graphStatements.join(';')).toContain('scale=w=1920:h=1080:flags=bicubic:in_color_matrix=bt601:in_range=pc')
    const args = buildRenderCommandArgs(plan, {
      filterGraphPath: 'g.ffgraph', outputPath: 'o.mp4', encoderId: 'libx264', videoBitrate: 8_000_000, audioBitrate: 192_000
    })
    expect(args.join(' ')).toContain('-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv')
  })

  it('lays rotated and cropped clips out in sequence pixels from the shared layout', () => {
    const project = makeProject()
    const image = project.tracks[0]?.clips[0]
    if (image?.kind !== 'image') throw new Error('fixture')
    image.transform = { ...image.transform, rotation: 90, scale: 0.5, positionX: 0, positionY: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 } }
    const graph = createRenderPlan(project, makeExportSettings(join(process.cwd(), 'out.mp4'))).graphStatements.join(';')
    // 800x600 fits as 1440x1080 at x1.8, scale 0.5 gives 720x540; rotated 90 degrees the box is 540x720, centred.
    expect(graph).toContain('scale=w=720:h=540:flags=bicubic')
    expect(graph).toContain('rotate=1.570796:ow=540:oh=720:c=black@0')
    expect(graph).toContain('overlay=x=690:y=180:eof_action=pass')
  })

  it('uses an argv array and a graph file for unsafe Unicode media paths', () => {
    const project = makeProject()
    const outputPath = join(process.cwd(), 'out & result', '完成.mp4')
    const graphPath = join(process.cwd(), 'tmp folder', 'render.ffgraph')
    const plan = createRenderPlan(project, makeExportSettings(outputPath))
    const args = buildRenderCommandArgs(plan, {
      filterGraphPath: graphPath,
      outputPath,
      encoderId: 'h264_nvenc',
      videoBitrate: 8_000_000,
      audioBitrate: 192_000
    })

    expect(args).toContain('-filter_complex_script')
    expect(args).toContain(graphPath)
    expect(args).toContain(project.media[0]?.path)
    expect(args.at(-1)).toBe(outputPath)
    expect(args).toContain('h264_nvenc')
    expect(args.join('\n')).not.toContain('cmd.exe')
  })

  it('uses the modern indirect option when supported', () => {
    const plan = createRenderPlan(makeProject(), makeExportSettings(join(process.cwd(), 'out.mp4')))
    const args = buildRenderCommandArgs(plan, {
      filterGraphPath: join(process.cwd(), 'render.ffgraph'),
      outputPath: join(process.cwd(), 'out.mp4'),
      encoderId: 'libx264',
      videoBitrate: 8_000_000,
      audioBitrate: 192_000,
      supportsFileOption: true
    })
    expect(args).toContain('-/filter_complex')
    expect(args).not.toContain('-filter_complex_script')
    expect(ffmpegSupportsFileBackedOptions('8.0-test')).toBe(true)
    expect(ffmpegSupportsFileBackedOptions('7.1')).toBe(true)
    expect(ffmpegSupportsFileBackedOptions('6.1.1')).toBe(false)
    expect(ffmpegSupportsFileBackedOptions('N-12345')).toBe(false)
  })

  it('rejects offline, relative, and missing assets before spawning FFmpeg', () => {
    const offline = makeProject()
    if (offline.media[0]) offline.media[0].offline = true
    expect(() => createRenderPlan(offline, makeExportSettings(join(process.cwd(), 'out.mp4')))).toThrow(/offline/u)

    const relative = makeProject()
    if (relative.media[0]) relative.media[0].path = 'relative.mp4'
    expect(() => createRenderPlan(relative, makeExportSettings(join(process.cwd(), 'out.mp4')))).toThrow(/absolute/u)

    const missing = makeProject()
    missing.media = missing.media.filter((asset) => asset.id !== 'asset-video')
    expect(() => createRenderPlan(missing, makeExportSettings(join(process.cwd(), 'out.mp4')))).toThrow(/missing asset/u)
  })

  it('keeps legacy video source audio enabled by default and supports explicit disablement', () => {
    const legacy = makeProject()
    const legacyPlan = createRenderPlan(legacy, makeExportSettings(join(process.cwd(), 'out.mp4')))
    expect(legacyPlan.inputs.filter((input) => input.useAudio).map((input) => input.clipId)).toEqual(['clip-video'])

    const disabled = makeProject()
    const videoClip = disabled.tracks.find((track) => track.id === 'track-main')?.clips[0]
    if (videoClip?.kind !== 'video') throw new Error('Expected legacy video fixture')
    videoClip.sourceAudioEnabled = false
    const disabledPlan = createRenderPlan(disabled, makeExportSettings(join(process.cwd(), 'out.mp4')))
    expect(disabledPlan.inputs.filter((input) => input.useAudio)).toHaveLength(0)
    expect(disabledPlan.graphStatements.join('\n')).toContain('anullsrc')
  })

  it('uses one shared layer order for Preview and Final and exposes preview audio settings', () => {
    const project = makeProject()
    const settings = makeExportSettings(join(process.cwd(), 'out.mp4'))
    const preview = createPreviewPlan(project, settings)
    const final = createRenderPlan(project, settings)
    expect(preview.videoClips.map((clip) => clip.clipId)).toEqual(['clip-video', 'clip-image'])
    expect(final.graphStatements.findIndex((statement) => statement.includes('[1:v:0]')))
      .toBeLessThan(final.graphStatements.findIndex((statement) => statement.includes('[0:v:0]')))
    expect(preview.audioClips).toEqual([expect.objectContaining({ clipId: 'clip-video', volumeDb: -3, pan: 0, fadeInUs: 250_000, fadeOutUs: 0 })])
  })
})
