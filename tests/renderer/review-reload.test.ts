import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from '../../src/shared/project'
import { DEFAULT_SUBTITLE_STYLE, type ProjectFile } from '../../src/shared/types'
import type { ExperimentalReviewRecord } from '../../src/shared/review/types'
import { useReviewStore } from '../../src/renderer/src/review-store'

const projectWithCaption = (): ProjectFile => {
  const project = createEmptyProject('Review reload')
  const track = project.tracks.find((item) => item.kind === 'subtitle')!
  track.clips = [{
    id: 'caption-reload',
    name: 'Caption reload',
    kind: 'subtitle',
    startUs: 0,
    durationUs: 1_000_000,
    sourceInUs: 0,
    enabled: true,
    text: '字幕',
    style: structuredClone(DEFAULT_SUBTITLE_STYLE)
  }]
  return project
}

describe('review reload hydration', () => {
  beforeEach(() => useReviewStore.getState().stop())

  it('hydrates persisted decisions before reopening the same project id', () => {
    const project = projectWithCaption()
    expect(useReviewStore.getState().start(project, 'caption-reload')).toBe(true)
    const record = useReviewStore.getState().decide(project, 'good')
    expect(record).not.toBeNull()

    useReviewStore.getState().stop()
    useReviewStore.getState().hydrate(project, [record as ExperimentalReviewRecord])
    expect(useReviewStore.getState().decisions['caption-reload']?.rating).toBe('good')
    expect(useReviewStore.getState().start(project, 'caption-reload')).toBe(true)
    expect(useReviewStore.getState().decisions['caption-reload']?.rating).toBe('good')
  })
})
