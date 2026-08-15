import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateCaptionsForMedia } from '../../src/main/ai/external-caption.js'

describe('external caption bridge', () => {
  it('uses the process boundary and validates word-bearing transcript output', async () => {
    const executor = {
      run: async ({ args }: { args: readonly string[] }) => {
        const outputPath = args[args.indexOf('--output') + 1]
        if (!outputPath) throw new Error('test output path missing')
        await writeFile(outputPath, JSON.stringify({
          schema_version: 'spectra.caption_bridge.v1',
          kind: 'transcript',
          language: 'ja',
          segments: [{
            startUs: 0,
            endUs: 1_000_000,
            text: 'テスト',
            words: [{ id: 'source-word:0', text: 'テスト', startUs: 0, endUs: 1_000_000 }]
          }]
        }), 'utf8')
        return { command: 'python', args, exitCode: 0, stdout: '', stderr: '' }
      }
    }
    const result = await generateCaptionsForMedia({
      appPath: path.resolve(process.cwd()),
      mediaPath: path.join(process.cwd(), 'fixture.mp4'),
      executor,
      timeoutMs: 5_000
    })
    expect(result.segments[0]).toMatchObject({ text: 'テスト', words: [{ id: 'source-word:0' }] })
  })
})
