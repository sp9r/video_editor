import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from '../../src/shared/project'
import { DEFAULT_SUBTITLE_STYLE, type ProjectFile } from '../../src/shared/types'
import { useReviewStore } from '../../src/renderer/src/review-store'

const makeProject = (): ProjectFile => {
  const project = createEmptyProject('Review fixture')
  const track = project.tracks.find((item) => item.kind === 'subtitle')!
  track.clips = [0, 1, 2].map((index) => ({
    id: `caption-${index}`,
    name: `Caption ${index}`,
    kind: 'subtitle' as const,
    startUs: index * 2_000_000,
    durationUs: 1_000_000,
    sourceInUs: 0,
    enabled: true,
    text: `字幕${index}`,
    style: structuredClone(DEFAULT_SUBTITLE_STYLE)
  }))
  return project
}

describe('review store session semantics', () => {
  beforeEach(() => useReviewStore.getState().stop())

  it('keeps an immutable baseline and compares only the final project state', () => {
    const project = makeProject()
    expect(useReviewStore.getState().start(project, 'caption-0')).toBe(true)
    const edited = structuredClone(project)
    const caption = edited.tracks.find((track) => track.kind === 'subtitle')!.clips[0]
    if (caption?.kind === 'subtitle') caption.text = '別の字幕'
    const record = useReviewStore.getState().decide(edited, 'corrected')
    expect(record?.baseline.captions.find((item) => item.id === 'caption-0')?.text).toBe('字幕0')
    expect(record?.final.captions.find((item) => item.id === 'caption-0')?.text).toBe('別の字幕')
    expect(record?.correction.primary).toBe('text_edit')
  })

  it('tracks decisions, navigation, progress and session-local skip', () => {
    const project = makeProject()
    const state = useReviewStore.getState()
    state.start(project, 'caption-0')
    state.decide(project, 'good')
    state.next(project)
    expect(useReviewStore.getState().targetIds[useReviewStore.getState().targetIndex]).toBe('caption-1')
    useReviewStore.getState().decide(project, 'skip')
    useReviewStore.getState().next(project)
    expect(useReviewStore.getState().targetIds[useReviewStore.getState().targetIndex]).toBe('caption-2')
    expect(useReviewStore.getState().decisions['caption-1']?.rating).toBe('skip')
    useReviewStore.getState().previous(project)
    expect(useReviewStore.getState().targetIds[useReviewStore.getState().targetIndex]).toBe('caption-1')
    useReviewStore.getState().stop()
    useReviewStore.getState().start(project, 'caption-1')
    expect(useReviewStore.getState().targetIds[useReviewStore.getState().targetIndex]).toBe('caption-1')
  })
})
