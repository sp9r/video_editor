import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSubtitlePrerenderPlan, PreviewSubtitleFrames, subtitleFrameKey } from '../../src/renderer/src/preview-subtitle-frames'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types'
import type { DesktopApi, ProjectFile } from '../../src/shared/types'

type Cue = { id: string; startUs: number; durationUs: number; animation?: 'none' | 'fade' | 'pop'; text?: string }

const project = (cues: Cue[]): ProjectFile => ({
  sequence: { width: 1280, height: 720, frameRate: { numerator: 30, denominator: 1 }, sampleRate: 48000, backgroundColor: '#000000' },
  media: [],
  tracks: [{
    id: 's', name: 'C1', kind: 'subtitle', locked: false, muted: false, hidden: false,
    clips: cues.map((cue) => ({ id: cue.id, name: cue.id, kind: 'subtitle', text: cue.text ?? cue.id, startUs: cue.startUs, durationUs: cue.durationUs, sourceInUs: 0, enabled: true, style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), animation: cue.animation ?? 'none', animationDurationUs: cue.animation ? 500_000 : 0 } }))
  }]
}) as unknown as ProjectFile

describe('subtitle frame identity and plan', () => {
  it('shares one image per static state and one per phase while animating', () => {
    const p = project([{ id: 'a', startUs: 0, durationUs: 3_000_000, animation: 'fade' }])
    expect(subtitleFrameKey(p, 3)).not.toBe(subtitleFrameKey(p, 4))
    expect(subtitleFrameKey(p, 40)).toBe(subtitleFrameKey(p, 41))
  })

  it('keeps the image of a cue that only moved on the timeline', () => {
    const a = project([{ id: 'a', startUs: 1_000_000, durationUs: 2_000_000 }])
    const b = project([{ id: 'a', startUs: 2_000_000, durationUs: 2_000_000 }])
    expect(subtitleFrameKey(a, 40)).toBe(subtitleFrameKey(b, 70))
  })

  it('plans exactly the distinct looks: one per static state, one per animated frame', () => {
    const p = project([
      { id: 'a', startUs: 0, durationUs: 3_000_000, animation: 'fade' },
      { id: 'b', startUs: 4_000_000, durationUs: 1_000_000 }
    ])
    const plan = buildSubtitlePrerenderPlan(p)
    const keys = plan.map((item) => item.key)
    expect(new Set(keys).size).toBe(keys.length)
    // fade-in frames 0..14, first settled frame 15, fade-out frames 76..89, end frame 90, then b
    const frames = plan.map((item) => item.frameIndex)
    expect(frames[0]).toBe(0)
    expect(frames).toContain(15)
    expect(frames).toContain(76)
    expect(frames).toContain(120)
    // every frame with a subtitle maps to a planned key
    const planned = new Set(keys)
    for (let frame = 0; frame < 160; frame += 1) {
      const key = subtitleFrameKey(p, frame)
      const active = frame < 90 || (frame >= 120 && frame < 150)
      if (active) expect(planned.has(key), `frame ${frame}`).toBe(true)
    }
  })

  it('does not plan frames without a subtitle', () => {
    const p = project([{ id: 'a', startUs: 1_000_000, durationUs: 500_000 }])
    expect(buildSubtitlePrerenderPlan(p).map((item) => item.frameIndex)).toEqual([30])
  })
})

describe('PreviewSubtitleFrames', () => {
  let batches: Array<{ frames: number[] }>
  let release: Array<() => void>

  beforeEach(() => {
    batches = []
    release = []
    vi.stubGlobal('Image', class {
      src = ''
      crossOrigin = ''
      decode(): Promise<void> { return Promise.resolve() }
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const fakeApi = (instant = true): Pick<DesktopApi, 'renderSubtitleFrames' | 'mediaUrl'> => ({
    mediaUrl: (path: string) => `media://${path}`,
    renderSubtitleFrames: (p: ProjectFile, frames: number[]) => {
      batches.push({ frames })
      const result = {
        ffmpegStarted: true,
        frames: frames.map((frameIndex) => ({ frameIndex, framePath: `C:/cache/${subtitleFrameKey(p, frameIndex).length}-${frameIndex}.png`, subtitleStateFingerprint: 'x' }))
      }
      return instant ? Promise.resolve(result) : new Promise((resolve) => { release.push(() => resolve(result)) })
    }
  })

  const flush = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 3)) }

  it('renders the current look first, then the rest nearest to the playhead outward', async () => {
    const cues: Cue[] = Array.from({ length: 30 }, (_, index) => ({ id: `c${index}`, startUs: index * 2_000_000, durationUs: 1_500_000 }))
    const p = project(cues)
    const frames = new PreviewSubtitleFrames(fakeApi(), () => undefined)
    frames.ensure(p, 15 * 60) // cue 15 is showing
    await flush()
    expect(batches[0]?.frames[0]).toBe(15 * 60)
    const order = batches.flatMap((batch) => batch.frames)
    // the next cues follow before cues further away
    expect(order.indexOf(16 * 60)).toBeLessThan(order.indexOf(25 * 60))
    for (let round = 0; round < 6; round += 1) { frames.ensure(p, 15 * 60); await flush() }
    expect(new Set(batches.flatMap((batch) => batch.frames)).size).toBe(30)
  })

  it('draws the exact decoded image once ready and never a different cue meanwhile', async () => {
    const p = project([{ id: 'a', startUs: 0, durationUs: 1_000_000 }, { id: 'b', startUs: 1_000_000, durationUs: 1_000_000 }])
    const changes = vi.fn()
    const frames = new PreviewSubtitleFrames(fakeApi(false), changes)
    frames.ensure(p, 5)
    expect(frames.imageFor(p, 5)).toEqual({ image: null, exact: false })
    release.splice(0).forEach((resolve) => resolve())
    await flush()
    frames.ensure(p, 5)
    await flush()
    const ready = frames.imageFor(p, 5)
    expect(ready.exact).toBe(true)
    expect(ready.image).not.toBeNull()
    // cue b never borrows a's image: it is its own image or nothing
    expect(frames.imageFor(p, 40).image).not.toBe(ready.image)
    expect(changes).toHaveBeenCalled()
  })

  it('re-plans only the edited cue', async () => {
    const cues: Cue[] = Array.from({ length: 10 }, (_, index) => ({ id: `c${index}`, startUs: index * 2_000_000, durationUs: 1_500_000 }))
    const p = project(cues)
    const frames = new PreviewSubtitleFrames(fakeApi(), () => undefined)
    for (let round = 0; round < 6; round += 1) { frames.ensure(p, 0); await flush() }
    const rendered = batches.flatMap((batch) => batch.frames).length
    expect(rendered).toBe(10)
    const edited = project(cues.map((cue) => cue.id === 'c4' ? { ...cue, text: 'edited' } : cue))
    batches.length = 0
    frames.ensure(edited, 4 * 60)
    await flush()
    for (let round = 0; round < 3; round += 1) { frames.ensure(edited, 4 * 60); await flush() }
    expect(batches.flatMap((batch) => batch.frames)).toEqual([4 * 60])
  })
})
