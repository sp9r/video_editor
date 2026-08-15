import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const WORKER_SCRIPT = 'spectra_caption_worker.py'
const PARALLEL_WORKER_SCRIPT = 'spectra_auto_processing_worker.py'

export interface AutoCaptionWorkerSettings {
  workerRoot?: string
  pythonPath?: string
}

export interface AutoCaptionWorkerDiscovery {
  root: string
  scriptPath: string
  command: string
  parallel?: boolean
}

export class AutoCaptionWorkerUnavailableError extends Error {
  constructor() {
    super('自動字幕エンジンを利用できません。workerの設定と実行環境を確認してください。')
    this.name = 'AutoCaptionWorkerUnavailableError'
  }
}

const existingFile = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isFile()
  } catch {
    return false
  }
}

const validSetting = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 32_000

export const loadAutoCaptionWorkerSettings = async (userDataPath: string): Promise<AutoCaptionWorkerSettings> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(userDataPath, 'auto-caption-worker.json'), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const record = parsed as Record<string, unknown>
    return {
      ...(validSetting(record.workerRoot) ? { workerRoot: record.workerRoot } : {}),
      ...(validSetting(record.pythonPath) ? { pythonPath: record.pythonPath } : {})
    }
  } catch {
    return {}
  }
}

const commandExists = async (candidate: string, environment: NodeJS.ProcessEnv): Promise<boolean> => {
  if (path.isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\')) return existingFile(candidate)
  const pathEntries = (environment.PATH ?? '').split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const entry of pathEntries) {
    for (const extension of extensions) if (await existingFile(path.join(entry, `${candidate}${extension}`))) return true
  }
  return false
}

const resolvePython = async (root: string, settings: AutoCaptionWorkerSettings, environment: NodeJS.ProcessEnv): Promise<string> => {
  const candidates = [
    settings.pythonPath,
    environment.SPECTRA_AUTO_CAPTION_PYTHON,
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, '.venv', 'bin', 'python'),
    environment.SPECTRA_PYTHON,
    process.platform === 'win32' ? 'python.exe' : 'python3'
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    if (await commandExists(candidate, environment)) return candidate
  }
  throw new AutoCaptionWorkerUnavailableError()
}

export const discoverAutoCaptionWorker = async ({
  appPath,
  userDataPath,
  settings = {},
  environment = process.env
}: {
  appPath: string
  userDataPath: string
  settings?: AutoCaptionWorkerSettings
  environment?: NodeJS.ProcessEnv
}): Promise<AutoCaptionWorkerDiscovery> => {
  const fileSettings = await loadAutoCaptionWorkerSettings(userDataPath)
  const mergedSettings: AutoCaptionWorkerSettings = { ...fileSettings, ...settings }
  const roots = [
    mergedSettings.workerRoot,
    environment.SPECTRA_AUTO_CAPTION_WORKER_ROOT,
    environment.SPECTRA_CLIP_AUTOMATION_ROOT,
    path.resolve(appPath, '..', 'clip_automation'),
    path.resolve(appPath, 'clip_automation')
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const root of roots) {
    const resolvedRoot = path.resolve(root)
    const parallelScriptPath = path.join(resolvedRoot, PARALLEL_WORKER_SCRIPT)
    const captionScriptPath = path.join(resolvedRoot, WORKER_SCRIPT)
    const parallel = await existingFile(parallelScriptPath)
    const scriptPath = parallel ? parallelScriptPath : captionScriptPath
    if (!parallel && !(await existingFile(captionScriptPath))) continue
    const command = await resolvePython(resolvedRoot, mergedSettings, environment)
    return { root: resolvedRoot, scriptPath, command, ...(parallel ? { parallel: true } : {}) }
  }
  throw new AutoCaptionWorkerUnavailableError()
}
