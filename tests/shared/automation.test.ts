import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_SCHEMA_VERSION,
  applyAutomationPreview,
  createAutomationPlanFromOutput,
  createAutomationProjectContext,
  previewAutomationProposal,
  undoAutomationChange,
  validateAiJobRequest,
  validateAiProviderOutput,
  validateAutomationProposal
} from '../../src/shared/automation.js'
import {
  APP_VERSION,
  DEFAULT_AUDIO,
  DEFAULT_TRANSFORM,
  PROJECT_SCHEMA_VERSION,
  type ProjectFile
} from '../../src/shared/types.js'

const projectFixture = (): ProjectFile => ({
  schemaVersion: PROJECT_SCHEMA_VERSION,
  appVersion: APP_VERSION,
  id: 'project-1',
  name: 'Automation fixture',
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
  sequence: {
    width: 1920,
    height: 1080,
    frameRate: { numerator: 30, denominator: 1 },
    sampleRate: 48_000,
    backgroundColor: '#000000'
  },
  media: [
    {
      id: 'asset-1',
      name: 'private-video.mp4',
      path: 'C:\\private\\private-video.mp4',
      kind: 'video',
      durationUs: 10_000_000,
      width: 1920,
      height: 1080,
      frameRate: { numerator: 30, denominator: 1 },
      hasAudio: true,
      fileSize: 1_024,
      modifiedAt: '2026-08-12T00:00:00.000Z',
      offline: false
    }
  ],
  tracks: [
    {
      id: 'track-v1',
      name: 'V1',
      kind: 'video',
      locked: false,
      muted: false,
      hidden: false,
      clips: [
        {
          id: 'clip-video-1',
          name: 'private-video.mp4',
          kind: 'video',
          assetId: 'asset-1',
          startUs: 0,
          durationUs: 10_000_000,
          sourceInUs: 0,
          enabled: true,
          transform: structuredClone(DEFAULT_TRANSFORM),
          audio: structuredClone(DEFAULT_AUDIO)
        }
      ]
    },
    {
      id: 'track-c1',
      name: 'C1',
      kind: 'subtitle',
      locked: false,
      muted: false,
      hidden: false,
      clips: []
    },
    {
      id: 'track-a1',
      name: 'A1',
      kind: 'audio',
      locked: false,
      muted: false,
      hidden: false,
      clips: []
    }
  ]
})

describe('AI project boundary', () => {
  it('creates a useful provider context without exposing local media paths', () => {
    const context = createAutomationProjectContext(projectFixture())
    const serialized = JSON.stringify(context)

    expect(context.clips[0]).toMatchObject({ id: 'clip-video-1', assetId: 'asset-1' })
    expect(serialized).not.toContain('C:\\private')
    expect(serialized).not.toContain('path')
  })

  it('rejects raw project replacement and unknown commands', () => {
    const project = projectFixture()
    expect(() =>
      validateAutomationProposal(project, {
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        title: 'Replace everything',
        project,
        commands: [{ type: 'replace-project', project }]
      })
    ).toThrow(/unsupported field/i)

    expect(() =>
      validateAiProviderOutput({
        kind: 'edit-proposal',
        project,
        proposal: { schemaVersion: 1, title: 'Bad', commands: [] }
      })
    ).toThrow(/unsupported field/i)
  })

  it('validates path-free job requests before they reach a provider', () => {
    const project = projectFixture()
    const context = createAutomationProjectContext(project)
    expect(
      validateAiJobRequest({
        jobId: 'job-edit-safe',
        capability: 'edit-suggestion',
        input: { instruction: 'Shorten the intro', project: context }
      })
    ).toMatchObject({ jobId: 'job-edit-safe', capability: 'edit-suggestion' })

    expect(() =>
      validateAiJobRequest({
        jobId: 'job-edit-unsafe',
        capability: 'edit-suggestion',
        input: {
          instruction: 'Edit',
          project: { ...context, path: 'C:\\private\\project.svs.json' }
        }
      })
    ).toThrow(/unsupported field/i)
  })
})

describe('validated automation preview and undo', () => {
  it('turns transcript segments into subtitle commands, previews, applies, and undoes', () => {
    const original = projectFixture()
    const plan = createAutomationPlanFromOutput(original, {
      kind: 'transcript',
      language: 'ja',
      segments: [
        { startUs: 500_000, endUs: 1_500_000, text: 'こんにちは', confidence: 0.98 },
        { startUs: 2_000_000, endUs: 3_000_000, text: '動画編集です' }
      ]
    })
    const preview = previewAutomationProposal(original, plan)

    expect(original.tracks[1]?.clips).toHaveLength(0)
    expect(preview.project.tracks[1]?.clips).toHaveLength(2)
    expect(preview.project.tracks[1]?.clips[0]).toMatchObject({
      kind: 'subtitle',
      startUs: 500_000,
      durationUs: 1_000_000,
      text: 'こんにちは'
    })

    const applied = applyAutomationPreview(original, preview)
    expect(applied.project.tracks[1]?.clips).toHaveLength(2)
    const undone = undoAutomationChange(applied.project, applied.undo)
    expect(undone.tracks[1]?.clips).toHaveLength(0)
    expect(undone.tracks[0]?.clips).toEqual(original.tracks[0]?.clips)
  })

  it('revalidates ranges and patches before previewing', () => {
    const project = projectFixture()
    expect(() =>
      previewAutomationProposal(project, {
        schemaVersion: 1,
        title: 'Unsafe opacity',
        commands: [{ type: 'set-transform', clipId: 'clip-video-1', patch: { opacity: 2 } }]
      })
    ).toThrow(/opacity/i)

    expect(() =>
      previewAutomationProposal(project, {
        schemaVersion: 1,
        title: 'Outside source',
        commands: [
          {
            type: 'trim-clip',
            clipId: 'clip-video-1',
            startUs: 0,
            durationUs: 9_000_000,
            sourceInUs: 2_000_000
          }
        ]
      })
    ).toThrow(/exceeds source/i)
  })

  it('refuses to apply a stale preview', () => {
    const project = projectFixture()
    const preview = previewAutomationProposal(project, {
      schemaVersion: 1,
      title: 'Lower volume',
      commands: [{ type: 'set-audio', clipId: 'clip-video-1', patch: { volumeDb: -6 } }]
    })
    const concurrentlyEdited = { ...project, updatedAt: '2026-08-12T01:00:00.000Z' }
    expect(() => applyAutomationPreview(concurrentlyEdited, preview)).toThrow(/changed/i)
  })
})
