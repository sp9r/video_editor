import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildRenderCommandArgs,
  buildRenderFilterGraph,
  createRenderPlan,
  ffmpegSupportsFileBackedOptions
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
      '-ss', '1.000000', '-t', '5.000000', '-i', project.media[0]?.path
    ])
    expect(plan.graphStatements[0]).toContain('color=c=0x102030:s=1280x720:r=30/1:d=5.000000')
    expect(plan.graphStatements.join('\n')).toContain("crop=w='max(2\\,trunc(iw*0.7/2)*2)'")
    expect(plan.graphStatements.join('\n')).toContain("overlay=x='(W-w)/2+120':y='(H-h)/2+-30'")
    expect(plan.graphStatements.join('\n')).toContain('adelay=0:all=1')
    expect(plan.graphStatements.join('\n')).toContain('amix=inputs=1:duration=longest:normalize=0')
    expect(plan.srt).toContain('日本語')
  })

  it('generates CPU and VAAPI terminal filters without interpolating paths into the graph', () => {
    const project = makeProject()
    const plan = createRenderPlan(project, makeExportSettings(join(process.cwd(), 'out.mp4')))
    const cpu = buildRenderFilterGraph(plan, 'libx264')
    const vaapi = buildRenderFilterGraph(plan, 'h264_vaapi')

    expect(cpu).toContain("ass=filename='captions.ass'")
    expect(cpu).toMatch(/\]format=yuv420p\[vout\]$/u)
    expect(vaapi).toMatch(/\]format=nv12,hwupload\[vout\]$/u)
    expect(cpu).not.toContain(project.media[0]?.path ?? 'missing')
    expect(cpu).not.toContain(project.media[1]?.path ?? 'missing')
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
})
