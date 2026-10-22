import { ProcessCancelledError, type CommandRequest, type CommandResult, type ProcessExecutor } from './process.js'

interface Waiting {
  request: CommandRequest
  resolve: (result: CommandResult) => void
  reject: (error: unknown) => void
  onAbort?: () => void
}

/**
 * Bounds how many FFmpeg processes run at once. Thumbnails, waveforms and
 * background subtitle images share `limit` slots in arrival order; a request
 * with priority 'high' (the subtitle on screen right now) starts at once in a
 * reserved extra slot and is queued ahead of everything else if that is busy.
 */
export class QueuedProcessExecutor implements ProcessExecutor {
  readonly #waiting: Waiting[] = []
  #running = 0
  #runningHigh = 0

  constructor(private readonly inner: ProcessExecutor, private readonly limit = 3) {}

  run(request: CommandRequest): Promise<CommandResult> {
    if (request.signal?.aborted) return Promise.reject(new ProcessCancelledError())
    return new Promise<CommandResult>((resolve, reject) => {
      const entry: Waiting = { request, resolve, reject }
      if (request.signal) {
        entry.onAbort = () => {
          const index = this.#waiting.indexOf(entry)
          if (index < 0) return
          this.#waiting.splice(index, 1)
          reject(new ProcessCancelledError())
        }
        request.signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      if (request.priority === 'high') {
        const firstNormal = this.#waiting.findIndex((item) => item.request.priority !== 'high')
        this.#waiting.splice(firstNormal < 0 ? this.#waiting.length : firstNormal, 0, entry)
      } else {
        this.#waiting.push(entry)
      }
      this.#drain()
    })
  }

  #drain(): void {
    for (;;) {
      const next = this.#waiting[0]
      if (!next) return
      const high = next.request.priority === 'high'
      // High priority runs in its own slots (at most two); everything else shares `limit`.
      if (high ? this.#runningHigh >= 2 : this.#running - this.#runningHigh >= this.limit) return
      this.#waiting.shift()
      if (next.onAbort) next.request.signal?.removeEventListener('abort', next.onAbort)
      this.#running += 1
      if (high) this.#runningHigh += 1
      // Progress-reporting runs (exports) keep normal OS priority; background work yields to the UI.
      const request = next.request.lowOsPriority !== undefined || next.request.onStdout || high ? next.request : { ...next.request, lowOsPriority: true }
      void this.inner.run(request).then(next.resolve, next.reject).finally(() => {
        this.#running -= 1
        if (high) this.#runningHigh -= 1
        this.#drain()
      })
    }
  }
}
