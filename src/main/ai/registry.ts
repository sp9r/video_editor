import {
  validateAiJobRequest,
  validateAiProviderOutput,
  type AiCapability,
  type AiJobRequest,
  type AiProviderDescriptor,
  type AiProviderHealth
} from '../../shared/automation.js'
import type { AiJobResult, AiProvider, RunAiJobOptions } from './provider.js'

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CAPABILITIES = new Set<AiCapability>(['transcription', 'edit-suggestion', 'text-generation'])

const clone = <T>(value: T): T => structuredClone(value)

const assertDescriptor = (descriptor: AiProviderDescriptor): void => {
  if (!descriptor || !PROVIDER_ID_PATTERN.test(descriptor.id)) throw new Error('Provider has an invalid id')
  if (!descriptor.displayName.trim() || descriptor.displayName.length > 200) throw new Error('Provider has an invalid display name')
  if (!Array.isArray(descriptor.capabilities) || descriptor.capabilities.length === 0) {
    throw new Error('Provider must declare at least one capability')
  }
  const unique = new Set(descriptor.capabilities)
  if (unique.size !== descriptor.capabilities.length || [...unique].some((item) => !CAPABILITIES.has(item))) {
    throw new Error('Provider declares invalid or duplicate capabilities')
  }
}

const unavailableHealth = (providerId: string, error: unknown, startedAt: number): AiProviderHealth => ({
  providerId,
  status: 'unavailable',
  checkedAt: new Date().toISOString(),
  latencyMs: Math.max(0, Date.now() - startedAt),
  message: error instanceof Error ? error.message : 'Provider health check failed'
})

export class AiProviderRegistry {
  readonly #providers = new Map<string, AiProvider>()
  readonly #activeJobs = new Map<string, { controller: AbortController; providerId: string }>()

  register(provider: AiProvider, options: { replace?: boolean } = {}): void {
    assertDescriptor(provider.descriptor)
    if (typeof provider.health !== 'function' || typeof provider.run !== 'function') throw new Error('Provider is incomplete')
    if (this.#providers.has(provider.descriptor.id) && options.replace !== true) {
      throw new Error(`AI provider is already registered: ${provider.descriptor.id}`)
    }
    this.#providers.set(provider.descriptor.id, provider)
  }

  unregister(providerId: string): boolean {
    if ([...this.#activeJobs.values()].some((job) => job.providerId === providerId)) {
      throw new Error(`Cannot unregister provider with an active job: ${providerId}`)
    }
    return this.#providers.delete(providerId)
  }

  get(providerId: string): AiProvider | undefined {
    return this.#providers.get(providerId)
  }

  list(capability?: AiCapability): AiProviderDescriptor[] {
    return [...this.#providers.values()]
      .filter((provider) => capability === undefined || provider.descriptor.capabilities.includes(capability))
      .map((provider) => clone(provider.descriptor))
  }

  async health(providerId: string, signal?: AbortSignal): Promise<AiProviderHealth> {
    const provider = this.#providers.get(providerId)
    if (!provider) throw new Error(`AI provider is not registered: ${providerId}`)
    const startedAt = Date.now()
    try {
      const result = await provider.health(signal)
      if (result.providerId !== providerId) throw new Error('Provider returned health for a different id')
      return clone(result)
    } catch (error) {
      return unavailableHealth(providerId, error, startedAt)
    }
  }

  async healthAll(signal?: AbortSignal): Promise<AiProviderHealth[]> {
    return Promise.all([...this.#providers.keys()].map((providerId) => this.health(providerId, signal)))
  }

  async run(request: AiJobRequest, options: RunAiJobOptions = {}): Promise<AiJobResult> {
    const validatedRequest = validateAiJobRequest(request)
    if (this.#activeJobs.has(validatedRequest.jobId)) throw new Error(`AI job is already active: ${validatedRequest.jobId}`)
    const providerId = options.providerId ?? validatedRequest.providerId
    const provider = providerId
      ? this.#providers.get(providerId)
      : [...this.#providers.values()].find((candidate) => candidate.descriptor.capabilities.includes(validatedRequest.capability))
    if (!provider) throw new Error(providerId ? `AI provider is not registered: ${providerId}` : `No provider supports ${validatedRequest.capability}`)
    if (!provider.descriptor.capabilities.includes(validatedRequest.capability)) {
      throw new Error(`${provider.descriptor.id} does not support ${validatedRequest.capability}`)
    }

    const controller = new AbortController()
    const relayAbort = (): void => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) relayAbort()
    else options.signal?.addEventListener('abort', relayAbort, { once: true })
    this.#activeJobs.set(validatedRequest.jobId, { controller, providerId: provider.descriptor.id })
    const started = Date.now()
    const startedAt = new Date(started).toISOString()
    try {
      const rawOutput = await provider.run(clone(validatedRequest), {
        signal: controller.signal,
        resolveMediaPath: options.resolveMediaPath,
        reportProgress: options.onProgress
      })
      if (controller.signal.aborted) throw new DOMException('AI job was cancelled', 'AbortError')
      const output = validateAiProviderOutput(rawOutput, validatedRequest.capability)
      const completed = Date.now()
      return {
        jobId: validatedRequest.jobId,
        providerId: provider.descriptor.id,
        capability: validatedRequest.capability,
        output,
        startedAt,
        completedAt: new Date(completed).toISOString(),
        durationMs: Math.max(0, completed - started)
      }
    } finally {
      options.signal?.removeEventListener('abort', relayAbort)
      this.#activeJobs.delete(validatedRequest.jobId)
    }
  }

  cancel(jobId: string): boolean {
    const active = this.#activeJobs.get(jobId)
    if (!active) return false
    active.controller.abort(new DOMException('AI job was cancelled', 'AbortError'))
    return true
  }

  activeJobs(): ReadonlyArray<{ jobId: string; providerId: string }> {
    return [...this.#activeJobs.entries()].map(([jobId, { providerId }]) => ({ jobId, providerId }))
  }
}

export const createAiProviderRegistry = (providers: readonly AiProvider[] = []): AiProviderRegistry => {
  const registry = new AiProviderRegistry()
  for (const provider of providers) registry.register(provider)
  return registry
}

export type AIProviderRegistry = AiProviderRegistry
