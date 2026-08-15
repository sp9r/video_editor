import { describe, expect, it } from 'vitest'
import { applyAutoCaptionResultToProject, autoCaptionResultToTranscript, createAutoCaptionAutomationPlan } from '../../src/shared/auto-caption-adapter'
import { createEmptyProject, createSubtitleClip, validateProject } from '../../src/shared/project'
import { buildSubtitleRenderSpec } from '../../src/shared/subtitle-render'
import type { AutoCaptionResult } from '../../src/shared/auto-caption-contract'

const result: AutoCaptionResult = {
  version: 'spectra.auto-caption.result.v1', jobId: 'caption-job-map', sourceStartUs: 20_000_000, sourceEndUs: 30_000_000,
  language: 'ja', provider: 'faster-whisper', model: 'test',
  rawWords: [{ id: 'source-word:0', text: '字幕', startUs: 25_000_000, endUs: 26_000_000 }],
  captions: [{ id: 'caption:0', text: '字幕', sourceWordIds: ['source-word:0'], startUs: 25_000_000, endUs: 26_000_000, textStatus: 'as_transcribed', provenance: 'caption_algorithm' }],
  diagnostics: [], fallback: { used: false }
}

describe('auto-caption timeline adapter', () => {
  it('maps caption and owned words with the same source-to-timeline formula', () => {
    const clip = { id: 'clip-1', kind: 'audio' as const, startUs: 10_000_000, sourceInUs: 20_000_000, durationUs: 10_000_000 }
    const transcript = autoCaptionResultToTranscript(clip, result)
    expect(transcript.segments[0]).toMatchObject({ startUs: 15_000_000, endUs: 16_000_000 })
    expect(transcript.segments[0]?.words?.[0]).toMatchObject({ id: 'source-word:0', startUs: 15_000_000, endUs: 16_000_000 })
  })

  it('creates an undoable automation plan for the mapped timeline', () => {
    const project = createEmptyProject('mapping')
    const clip = { id: 'clip-1', kind: 'video' as const, startUs: 10_000_000, sourceInUs: 20_000_000, durationUs: 10_000_000 }
    const plan = createAutoCaptionAutomationPlan(project, clip, result)
    const command = plan.commands[0]
    expect(command).toBeDefined()
    if (!command || command.type !== 'insert-subtitle') throw new Error('expected subtitle command')
    expect(command).toMatchObject({ type: 'insert-subtitle', startUs: 15_000_000, durationUs: 1_000_000 })
    expect(command.words?.[0]).toMatchObject({ startUs: 15_000_000, endUs: 16_000_000 })
  })

  it('does not attach word truth when display text differs from owned word text', () => {
    const normalized = {
      ...result,
      rawWords: [{ ...result.rawWords[0]!, text: '字幕。' }],
      captions: [{ ...result.captions[0]!, text: '字幕', textStatus: 'display_normalized' as const }]
    }
    const project = createEmptyProject('normalized')
    const clip = { id: 'clip-1', kind: 'video' as const, startUs: 10_000_000, sourceInUs: 20_000_000, durationUs: 10_000_000 }
    const plan = createAutoCaptionAutomationPlan(project, clip, normalized)
    const command = plan.commands[0]
    if (!command || command.type !== 'insert-subtitle') throw new Error('expected subtitle command')
    expect(command.text).toBe('字幕')
    expect(command.words).toBeUndefined()
  })

  it('creates a fresh named track with edit units and keeps previous tracks untouched', () => {
    const project = createEmptyProject('fresh track')
    const clip = { id: 'clip-1', kind: 'video' as const, startUs: 10_000_000, sourceInUs: 20_000_000, durationUs: 10_000_000 }
    const first = applyAutoCaptionResultToProject(project, clip, result)
    const second = applyAutoCaptionResultToProject(first.project, clip, result)
    expect(first.project.tracks.filter((track) => track.kind === 'subtitle').map((track) => track.name)).toEqual(['C1', '自動字幕'])
    expect(second.project.tracks.filter((track) => track.kind === 'subtitle').map((track) => track.name)).toEqual(['C1', '自動字幕', '自動字幕 2'])
    const generated = second.project.tracks.at(-1)!.clips[0]
    expect(generated?.kind === 'subtitle' ? generated.editUnits?.map((unit) => unit.parentSourceWordId) : []).toEqual(['source-word:0'])
    expect(generated?.kind === 'subtitle' ? generated.sourceCaptionId : undefined).toBe('caption:0')
    expect(generated?.kind === 'subtitle' ? generated.sourceJobId : undefined).toBe('caption-job-map')
    const reopened = validateProject(JSON.parse(JSON.stringify(second.project)))
    const reopenedCaption = reopened.tracks.at(-1)!.clips[0]
    expect(reopenedCaption?.kind === 'subtitle' ? reopenedCaption.editUnits?.length : 0).toBe(1)
    expect(reopenedCaption?.kind === 'subtitle' ? reopenedCaption.sourceCaptionId : undefined).toBe('caption:0')
  })

  it('persists the requested maxLines on generated captions and defaults legacy captions to two lines', () => {
    const project = createEmptyProject('max lines')
    const clip = { id: 'clip-1', kind: 'video' as const, startUs: 10_000_000, sourceInUs: 20_000_000, durationUs: 10_000_000 }
    const applied = applyAutoCaptionResultToProject(project, clip, result, { maxLines: 1 })
    const generated = applied.project.tracks.at(-1)!.clips[0]
    expect(generated?.kind === 'subtitle' ? generated.maxLines : undefined).toBe(1)
    const reopened = validateProject(JSON.parse(JSON.stringify(applied.project)))
    expect(reopened.tracks.at(-1)?.clips[0]).toMatchObject({ maxLines: 1 })
    const legacy = createSubtitleClip(0)
    expect(buildSubtitleRenderSpec(legacy, project.sequence).maxLines).toBe(2)
  })
})
