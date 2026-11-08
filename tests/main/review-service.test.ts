import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => state.userData) } }))

import { experimentalReviewLogPath, loadExperimentalReviewRecords, saveExperimentalReviewRecord } from '../../src/main/review-service'
import type { ExperimentalReviewRecord } from '../../src/shared/review/types'

const record = (recordId: string, sessionId: string, captionId: string): ExperimentalReviewRecord => ({
  version: 'experimental.phase3.5b1', recordId, sessionId, decidedAt: recordId, rating: 'good',
  target: { captionId, trackId: 'subtitles' },
  provenance: { projectId: 'project', projectName: 'project', projectFingerprint: '{}', media: [] }
} as unknown as ExperimentalReviewRecord)

describe('review persistence transaction safety', () => {
  it('serializes concurrent upserts and preserves different records and replacement semantics', async () => {
    state.userData = await mkdtemp(join(tmpdir(), 'spectra-review-service-'))
    try {
      await Promise.all([
        ...Array.from({ length: 10 }, (_, index) => saveExperimentalReviewRecord(record(`r-${index}`, 'session', `caption-${index}`))),
        saveExperimentalReviewRecord(record('replacement', 'session', 'caption-0'))
      ])
      const loaded = await loadExperimentalReviewRecords()
      expect(loaded).toHaveLength(10)
      expect(loaded.find((item) => item.target.captionId === 'caption-0')?.recordId).toBe('replacement')
      expect(new Set(loaded.map((item) => item.target.captionId))).toEqual(new Set(Array.from({ length: 10 }, (_, index) => `caption-${index}`)))
      const raw = await readFile(experimentalReviewLogPath(), 'utf8')
      expect(JSON.parse(raw).records).toHaveLength(10)
    } finally {
      await rm(state.userData, { recursive: true, force: true })
    }
  })

  it('does not poison the queue after a write failure and leaves no temporary file', async () => {
    state.userData = await mkdtemp(join(tmpdir(), 'spectra-review-failure-'))
    try {
      const destination = experimentalReviewLogPath()
      await mkdir(destination, { recursive: true })
      await expect(saveExperimentalReviewRecord(record('failed', 'session', 'caption'))).rejects.toThrow()
      await rm(destination, { recursive: true, force: true })
      await saveExperimentalReviewRecord(record('recovered', 'session', 'caption'))
      expect((await loadExperimentalReviewRecords()).map((item) => item.recordId)).toEqual(['recovered'])
    } finally {
      await rm(state.userData, { recursive: true, force: true })
    }
  })
})
