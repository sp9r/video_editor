import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addClipToTrack, createClipForAsset, createEmptyProject } from '../../src/shared/project'
import { loadAutoCaptionBaselines } from '../../src/main/ai/auto-caption-baseline'
import { AutoCaptionService } from '../../src/main/ai/auto-caption-service'
import { discoverAutoCaptionWorker } from '../../src/main/ai/worker-discovery'
import type { CommandRequest, CommandResult } from '../../src/main/ffmpeg/process'
import type { AutoCaptionResult } from '../../src/shared/auto-caption-contract'
import type { MediaAsset } from '../../src/shared/types'

const temporaryDirectories: string[] = []

const makeTemp = async (name: string): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), `${name}-`))
  temporaryDirectories.push(directory)
  return directory
}

const makeProject = (mediaPath: string, kind: 'video' | 'audio' = 'video', hasAudio = true) => {
  const asset: MediaAsset = {
    id: 'asset-1', name: '日本語 source file.mp4', path: mediaPath, kind, durationUs: 40_000_000,
    width: kind === 'video' ? 640 : undefined, height: kind === 'video' ? 360 : undefined,
    hasAudio, fileSize: 1, modifiedAt: '2026-08-15T00:00:00.000Z', offline: false
  }
  const base = createEmptyProject('worker test')
  const clip = { ...createClipForAsset(asset, 10_000_000), id: 'clip-1', sourceInUs: 20_000_000, durationUs: 10_000_000 }
  return { project: addClipToTrack({ ...base, media: [asset] }, base.tracks[0]!.id, clip), clip }
}

const resultFor = (jobId: string, unsafeDiagnostic = false): AutoCaptionResult => ({
  version: 'spectra.auto-caption.result.v1', jobId, sourceStartUs: 20_000_000, sourceEndUs: 30_000_000,
  language: 'ja', provider: 'faster-whisper+caption.py', model: 'test',
  rawWords: [{ id: 'source-word:0', text: 'テスト', startUs: 25_000_000, endUs: 26_000_000 }],
  captions: [{ id: 'caption:0', text: 'テスト', sourceWordIds: ['source-word:0'], startUs: 25_000_000, endUs: 26_000_000, textStatus: 'as_transcribed', provenance: 'caption_algorithm' }],
  diagnostics: [{ level: 'info', code: 'NO_FINE_ACOUSTIC_ALIGNMENT', message: unsafeDiagnostic ? 'C:\\Users\\secret\\worker.log' : 'not available' }],
  fallback: { used: false }
})

const discovery = (root: string) => ({ root, scriptPath: path.join(root, 'spectra_caption_worker.py'), command: 'fake-python' })

const fakeExecutor = (mode: 'success' | 'malformed' | 'oversized' | 'timeout' | 'nonzero' | 'cancel' | 'unsafe', observed?: { request?: Record<string, unknown>; args?: readonly string[] }) => async (request: CommandRequest): Promise<CommandResult> => {
  const requestPath = request.args[request.args.indexOf('--request') + 1]
  const outputPath = request.args[request.args.indexOf('--output') + 1]
  if (!requestPath || !outputPath) throw new Error('missing worker paths')
  const requestPayload = JSON.parse(await readFile(requestPath, 'utf8')) as { jobId: string }
  if (observed) {
    observed.request = requestPayload
    observed.args = request.args
  }
  if (mode === 'success' || mode === 'unsafe') {
    await writeFile(outputPath, JSON.stringify(resultFor(requestPayload.jobId, mode === 'unsafe')), 'utf8')
    request.onStdout?.([
      { state: 'preparing', ratio: 0, message: '準備中' },
      { state: 'transcribing', ratio: 0.5, message: '文字起こし中' },
      { state: 'segmenting', ratio: 0.8, message: '字幕分割中' }
    ].map((event) => JSON.stringify({ version: 'spectra.auto-caption.progress.v1', jobId: requestPayload.jobId, ...event })).join('\n') + '\n')
  } else if (mode === 'malformed') {
    await writeFile(outputPath, '{bad json', 'utf8')
  } else if (mode === 'oversized') {
    request.onStdout?.('x'.repeat(8 * 1024 * 1024 + 1))
  } else if (mode === 'timeout') {
    throw new Error('Command timed out after 10 ms')
  } else if (mode === 'nonzero') {
    throw new Error('Command failed (1): C:\\Users\\secret\\worker.py')
  } else if (mode === 'cancel') {
    await new Promise<void>((_resolve, reject) => {
      if (request.signal?.aborted) {
        reject(new Error('Process was cancelled'))
        return
      }
      request.signal?.addEventListener('abort', () => reject(new Error('Process was cancelled')), { once: true })
    })
  }
  return { command: request.command, args: request.args, exitCode: 0, stdout: '', stderr: '' }
}

const runUntilTerminal = async (service: AutoCaptionService, project: ReturnType<typeof makeProject>['project']) => {
  const events: any[] = []
  let resolveTerminal: ((event: any) => void) | undefined
  const terminal = new Promise<any>((resolve) => { resolveTerminal = resolve })
  const started = await service.start({ project, selectedClipIds: ['clip-1'], onProgress: (event) => {
    events.push(event)
    if (event.state === 'completed' || event.state === 'failed') resolveTerminal?.(event)
  } })
  return { started, events, terminal }
}

describe('auto-caption worker discovery and service', () => {
  afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
  })

  it('discovers a Japanese/space worker root from an explicit local setting', async () => {
    const rootBase = await makeTemp('日本語 worker root')
    const root = path.join(rootBase, 'worker with spaces')
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'spectra_caption_worker.py'), 'fixture', 'utf8')
    const pythonPath = path.join(root, 'python-fixture.exe')
    await writeFile(pythonPath, 'fixture', 'utf8')
    const found = await discoverAutoCaptionWorker({ appPath: rootBase, userDataPath: rootBase, settings: { workerRoot: root, pythonPath } })
    expect(found.root).toBe(path.resolve(root))
    expect(found.command).toBe(pythonPath)
    expect(found.scriptPath).toContain('worker with spaces')
  })

  it('uses environment discovery before sibling discovery', async () => {
    const base = await makeTemp('discovery-priority')
    const envRoot = path.join(base, 'env-worker')
    await mkdir(envRoot, { recursive: true })
    await writeFile(path.join(envRoot, 'spectra_caption_worker.py'), 'fixture', 'utf8')
    const envPython = path.join(envRoot, 'python.exe')
    await writeFile(envPython, 'fixture', 'utf8')
    const found = await discoverAutoCaptionWorker({
      appPath: path.join(base, 'video_editor'), userDataPath: base,
      environment: { PATH: '', SPECTRA_AUTO_CAPTION_WORKER_ROOT: envRoot, SPECTRA_AUTO_CAPTION_PYTHON: envPython }
    })
    expect(found.root).toBe(path.resolve(envRoot))
  })

  it('discovers the worker from the sibling clip_automation directory as a development fallback', async () => {
    const base = await makeTemp('sibling-discovery')
    const appPath = path.join(base, 'video_editor')
    const sibling = path.join(base, 'clip_automation')
    const venv = path.join(sibling, '.venv', 'Scripts')
    await mkdir(venv, { recursive: true })
    await writeFile(path.join(sibling, 'spectra_caption_worker.py'), 'fixture', 'utf8')
    await writeFile(path.join(venv, 'python.exe'), 'fixture', 'utf8')
    const found = await discoverAutoCaptionWorker({ appPath, userDataPath: base, environment: { PATH: '' } })
    expect(found.root).toBe(path.resolve(sibling))
  })

  it('reports unavailable without leaking the worker path', async () => {
    const root = await makeTemp('missing-worker')
    const service = new AutoCaptionService({ appPath: root, userDataPath: root, discover: async () => { throw new Error('internal path C:\\Users\\secret') } })
    const health = await service.health()
    expect(health.available).toBe(false)
    expect(health.reason).not.toContain('C:\\Users')
  })

  it('rejects no selection, multiple selection, and silent assets before spawning', async () => {
    const root = await makeTemp('selection')
    const media = path.join(root, 'source.mp4')
    await writeFile(media, 'fixture', 'utf8')
    const fixture = makeProject(media)
    const service = new AutoCaptionService({ appPath: root, userDataPath: root, discover: async () => discovery(root) })
    await expect(service.start({ project: fixture.project, selectedClipIds: [], onProgress: () => undefined })).rejects.toThrow(/1つ/)
    await expect(service.start({ project: fixture.project, selectedClipIds: ['clip-1', 'clip-1'], onProgress: () => undefined })).rejects.toThrow(/1つ/)
    const silent = makeProject(media, 'video', false)
    await expect(service.start({ project: silent.project, selectedClipIds: ['clip-1'], onProgress: () => undefined })).rejects.toThrow(/音声/)
  })

  it('uses the selected source range, validates progress/result, saves a path-free baseline, and loads it safely', async () => {
    const root = await makeTemp('success')
    const media = path.join(root, '日本語 source.mp4')
    await writeFile(media, 'generated fixture', 'utf8')
    const fixture = makeProject(media)
    const observed: { request?: Record<string, unknown>; args?: readonly string[] } = {}
    const service = new AutoCaptionService({ appPath: root, userDataPath: root, executor: { run: fakeExecutor('success', observed) }, discover: async () => discovery(root) })
    const run = await runUntilTerminal(service, fixture.project)
    const terminal = await run.terminal
    expect(run.started.clipId).toBe('clip-1')
    expect(observed.request).toMatchObject({ sourceStartUs: 20_000_000, sourceEndUs: 30_000_000, mediaPath: media, maxChars: 32, maxLines: 2 })
    expect(observed.args).toContain('--request')
    expect(run.events.map((event) => event.state)).toEqual(['preparing', 'transcribing', 'segmenting', 'completed'])
    expect(terminal.result.sourceStartUs).toBe(20_000_000)
    expect(terminal.result.rawWords[0].startUs).toBe(25_000_000)
    const loaded = await loadAutoCaptionBaselines(root)
    expect(loaded.records).toHaveLength(1)
    expect(loaded.records[0]?.settings).toMatchObject({ maxChars: 32, maxLines: 2 })
    expect(JSON.stringify(loaded.records[0])).not.toContain('mediaPath')
    await writeFile(path.join(root, 'experimental.auto-caption-baseline.v1', 'malformed.json'), '{bad json', 'utf8')
    expect((await loadAutoCaptionBaselines(root)).malformedCount).toBe(1)
  })

  it.each([
    ['malformed', 'MALFORMED_OUTPUT'], ['oversized', 'MALFORMED_OUTPUT'], ['timeout', 'TIMEOUT'], ['nonzero', 'WORKER_FAILED']
  ] as const)('turns %s into a safe terminal failure', async (mode, errorCode) => {
    const root = await makeTemp(`failure-${mode}`)
    const media = path.join(root, 'source.mp4')
    await writeFile(media, 'fixture', 'utf8')
    const fixture = makeProject(media)
    const service = new AutoCaptionService({ appPath: root, userDataPath: root, executor: { run: fakeExecutor(mode) }, discover: async () => discovery(root) })
    const run = await runUntilTerminal(service, fixture.project)
    const terminal = await run.terminal
    expect(terminal.errorCode).toBe(errorCode)
    expect(JSON.stringify(terminal)).not.toContain('C:\\Users\\secret')
  })

  it('cancels an active worker and rejects unsafe diagnostic text without leaking it', async () => {
    const root = await makeTemp('cancel')
    const media = path.join(root, 'source.mp4')
    await writeFile(media, 'fixture', 'utf8')
    const fixture = makeProject(media)
    const cancelService = new AutoCaptionService({ appPath: root, userDataPath: root, executor: { run: fakeExecutor('cancel') }, discover: async () => discovery(root) })
    const cancelRun = await runUntilTerminal(cancelService, fixture.project)
    expect(cancelService.cancel(cancelRun.started.jobId)).toBe(true)
    expect((await cancelRun.terminal).errorCode).toBe('CANCELLED')

    const unsafeService = new AutoCaptionService({ appPath: root, userDataPath: root, executor: { run: fakeExecutor('unsafe') }, discover: async () => discovery(root) })
    const unsafeRun = await runUntilTerminal(unsafeService, fixture.project)
    const unsafeTerminal = await unsafeRun.terminal
    expect(unsafeTerminal.state).toBe('failed')
    expect(JSON.stringify(unsafeTerminal)).not.toContain('C:\\Users\\secret')
  })
})
