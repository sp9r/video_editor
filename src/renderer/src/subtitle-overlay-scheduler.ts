export interface LatestSubtitleOverlayRequest<T> {
  key: string
  debounceMs?: number
  run: () => Promise<T>
  onCommit: (value: T, key: string) => void
  onError: (error: unknown, key: string) => void
}

/** Coalesces rapid inspector updates into one latest-only render after the debounce window. */
export class LatestSubtitleOverlayScheduler<T> {
  readonly #debounceMs: number
  #timer: ReturnType<typeof setTimeout> | null = null
  #pending: (LatestSubtitleOverlayRequest<T> & { sequence: number }) | null = null
  #running = new Map<number, LatestSubtitleOverlayRequest<T>>()
  #sequence = 0

  constructor(debounceMs = 40) {
    if (!Number.isFinite(debounceMs) || debounceMs < 0) throw new Error('Subtitle overlay debounce must be finite and non-negative')
    this.#debounceMs = debounceMs
  }

  schedule(request: LatestSubtitleOverlayRequest<T>): void {
    const sequence = ++this.#sequence
    this.#pending = { ...request, sequence }
    this.#arm()
  }

  cancel(): void {
    ++this.#sequence
    this.#pending = null
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  dispose(): void {
    this.cancel()
  }

  get inFlight(): boolean {
    return this.#running.size > 0
  }

  get hasPending(): boolean {
    return this.#pending !== null
  }

  #arm(): void {
    if (this.#timer !== null || !this.#pending) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#start()
    }, this.#pending?.debounceMs ?? this.#debounceMs)
  }

  #start(): void {
    if (!this.#pending) return
    const pending = this.#pending
    this.#pending = null
    this.#running.set(pending.sequence, pending)
    void pending.run()
      .then((value) => {
        if (this.#sequence === pending.sequence) pending.onCommit(value, pending.key)
      })
      .catch((error: unknown) => {
        if (this.#sequence === pending.sequence) pending.onError(error, pending.key)
      })
      .finally(() => {
        this.#running.delete(pending.sequence)
        if (this.#pending) this.#arm()
      })
  }
}
