import type {
  AiCapability,
  AiJobRequest,
  AiProviderDescriptor,
  AiProviderHealth,
  AiProviderOutput
} from '../../shared/automation.js'

export interface AiJobProgress {
  jobId: string
  ratio: number
  message: string
}

export interface AiProviderExecutionContext {
  signal: AbortSignal
  /** Resolve only the asset selected in the job. Providers should not receive a whole ProjectFile. */
  resolveMediaPath?: (assetId: string) => Promise<string>
  reportProgress?: (progress: AiJobProgress) => void
}

/**
 * Implementations may wrap Whisper, a local model, an OpenAI-compatible API,
 * Codex, or a test double. The result remains unknown until the registry has
 * passed it through the shared runtime validator.
 */
export interface AiProvider {
  readonly descriptor: AiProviderDescriptor
  health(signal?: AbortSignal): Promise<AiProviderHealth>
  run(request: AiJobRequest, context: AiProviderExecutionContext): Promise<unknown>
}

export interface AiJobResult {
  jobId: string
  providerId: string
  capability: AiCapability
  output: AiProviderOutput
  startedAt: string
  completedAt: string
  durationMs: number
}

export interface RunAiJobOptions {
  providerId?: string
  signal?: AbortSignal
  resolveMediaPath?: (assetId: string) => Promise<string>
  onProgress?: (progress: AiJobProgress) => void
}

// Uppercase aliases keep integration ergonomic for codebases that use AI as an initialism.
export type AIProvider = AiProvider
export type AIJobResult = AiJobResult
