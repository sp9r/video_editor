import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import type { ExportProgress } from '../../src/shared/types.js'
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
