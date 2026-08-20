export interface LatestSubtitleOverlayRequest<T> {
  key: string
  debounceMs?: number
  run: () => Promise<T>
  onCommit: (value: T, key: string) => void
  onError: (error: unknown, key: string) => void
}

/**
 * Serializes authoritative overlay work: one current render in flight and at
 * most two queued prefetches. A stale in-flight render may finish for cache
 * warming, but it can never commit to the current display.
 */
export class LatestSubtitleOverlayScheduler<T> {
  readonly #debounceMs: number
  #timer: ReturnType<typeof setTimeout> | null = null
  #pending: (LatestSubtitleOverlayRequest<T> & { sequence: number }) | null = null
  #prefetch = new Map<string, LatestSubtitleOverlayRequest<T> & { sequence: number }>()
  #running: (LatestSubtitleOverlayRequest<T> & { sequence: number; prefetch: boolean }) | null = null
  #sequence = 0
  #latestCurrentSequence = 0

  constructor(debounceMs = 40) {
    if (!Number.isFinite(debounceMs) || debounceMs < 0) throw new Error('Subtitle overlay debounce must be finite and non-negative')
    this.#debounceMs = debounceMs
  }

  schedule(request: LatestSubtitleOverlayRequest<T>): void {
    const sequence = ++this.#sequence
    this.#pending = { ...request, sequence }
    this.#latestCurrentSequence = sequence
    this.#prefetch.delete(request.key)
    this.#arm()
  }

  schedulePrefetch(request: LatestSubtitleOverlayRequest<T>): void {
    if (this.#pending?.key === request.key || this.#running?.key === request.key || this.#prefetch.has(request.key)) return
    if (this.#prefetch.size >= 2) {
      const oldest = this.#prefetch.keys().next().value
      if (oldest) this.#prefetch.delete(oldest)
    }
    this.#prefetch.set(request.key, { ...request, sequence: ++this.#sequence })
    this.#arm()
  }

  cancel(): void {
    ++this.#sequence
    this.#pending = null
    this.#prefetch.clear()
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  dispose(): void {
    this.cancel()
  }

  get inFlight(): boolean {
    return this.#running !== null
  }

  get hasPending(): boolean {
    return this.#pending !== null || this.#prefetch.size > 0
  }

  get queuedPrefetchCount(): number {
    return this.#prefetch.size
  }

  #arm(): void {
    if (this.#timer !== null || this.#running !== null || (!this.#pending && this.#prefetch.size === 0)) return
    const next = this.#pending ?? this.#prefetch.values().next().value
    if (!next) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#start()
    }, next.debounceMs ?? this.#debounceMs)
  }

  #start(): void {
    const current = this.#pending
    const prefetch = current ? false : true
    const pending = current ?? this.#prefetch.values().next().value
    if (!pending) return
    this.#pending = current ? null : this.#pending
    if (prefetch) this.#prefetch.delete(pending.key)
    this.#running = { ...pending, prefetch }
    void pending.run()
      .then((value) => {
        if (prefetch || pending.sequence === this.#latestCurrentSequence) pending.onCommit(value, pending.key)
      })
      .catch((error: unknown) => {
        if (prefetch || pending.sequence === this.#latestCurrentSequence) pending.onError(error, pending.key)
      })
      .finally(() => {
        this.#running = null
        if (this.#pending || this.#prefetch.size) this.#arm()
      })
  }
}
