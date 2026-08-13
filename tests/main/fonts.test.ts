import { describe, expect, it } from 'vitest'
import { enumerateFontFamilies } from '../../src/main/fonts.js'
import type { CommandRequest, CommandResult, ProcessExecutor } from '../../src/main/ffmpeg/process.js'

describe('font family enumeration', () => {
  it('merges installed Windows registry families with fallbacks', async () => {
    const executor: ProcessExecutor = { run: async (request: CommandRequest): Promise<CommandResult> => ({
      command: request.command,
      args: request.args,
      exitCode: 0,
      stdout: '    Test Sans (TrueType)    REG_SZ    test.ttf\r\n',
      stderr: ''
    }) }
    const fonts = await enumerateFontFamilies(executor, 'win32')
    expect(fonts).toContain('Test Sans')
    expect(fonts).toContain('Noto Sans JP')
  })

  it('returns safe fallbacks when registry enumeration is unavailable', async () => {
    const fonts = await enumerateFontFamilies({ run: async () => { throw new Error('unavailable') } }, 'win32')
    expect(fonts).toContain('sans-serif')
  })
})
