import { describe, expect, it } from 'vitest'
import { applyAutoCaptionResultToProject, autoCaptionResultToTranscript, createAutoCaptionAutomationPlan } from '../../src/shared/auto-caption-adapter'
import { createEmptyProject, createSubtitleClip, validateProject } from '../../src/shared/project'
import { buildSubtitleRenderSpec } from '../../src/shared/subtitle-render'
import { createSilenceCutTimeMapper } from '../../src/shared/silence-cut'
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

  it('uses the same source mapper for caption, SubtitleWord, and SubtitleEditUnit timing', () => {
    const clip = { id: 'clip-1', kind: 'video' as const, startUs: 10_000_000, sourceInUs: 20_000_000, durationUs: 10_000_000 }
    const mappedResult = {
      ...result,
      rawWords: [{ id: 'source-word:0', text: '字幕', startUs: 29_000_000, endUs: 30_000_000 }],
      captions: [{ ...result.captions[0]!, startUs: 29_000_000, endUs: 30_000_000 }]
    }
    const mapper = createSilenceCutTimeMapper(clip, [{ startUs: 20_000_000, endUs: 25_000_000 }, { startUs: 28_000_000, endUs: 30_000_000 }])
    const applied = applyAutoCaptionResultToProject(createEmptyProject('mapped silence'), clip, mappedResult, { sourceTimeMapper: mapper })
    const generated = applied.project.tracks.at(-1)?.clips[0]
    expect(generated?.kind === 'subtitle' ? [generated.startUs, generated.durationUs] : undefined).toEqual([16_000_000, 1_000_000])
    expect(generated?.kind === 'subtitle' ? generated.words?.[0] : undefined).toMatchObject({ startUs: 16_000_000, endUs: 17_000_000 })
    expect(generated?.kind === 'subtitle' ? generated.editUnits?.[0] : undefined).toMatchObject({ startUs: 16_000_000, endUs: 17_000_000 })
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

  it('attaches ownership when the documented display normalization only removes punctuation', () => {
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
    expect(command.words?.[0]).toMatchObject({ id: 'source-word:0', text: '字幕。' })
    const applied = applyAutoCaptionResultToProject(project, clip, normalized)
    const generated = applied.project.tracks.at(-1)?.clips[0]
    expect(generated?.kind === 'subtitle' ? generated.editUnits?.map((unit) => unit.text) : []).toEqual(['字幕'])
  })

  it('does not attach word truth for an unrelated display mismatch', () => {
    const corrected = {
      ...result,
      rawWords: [{ ...result.rawWords[0]!, text: '字幕' }],
      captions: [{ ...result.captions[0]!, text: '別の字幕', textStatus: 'manually_corrected' as const }]
    }
    const project = createEmptyProject('mismatch')
    const clip = { id: 'clip-1', kind: 'video' as const, startUs: 10_000_000, sourceInUs: 20_000_000, durationUs: 10_000_000 }
    const plan = createAutoCaptionAutomationPlan(project, clip, corrected)
    const command = plan.commands[0]
    if (!command || command.type !== 'insert-subtitle') throw new Error('expected subtitle command')
    expect(command.words).toBeUndefined()
  })

  it('preserves point words as source metadata and derives point edit units', () => {
    const point = {
      ...result,
      rawWords: [
        { id: 'source-word:0', text: '字幕', startUs: 25_000_000, endUs: 25_000_000 },
        { id: 'source-word:1', text: 'です', startUs: 25_000_000, endUs: 26_000_000 }
      ],
      captions: [{ ...result.captions[0]!, text: '字幕です', sourceWordIds: ['source-word:0', 'source-word:1'] }]
    }
    const project = createEmptyProject('point word')
    const clip = { id: 'clip-1', kind: 'video' as const, startUs: 10_000_000, sourceInUs: 20_000_000, durationUs: 10_000_000 }
    const applied = applyAutoCaptionResultToProject(project, clip, point)
    const generated = applied.project.tracks.at(-1)?.clips[0]
    expect(generated?.kind === 'subtitle' ? generated.words?.[0] : undefined).toMatchObject({ startUs: 15_000_000, endUs: 15_000_000 })
    expect(generated?.kind === 'subtitle' ? generated.editUnits?.[0] : undefined).toMatchObject({ timingProvenance: 'point', startUs: 15_000_000, endUs: 15_000_000 })
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

  it('applies the selected subtitle template to the generated track', () => {
    const project = createEmptyProject('template')
    const clip = { id: 'clip-1', kind: 'video' as const, startUs: 10_000_000, sourceInUs: 20_000_000, durationUs: 10_000_000 }
    const applied = applyAutoCaptionResultToProject(project, clip, result, { subtitleTemplate: 'minimal' })
    const generated = applied.project.tracks.at(-1)?.clips[0]
    expect(generated?.kind === 'subtitle' ? generated.style : undefined).toMatchObject({ outlineWidth: 1, shadowBlur: 0, bold: false })
  })
})
