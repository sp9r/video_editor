import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject } from '../../src/shared/project'
import { DEFAULT_SUBTITLE_STYLE, type ProjectFile } from '../../src/shared/types'
import type { AutoCaptionBaseline } from '../../src/shared/auto-caption-contract'

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }))

import { app } from 'electron'
import { finishFullCorrectionSession, loadFullCorrectionSessions, startFullCorrectionSession } from '../../src/main/full-correction-service'

const roots: string[] = []

const makeProject = (): ProjectFile => {
  const project = createEmptyProject('service fixture')
  const track = project.tracks.find((item) => item.kind === 'subtitle')!
  track.name = '自動字幕'
  track.clips = [{ id: 'clip-1', name: '字幕', kind: 'subtitle', startUs: 0, durationUs: 1_000_000, sourceInUs: 0, enabled: true, text: '元字幕', style: structuredClone(DEFAULT_SUBTITLE_STYLE), sourceCaptionId: 'caption-1', sourceJobId: 'job-1', words: [{ id: 'word-1', text: '元字幕', startUs: 0, endUs: 1_000_000 }], editUnits: [{ id: 'unit-1', text: '元字幕', parentSourceWordId: 'word-1', startUs: 0, endUs: 1_000_000, timingProvenance: 'estimated' }] }]
  return project
}

const makeBaseline = (): AutoCaptionBaseline => ({
  version: 'experimental.auto-caption-baseline.v1', jobId: 'job-1', createdAt: '2026-08-15T00:00:00.000Z', projectFingerprint: 'before', mediaFingerprint: 'media',
  sourceClip: { clipId: 'video-1', assetId: 'asset-1', startUs: 0, sourceInUs: 0, durationUs: 1_000_000 },
  timelineMapping: { formula: 'timelineUs = clip.startUs + (sourceUs - clip.sourceInUs)', clipStartUs: 0, sourceInUs: 0 },
  rawWords: [{ id: 'word-1', text: '元字幕', startUs: 0, endUs: 1_000_000 }],
  captions: [{ id: 'caption-1', text: '元字幕', sourceWordIds: ['word-1'], startUs: 0, endUs: 1_000_000, textStatus: 'as_transcribed', provenance: 'caption_algorithm' }],
  settings: { language: 'ja', maxChars: 32, maxLines: 2, segmentationMode: 'auto' }, provider: 'fake', model: 'fake', diagnostics: [], fallback: { used: false }
})

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'spectra-full-correction-'))
  roots.push(root)
  vi.mocked(app.getPath).mockReturnValue(root)
  const directory = path.join(root, 'experimental.auto-caption-baseline.v1')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'job-1.json'), `${JSON.stringify(makeBaseline())}\n`, 'utf8')
})

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('full correction main persistence', () => {
  it('persists active session, finishes after editing, round-trips, and ignores malformed sessions', async () => {
    const project = makeProject()
    const trackId = project.tracks.find((track) => track.kind === 'subtitle')!.id
    const active = await startFullCorrectionSession(project, trackId)
    expect(active.status).toBe('active')
    expect((await loadFullCorrectionSessions()).map((session) => session.sessionId)).toEqual([active.sessionId])

    const edited = structuredClone(project)
    const clip = edited.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === 'clip-1')
    if (clip?.kind === 'subtitle') {
      clip.text = '修正字幕'
      clip.words = undefined
      clip.editUnits = undefined
    }
    const finished = await finishFullCorrectionSession(edited, active.sessionId)
    expect(finished.status).toBe('finished')
    expect(finished.after?.captions[0]?.text).toBe('修正字幕')
    expect(finished.statistics.text).toBe(1)
    const artifactPath = path.join(String(vi.mocked(app.getPath).mock.results[0]?.value), 'experimental.full-correction.v1', `${active.sessionId}.json`)
    expect(await readFile(artifactPath, 'utf8')).not.toContain('source.mp4')

    await writeFile(path.join(path.dirname(artifactPath), 'malformed.json'), '{not-json', 'utf8')
    const loaded = await loadFullCorrectionSessions()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.status).toBe('finished')
  })
})
