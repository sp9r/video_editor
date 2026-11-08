import { describe, expect, it } from 'vitest'
import { createMockAiProvider } from '../../src/main/ai/mock-provider.js'
import { AiProviderRegistry } from '../../src/main/ai/registry.js'

describe('AiProviderRegistry', () => {
  it('selects a capable mock provider and validates its result', async () => {
    const registry = new AiProviderRegistry()
    registry.register(
      createMockAiProvider({
        id: 'whisper-mock',
        capabilities: ['transcription'],
        output: {
          kind: 'transcript',
          language: 'ja',
          segments: [{ startUs: 0, endUs: 1_000_000, text: 'test' }]
        }
      })
    )

    const result = await registry.run({
      jobId: 'job-transcribe-1',
      capability: 'transcription',
      input: { assetId: 'asset-1', language: 'ja' }
    })

    expect(result.providerId).toBe('whisper-mock')
    expect(result.output).toMatchObject({ kind: 'transcript', language: 'ja' })
    expect(registry.activeJobs()).toEqual([])
  })

  it('rejects a provider result that does not match the requested capability', async () => {
    const registry = new AiProviderRegistry()
    registry.register(
      createMockAiProvider({
        id: 'bad-whisper',
        capabilities: ['transcription'],
        output: { kind: 'text', text: 'not a transcript' }
      })
    )

    await expect(
      registry.run({ jobId: 'job-bad-result', capability: 'transcription', input: { assetId: 'asset-1' } })
    ).rejects.toThrow(/non-transcript/i)
  })

  it('reports provider health failures without crashing the whole registry', async () => {
    const provider = createMockAiProvider({ id: 'health-mock', capabilities: ['text-generation'] })
    provider.health = async () => {
      throw new Error('model process is offline')
    }
    const registry = new AiProviderRegistry()
    registry.register(provider)

    await expect(registry.health('health-mock')).resolves.toMatchObject({
      providerId: 'health-mock',
      status: 'unavailable',
      message: 'model process is offline'
    })
  })

  it('cancels active jobs through an AbortSignal', async () => {
    const registry = new AiProviderRegistry()
    registry.register(
      createMockAiProvider({
        id: 'slow-mock',
        capabilities: ['text-generation'],
        handler: (_request, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
          })
      })
    )

    const running = registry.run({
      jobId: 'job-cancel-1',
      capability: 'text-generation',
      input: { instruction: 'wait' }
    })
    await Promise.resolve()
    expect(registry.cancel('job-cancel-1')).toBe(true)
    await expect(running).rejects.toBeDefined()
    expect(registry.activeJobs()).toEqual([])
  })

  it('does not expose a mutable registry descriptor', () => {
    const registry = new AiProviderRegistry()
    registry.register(createMockAiProvider({ id: 'immutable-mock', capabilities: ['text-generation'] }))
    const listed = registry.list()
    listed[0]!.displayName = 'tampered'
    expect(registry.list()[0]?.displayName).toBe('Mock AI')
  })
})

