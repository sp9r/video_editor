import { describe, expect, it, vi } from 'vitest'
import { SafeHttpAdapter } from '../../src/main/ai/http-adapter.js'

const response = (body: string, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => String(Buffer.byteLength(body, 'utf8')) },
    text: async () => body
  }) as unknown as Response

describe('SafeHttpAdapter URL policy', () => {
  it('requires HTTPS except for explicitly enabled loopback endpoints', () => {
    expect(() => new SafeHttpAdapter({ baseUrl: 'http://api.example.com/v1/' })).toThrow(/HTTPS/i)
    expect(() =>
      new SafeHttpAdapter({ baseUrl: 'http://localhost:11434/v1/', allowInsecureLoopback: true })
    ).not.toThrow()
    expect(() =>
      new SafeHttpAdapter({ baseUrl: 'http://192.168.1.10:11434/v1/', allowInsecureLoopback: true })
    ).toThrow(/HTTPS/i)
    expect(() => new SafeHttpAdapter({ baseUrl: 'https://key@example.com/v1/' })).toThrow(/credentials/i)
  })

  it('keeps every request under the configured base path', async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => response('{}'))
    const client = new SafeHttpAdapter({
      baseUrl: 'https://api.example.com/v1/',
      fetchImpl: fetchMock as unknown as typeof fetch
    })

    await expect(client.requestJson('https://evil.example/steal')).rejects.toThrow(/relative/i)
    await expect(client.requestJson('../admin')).rejects.toThrow(/base URL/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('SafeHttpAdapter secret and payload handling', () => {
  it('adds the API key only as an authorization header and sends plain JSON', async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      response('{"ok":true}')
    )
    const client = new SafeHttpAdapter({
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'super-secret-key',
      fetchImpl: fetchMock as unknown as typeof fetch
    })

    await expect(client.requestJson('chat/completions', { method: 'POST', body: { prompt: 'hello' } })).resolves.toEqual({
      ok: true
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://api.example.com/v1/chat/completions')
    expect(String(url)).not.toContain('super-secret-key')
    expect((init?.headers as Headers).get('Authorization')).toBe('Bearer super-secret-key')
    expect(init?.body).toBe('{"prompt":"hello"}')
  })

  it('does not allow callers to override authorization and redacts echoed keys from errors', async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      response('invalid super-secret-key', 401)
    )
    const client = new SafeHttpAdapter({
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'super-secret-key',
      fetchImpl: fetchMock as unknown as typeof fetch
    })

    await expect(client.requestJson('models', { headers: { Authorization: 'Bearer attacker' } })).rejects.toThrow(
      /not allowed/i
    )
    try {
      await client.requestJson('models')
      throw new Error('expected request failure')
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-key')
      expect((error as Error).message).toContain('[REDACTED]')
    }
  })

  it('rejects executable or accessor-bearing request bodies without touching them', async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => response('{}'))
    const client = new SafeHttpAdapter({
      baseUrl: 'https://api.example.com/v1/',
      fetchImpl: fetchMock as unknown as typeof fetch
    })
    const body = Object.create(null) as Record<string, unknown>
    Object.defineProperty(body, 'prompt', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute')
      }
    })

    await expect(client.requestJson('chat', { method: 'POST', body })).rejects.toThrow(/accessors/i)
    await expect(client.requestJson('chat', { method: 'POST', body: { callback: () => 'run' } })).rejects.toThrow(
      /functions/i
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
