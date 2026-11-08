import { isIP } from 'node:net'

export interface SafeHttpAdapterOptions {
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
  maxResponseBytes?: number
  maxRequestBytes?: number
  allowInsecureLoopback?: boolean
  fetchImpl?: typeof fetch
}

export interface SafeJsonRequest {
  method?: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal
  headers?: Readonly<Record<string, string>>
}

export class AiHttpError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'AiHttpError'
    this.status = status
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_REQUEST_BYTES = 5 * 1024 * 1024
const MAX_URL_LENGTH = 2_048
const SAFE_EXTRA_HEADERS = new Set(['accept', 'content-type', 'openai-organization', 'openai-project'])

const hasControlCharacters = (value: string): boolean => /[\u0000-\u001f\u007f]/u.test(value)

const isLoopbackHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  const ipVersion = isIP(normalized)
  if (ipVersion === 4) return normalized.startsWith('127.')
  if (ipVersion === 6) return normalized === '::1'
  return false
}

const validateBaseUrl = (raw: string, allowInsecureLoopback: boolean): URL => {
  if (!raw || raw.length > MAX_URL_LENGTH || hasControlCharacters(raw)) throw new AiHttpError('Invalid AI endpoint URL')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AiHttpError('Invalid AI endpoint URL')
  }
  if (url.username || url.password) throw new AiHttpError('AI endpoint credentials must not be embedded in the URL')
  if (url.hash || url.search) throw new AiHttpError('AI base URL cannot contain a query or fragment')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowInsecureLoopback && isLoopbackHost(url.hostname))) {
    throw new AiHttpError('AI endpoint must use HTTPS; HTTP is allowed only for an explicitly enabled loopback service')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

const validateApiKey = (apiKey: string | undefined): string | undefined => {
  if (apiKey === undefined || apiKey === '') return undefined
  if (apiKey.length > 8_192 || hasControlCharacters(apiKey)) throw new AiHttpError('Invalid AI API key')
  return apiKey
}

const redact = (message: string, secret: string | undefined): string => {
  let result = message
  if (secret) result = result.split(secret).join('[REDACTED]')
  return result.replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/giu, 'Bearer [REDACTED]')
}

const toPlainJson = (value: unknown, seen = new Set<object>()): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AiHttpError('JSON body contains a non-finite number')
    return value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new AiHttpError('JSON body contains a cycle')
    seen.add(value)
    const result = value.map((item) => toPlainJson(item, seen))
    seen.delete(value)
    return result
  }
  if (typeof value !== 'object' || value === null) throw new AiHttpError('JSON body contains an unsupported value')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new AiHttpError('JSON body must contain plain objects only')
  if (seen.has(value)) throw new AiHttpError('JSON body contains a cycle')
  seen.add(value)
  const result: Record<string, unknown> = {}
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor) || typeof descriptor.value === 'function') {
      throw new AiHttpError('JSON body cannot contain accessors or functions')
    }
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new AiHttpError(`JSON body contains an unsafe key: ${key}`)
    }
    result[key] = toPlainJson(descriptor.value, seen)
  }
  seen.delete(value)
  return result
}

const combineAbortSignals = (controller: AbortController, signal: AbortSignal | undefined): (() => void) => {
  if (!signal) return () => undefined
  const abort = (): void => controller.abort(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

export class SafeHttpAdapter {
  readonly #baseUrl: URL
  readonly #apiKey?: string
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number
  readonly #maxRequestBytes: number
  readonly #fetch: typeof fetch

  constructor(options: SafeHttpAdapterOptions) {
    this.#baseUrl = validateBaseUrl(options.baseUrl, options.allowInsecureLoopback === true)
    this.#apiKey = validateApiKey(options.apiKey)
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    this.#maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    if (typeof this.#fetch !== 'function') throw new AiHttpError('Fetch is not available')
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 100 || this.#timeoutMs > 10 * 60_000) {
      throw new AiHttpError('HTTP timeout is outside the allowed range')
    }
  }

  get origin(): string {
    return this.#baseUrl.origin
  }

  async requestJson(path: string, request: SafeJsonRequest = {}): Promise<unknown> {
    if (!path || path.length > MAX_URL_LENGTH || hasControlCharacters(path) || path.includes('\\')) {
      throw new AiHttpError('Invalid AI endpoint path')
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path) || path.startsWith('//')) {
      throw new AiHttpError('AI request path must be relative')
    }
    const url = new URL(path, this.#baseUrl)
    if (url.origin !== this.#baseUrl.origin || !url.pathname.startsWith(this.#baseUrl.pathname)) {
      throw new AiHttpError('AI request cannot leave the configured base URL')
    }
    if (url.username || url.password || url.hash) throw new AiHttpError('Invalid AI request URL')

    const headers = new Headers({ Accept: 'application/json' })
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      const normalizedName = name.toLowerCase()
      if (!SAFE_EXTRA_HEADERS.has(normalizedName) || hasControlCharacters(value)) {
        throw new AiHttpError(`HTTP header is not allowed: ${name}`)
      }
      headers.set(name, value)
    }
    if (this.#apiKey) headers.set('Authorization', `Bearer ${this.#apiKey}`)

    const method = request.method ?? (request.body === undefined ? 'GET' : 'POST')
    let body: string | undefined
    if (request.body !== undefined) {
      if (method !== 'POST') throw new AiHttpError('A request body is allowed only with POST')
      body = JSON.stringify(toPlainJson(request.body))
      if (Buffer.byteLength(body, 'utf8') > this.#maxRequestBytes) throw new AiHttpError('AI request body is too large')
      headers.set('Content-Type', 'application/json')
    }

    const controller = new AbortController()
    const removeAbortListener = combineAbortSignals(controller, request.signal)
    const timeout = setTimeout(() => controller.abort(new Error('AI request timed out')), this.#timeoutMs)
    try {
      const response = await this.#fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      })
      const declaredLength = Number(response.headers.get('content-length') ?? 0)
      if (Number.isFinite(declaredLength) && declaredLength > this.#maxResponseBytes) {
        throw new AiHttpError('AI response is too large', response.status)
      }
      const responseText = await response.text()
      if (Buffer.byteLength(responseText, 'utf8') > this.#maxResponseBytes) {
        throw new AiHttpError('AI response is too large', response.status)
      }
      if (!response.ok) {
        const safeSnippet = redact(responseText.slice(0, 500), this.#apiKey)
        throw new AiHttpError(`AI endpoint returned HTTP ${response.status}${safeSnippet ? `: ${safeSnippet}` : ''}`, response.status)
      }
      if (!responseText.trim()) return null
      try {
        return JSON.parse(responseText) as unknown
      } catch {
        throw new AiHttpError('AI endpoint returned invalid JSON', response.status)
      }
    } catch (error) {
      if (error instanceof AiHttpError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new AiHttpError(redact(`AI HTTP request failed: ${message}`, this.#apiKey))
    } finally {
      clearTimeout(timeout)
      removeAbortListener()
    }
  }
}

