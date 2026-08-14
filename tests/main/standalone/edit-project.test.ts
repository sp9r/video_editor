import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createPreviewPlan, createRenderPlan } from '../../../src/main/ffmpeg/render-plan.js'
import { splitSubtitleAtWordBoundary } from '../../../src/shared/editing/operations.js'
import {
  decimalAdd,
  decimalCompare,
  decimalFromNumber,
  EditProjectError,
  loadEditProject,
  validateEditProject,
  type EditProjectDocument
} from '../../../src/main/standalone/edit-project.js'
import { validateProject } from '../../../src/shared/project.js'

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
    { id: 'caption_1', track_id: 'C1', text: 'Phase 3', timeline: { start: 0.25, duration: 0.75 }, style: { template_id: 'legacy-template' }, enabled: true }
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
      expect(loaded.project.tracks.find((track) => track.id === 'V1')?.kind).toBe('media')
      expect(loaded.project.tracks.find((track) => track.id === 'A1')?.kind).toBe('media')
      expect(loaded.project.tracks.find((track) => track.id === 'V1')?.clips.map((clip) => [clip.startUs, clip.sourceInUs])).toEqual([[0, 0], [1_000_000, 2_000_000]])
      expect(loaded.project.tracks.find((track) => track.id === 'A1')?.clips).toHaveLength(2)
      expect(loaded.project.tracks.find((track) => track.id === 'V1')?.clips[0]?.linkGroupId)
        .toBe(loaded.project.tracks.find((track) => track.id === 'A1')?.clips[0]?.linkGroupId)
      expect(loaded.project.tracks.find((track) => track.id === 'V1')?.clips[1]?.linkGroupId)
        .toBe(loaded.project.tracks.find((track) => track.id === 'A1')?.clips[1]?.linkGroupId)
      expect(loaded.project.tracks.find((track) => track.id === 'subtitle')?.clips ?? loaded.project.tracks.find((track) => track.id === 'C1')?.clips).toHaveLength(1)
      expect(loaded.diagnostics).toContain('Unsupported caption style key: caption_1.template_id')
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

  it('validates transform semantics with finite, positive, and bounded helpers', () => {
    const valid = makeDocument()
    const validClip = valid.tracks[0]!.clips[0]!
    if (validClip.type !== 'video_clip') throw new Error('Expected video clip fixture')
    validClip.transform.x = -100
    validClip.transform.y = -50
    validClip.transform.rotation = -45
    expect(() => validateEditProject(valid)).not.toThrow()

    for (const value of [-1, 0]) {
      const invalidScale = makeDocument()
      const clip = invalidScale.tracks[0]!.clips[0]!
      if (clip.type !== 'video_clip') throw new Error('Expected video clip fixture')
      clip.transform.scale_x = value
      expect(() => validateEditProject(invalidScale)).toThrow(/scale_x/u)
    }

    for (const value of [-0.1, 1.1]) {
      const invalidOpacity = makeDocument()
      const clip = invalidOpacity.tracks[0]!.clips[0]!
      if (clip.type !== 'video_clip') throw new Error('Expected video clip fixture')
      clip.transform.opacity = value
      expect(() => validateEditProject(invalidOpacity)).toThrow(/opacity/u)
    }

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalidFinite = makeDocument()
      const clip = invalidFinite.tracks[0]!.clips[0]!
      if (clip.type !== 'video_clip') throw new Error('Expected video clip fixture')
      clip.transform.x = value
      expect(() => validateEditProject(invalidFinite)).toThrow(/x must be a finite number/u)
    }
  })

  it('accepts only portable relative source paths in edit_project.v1', () => {
    for (const sourcePath of ['source.mp4', '../media/source.mp4', '../../source/source.mp4']) {
      expect(() => validateEditProject(makeDocument(sourcePath))).not.toThrow()
    }
    for (const sourcePath of ['C:/source.mp4', String.raw`C:\source.mp4`, '/source.mp4', String.raw`\\server\source.mp4`]) {
      expect(() => validateEditProject(makeDocument(sourcePath))).toThrow(/portable relative path/u)
    }
  })

  it('imports optional caption words into absolute SubtitleClip timing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-editor-caption-words-'))
    try {
      const document = makeDocument()
      document.captions[0] = {
        ...document.captions[0]!,
        text: '私の',
        timeline: { start: 0.25, duration: 0.75 },
        source_word_ids: [123, 124],
        words: [
          { id: 'source-word:123', text: '私', timeline: { start: 0.25, duration: 0.18 } },
          { id: 'source-word:124', text: 'の', timeline: { start: 0.43, duration: 0.22 } }
        ]
      }
      const projectPath = await writeProject(root, document)
      const loaded = await loadEditProject(projectPath)
      const caption = loaded.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'caption_1')
      expect(caption?.kind === 'subtitle' ? caption.words : undefined).toEqual([
        { id: 'source-word:123', text: '私', startUs: 250_000, endUs: 430_000 },
        { id: 'source-word:124', text: 'の', startUs: 430_000, endUs: 650_000 }
      ])
      const split = splitSubtitleAtWordBoundary(loaded.project, 'caption_1', 0)
      expect(split.tracks.find((track) => track.kind === 'subtitle')?.clips.map((item) => item.kind === 'subtitle' ? item.text : item.id)).toEqual(['私', 'の'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses exact decimal value semantics for caption word adjacency and caption end', () => {
    const document = makeDocument()
    document.sequence.duration = 15
    document.captions[0] = {
      ...document.captions[0]!,
      text: 'AB',
      timeline: { start: 13.88, duration: 0.52 },
      words: [
        { id: 'source-word:1', text: 'A', timeline: { start: 13.88, duration: 0.32 } },
        { id: 'source-word:2', text: 'B', timeline: { start: 14.2, duration: 0.2 } }
      ]
    }
    expect(() => validateEditProject(document)).not.toThrow()
  })

  it.each([
    ['true 1us overlap', 0.320001, /overlaps or reverses/u],
    ['true sub-us overlap', 0.320000000000001, /overlaps or reverses/u]
  ])('%s is rejected without microsecond quantization', (_name, firstDuration, message) => {
    const document = makeDocument()
    document.sequence.duration = 15
    document.captions[0] = {
      ...document.captions[0]!,
      text: 'AB',
      timeline: { start: 13.88, duration: 0.52 },
      words: [
        { id: 'source-word:1', text: 'A', timeline: { start: 13.88, duration: firstDuration } },
        { id: 'source-word:2', text: 'B', timeline: { start: 14.2, duration: 0.2 } }
      ]
    }
    expect(() => validateEditProject(document)).toThrow(message)
  })

  it('rejects a true caption overrun while accepting exact caption end', () => {
    const exact = makeDocument()
    exact.sequence.duration = 15
    exact.captions[0] = {
      ...exact.captions[0]!,
      text: 'AB',
      timeline: { start: 13.88, duration: 0.52 },
      words: [
        { id: 'source-word:1', text: 'A', timeline: { start: 13.88, duration: 0.32 } },
        { id: 'source-word:2', text: 'B', timeline: { start: 14.2, duration: 0.2 } }
      ]
    }
    expect(() => validateEditProject(exact)).not.toThrow()

    const overrun = structuredClone(exact)
    overrun.captions[0]!.words![1]!.timeline.duration = 0.200001
    expect(() => validateEditProject(overrun)).toThrow(/ends after the caption/u)
  })

  it('parses exponent notation in decimal helper arithmetic and comparison', () => {
    const one = decimalFromNumber(1e-7)
    const two = decimalFromNumber(2e-7)
    expect(decimalCompare(decimalAdd(one, two), decimalFromNumber(3e-7))).toBe(0)
    expect(decimalCompare(decimalFromNumber(1.5e+2), decimalFromNumber(150))).toBe(0)
    expect(decimalCompare(decimalFromNumber(1e-7), decimalFromNumber(2e-7))).toBe(-1)
  })

  it('keeps exact decimal adjacency when importing to microseconds and validates the Project Model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-editor-decimal-import-'))
    try {
      const document = makeDocument()
      document.sequence.duration = 15
      document.captions[0] = {
        ...document.captions[0]!,
        text: 'AB',
        timeline: { start: 13.88, duration: 0.52 },
        words: [
          { id: 'source-word:1', text: 'A', timeline: { start: 13.88, duration: 0.32 } },
          { id: 'source-word:2', text: 'B', timeline: { start: 14.2, duration: 0.2 } }
        ]
      }
      const projectPath = await writeProject(root, document)
      const loaded = await loadEditProject(projectPath)
      const caption = loaded.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'caption_1')
      expect(caption?.kind === 'subtitle' ? caption.words : undefined).toEqual([
        { id: 'source-word:1', text: 'A', startUs: 13_880_000, endUs: 14_200_000 },
        { id: 'source-word:2', text: 'B', startUs: 14_200_000, endUs: 14_400_000 }
      ])
      expect(() => validateProject(loaded.project)).not.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects invalid optional caption word metadata', () => {
    const cases = [
      { words: [{ id: 'source-word:1', text: 'A', timeline: { start: 0.25, duration: 0.2 } }, { id: 'source-word:1', text: 'B', timeline: { start: 0.45, duration: 0.2 } }] },
      { words: [{ id: 'source-word:1', text: 'AB', timeline: { start: 0.25, duration: 0.4 } }, { id: 'source-word:2', text: 'B', timeline: { start: 0.5, duration: 0.2 } }] },
      { words: [{ id: 'source-word:1', text: 'A', timeline: { start: 0.1, duration: 0.2 } }] },
      { words: [{ id: 'source-word:1', text: 'A', timeline: { start: 0.25, duration: 0.2 } }] }
    ]
    for (const extra of cases) {
      const document = makeDocument()
      document.captions[0] = { ...document.captions[0]!, text: 'AB', ...extra }
      expect(() => validateEditProject(document)).toThrow(EditProjectError)
    }
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
      expect(preview.audioClips.map((clip) => clip.clipId)).toEqual(['audio_1'])
      expect(preview.audioClips).toHaveLength(1)
      expect(preview.audioClips[0]).toMatchObject({ clipId: 'audio_1', volumeDb: 0 })
      expect(preview.captions.map((caption) => caption.clipId)).toEqual(['caption_1'])
      expect(finalPlan.inputs.filter((input) => input.useAudio).map((input) => input.clipId)).toEqual(['audio_1'])
      expect(finalPlan.graphStatements.join('\n')).toContain('amix=inputs=1')
      expect(finalPlan.inputArgs).toContain('-ss')
      expect(finalPlan.filterGraph).toContain('ass=filename')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not change render planning when caption words are present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-editor-word-render-plan-'))
    try {
      const withoutWords = makeDocument()
      const withWords = makeDocument()
      withWords.captions[0] = {
        ...withWords.captions[0]!,
        words: [
          { id: 'source-word:1', text: 'Phase ', timeline: { start: 0.25, duration: 0.3 } },
          { id: 'source-word:2', text: '3', timeline: { start: 0.55, duration: 0.45 } }
        ]
      }
      const settings = {
        outputPath: join(root, 'output.mp4'), width: 640, height: 360,
        frameRate: { numerator: 30, denominator: 1 }, videoBitrate: 1_000_000,
        audioBitrate: 96_000, encoderMode: 'software' as const, burnSubtitles: true, exportSrt: false
      }
      const basePath = await writeProject(root, withoutWords)
      const basePlan = createRenderPlan((await loadEditProject(basePath)).project, settings)
      const withWordsPath = await writeProject(root, withWords)
      const wordPlan = createRenderPlan((await loadEditProject(withWordsPath)).project, settings)
      expect(wordPlan).toEqual(basePlan)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps contract video audio-only semantics for video-only, disabled, and zero-volume variants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-editor-audio-semantics-'))
    try {
      const settings = {
        outputPath: join(root, 'output.mp4'), width: 640, height: 360,
        frameRate: { numerator: 30, denominator: 1 }, videoBitrate: 1_000_000,
        audioBitrate: 96_000, encoderMode: 'software' as const, burnSubtitles: false, exportSrt: false
      }
      const loadPlan = async (document: EditProjectDocument) => {
        const projectPath = await writeProject(root, document)
        const loaded = await loadEditProject(projectPath)
        return { project: loaded.project, plan: createRenderPlan(loaded.project, settings) }
      }

      const videoOnly = makeDocument()
      videoOnly.tracks = videoOnly.tracks.filter((track) => track.id !== 'A1')
      const videoOnlyResult = await loadPlan(videoOnly)
      expect(videoOnlyResult.plan.inputs.filter((input) => input.useAudio)).toHaveLength(0)
      expect(videoOnlyResult.plan.graphStatements.join('\n')).toContain('anullsrc')
      const videoOnlyPath = await writeProject(root, videoOnly)
      const videoOnlyPreview = createPreviewPlan((await loadEditProject(videoOnlyPath)).project, settings)
      expect(videoOnlyPreview.audioClips).toHaveLength(0)

      const disabledAudio = makeDocument()
      const disabledTrack = disabledAudio.tracks.find((track) => track.id === 'A1')
      for (const clip of disabledTrack?.clips ?? []) clip.enabled = false
      const disabledResult = await loadPlan(disabledAudio)
      expect(disabledResult.plan.inputs.filter((input) => input.useAudio)).toHaveLength(0)
      expect(disabledResult.plan.graphStatements.join('\n')).toContain('anullsrc')

      const zeroVolume = makeDocument()
      const zeroAudio = zeroVolume.tracks.find((track) => track.id === 'A1')?.clips[0]
      if (!zeroAudio || zeroAudio.type !== 'audio_clip') throw new Error('Expected audio clip fixture')
      zeroAudio.volume = 0
      const zeroVolumeResult = await loadPlan(zeroVolume)
      expect(zeroVolumeResult.plan.inputs.filter((input) => input.useAudio).map((input) => input.clipId)).toEqual(['audio_1'])
      expect(zeroVolumeResult.plan.graphStatements.join('\n')).toContain('volume=0')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

})
