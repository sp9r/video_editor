import { mkdtemp, readdir, rm, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ThumbnailService } from '../../src/main/thumbnail-service'
import type { ProcessExecutor } from '../../src/main/ffmpeg/process'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('ThumbnailService', () => {
  const renderExecutor: ProcessExecutor['run'] = async (request) => {
    const output = request.args.at(-1)
    if (request.args.includes('-f') && request.args.includes('image2') && output && output !== '-') await writeFile(output, 'frame')
    return { command: request.command, args: request.args, exitCode: 0, stdout: '', stderr: '' }
  }

  it('extracts six bounded source-time candidates and cleans cache', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'spectra-thumbnail-'))
    roots.push(root)
    const media = path.join(root, '日本語 source.mp4')
    await writeFile(media, 'fixture')
    const args: string[][] = []
    const service = new ThumbnailService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, { cacheRoot: path.join(root, 'cache'), executor: { run: async (request) => { args.push([...request.args]); return renderExecutor(request) } } })
    const candidates = await service.extractCandidates({ mediaPath: media, sourceInUs: 10_000_000, durationUs: 60_000_000 })
    expect(candidates).toHaveLength(6)
    expect(args.filter((item) => item.includes('-ss'))).toHaveLength(6)
    expect(args[0]).toContain('18.571429')
    await service.clearCache()
    await expect(stat(path.join(root, 'cache'))).rejects.toThrow()
  })

  it('can exclude a signalstats-reported near-black frame', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'spectra-thumbnail-black-'))
    roots.push(root)
    const media = path.join(root, 'source.mp4')
    await writeFile(media, 'fixture')
    let invocation = 0
    const service = new ThumbnailService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, { cacheRoot: path.join(root, 'cache'), executor: { run: async (request) => { invocation += 1; const result = await renderExecutor(request); return { ...result, stdout: invocation === 2 ? 'YAVG=0' : '' } } } })
    expect(await service.extractCandidates({ mediaPath: media, sourceInUs: 0, durationUs: 60_000_000 })).toHaveLength(5)
  })

  it('coalesces same-key requests, reuses complete disk cache, and bounds cache directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'spectra-thumbnail-cache-'))
    roots.push(root)
    const media = path.join(root, 'source.mp4')
    await writeFile(media, 'fixture')
    let ffmpegFrames = 0
    const service = new ThumbnailService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, {
      cacheRoot: path.join(root, 'cache'),
      executor: { run: async (request) => { const result = await renderExecutor(request); if (request.args.includes('image2')) ffmpegFrames += 1; return result } }
    })
    const same = await Promise.all(Array.from({ length: 10 }, () => service.extractCandidates({ mediaPath: media, sourceInUs: 0, durationUs: 60_000_000 })))
    expect(same.every((item) => item.length === 6)).toBe(true)
    expect(ffmpegFrames).toBe(6)
    expect((await service.extractCandidates({ mediaPath: media, sourceInUs: 0, durationUs: 60_000_000 })).length).toBe(6)
    expect(ffmpegFrames).toBe(6)
    for (let index = 1; index < 66; index += 1) {
      await service.extractCandidates({ mediaPath: media, sourceInUs: index * 1_000_000, durationUs: 60_000_000 })
    }
    expect((await readdir(path.join(root, 'cache'))).filter((entry) => !entry.startsWith('.'))).toHaveLength(64)
    // 66 cache directories on Windows disk; slow while FFmpeg tests run in parallel.
  }, 60_000)
})
