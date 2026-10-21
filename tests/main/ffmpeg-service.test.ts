import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { FfmpegService, createFfmpegProgressParser } from '../../src/main/ffmpeg/service.js'
import {
  CommandExecutionError,
  ProcessCancelledError,
  type CommandRequest,
  type CommandResult,
  type ProcessExecutor
} from '../../src/main/ffmpeg/process.js'
import type { ExportProgress, SubtitleClip } from '../../src/shared/types.js'
import { makeExportSettings, makeProject } from './ffmpeg-fixtures.js'

const success = (request: CommandRequest, stdout = '', stderr = ''): CommandResult => ({
  command: request.command,
  args: request.args,
  exitCode: 0,
  stdout,
  stderr
})

const prepareProjectFiles = async (root: string) => {
  const project = makeProject()
  const videoPath = join(root, '映像 & テスト.mp4')
  const imagePath = join(root, '画像.png')
  await Promise.all([writeFile(videoPath, 'video'), writeFile(imagePath, 'image')])
  if (project.media[0]) project.media[0].path = videoPath
  if (project.media[1]) project.media[1].path = imagePath
  return project
}

const validationJson = JSON.stringify({
  format: { duration: '5.000000' },
  streams: [
    { codec_type: 'video', width: 1280, height: 720, duration: '5.000000' },
    { codec_type: 'audio', sample_rate: '48000', channels: 2, duration: '5.000000' }
  ]
})

describe('FFmpeg export service', () => {
  it('reuses static subtitle overlay PNGs by active visual state and keeps authoritative render options', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-subtitle-overlay-cache-'))
    try {
      const project = makeProject()
      const subtitle = project.tracks.find((track) => track.kind === 'subtitle')?.clips[0]
      if (!subtitle || subtitle.kind !== 'subtitle') throw new Error('subtitle fixture missing')
      subtitle.startUs = 0
      subtitle.durationUs = 2_000_000
      subtitle.style = { ...subtitle.style, animation: 'none', animationDurationUs: 0 }
      let renderCalls = 0
      const graphs: string[] = []
      const executor: ProcessExecutor = {
        async run(request) {
          if (request.args.includes('-filter_complex_script')) {
            renderCalls += 1
            const graphPath = request.args[request.args.indexOf('-filter_complex_script') + 1]
            if (!graphPath) throw new Error('Missing subtitle overlay graph')
            graphs.push(await readFile(graphPath, 'utf8'))
            const outputPath = request.args.at(-1)
            if (!outputPath) throw new Error('Missing subtitle overlay output')
            await writeFile(outputPath, `overlay-${renderCalls}`)
          }
          return success(request)
        }
      }
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, { executor, workspaceRoot: join(root, 'workspace') })
      const [first, concurrent] = await Promise.all([
        service.renderSubtitleOverlay(project, 500_000),
        service.renderSubtitleOverlay(project, 500_000)
      ])
      expect(concurrent.framePath).toBe(first.framePath)
      expect(concurrent.subtitleStateFingerprint).toBe(first.subtitleStateFingerprint)
      expect(concurrent.cacheHit).toBe(true)
      expect(concurrent.ffmpegStarted).toBe(false)
      const cacheHit = await service.renderSubtitleOverlay(project, 500_001)
      expect(renderCalls).toBe(1)
      expect(cacheHit.framePath).toBe(first.framePath)
      expect(cacheHit.cacheHit).toBe(true)
      expect(cacheHit.ffmpegStarted).toBe(false)
      expect(graphs[0]).toContain("ass=filename='")
      expect(graphs[0]).toContain('unpremultiply')
      expect(graphs[0]).toContain('alphamerge')
      const changedProject = structuredClone(project)
      const changedSubtitle = changedProject.tracks.find((track) => track.kind === 'subtitle')?.clips[0]
      if (!changedSubtitle || changedSubtitle.kind !== 'subtitle') throw new Error('changed subtitle fixture missing')
      changedSubtitle.style = { ...changedSubtitle.style, color: '#00ff00' }
      const invalidated = await service.renderSubtitleOverlay(changedProject, 500_000)
      expect(renderCalls).toBe(2)
      expect(invalidated.framePath).not.toBe(first.framePath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renders animated subtitles as a static authoritative base image for Fast Preview', async () => {
    const project = makeProject()
    const root = await mkdtemp(join(tmpdir(), 'spectra-subtitle-overlay-animation-test-'))
    const subtitle = project.tracks.find((track) => track.kind === 'subtitle')?.clips[0]
    if (!subtitle || subtitle.kind !== 'subtitle') throw new Error('subtitle fixture missing')
    subtitle.startUs = 0
    subtitle.durationUs = 2_000_000
    subtitle.style = { ...subtitle.style, animation: 'fade', animationDurationUs: 200_000 }
    let ass = ''
    const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
      workspaceRoot: join(root, 'workspace'),
      executor: { run: async (request) => {
        if (request.args.includes('-filter_complex_script')) {
          const graphPath = request.args[request.args.indexOf('-filter_complex_script') + 1]
          if (graphPath) {
            const graph = await readFile(graphPath, 'utf8')
            const assFile = /ass=filename='([^']+)'/u.exec(graph)?.[1]
            if (assFile) ass = await readFile(join(dirname(graphPath), assFile), 'utf8').catch(() => '')
          }
          const outputPath = request.args.at(-1)
          if (outputPath) await writeFile(outputPath, 'overlay')
        }
        return success(request)
      } }
    })
    try {
      await expect(service.renderSubtitleOverlay(project, 500_000, { animationMode: 'base' })).resolves.toMatchObject({ ffmpegStarted: true })
      expect(ass).not.toContain('\\fad')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('bounds the subtitle overlay cache while cycling through 250 visual states', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-subtitle-overlay-100-cues-'))
    try {
      const project = makeProject()
      const subtitle = project.tracks.find((track) => track.kind === 'subtitle')?.clips[0]
      if (!subtitle || subtitle.kind !== 'subtitle') throw new Error('subtitle fixture missing')
      subtitle.startUs = 0
      subtitle.durationUs = 2_000_000
      subtitle.style = { ...subtitle.style, animation: 'none', animationDurationUs: 0 }
      const executor: ProcessExecutor = {
        async run(request) {
          if (request.args.includes('-filter_complex_script')) {
            const outputPath = request.args.at(-1)
            if (!outputPath) throw new Error('Missing subtitle overlay output')
            await writeFile(outputPath, 'overlay')
          }
          return success(request)
        }
      }
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, { executor, workspaceRoot: join(root, 'workspace') })
      for (let index = 0; index < 250; index += 1) {
        const next = structuredClone(project)
        const clip = next.tracks.find((track) => track.kind === 'subtitle')?.clips[0]
        if (!clip || clip.kind !== 'subtitle') throw new Error('subtitle fixture missing')
        clip.style = { ...clip.style, positionX: 10 + index }
        await service.renderSubtitleOverlay(next, 500_000)
      }
      expect(service.subtitleOverlayCacheSize).toBeLessThanOrEqual(240)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 90_000)

  it('reuses a prefetched next cue at the boundary without another FFmpeg render', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-subtitle-overlay-prefetch-'))
    try {
      const project = makeProject()
      const track = project.tracks.find((item) => item.kind === 'subtitle')
      const current = track?.clips.find((clip): clip is SubtitleClip => clip.kind === 'subtitle')
      if (!track || !current) throw new Error('subtitle fixture missing')
      current.style = { ...current.style, animation: 'none', animationDurationUs: 0 }
      const next = structuredClone(current)
      next.id = 'caption-next'
      next.startUs = current.startUs + current.durationUs + 50_000
      next.text = '次の字幕'
      track.clips.push(next)
      let renderCalls = 0
      const executor: ProcessExecutor = {
        async run(request) {
          if (request.args.includes('-filter_complex_script')) {
            renderCalls += 1
            const outputPath = request.args.at(-1)
            if (!outputPath) throw new Error('Missing subtitle overlay output')
            await writeFile(outputPath, `overlay-${renderCalls}`)
          }
          return success(request)
        }
      }
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, { executor, workspaceRoot: join(root, 'workspace') })
      await service.renderSubtitleOverlay(project, current.startUs + 100_000)
      await service.renderSubtitleOverlay(project, next.startUs)
      const boundary = await service.renderSubtitleOverlay(project, next.startUs + 1)
      expect(renderCalls).toBe(2)
      expect(boundary.framePath).toContain('subtitle-overlay')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renders an authoritative single frame and shares bounded cache entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-accurate-frame-'))
    try {
      const project = await prepareProjectFiles(root)
      let renderCalls = 0
      const graphs: string[] = []
      const executor: ProcessExecutor = {
        async run(request) {
          if (request.args.includes('-filter_complex_script')) {
            renderCalls += 1
            const graphPath = request.args[request.args.indexOf('-filter_complex_script') + 1]
            if (!graphPath) throw new Error('Missing accurate frame graph')
            graphs.push(await readFile(graphPath, 'utf8'))
            const outputPath = request.args.at(-1)
            if (!outputPath) throw new Error('Missing accurate frame output')
            await writeFile(outputPath, `frame-${renderCalls}`)
          }
          return success(request)
        }
      }
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
        executor,
        platform: 'win32',
        workspaceRoot: join(root, 'workspaces')
      })

      const first = await service.renderAccurateFrame(project, 100_000)
      const sameFrame = await service.renderAccurateFrame(project, 100_000)
      const sameCanonicalFrame = await service.renderAccurateFrame(project, 100_001)
      expect(renderCalls).toBe(1)
      expect(sameFrame.framePath).toBe(first.framePath)
      expect(sameFrame.projectFingerprint).toBe(first.projectFingerprint)
      expect(sameFrame.cacheHit).toBe(true)
      expect(sameFrame.ffmpegStarted).toBe(false)
      expect(sameCanonicalFrame.framePath).toBe(first.framePath)
      expect(sameCanonicalFrame.requestedTimeUs).toBe(100_001)
      expect(first.frameIndex).toBe(3)
      expect(first.renderedTimeUs).toBe(100_000)
      // Only a few frames are rendered, so the target is an index inside the window (frames 1..3).
      expect(graphs[0]).toContain("select='eq(n\\,2)'")
      expect(graphs[0]).toContain('setpts=PTS+ceil(1*1/30/TB-0.0001)[canvas]')

      const nextFrame = await service.renderAccurateFrame(project, 133_334)
      expect(renderCalls).toBe(2)
      expect(nextFrame.frameIndex).toBe(4)
      expect(nextFrame.framePath).not.toBe(first.framePath)

      const sourcePath = project.media[0]?.path
      if (!sourcePath) throw new Error('Missing fixture source')
      await writeFile(sourcePath, 'changed-source')
      const invalidated = await service.renderAccurateFrame(project, 100_000)
      expect(renderCalls).toBe(3)
      expect(invalidated.framePath).not.toBe(first.framePath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('evicts old accurate frame files and clears the project cache on preview reset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-accurate-frame-eviction-'))
    try {
      const project = await prepareProjectFiles(root)
      const executor: ProcessExecutor = {
        async run(request) {
          if (request.args.includes('-filter_complex_script')) {
            const outputPath = request.args.at(-1)
            if (!outputPath) throw new Error('Missing accurate frame output')
            await writeFile(outputPath, 'frame')
          }
          return success(request)
        }
      }
      const workspaceRoot = join(root, 'workspaces')
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, { executor, platform: 'win32', workspaceRoot })
      for (let index = 0; index < 65; index += 1) await service.renderAccurateFrame(project, index * 33_334)
      const frameDirectory = join(workspaceRoot, 'accurate-preview')
      const beforeReset = (await readdir(frameDirectory)).filter((name) => name.endsWith('.png'))
      expect(beforeReset.length).toBeLessThanOrEqual(64)
      await service.clearAccuratePreviewCache()
      await expect(readdir(frameDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('invalidates an in-flight accurate render without leaving a cache-visible PNG', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-accurate-frame-generation-'))
    try {
      const project = await prepareProjectFiles(root)
      let renderCalls = 0
      let release: () => void = () => undefined
      let startedResolve: (() => void) | undefined
      const started = new Promise<void>((resolve) => { startedResolve = resolve })
      const executor: ProcessExecutor = {
        async run(request) {
          if (request.args.includes('-filter_complex_script')) {
            renderCalls += 1
            startedResolve?.()
            await new Promise<void>((resolve) => { release = resolve })
            const outputPath = request.args.at(-1)
            if (!outputPath) throw new Error('Missing accurate frame output')
            await writeFile(outputPath, 'stale-frame')
          }
          return success(request)
        }
      }
      const workspaceRoot = join(root, 'workspaces')
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, { executor, platform: 'win32', workspaceRoot })
      const pending = service.renderAccurateFrame(project, 100_000)
      await started
      await service.clearAccuratePreviewCache()
      release()
      await expect(pending).rejects.toThrow(/invalidated/u)
      await expect(readdir(join(workspaceRoot, 'accurate-preview'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back from a runtime GPU failure to CPU, validates, and replaces output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-service-'))
    try {
      const project = await prepareProjectFiles(root)
      const outputPath = join(root, '完成.mp4')
      await writeFile(outputPath, 'previous-output')
      const renderEncoders: string[] = []
      const executor: ProcessExecutor = {
        async run(request) {
          if (request.args.includes('-version')) return success(request, 'ffmpeg version 6.1.1-test\n')
          if (request.args.includes('-encoders')) {
            return success(request, ' V....D h264_nvenc NVIDIA\n V....D libx264 CPU\n')
          }
          if (request.command === 'ffprobe') return success(request, validationJson)
          if (request.args.includes('-progress')) {
            const encoder = request.args[request.args.indexOf('-c:v') + 1] ?? 'unknown'
            renderEncoders.push(encoder)
            if (encoder === 'h264_nvenc') {
              throw new CommandExecutionError({ ...success(request, '', 'NVENC session initialization failed'), exitCode: 1 })
            }
            request.onStdout?.('out_time_us=1000000\nprogress=continue\n')
            request.onStdout?.('out_time_us=5000000\nprogress=end\n')
            const temporaryPath = request.args.at(-1)
            if (!temporaryPath) throw new Error('No output argument')
            await writeFile(temporaryPath, 'new-output')
            return success(request)
          }
          return success(request)
        }
      }
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
        executor,
        platform: 'win32',
        workspaceRoot: join(root, 'workspaces')
      })
      const progress: ExportProgress[] = []
      const job = await service.startExport(project, makeExportSettings(outputPath), {
        jobId: 'fallback-job',
        onProgress: (item) => progress.push(item)
      })
      const exported = await job.result

      expect(renderEncoders).toEqual(['h264_nvenc', 'libx264'])
      expect(exported.encoderId).toBe('libx264')
      expect(exported.fallbackReason).toContain('NVENC session initialization failed')
      expect(await readFile(outputPath, 'utf8')).toBe('new-output')
      expect(await readFile(join(root, '完成.srt'), 'utf8')).toContain('日本語')
      expect(progress.map((item) => item.stage)).toContain('fallback')
      expect(progress.at(-1)).toMatchObject({ stage: 'completed', ratio: 1, encoderId: 'libx264' })
      const renderingRatios = progress.filter((item) => item.stage === 'rendering' && item.encoderId === 'libx264').map((item) => item.ratio)
      expect(renderingRatios).toEqual([...renderingRatios].sort((left, right) => left - right))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([true, false])('handles the previous SRT after exporting a project with no subtitles (exportSrt: %s)', async (exportSrt) => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-empty-sidecar-'))
    try {
      const project = await prepareProjectFiles(root)
      project.tracks = project.tracks.filter((track) => track.kind !== 'subtitle')
      const outputPath = join(root, 'output.mp4')
      const sidecarPath = join(root, 'output.srt')
      await Promise.all([writeFile(outputPath, 'old-video'), writeFile(sidecarPath, 'old-subtitles')])
      const executor: ProcessExecutor = {
        async run(request) {
          if (request.args.includes('-version')) return success(request, 'ffmpeg version 6.1.1-test\n')
          if (request.args.includes('-encoders')) return success(request, ' V....D libx264 CPU\n')
          if (request.command === 'ffprobe') return success(request, validationJson)
          if (request.args.includes('-progress')) {
            const partial = request.args.at(-1)
            if (!partial) throw new Error('No output argument')
            await writeFile(partial, 'new-video')
          }
          return success(request)
        }
      }
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
        executor, workspaceRoot: join(root, 'workspaces')
      })
      const job = await service.startExport(project, { ...makeExportSettings(outputPath), encoderMode: 'software', exportSrt })
      await job.result
      expect(await readFile(outputPath, 'utf8')).toBe('new-video')
      expect(await readFile(sidecarPath, 'utf8')).toBe(exportSrt ? '' : 'old-subtitles')
      expect((await readdir(root)).some((name) => name.includes('.backup-') || name.includes('.part-'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves the previous video when the sidecar destination cannot be published', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-sidecar-failure-'))
    try {
      const project = await prepareProjectFiles(root)
      const outputPath = join(root, 'output.mp4')
      await writeFile(outputPath, 'previous-output')
      await mkdir(join(root, 'output.srt'))
      const renderEncoders: string[] = []
      const executor: ProcessExecutor = {
        async run(request) {
          if (request.args.includes('-version')) return success(request, 'ffmpeg version 6.1.1-test\n')
          if (request.args.includes('-encoders')) return success(request, ' V....D h264_nvenc NVIDIA\n V....D libx264 CPU\n')
          if (request.command === 'ffprobe') return success(request, validationJson)
          if (request.args.includes('-progress')) {
            renderEncoders.push(request.args[request.args.indexOf('-c:v') + 1] ?? 'unknown')
            const partial = request.args.at(-1)
            if (!partial) throw new Error('No output argument')
            await writeFile(partial, 'new-output')
          }
          return success(request)
        }
      }
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
        executor, platform: 'win32', workspaceRoot: join(root, 'workspaces')
      })
      const progress: ExportProgress[] = []
      const job = await service.startExport(project, makeExportSettings(outputPath), { onProgress: (item) => progress.push(item) })
      await expect(job.result).rejects.toThrow('Export destination is not a regular file')
      expect(await readFile(outputPath, 'utf8')).toBe('previous-output')
      expect(await readdir(join(root, 'output.srt'))).toEqual([])
      expect(renderEncoders).toEqual(['h264_nvenc'])
      expect(progress.at(-1)?.stage).toBe('failed')
      expect((await readdir(root)).some((name) => name.includes('.backup-') || name.includes('.part-'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['success', 'failure', 'cancel'] as const)('reserves normalized video/SRT paths until %s and permits other outputs', async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-output-reservation-'))
    try {
      const project = await prepareProjectFiles(root)
      const outputPath = join(root, 'output.mp4')
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      let failing = outcome === 'failure'
      const executor: ProcessExecutor = {
        async run(request) {
          if (request.args.includes('-version')) {
            await gate
            return success(request, 'ffmpeg version 6.1.1-test\n')
          }
          if (request.args.includes('-encoders')) return success(request, ' V....D libx264 CPU\n')
          if (request.command === 'ffprobe') return success(request, validationJson)
          if (request.args.includes('-progress')) {
            if (failing) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
            const partial = request.args.at(-1)
            if (!partial) throw new Error('No output argument')
            await writeFile(partial, 'new-output')
          }
          return success(request)
        }
      }
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
        executor, platform: 'win32', workspaceRoot: join(root, 'workspaces')
      })
      const settings = { ...makeExportSettings(outputPath), encoderMode: 'software' as const }
      const first = await service.startExport(project, settings, { jobId: 'reserved' })
      // Both path.resolve aliases and Windows case aliases share the reservation.
      await expect(service.startExport(project, { ...settings, outputPath: join(root, 'unused', '..', 'OUTPUT.MP4') })).rejects.toThrow('already in use')
      await expect(service.writeSrt(project, join(root, 'OUTPUT.SRT'))).rejects.toThrow('already in use')
      const other = await service.startExport(project, { ...settings, outputPath: join(root, 'other.mp4') }, { jobId: 'other' })
      const settled = Promise.allSettled([first.result, other.result])
      if (outcome === 'cancel') service.cancelExport(first.jobId)
      release()
      const results = await settled
      expect(results[0]?.status).toBe(outcome === 'success' ? 'fulfilled' : 'rejected')
      expect(results[1]?.status).toBe(outcome === 'failure' ? 'rejected' : 'fulfilled')
      failing = false
      // Success, render failure and cancellation all release the video and SRT.
      await expect(service.writeSrt(project, join(root, 'output.srt'))).resolves.toBeUndefined()
      const retry = await service.startExport(project, settings, { jobId: 'reserved' })
      await expect(retry.result).resolves.toMatchObject({ outputPath })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a video export while its sidecar is being saved independently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-srt-write-reservation-'))
    try {
      const project = await prepareProjectFiles(root)
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
        platform: 'win32', workspaceRoot: join(root, 'workspaces'),
        executor: { run: async () => { throw new Error('Must not launch FFmpeg') } }
      })
      const saving = service.writeSrt(project, join(root, 'output.srt'))
      await expect(service.startExport(project, makeExportSettings(join(root, 'OUTPUT.MP4')))).rejects.toThrow('already in use')
      await saving
      await expect(service.writeSrt(project, join(root, 'output.srt'))).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reserves the sidecar even when case-sensitive video paths differ by extension case', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-sidecar-reservation-'))
    try {
      const project = await prepareProjectFiles(root)
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
        platform: 'linux', workspaceRoot: join(root, 'workspaces'),
        executor: { run: async (request) => {
          await gate
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        } }
      })
      const first = await service.startExport(project, makeExportSettings(join(root, 'output.mp4')))
      await expect(service.startExport(project, makeExportSettings(join(root, 'output.MP4')))).rejects.toThrow('already in use')
      const settled = first.result.catch(() => undefined)
      release()
      await settled
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cancels the active child process without falling back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-cancel-'))
    try {
      const project = await prepareProjectFiles(root)
      const outputPath = join(root, 'cancelled.mp4')
      let notifyStarted: (() => void) | undefined
      const started = new Promise<void>((resolve) => { notifyStarted = resolve })
      const rendered: string[] = []
      const executor: ProcessExecutor = {
        async run(request) {
          if (request.args.includes('-version')) return success(request, 'ffmpeg version 6.1.1-test\n')
          if (request.args.includes('-encoders')) return success(request, ' V....D libx264 CPU\n')
          if (request.args.includes('-progress')) {
            rendered.push(request.args[request.args.indexOf('-c:v') + 1] ?? 'unknown')
            notifyStarted?.()
            return await new Promise<CommandResult>((resolve, reject) => {
              const abort = (): void => reject(new ProcessCancelledError())
              if (request.signal?.aborted) abort()
              else request.signal?.addEventListener('abort', abort, { once: true })
            })
          }
          return success(request)
        }
      }
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
        executor,
        platform: 'win32',
        workspaceRoot: join(root, 'workspaces')
      })
      const progress: ExportProgress[] = []
      const settings = { ...makeExportSettings(outputPath), encoderMode: 'software' as const }
      const job = await service.startExport(project, settings, {
        jobId: 'cancel-job',
        onProgress: (item) => progress.push(item)
      })
      await started
      expect(service.cancelExport(job.jobId)).toBe(true)
      await expect(job.result).rejects.toBeInstanceOf(ProcessCancelledError)
      expect(rendered).toEqual(['libx264'])
      expect(progress.at(-1)?.stage).toBe('cancelled')
      expect(service.cancelExport(job.jobId)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a diagnosable export workspace when subtitle debug mode is enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-export-debug-'))
    const previous = process.env.SPECTRA_KEEP_EXPORT_DEBUG
    process.env.SPECTRA_KEEP_EXPORT_DEBUG = '1'
    try {
      const project = await prepareProjectFiles(root)
      const outputPath = join(root, 'debug.mp4')
      const executor: ProcessExecutor = {
        async run(request) {
          if (request.args.includes('-version')) return success(request, 'ffmpeg version 6.1.1-test\n')
          if (request.args.includes('-encoders')) return success(request, ' V....D libx264 CPU\n')
          if (request.command === 'ffprobe') return success(request, validationJson)
          if (request.args.includes('-progress')) {
            request.onStdout?.('out_time_us=5000000\nprogress=end\n')
            const temporaryPath = request.args.at(-1)
            if (!temporaryPath) throw new Error('No output argument')
            await writeFile(temporaryPath, 'debug-output')
            return success(request)
          }
          return success(request)
        }
      }
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
        executor,
        platform: 'win32',
        workspaceRoot: join(root, 'workspaces')
      })
      await (await service.startExport(project, { ...makeExportSettings(outputPath), encoderMode: 'software', exportSrt: false }, { jobId: 'debug-artifacts' })).result

      const workspace = join(root, 'workspaces', 'export-debug-artifacts')
      const settings = JSON.parse(await readFile(join(workspace, 'export-settings.json'), 'utf8')) as Record<string, unknown>
      expect(settings).toMatchObject({ burnSubtitles: true, subtitleCueCount: 1, subtitleIds: ['caption-1'], assFilterExpected: true })
      expect(await readFile(join(workspace, 'project-snapshot.json'), 'utf8')).toContain('字幕')
      expect(await readFile(join(workspace, 'captions.ass'), 'utf8')).toContain('Style: Cue0')
      expect(await readFile(join(workspace, 'render.ffgraph'), 'utf8')).toContain("ass=filename='captions.ass'")
    } finally {
      if (previous === undefined) delete process.env.SPECTRA_KEEP_EXPORT_DEBUG
      else process.env.SPECTRA_KEEP_EXPORT_DEBUG = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not retry another encoder for a non-recoverable disk failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-disk-full-'))
    try {
      const project = await prepareProjectFiles(root)
      const rendered: string[] = []
      const executor: ProcessExecutor = {
        async run(request) {
          if (request.args.includes('-version')) return success(request, 'ffmpeg version 6.1.1-test\n')
          if (request.args.includes('-encoders')) return success(request, ' V....D h264_nvenc NVIDIA\n V....D libx264 CPU\n')
          if (request.args.includes('-progress')) {
            rendered.push(request.args[request.args.indexOf('-c:v') + 1] ?? 'unknown')
            throw new CommandExecutionError({ ...success(request, '', 'No space left on device'), exitCode: 1 })
          }
          return success(request)
        }
      }
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
        executor,
        platform: 'win32',
        workspaceRoot: join(root, 'workspaces')
      })
      const job = await service.startExport(project, makeExportSettings(join(root, 'disk-full.mp4')), {
        jobId: 'disk-full'
      })
      await expect(job.result).rejects.toThrow(/No space left/u)
      expect(rendered).toEqual(['h264_nvenc'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('parses chunked progress monotonically and caps it to the project duration', () => {
    const values: number[] = []
    const consume = createFfmpegProgressParser(5_000_000, (value) => values.push(value))
    consume('out_time_us=100')
    consume('0000\nprogress=continue\nout_time_us=500000\n')
    consume('out_time_us=9000000\nprogress=end\n')
    expect(values).toEqual([1_000_000, 1_000_000, 5_000_000, 5_000_000])
  })

  it('rejects attempts to overwrite a source asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-same-file-'))
    try {
      const project = await prepareProjectFiles(root)
      const sourcePath = project.media[0]?.path
      if (!sourcePath) throw new Error('Missing fixture source')
      const service = new FfmpegService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
        executor: { run: async (request) => success(request) },
        platform: 'win32',
        workspaceRoot: join(root, 'workspaces')
      })
      const job = await service.startExport(project, makeExportSettings(sourcePath), { jobId: 'same-file' })
      await expect(job.result).rejects.toThrow(/overwrite an input/u)
      expect(await readFile(sourcePath, 'utf8')).toBe('video')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
