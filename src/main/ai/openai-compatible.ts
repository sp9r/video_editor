import type {
  AiCapability,
  AiJobRequest,
  AiProviderDescriptor,
  AiProviderKind,
  AiProviderHealth
} from '../../shared/automation.js'
import { SafeHttpAdapter, type SafeHttpAdapterOptions } from './http-adapter.js'
import type { AiProvider, AiProviderExecutionContext } from './provider.js'

export interface OpenAiCompatibleProviderOptions {
  id: string
  displayName: string
  baseUrl: string
  model: string
  apiKey?: string
  kind?: Extract<AiProviderKind, 'openai-compatible' | 'local-llm' | 'codex'>
  local?: boolean
  capabilities?: readonly Extract<AiCapability, 'edit-suggestion' | 'text-generation'>[]
  chatCompletionsPath?: string
  modelsPath?: string
  allowInsecureLoopback?: boolean
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const SYSTEM_PROMPT = `You are an editing assistant. Never return a ProjectFile, source code, shell command, or tool call.
For edit requests return only JSON: {"kind":"edit-proposal","proposal":{"schemaVersion":1,"title":"...","commands":[...]}}.
Allowed command types are insert-subtitle, update-subtitle, delete-clips, move-clip, trim-clip, split-clip, set-transform, and set-audio.
The application validates every field and lets the user preview edits before applying them.`

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`)
  return value as Record<string, unknown>
}

const completionText = (response: unknown): string => {
  const root = record(response, 'OpenAI response')
  const choices = root.choices
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('OpenAI response has no choices')
  const first = record(choices[0], 'OpenAI choice')
  const message = record(first.message, 'OpenAI message')
  if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('OpenAI response has no message content')
  if (message.content.length > 2 * 1024 * 1024) throw new Error('OpenAI response content is too large')
  return message.content.trim()
}

const requestPrompt = (request: AiJobRequest): string => {
  // AiJobRequest contains asset ids and a path-free project summary, never local file paths or API keys.
  return JSON.stringify({ capability: request.capability, input: request.input })
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly descriptor: AiProviderDescriptor
  readonly #http: SafeHttpAdapter
  readonly #model: string
  readonly #chatPath: string
  readonly #modelsPath: string

  constructor(options: OpenAiCompatibleProviderOptions) {
    if (!options.model.trim() || options.model.length > 200) throw new Error('AI model name is invalid')
    const capabilities = options.capabilities ?? ['edit-suggestion', 'text-generation']
    this.descriptor = {
      id: options.id,
      displayName: options.displayName,
      kind: options.kind ?? 'openai-compatible',
      capabilities,
      local: options.local ?? false,
      description: 'OpenAI-compatible chat completions provider'
    }
    const httpOptions: SafeHttpAdapterOptions = {
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      allowInsecureLoopback: options.allowInsecureLoopback,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs
    }
    this.#http = new SafeHttpAdapter(httpOptions)
    this.#model = options.model
    this.#chatPath = options.chatCompletionsPath ?? 'chat/completions'
    this.#modelsPath = options.modelsPath ?? 'models'
  }

  async health(signal?: AbortSignal): Promise<AiProviderHealth> {
    const started = Date.now()
    try {
      await this.#http.requestJson(this.#modelsPath, { signal })
      return {
        providerId: this.descriptor.id,
        status: 'healthy',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started
      }
    } catch (error) {
      return {
        providerId: this.descriptor.id,
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : 'Health check failed'
      }
    }
  }

  async run(request: AiJobRequest, context: AiProviderExecutionContext): Promise<unknown> {
    if (request.capability === 'transcription') throw new Error('Chat completions providers do not transcribe media')
    const response = await this.#http.requestJson(this.#chatPath, {
      method: 'POST',
      signal: context.signal,
      body: {
        model: this.#model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: requestPrompt(request) }
        ],
        ...(request.capability === 'edit-suggestion' ? { response_format: { type: 'json_object' } } : {})
      }
    })
    const content = completionText(response)
    if (request.capability === 'text-generation') return { kind: 'text', text: content }
    try {
      return JSON.parse(content) as unknown
    } catch {
      throw new Error('Edit provider returned non-JSON content')
    }
  }
}

export const createLocalLlmProvider = (
  options: Omit<OpenAiCompatibleProviderOptions, 'kind' | 'local' | 'allowInsecureLoopback'>
): OpenAiCompatibleProvider =>
  new OpenAiCompatibleProvider({
    ...options,
    kind: 'local-llm',
    local: true,
    allowInsecureLoopback: true
  })

export type OpenAICompatibleProviderOptions = OpenAiCompatibleProviderOptions
