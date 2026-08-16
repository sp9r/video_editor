import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ThumbnailService } from '../../src/main/thumbnail-service'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('ThumbnailService', () => {
  it('extracts six bounded source-time candidates and cleans cache', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'spectra-thumbnail-'))
    roots.push(root)
    const media = path.join(root, '日本語 source.mp4')
    await writeFile(media, 'fixture')
    const args: string[][] = []
    const service = new ThumbnailService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, { cacheRoot: path.join(root, 'cache'), executor: { run: async (request) => { args.push([...request.args]); return { command: request.command, args: request.args, exitCode: 0, stdout: '', stderr: '' } } } })
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
    const service = new ThumbnailService({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }, { cacheRoot: path.join(root, 'cache'), executor: { run: async (request) => { invocation += 1; return { command: request.command, args: request.args, exitCode: 0, stdout: invocation === 2 ? 'YAVG=0' : '', stderr: '' } } } })
    expect(await service.extractCandidates({ mediaPath: media, sourceInUs: 0, durationUs: 60_000_000 })).toHaveLength(5)
  })
})
