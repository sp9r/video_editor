import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveFfmpegPaths } from '../../src/main/ffmpeg/binaries.js'
import { executeProcess } from '../../src/main/ffmpeg/process.js'
import { WaveformExtractor, peaksFromFloat32 } from '../../src/main/ffmpeg/waveform.js'
import type { CommandRequest, CommandResult, ProcessExecutor } from '../../src/main/ffmpeg/process.js'

const result = (request: CommandRequest): CommandResult => ({ command: request.command, args: request.args, exitCode: 0, stdout: '', stderr: '' })

const pcm = (values: number[]): Buffer => {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4))
  return bytes
}

describe('bounded FFmpeg waveform extraction', () => {
  it('passes only the requested source interval to FFmpeg', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-waveform-range-'))
    try {
      const mediaPath = join(root, 'source.mp4')
      await writeFile(mediaPath, 'fixture')
      const requests: CommandRequest[] = []
      const executor: ProcessExecutor = { run: async (request) => { requests.push(request); request.onStdoutBytes?.(pcm([0.1, 0.4, 0.2, 0.8])); return result(request) } }
      const extractor = new WaveformExtractor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, executor)
      await extractor.getPeaks({ mediaPath, sourceInUs: 10_000_000, durationUs: 5_000_000, peakCount: 4 })
      const args = requests[0]?.args ?? []
      expect(args).toContain('-ss')
      expect(args).toContain('10.000000')
      expect(args).toContain('-t')
      expect(args).toContain('5.000000')
      expect(args).toContain(mediaPath)
      expect(args).toContain('-f')
      expect(args).toContain('f32le')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('shares in-flight requests and separates source ranges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-waveform-cache-'))
    try {
      const mediaPath = join(root, 'source.mp4')
      await writeFile(mediaPath, 'fixture')
      let calls = 0
      const executor: ProcessExecutor = { run: async (request) => { calls += 1; await Promise.resolve(); request.onStdoutBytes?.(pcm([0.25, 0.5, 0.75, 1])); return result(request) } }
      const extractor = new WaveformExtractor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, executor)
      const first = { mediaPath, sourceInUs: 0, durationUs: 5_000_000, peakCount: 4 }
      const second = { mediaPath, sourceInUs: 10_000_000, durationUs: 5_000_000, peakCount: 4 }
      await Promise.all([extractor.getPeaks(first), extractor.getPeaks(first)])
      await extractor.getPeaks(second)
      expect(calls).toBe(2)
      expect(extractor.cacheSize).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('invalidates a cache entry when the media fingerprint changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-waveform-invalidate-'))
    try {
      const mediaPath = join(root, 'source.mp4')
      await writeFile(mediaPath, 'old')
      let calls = 0
      const executor: ProcessExecutor = { run: async (request) => { calls += 1; request.onStdoutBytes?.(pcm([0.5, 0.5])); return result(request) } }
      const extractor = new WaveformExtractor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, executor)
      const request = { mediaPath, sourceInUs: 0, durationUs: 5_000_000, peakCount: 2 }
      await extractor.getPeaks(request)
      await writeFile(mediaPath, 'new-content-with-a-different-size')
      await utimes(mediaPath, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000))
      await extractor.getPeaks(request)
      expect(calls).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reuses moved clips with the same source range and separates trim/split ranges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-waveform-editing-'))
    try {
      const mediaPath = join(root, 'source.mp4')
      await writeFile(mediaPath, 'fixture')
      let calls = 0
      const executor: ProcessExecutor = { run: async (request) => { calls += 1; request.onStdoutBytes?.(pcm([0.2, 0.6, 0.3, 0.9])); return result(request) } }
      const extractor = new WaveformExtractor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, executor)
      await extractor.getPeaks({ mediaPath, sourceInUs: 0, durationUs: 5_000_000, peakCount: 4 })
      await extractor.getPeaks({ mediaPath, sourceInUs: 0, durationUs: 5_000_000, peakCount: 4 })
      await extractor.getPeaks({ mediaPath, sourceInUs: 1_000_000, durationUs: 4_000_000, peakCount: 4 })
      await extractor.getPeaks({ mediaPath, sourceInUs: 5_000_000, durationUs: 5_000_000, peakCount: 4 })
      expect(calls).toBe(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('produces different peak patterns for deterministic source ranges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-waveform-pattern-'))
    try {
      const mediaPath = join(root, 'source.wav')
      await writeFile(mediaPath, 'fixture')
      const executor: ProcessExecutor = { run: async (request) => {
        const start = request.args[request.args.indexOf('-ss') + 1]
        request.onStdoutBytes?.(pcm(start === '0.000000' ? [0.1, 0.1, 0.1, 0.1] : [0.9, 0.9, 0.9, 0.9]))
        return result(request)
      } }
      const extractor = new WaveformExtractor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, executor)
      const first = await extractor.getPeaks({ mediaPath, sourceInUs: 0, durationUs: 5_000_000, peakCount: 4 })
      const second = await extractor.getPeaks({ mediaPath, sourceInUs: 5_000_000, durationUs: 5_000_000, peakCount: 4 })
      expect(first).not.toEqual(second)
      expect(peaksFromFloat32(pcm([-2, 0.5, 0.1, 0]), 2)[0]).toBe(1)
      expect(peaksFromFloat32(pcm([-2, 0.5, 0.1, 0]), 2)[1]).toBeCloseTo(0.1, 5)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('extracts different bounded peaks from generated low/high amplitude audio', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-waveform-generated-'))
    try {
      const paths = await resolveFfmpegPaths()
      const mediaPath = join(root, 'amplitude.wav')
      await executeProcess({
        command: paths.ffmpegPath,
        args: [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
          '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
          '-filter_complex', '[0:a]volume=0.1[a0];[1:a]volume=0.9[a1];[a0][a1]concat=n=2:v=0:a=1[out]',
          '-map', '[out]', '-c:a', 'pcm_s16le', mediaPath
        ],
        timeoutMs: 30_000
      })
      const extractor = new WaveformExtractor(paths)
      const first = await extractor.getPeaks({ mediaPath, sourceInUs: 0, durationUs: 1_000_000, peakCount: 8 })
      const second = await extractor.getPeaks({ mediaPath, sourceInUs: 1_000_000, durationUs: 1_000_000, peakCount: 8 })
      expect(first.reduce((sum, value) => sum + value, 0) / first.length).toBeLessThan(0.03)
      expect(second.reduce((sum, value) => sum + value, 0) / second.length).toBeGreaterThan(0.08)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not retain a failed request in cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spectra-waveform-failure-'))
    try {
      const mediaPath = join(root, 'source.mp4')
      await writeFile(mediaPath, 'fixture')
      let calls = 0
      const executor: ProcessExecutor = { run: async () => { calls += 1; throw new Error('decode failed') } }
      const extractor = new WaveformExtractor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, executor)
      const request = { mediaPath, sourceInUs: 0, durationUs: 5_000_000, peakCount: 4 }
      await expect(extractor.getPeaks(request)).rejects.toThrow('decode failed')
      await expect(extractor.getPeaks(request)).rejects.toThrow('decode failed')
      expect(calls).toBe(2)
      expect(extractor.cacheSize).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
