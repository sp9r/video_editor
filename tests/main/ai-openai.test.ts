import { describe, expect, it, vi } from 'vitest'
import { OpenAiCompatibleProvider, createLocalLlmProvider } from '../../src/main/ai/openai-compatible.js'

const response = (body: unknown): Response => {
  const text = JSON.stringify(body)
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(Buffer.byteLength(text, 'utf8')) },
    text: async () => text
  } as unknown as Response
}

describe('OpenAI-compatible provider', () => {
  it('returns an edit proposal as data without executing model-provided content', async () => {
    const modelOutput = {
      kind: 'edit-proposal',
      proposal: {
        schemaVersion: 1,
        title: 'Add title',
        commands: [
          { type: 'insert-subtitle', trackId: 'track-c1', startUs: 0, durationUs: 1_000_000, text: 'Title' }
        ]
      }
    }
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      response({ choices: [{ message: { content: JSON.stringify(modelOutput) } }] })
    )
    const provider = new OpenAiCompatibleProvider({
      id: 'remote-edit',
      displayName: 'Remote Edit',
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'secret',
      model: 'example-model',
      capabilities: ['edit-suggestion'],
      fetchImpl: fetchMock as unknown as typeof fetch
    })

    const output = await provider.run(
      {
        jobId: 'job-edit-1',
        capability: 'edit-suggestion',
        input: {
          instruction: 'Add a title',
          project: {
            projectId: 'project-1',
            projectName: 'Fixture',
            updatedAt: '2026-08-12T00:00:00.000Z',
            sequence: {
              width: 1920,
              height: 1080,
              frameRate: { numerator: 30, denominator: 1 },
              sampleRate: 48_000
            },
            tracks: [],
            clips: [],
            assets: []
          }
        }
      },
      { signal: new AbortController().signal }
    )

    expect(output).toEqual(modelOutput)
    const [, init] = fetchMock.mock.calls[0]!
    expect(String(init?.body)).not.toContain('secret')
    expect(String(init?.body)).not.toContain('C:\\\\private')
  })

  it('provides an explicitly local OpenAI-compatible profile for local LLMs', () => {
    const provider = createLocalLlmProvider({
      id: 'ollama',
      displayName: 'Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1/',
      model: 'local-model',
      fetchImpl: vi.fn() as unknown as typeof fetch
    })
    expect(provider.descriptor).toMatchObject({ kind: 'local-llm', local: true })
  })
})
