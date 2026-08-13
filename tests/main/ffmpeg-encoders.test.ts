import { describe, expect, it } from 'vitest'
import {
  EncoderDetector,
  buildEncoderOutputArgs,
  parseEncoderNames,
  selectEncoderCandidates
} from '../../src/main/ffmpeg/encoders.js'
import { CommandExecutionError, type CommandRequest, type CommandResult, type ProcessExecutor } from '../../src/main/ffmpeg/process.js'

const result = (request: CommandRequest, stdout = '', stderr = ''): CommandResult => ({
  command: request.command,
  args: request.args,
  exitCode: 0,
  stdout,
  stderr
})

describe('encoder detection', () => {
  it('parses the encoder table without confusing descriptions for names', () => {
    const names = parseEncoderNames(`Encoders:
 V....D libx264              libx264 H.264
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder
 A..... aac                  AAC
`)
    expect([...names]).toEqual(['libx264', 'h264_nvenc', 'aac'])
  })

  it('requires a real one-frame encode, not only a compiled encoder name', async () => {
    const executor: ProcessExecutor = {
      async run(request) {
        if (request.args.includes('-version')) return result(request, 'ffmpeg version 8.0-test\n')
        if (request.args.includes('-encoders')) {
          return result(request, ' V....D h264_nvenc NVIDIA\n V....D h264_qsv Intel\n V....D libx264 CPU\n')
        }
        const encoderIndex = request.args.indexOf('-c:v')
        const encoder = request.args[encoderIndex + 1]
        if (encoder === 'h264_qsv') {
          throw new CommandExecutionError({ ...result(request, '', 'device setup failed'), exitCode: 1 })
        }
        return result(request)
      }
    }
    const detector = new EncoderDetector({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
      executor,
      platform: 'win32'
    })
    const report = await detector.detect()

    expect(report.ffmpegVersion).toBe('8.0-test')
    expect(report.selectedId).toBe('h264_nvenc')
    expect(report.capabilities.find((capability) => capability.id === 'h264_nvenc')?.available).toBe(true)
    expect(report.capabilities.find((capability) => capability.id === 'h264_qsv')).toMatchObject({
      available: false,
      reason: 'device setup failed'
    })
    expect(report.capabilities.find((capability) => capability.id === 'h264_amf')?.reason).toMatch(/not included/u)
  })

  it('orders hardware before CPU and honors a preferred available adapter', () => {
    const report = {
      ffmpegPath: 'ffmpeg',
      ffmpegVersion: '8',
      platform: 'win32',
      checkedAt: 'now',
      selectedId: 'h264_nvenc',
      capabilities: [
        { id: 'h264_nvenc', name: 'NVENC', codec: 'h264' as const, vendor: 'nvidia' as const, hardware: true, available: true },
        { id: 'h264_qsv', name: 'QSV', codec: 'h264' as const, vendor: 'intel' as const, hardware: true, available: true },
        { id: 'libx264', name: 'CPU', codec: 'h264' as const, vendor: 'cpu' as const, hardware: false, available: true }
      ]
    }
    expect(selectEncoderCandidates(report, 'auto', 'h264_qsv')).toEqual(['h264_qsv', 'h264_nvenc', 'libx264'])
    expect(selectEncoderCandidates(report, 'software')).toEqual(['libx264'])
  })

  it('keeps private quality flags inside each encoder adapter', () => {
    expect(buildEncoderOutputArgs('h264_nvenc', 8_000_000)).toContain('p5')
    expect(buildEncoderOutputArgs('h264_qsv', 8_000_000)).toContain('medium')
    expect(buildEncoderOutputArgs('h264_amf', 8_000_000)).toContain('quality')
    expect(buildEncoderOutputArgs('libx264', 8_000_000)).toEqual(['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'])
  })
})
