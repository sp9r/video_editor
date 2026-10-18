import { mkdtemp, lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportPublishError, publishExportOutputs } from '../../src/main/ffmpeg/export-publish.js'

describe('export output publication', () => {
  let root: string
  let paths: { temporaryPath: string; outputPath: string; temporarySrtPath: string; sidecarPath: string }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'spectra-publish-'))
    paths = { temporaryPath: join(root, '.partial.mp4'), outputPath: join(root, 'output.mp4'), temporarySrtPath: join(root, '.partial.srt'), sidecarPath: join(root, 'output.srt') }
    await Promise.all([writeFile(paths.temporaryPath, 'new-video'), writeFile(paths.temporarySrtPath, 'new-subtitles')])
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it.each([false, true])('publishes both files and removes backups (previous output: %s)', async (existing) => {
    if (existing) await Promise.all([writeFile(paths.outputPath, 'old-video'), writeFile(paths.sidecarPath, 'old-subtitles')])
    await publishExportOutputs(paths)
    expect(await readFile(paths.outputPath, 'utf8')).toBe('new-video')
    expect(await readFile(paths.sidecarPath, 'utf8')).toBe('new-subtitles')
    expect(await readdir(root)).toEqual(['output.mp4', 'output.srt'])
  })

  it.each([1, 2, 3, 4])('restores both existing outputs when rename %s fails', async (failedCall) => {
    await Promise.all([writeFile(paths.outputPath, 'old-video'), writeFile(paths.sidecarPath, 'old-subtitles')])
    let calls = 0
    const renameWithFailure: typeof rename = async (source, destination) => {
      if (++calls === failedCall) throw new Error('injected rename failure')
      await rename(source, destination)
    }
    await expect(publishExportOutputs(paths, { lstat, rename: renameWithFailure, rm })).rejects.toThrow('injected rename failure')
    expect(await readFile(paths.outputPath, 'utf8')).toBe('old-video')
    expect(await readFile(paths.sidecarPath, 'utf8')).toBe('old-subtitles')
    expect((await readdir(root)).filter((name) => name.includes('.backup-'))).toEqual([])
  })

  it.each([[false, false], [false, true], [true, false]])('restores original absence after sidecar publish failure (video: %s, subtitles: %s)', async (videoExists, subtitlesExist) => {
    if (videoExists) await writeFile(paths.outputPath, 'old-video')
    if (subtitlesExist) await writeFile(paths.sidecarPath, 'old-subtitles')
    const renameWithFailure: typeof rename = async (source, destination) => {
      if (source === paths.temporarySrtPath) throw new Error('sidecar publish failed')
      await rename(source, destination)
    }
    await expect(publishExportOutputs(paths, { lstat, rename: renameWithFailure, rm })).rejects.toThrow('sidecar publish failed')
    if (videoExists) expect(await readFile(paths.outputPath, 'utf8')).toBe('old-video')
    else await expect(lstat(paths.outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    if (subtitlesExist) expect(await readFile(paths.sidecarPath, 'utf8')).toBe('old-subtitles')
    else await expect(lstat(paths.sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports a rollback failure with the retained backup location and continues restoring the other file', async () => {
    await Promise.all([writeFile(paths.outputPath, 'old-video'), writeFile(paths.sidecarPath, 'old-subtitles')])
    const renameWithFailure: typeof rename = async (source, destination) => {
      if (source === paths.temporarySrtPath) throw new Error('publish denied')
      if (String(source).startsWith(`${paths.sidecarPath}.backup-`)) throw new Error('restore denied')
      await rename(source, destination)
    }
    const error = await publishExportOutputs(paths, { lstat, rename: renameWithFailure, rm }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ExportPublishError)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
    expect((error as Error).message).toContain(`${paths.sidecarPath}.backup-`)
    expect((error as Error).message).toContain('restore denied')
    expect(await readFile(paths.outputPath, 'utf8')).toBe('old-video')
    const backup = (await readdir(root)).find((name) => name.startsWith('output.srt.backup-'))
    expect(backup).toBeDefined()
    expect(await readFile(join(root, backup!), 'utf8')).toBe('old-subtitles')
  })

  it('keeps the old video backup when removing a newly published video fails during rollback', async () => {
    await Promise.all([writeFile(paths.outputPath, 'old-video'), writeFile(paths.sidecarPath, 'old-subtitles')])
    const renameWithFailure: typeof rename = async (source, destination) => {
      if (source === paths.temporarySrtPath) throw new Error('publish denied')
      await rename(source, destination)
    }
    const removeWithFailure: typeof rm = async (path, options) => {
      if (path === paths.outputPath) throw new Error('remove denied')
      await rm(path, options)
    }
    await expect(publishExportOutputs(paths, { lstat, rename: renameWithFailure, rm: removeWithFailure })).rejects.toThrow('rollback failed')
    expect(await readFile(paths.outputPath, 'utf8')).toBe('new-video')
    expect(await readFile(paths.sidecarPath, 'utf8')).toBe('old-subtitles')
    const backup = (await readdir(root)).find((name) => name.startsWith('output.mp4.backup-'))
    expect(backup).toBeDefined()
    expect(await readFile(join(root, backup!), 'utf8')).toBe('old-video')
  })

  it.each(['temporarySrtPath', 'sidecarPath'] as const)('rejects a one-sided %s before modifying files', async (missing) => {
    const incomplete: Partial<typeof paths> = { ...paths }
    delete incomplete[missing]
    const fileSystem = { lstat: vi.fn(lstat), rename: vi.fn(rename), rm: vi.fn(rm) }
    await expect(publishExportOutputs(incomplete as typeof paths, fileSystem)).rejects.toThrow('must be provided together')
    expect(fileSystem.rename).not.toHaveBeenCalled()
    expect(fileSystem.lstat).not.toHaveBeenCalled()
  })

  it('does not rollback committed outputs after backup cleanup fails', async () => {
    await Promise.all([writeFile(paths.outputPath, 'old-video'), writeFile(paths.sidecarPath, 'old-subtitles')])
    const removeWithFailure: typeof rm = async (path, options) => {
      if (String(path).startsWith(`${paths.sidecarPath}.backup-`)) throw new Error('cleanup denied')
      await rm(path, options)
    }
    await publishExportOutputs(paths, { lstat, rename, rm: removeWithFailure })
    expect(await readFile(paths.outputPath, 'utf8')).toBe('new-video')
    expect(await readFile(paths.sidecarPath, 'utf8')).toBe('new-subtitles')
  })

  it('publishes a video without a sidecar', async () => {
    await writeFile(paths.outputPath, 'old-video')
    await publishExportOutputs({ temporaryPath: paths.temporaryPath, outputPath: paths.outputPath })
    expect(await readFile(paths.outputPath, 'utf8')).toBe('new-video')
    await expect(lstat(paths.sidecarPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
