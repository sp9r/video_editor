import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { defaultProcessExecutor, type ProcessExecutor } from '../ffmpeg/process.js'
import { validateAiProviderOutput, type TranscriptAiOutput } from '../../shared/automation.js'

const BRIDGE_SCHEMA_VERSION = 'spectra.caption_bridge.v1'
const MAX_RESULT_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000

export interface CaptionBridgeInvocation {
  command: string
  args: readonly string[]
  root: string
  outputPath: string
}

const existingFile = async (candidate: string): Promise<string | null> => {
  try {
    return (await stat(candidate)).isFile() ? candidate : null
  } catch {
    return null
  }
}

export const resolveCaptionBridgeRoot = async (appPath: string): Promise<string> => {
  const candidates = [
    process.env.SPECTRA_CLIP_AUTOMATION_ROOT,
    path.resolve(appPath, '..', 'clip_automation'),
    path.resolve(appPath, 'clip_automation')
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    if (await existingFile(path.join(candidate, 'caption_bridge.py'))) return path.resolve(candidate)
  }
  throw new Error('自動字幕bridgeが見つかりません。SPECTRA_CLIP_AUTOMATION_ROOTを設定してください。')
}

const resolvePython = async (root: string): Promise<string> => {
  const candidates = [
    process.env.SPECTRA_CLIP_AUTOMATION_PYTHON,
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, '.venv', 'bin', 'python')
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    if (await existingFile(candidate)) return candidate
  }
  return process.env.SPECTRA_PYTHON ?? (process.platform === 'win32' ? 'python.exe' : 'python3')
}

export const buildCaptionBridgeInvocation = async (
  appPath: string,
  outputPath: string,
  sourcePath: string
): Promise<CaptionBridgeInvocation> => {
  const root = await resolveCaptionBridgeRoot(appPath)
  const command = await resolvePython(root)
  return {
    command,
    root,
    outputPath,
    args: [
      path.join(root, 'caption_bridge.py'),
      '--source', sourcePath,
      '--output', outputPath,
      '--no-llm'
    ]
  }
}

const readBridgeResult = async (outputPath: string): Promise<TranscriptAiOutput> => {
  const file = await stat(outputPath)
  if (!file.isFile() || file.size <= 0 || file.size > MAX_RESULT_BYTES) throw new Error('自動字幕bridgeの出力サイズが不正です。')
  const parsed: unknown = JSON.parse(await readFile(outputPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('自動字幕bridgeの出力が不正です。')
  const envelope = parsed as Record<string, unknown>
  if (envelope.schema_version !== BRIDGE_SCHEMA_VERSION) throw new Error('自動字幕bridgeのschema versionが未対応です。')
  const { schema_version: _schemaVersion, ...providerOutput } = envelope
  return validateAiProviderOutput(providerOutput, 'transcription') as TranscriptAiOutput
}

export const generateCaptionsForMedia = async ({
  appPath,
  mediaPath,
  signal,
  executor = defaultProcessExecutor,
  timeoutMs = DEFAULT_TIMEOUT_MS
}: {
  appPath: string
  mediaPath: string
  signal?: AbortSignal
  executor?: ProcessExecutor
  timeoutMs?: number
}): Promise<TranscriptAiOutput> => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'spectra-caption-'))
  const outputPath = path.join(workspace, 'caption-result.json')
  try {
    const invocation = await buildCaptionBridgeInvocation(appPath, outputPath, mediaPath)
    await executor.run({
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.root,
      signal,
      timeoutMs,
      maxOutputBytes: 8 * 1024 * 1024
    })
    return await readBridgeResult(outputPath)
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}
