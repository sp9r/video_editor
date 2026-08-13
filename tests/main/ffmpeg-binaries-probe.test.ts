import { describe, expect, it } from 'vitest'
import { resolveFfmpegPaths, toUnpackedAsarPath } from '../../src/main/ffmpeg/binaries.js'
import { parseFfprobeJson, parseRational, validateRenderedOutput } from '../../src/main/ffmpeg/probe.js'
import type { CommandRequest, CommandResult, ProcessExecutor } from '../../src/main/ffmpeg/process.js'

const result = (request: CommandRequest, stdout = ''): CommandResult => ({
  command: request.command,
  args: request.args,
  exitCode: 0,
  stdout,
  stderr: ''
})

describe('FFmpeg binary resolution', () => {
  it('uses explicit/env paths and checks both executables', async () => {
    const checked: string[] = []
    const paths = await resolveFfmpegPaths({
      env: { FFMPEG_PATH: 'C:\\tools\\ffmpeg.exe', FFPROBE_PATH: 'C:\\tools\\ffprobe.exe' },
      accessFile: async (path) => { checked.push(path) }
    })
    expect(paths).toEqual({ ffmpegPath: 'C:\\tools\\ffmpeg.exe', ffprobePath: 'C:\\tools\\ffprobe.exe' })
    expect(checked).toEqual(['C:\\tools\\ffmpeg.exe', 'C:\\tools\\ffprobe.exe'])
  })

  it('rewrites packaged asar paths to electron-builder unpacked paths', () => {
    expect(toUnpackedAsarPath('C:\\app\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe'))
      .toBe('C:\\app\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe')
    expect(toUnpackedAsarPath('/opt/app/resources/app.asar/node_modules/ffmpeg-static/ffmpeg'))
      .toBe('/opt/app/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg')
  })
})

describe('ffprobe parsing and output verification', () => {
  it('parses only positive rational values and rejects invalid JSON shapes', () => {
    expect(parseRational('30000/1001')).toEqual({ numerator: 30_000, denominator: 1_001 })
    expect(parseRational('0/0')).toBeUndefined()
    expect(() => parseFfprobeJson('null')).toThrow(/invalid JSON/u)
  })

  it('validates metadata and decodes the beginning and end frames', async () => {
    const calls: CommandRequest[] = []
    const executor: ProcessExecutor = {
      async run(request) {
        calls.push(request)
        if (request.command === 'ffprobe') {
          return result(request, JSON.stringify({
            format: { duration: '5.000' },
            streams: [
              { codec_type: 'video', width: 1280, height: 720, duration: '5.000' },
              { codec_type: 'audio', sample_rate: '48000', channels: 2, duration: '5.000' }
            ]
          }))
        }
        return result(request)
      }
    }
    const validated = await validateRenderedOutput(
      { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' },
      'video.mp4',
      { durationUs: 5_000_000, width: 1280, height: 720 },
      executor
    )
    expect(validated).toEqual({ durationUs: 5_000_000, width: 1280, height: 720, hasAudio: true })
    expect(calls.filter((call) => call.command === 'ffmpeg')).toHaveLength(2)
    expect(calls.some((call) => call.args.includes('4.500000'))).toBe(true)
  })

  it('rejects a wrong stream layout before accepting a corrupt export', async () => {
    const executor: ProcessExecutor = {
      async run(request) {
        return result(request, JSON.stringify({
          format: { duration: '3.0' },
          streams: [{ codec_type: 'video', width: 640, height: 360 }]
        }))
      }
    }
    await expect(validateRenderedOutput(
      { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' },
      'bad.mp4',
      { durationUs: 5_000_000, width: 1280, height: 720 },
      executor
    )).rejects.toThrow(/size/u)
  })
})
