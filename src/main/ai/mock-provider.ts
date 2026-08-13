import type {
  AiCapability,
  AiJobRequest,
  AiProviderDescriptor,
  AiProviderHealth
} from '../../shared/automation.js'
import type { AiProvider, AiProviderExecutionContext } from './provider.js'

export interface MockAiProviderOptions {
  id?: string
  displayName?: string
  capabilities?: readonly AiCapability[]
  output?: unknown
  handler?: (request: AiJobRequest, context: AiProviderExecutionContext) => unknown | Promise<unknown>
  health?: AiProviderHealth['status']
}

export const createMockAiProvider = (options: MockAiProviderOptions = {}): AiProvider => {
  const id = options.id ?? 'mock-ai'
  const descriptor: AiProviderDescriptor = {
    id,
    displayName: options.displayName ?? 'Mock AI',
    kind: 'mock',
    capabilities: options.capabilities ?? ['transcription', 'edit-suggestion', 'text-generation'],
    local: true,
    description: 'Deterministic in-process provider for tests and development'
  }
  return {
    descriptor,
    async health(): Promise<AiProviderHealth> {
      return {
        providerId: id,
        status: options.health ?? 'healthy',
        checkedAt: new Date().toISOString(),
        latencyMs: 0
      }
    },
    async run(request: AiJobRequest, context: AiProviderExecutionContext): Promise<unknown> {
      if (context.signal.aborted) throw new DOMException('AI job was cancelled', 'AbortError')
      if (options.handler) return options.handler(request, context)
      return options.output ?? { kind: 'text', text: 'mock output' }
    }
  }
}

export type MockAIProviderOptions = MockAiProviderOptions
