import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createPreviewPlan, createRenderPlan } from '../../../src/main/ffmpeg/render-plan.js'
import {
  EditProjectError,
  loadEditProject,
  validateEditProject,
  type EditProjectDocument
} from '../../../src/main/standalone/edit-project.js'

const sourceBytes = Buffer.from('deterministic phase 3 media fixture\n', 'utf8')

const makeDocument = (sourcePath = '../../../media/source.mp4', sha256?: string): EditProjectDocument => ({
  schema_version: 'edit_project.v1',
  project: { id: 'phase3-fixture', name: 'Phase 3 fixture' },
  source_media: [{
    id: 'media_main',
    path: sourcePath,
    kind: 'video',
    ...(sha256 ? { sha256 } : {}),
    duration: 4,
    width: 640,
    height: 360,
    fps: 30
  }],
  sequence: {
    id: 'sequence_main',
    width: 640,
    height: 360,
    fps: 30,
    timebase: { numerator: 1, denominator: 1000 },
    duration: 3
  },
  tracks: [
    {
      id: 'V1',
      kind: 'video',
      clips: [
        {
          id: 'video_1', type: 'video_clip', source_media_id: 'media_main',
          timeline: { start: 0, duration: 1 }, source: { start: 0, duration: 1 },
          transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 }, enabled: true
        },
        {
          id: 'video_2', type: 'video_clip', source_media_id: 'media_main',
          timeline: { start: 1, duration: 2 }, source: { start: 2, duration: 2 },
          transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 }, enabled: true
        }
      ]
    },
    {
      id: 'A1',
      kind: 'audio',
      clips: [
        {
          id: 'audio_1', type: 'audio_clip', source_media_id: 'media_main',
          timeline: { start: 0, duration: 1 }, source: { start: 0, duration: 1 }, volume: 1, enabled: true
        },
        {
          id: 'audio_2', type: 'audio_clip', source_media_id: 'media_main',
          timeline: { start: 1, duration: 2 }, source: { start: 2, duration: 2 }, volume: 0, enabled: false
        }
      ]
    },
    { id: 'C1', kind: 'caption', clips: [] }
  ],
  captions: [
    { id: 'caption_1', track_id: 'C1', text: 'Phase 3', timeline: { start: 0.25, duration: 0.75 }, enabled: true }
  ]
})

const writeProject = async (root: string, document: EditProjectDocument): Promise<string> => {
  const projectDir = join(root, 'planning', 'clips', 'clip_000001')
  await mkdir(join(root, 'media'), { recursive: true })
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(root, 'media', 'source.mp4'), sourceBytes)
  const projectPath = join(projectDir, 'edit_project.json')
  await writeFile(projectPath, JSON.stringify(document, null, 2), 'utf8')
  return projectPath
}

describe('standalone edit_project.v1 loader', () => {
  it('resolves the source relative to the contract parent, verifies its hash, and maps both time axes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-editor-contract-'))
    try {
      const hash = createHash('sha256').update(sourceBytes).digest('hex')
      const projectPath = await writeProject(root, makeDocument('../../../media/source.mp4', hash))
      const loaded = await loadEditProject(projectPath)

      expect(loaded.resolvedSourceMedia.get('media_main')).toBe(join(root, 'media', 'source.mp4'))
      expect(loaded.project.projectFormat).toBe('edit_project_v1')
      expect(loaded.project.tracks.find((track) => track.id === 'V1')?.clips.map((clip) => [clip.startUs, clip.sourceInUs])).toEqual([[0, 0], [1_000_000, 2_000_000]])
      expect(loaded.project.tracks.find((track) => track.id === 'A1')?.clips).toHaveLength(2)
      expect(loaded.project.tracks.find((track) => track.id === 'subtitle')?.clips ?? loaded.project.tracks.find((track) => track.id === 'C1')?.clips).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves resolution when the common parent moves', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'video-editor-move-'))
    const moved = `${parent}-moved`
    try {
      const projectPath = await writeProject(parent, makeDocument())
      await rename(parent, moved)
      const loaded = await loadEditProject(projectPath.replace(parent, moved))
      expect(loaded.resolvedSourceMedia.get('media_main')).toBe(join(moved, 'media', 'source.mp4'))
    } finally {
      await rm(parent, { recursive: true, force: true })
      await rm(moved, { recursive: true, force: true })
    }
  })

  it('returns typed errors for missing and mismatched source media', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-editor-errors-'))
    try {
      const missingPath = await writeProject(root, makeDocument('media/missing.mp4'))
      await expect(loadEditProject(missingPath)).rejects.toMatchObject({ code: 'source_missing' })

      const mismatchPath = await writeProject(root, makeDocument(undefined, '0'.repeat(64)))
      await expect(loadEditProject(mismatchPath)).rejects.toMatchObject({ code: 'source_hash_mismatch' })
      await expect(loadEditProject(mismatchPath, { verifyHashes: false })).resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects unknown schema majors and invalid references before model construction', () => {
    expect(() => validateEditProject({ ...makeDocument(), schema_version: 'edit_project.v2' })).toThrowError(EditProjectError)
    expect(() => validateEditProject({ ...makeDocument(), schema_version: 'edit_project.v2' })).toThrow(/unsupported/u)
    const invalid = makeDocument()
    invalid.tracks[0]!.clips[0]!.source_media_id = 'missing'
    expect(() => validateEditProject(invalid)).toThrow(/missing source media/u)
    const speedChange = makeDocument()
    speedChange.tracks[0]!.clips[0]!.timeline.duration = 0.5
    expect(() => validateEditProject(speedChange)).toThrow(/changes speed/u)
  })

  it('feeds preview and final render planning from the same adapted project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-editor-render-plan-'))
    try {
      const projectPath = await writeProject(root, makeDocument())
      const loaded = await loadEditProject(projectPath)
      const settings = {
        outputPath: join(root, 'output.mp4'), width: 640, height: 360,
        frameRate: { numerator: 30, denominator: 1 }, videoBitrate: 1_000_000,
        audioBitrate: 96_000, encoderMode: 'software' as const, burnSubtitles: true, exportSrt: false
      }
      const preview = createPreviewPlan(loaded.project, settings)
      const finalPlan = createRenderPlan(loaded.project, settings)
      expect(preview.durationUs).toBe(finalPlan.durationUs)
      expect(preview.videoClips.map((clip) => clip.clipId)).toEqual(['video_1', 'video_2'])
      expect(preview.audioClips.map((clip) => clip.clipId)).toEqual(['video_1', 'audio_1', 'video_2'])
      expect(preview.captions.map((caption) => caption.clipId)).toEqual(['caption_1'])
      expect(finalPlan.inputArgs).toContain('-ss')
      expect(finalPlan.filterGraph).toContain('ass=filename')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

})
