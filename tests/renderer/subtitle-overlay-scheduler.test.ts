import { describe, expect, it, vi } from 'vitest'
import { LatestSubtitleOverlayScheduler } from '../../src/renderer/src/subtitle-overlay-scheduler'

describe('latest-only subtitle overlay scheduling', () => {
  it('coalesces a slider burst and commits only the latest result', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const committed: string[] = []
      let resolveRunning: ((value: string) => void) | undefined
      const scheduler = new LatestSubtitleOverlayScheduler<string>(40)
      const schedule = (key: string): void => scheduler.schedule({
        key,
        run: () => {
          calls.push(key)
          return new Promise<string>((resolve) => { resolveRunning = resolve })
        },
        onCommit: (value) => committed.push(value),
        onError: () => undefined
      })

      for (const value of ['123', '124', '125', '126', '127', '128', '129', '130', '131', '132']) schedule(value)
      await vi.advanceTimersByTimeAsync(40)
      expect(calls).toEqual(['132'])
      expect(committed).toEqual([])
      resolveRunning?.('132')
      await vi.advanceTimersByTimeAsync(0)
      expect(committed).toEqual(['132'])
      expect(calls).toHaveLength(1)
      scheduler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not commit a stale in-flight result and renders the pending latest value', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const committed: string[] = []
      const resolvers = new Map<string, (value: string) => void>()
      const scheduler = new LatestSubtitleOverlayScheduler<string>(40)
      const schedule = (key: string): void => scheduler.schedule({
        key,
        run: () => {
          calls.push(key)
          return new Promise<string>((resolve) => { resolvers.set(key, resolve) })
        },
        onCommit: (value) => committed.push(value),
        onError: () => undefined
      })

      schedule('A')
      await vi.advanceTimersByTimeAsync(40)
      schedule('D')
      resolvers.get('A')?.('A')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(40)
      expect(calls).toEqual(['A', 'D'])
      expect(committed).toEqual([])
      resolvers.get('D')?.('D')
      await vi.advanceTimersByTimeAsync(0)
      expect(committed).toEqual(['D'])
      scheduler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps one authoritative render in flight and then starts the latest cue', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const resolvers = new Map<string, (value: string) => void>()
      const scheduler = new LatestSubtitleOverlayScheduler<string>(40)
      const schedule = (key: string): void => scheduler.schedule({
        key,
        debounceMs: 0,
        run: () => {
          calls.push(key)
          return new Promise<string>((resolve) => { resolvers.set(key, resolve) })
        },
        onCommit: () => undefined,
        onError: () => undefined
      })

      schedule('cue-a')
      await vi.advanceTimersByTimeAsync(0)
      schedule('cue-b')
      await vi.advanceTimersByTimeAsync(0)

      expect(calls).toEqual(['cue-a'])
      await vi.advanceTimersByTimeAsync(0)
      expect(scheduler.inFlight).toBe(true)

      resolvers.get('cue-a')?.('cue-a')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual(['cue-a', 'cue-b'])
      resolvers.get('cue-b')?.('cue-b')
      await vi.advanceTimersByTimeAsync(0)
      expect(scheduler.inFlight).toBe(false)
      scheduler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds prefetch to two queued visual states and prioritizes the current cue', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const resolvers = new Map<string, (value: string) => void>()
      const scheduler = new LatestSubtitleOverlayScheduler<string>(0)
      const item = (key: string) => ({ key, run: () => {
        calls.push(key)
        return new Promise<string>((resolve) => resolvers.set(key, resolve))
      }, onCommit: () => undefined, onError: () => undefined })
      scheduler.schedule(item('current'))
      scheduler.schedulePrefetch(item('next-1'))
      scheduler.schedulePrefetch(item('next-2'))
      scheduler.schedulePrefetch(item('next-3'))
      expect(scheduler.queuedPrefetchCount).toBe(2)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual(['current'])
      resolvers.get('current')?.('current')
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual(['current', 'next-2'])
      scheduler.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
