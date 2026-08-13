import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveFfmpegPaths } from '../../../src/main/ffmpeg/binaries.js'
import { executeProcess } from '../../../src/main/ffmpeg/process.js'
import { FfmpegService } from '../../../src/main/ffmpeg/service.js'
import { loadEditProject } from '../../../src/main/standalone/edit-project.js'

describe('standalone edit_project headless render', () => {
  it('renders a deterministic contract source to MP4 and validates the promoted output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-editor-headless-'))
    try {
      const paths = await resolveFfmpegPaths()
      const sourcePath = join(root, 'media', 'source.mp4')
      const projectPath = join(root, 'project', 'edit_project.json')
      const outputPath = join(root, 'output.mp4')
      await mkdir(join(root, 'media'), { recursive: true })
      await mkdir(join(root, 'project'), { recursive: true })
      await executeProcess({
        command: paths.ffmpegPath,
        args: [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1',
          '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '1', sourcePath
        ],
        timeoutMs: 30_000
      })
      const sourceHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex')
      const document = {
        schema_version: 'edit_project.v1',
        project: { id: 'headless-test', name: 'Headless test' },
        source_media: [{ id: 'main', path: '../media/source.mp4', kind: 'video', sha256: sourceHash, duration: 1, width: 320, height: 180, fps: 30 }],
        sequence: { width: 320, height: 180, fps: 30, duration: 1 },
        tracks: [
          { id: 'V1', kind: 'video', clips: [{ id: 'v1', type: 'video_clip', source_media_id: 'main', timeline: { start: 0, duration: 1 }, source: { start: 0, duration: 1 }, transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 }, enabled: true }] },
          { id: 'A1', kind: 'audio', clips: [{ id: 'a1', type: 'audio_clip', source_media_id: 'main', timeline: { start: 0, duration: 1 }, source: { start: 0, duration: 1 }, volume: 1, enabled: true }] },
          { id: 'C1', kind: 'caption', clips: [] }
        ],
        captions: []
      }
      await writeFile(projectPath, JSON.stringify(document, null, 2), 'utf8')

      const loaded = await loadEditProject(projectPath)
      const service = new FfmpegService(paths, { platform: 'win32', workspaceRoot: join(root, 'workspace') })
      const settings = {
        outputPath,
        width: 320,
        height: 180,
        frameRate: { numerator: 30, denominator: 1 },
        videoBitrate: 500_000,
        audioBitrate: 96_000,
        encoderMode: 'software' as const,
        burnSubtitles: true,
        exportSrt: false
      }
      const plan = service.createRenderPlan(loaded.project, settings)
      expect(plan.inputs.filter((input) => input.useAudio).map((input) => input.clipId)).toEqual(['a1'])
      expect(plan.graphStatements.filter((statement) => /\[\d+:a:0\]/u.test(statement))).toHaveLength(1)
      expect(plan.graphStatements.join('\n')).toContain('amix=inputs=1')
      const job = await service.startExport(loaded.project, {
        ...settings
      }, { jobId: 'headless-contract' })
      const result = await job.result
      const probe = await service.probeMedia(result.outputPath)

      expect(result.outputPath).toBe(outputPath)
      expect(probe.kind).toBe('video')
      expect(probe.width).toBe(320)
      expect(probe.height).toBe(180)
      expect(probe.hasAudio).toBe(true)
      expect(probe.durationUs).toBeGreaterThanOrEqual(900_000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
