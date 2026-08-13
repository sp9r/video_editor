import { spawn, type ChildProcess } from 'node:child_process'

export interface CommandRequest {
  command: string
  args: readonly string[]
  cwd?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputBytes?: number
  onStdout?: (chunk: string) => void
  onStdoutBytes?: (chunk: Buffer) => void
  onStderr?: (chunk: string) => void
}

export interface CommandResult {
  command: string
  args: readonly string[]
  exitCode: number
  stdout: string
  stderr: string
}

export interface ProcessExecutor {
  run(request: CommandRequest): Promise<CommandResult>
}

export class CommandExecutionError extends Error {
  readonly result: CommandResult

  constructor(result: CommandResult) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
    super(`Command failed (${result.exitCode}): ${detail}`)
    this.name = 'CommandExecutionError'
    this.result = result
  }
}

export class ProcessCancelledError extends Error {
  constructor(message = 'Process was cancelled') {
    super(message)
    this.name = 'ProcessCancelledError'
  }
}

const terminate = (child: ChildProcess): void => {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 2_000)
  forceKill.unref()
}

export const executeProcess = async (request: CommandRequest): Promise<CommandResult> => {
  if (request.signal?.aborted) throw new ProcessCancelledError()

  const maxOutputBytes = request.maxOutputBytes ?? 32 * 1024 * 1024
  return await new Promise<CommandResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let cancelled = false
    let timedOut = false
    let settled = false
    let timeout: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onAbort)
    }

    const finishReject = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const onAbort = (): void => {
      cancelled = true
      terminate(child)
    }

    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    timeout = request.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          terminate(child)
        }, request.timeoutMs)
      : undefined

    const append = (target: 'stdout' | 'stderr', data: Buffer): void => {
      outputBytes += data.byteLength
      if (outputBytes > maxOutputBytes) {
        terminate(child)
        finishReject(new Error(`Command output exceeded ${maxOutputBytes} bytes`))
        return
      }
      const chunk = data.toString('utf8')
      if (target === 'stdout') {
        request.onStdoutBytes?.(data)
        stdout += chunk
        request.onStdout?.(chunk)
      } else {
        stderr += chunk
        request.onStderr?.(chunk)
      }
    }

    request.signal?.addEventListener('abort', onAbort, { once: true })
    // Close the small race between the initial aborted check and listener registration.
    if (request.signal?.aborted) onAbort()
    child.stdout.on('data', (data: Buffer) => append('stdout', data))
    child.stderr.on('data', (data: Buffer) => append('stderr', data))
    child.once('error', (error) => finishReject(error))
    child.once('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (cancelled) {
        reject(new ProcessCancelledError())
        return
      }
      if (timedOut) {
        reject(new Error(`Command timed out after ${request.timeoutMs} ms`))
        return
      }
      const result: CommandResult = {
        command: request.command,
        args: request.args,
        exitCode: code ?? -1,
        stdout,
        stderr
      }
      if (result.exitCode === 0) resolve(result)
      else reject(new CommandExecutionError(result))
    })
  })
}

export const defaultProcessExecutor: ProcessExecutor = { run: executeProcess }
