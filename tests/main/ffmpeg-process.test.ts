import { describe, expect, it } from 'vitest'
import { executeProcess, ProcessCancelledError } from '../../src/main/ffmpeg/process.js'

describe('safe process execution', () => {
  it('passes shell metacharacters as one literal argument', async () => {
    const literal = '日本語 & echo injected; $(bad)'
    const result = await executeProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', literal],
      timeoutMs: 10_000
    })
    expect(result.stdout).toBe(literal)
  })

  it('terminates an active process through AbortSignal', async () => {
    const controller = new AbortController()
    const running = executeProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      signal: controller.signal,
      timeoutMs: 10_000
    })
    setTimeout(() => controller.abort(), 20)
    await expect(running).rejects.toBeInstanceOf(ProcessCancelledError)
  })

  it('does not start when the signal was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(executeProcess({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      signal: controller.signal
    })).rejects.toBeInstanceOf(ProcessCancelledError)
  })
})
