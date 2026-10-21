import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addClipToTrack, createClipForAsset, createEmptyProject, createTrack } from '../../src/shared/project'
import type { MediaAsset, ProjectFile } from '../../src/shared/types'
import Timeline from '../../src/renderer/src/components/Timeline'
import { useEditorStore } from '../../src/renderer/src/store'

// Waveform is rendered once per audio/video clip item, so its render count per clip id equals the item's render count.
const renders = vi.hoisted(() => new Map<string, number>())
vi.mock('../../src/renderer/src/components/Waveform', () => ({
  peakCountForPixelWidth: () => 16,
  Waveform: ({ clip }: { clip: { id: string } }): null => {
    renders.set(clip.id, (renders.get(clip.id) ?? 0) + 1)
    return null
  }
}))

const asset: MediaAsset = {
  id: 'media', name: 'source.mp4', path: 'C:\\source.mp4', kind: 'video', durationUs: 60_000_000,
  width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, hasAudio: true,
  fileSize: 1, modifiedAt: '2026-08-13T00:00:00.000Z', offline: false
}

const PAIRS = 12

const fixture = (): ProjectFile => {
  let project: ProjectFile = { ...createEmptyProject('render count'), media: [asset] }
  project = { ...project, tracks: [...project.tracks, createTrack('media', 2)] }
  const [videoTrack, audioTrack] = project.tracks.filter((track) => track.kind === 'media')
  for (let index = 0; index < PAIRS; index += 1) {
    const startUs = index * 1_000_000
    const video = { ...createClipForAsset(asset, startUs, 500_000), id: `v${index}`, name: `vid${String(index).padStart(2, '0')}`, linkGroupId: `g${index}` }
    const audio = { ...createClipForAsset(asset, startUs, 500_000), id: `a${index}`, name: `aud${String(index).padStart(2, '0')}`, kind: 'audio' as const, linkGroupId: `g${index}`, audio: { volumeDb: 0, pan: 0, fadeInUs: 0, fadeOutUs: 0 } }
    project = addClipToTrack(project, videoTrack!.id, video)
    project = addClipToTrack(project, audioTrack!.id, audio)
  }
  return project
}

const pointer = (type: string, clientX: number, clientY = 0): Event => {
  const Ctor = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent
  return new Ctor(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 })
}

describe('timeline clip rendering during drags and playback', () => {
  let container: HTMLDivElement
  let root: Root
  let frames: Array<() => void>

  const flushFrame = (): void => {
    const pending = frames
    frames = []
    act(() => { for (const callback of pending) callback() })
  }
  const clipElement = (name: string): HTMLElement => {
    const found = [...container.querySelectorAll<HTMLElement>('.timeline-clip')].find((element) => (element.getAttribute('aria-label') ?? '').includes(name))
    if (!found) throw new Error(`clip ${name} not rendered`)
    return found
  }
  const countsFor = (...ids: string[]): number[] => ids.map((id) => renders.get(id) ?? 0)

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    frames = []
    const schedule = (callback: FrameRequestCallback): number => frames.push(() => callback(0))
    vi.stubGlobal('requestAnimationFrame', schedule)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    window.requestAnimationFrame = schedule
    window.cancelAnimationFrame = () => undefined
    renders.clear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => { useEditorStore.getState().loadProject(fixture()) })
    act(() => { root.render(createElement(Timeline)) })
    flushFrame()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('re-renders only the dragged clip and its linked partner while a drag moves', () => {
    const lanes = [...container.querySelectorAll<HTMLElement>('.track-lane')]
    document.elementFromPoint = () => lanes[0] ?? null
    const grabbed = clipElement('vid03')
    const before = new Map([...renders])
    expect(renders.size).toBe(PAIRS * 2)

    act(() => { grabbed.dispatchEvent(pointer('pointerdown', 100)) })
    for (const x of [105, 110, 115, 120, 125]) act(() => { window.dispatchEvent(pointer('pointermove', x)) })
    // Five pointer moves inside one frame are coalesced: nothing has rendered a drag yet.
    expect(container.querySelectorAll('.timeline-clip.is-dragging')).toHaveLength(0)
    flushFrame()
    for (const x of [130, 135, 140]) act(() => { window.dispatchEvent(pointer('pointermove', x)) })
    flushFrame()

    const dragging = [...container.querySelectorAll('.timeline-clip.is-dragging')].map((element) => element.getAttribute('aria-label'))
    expect(dragging).toHaveLength(2)
    for (let index = 0; index < PAIRS; index += 1) {
      const delta = [renders.get(`v${index}`)! - before.get(`v${index}`)!, renders.get(`a${index}`)! - before.get(`a${index}`)!]
      if (index === 3) expect(delta.every((value) => value > 0)).toBe(true)
      else expect(delta).toEqual([0, 0])
    }

    // The grabbed pair renders once per applied frame, not once per pointer event.
    const afterTwoFrames = countsFor('v3')[0]!
    for (const x of [150, 160, 170]) act(() => { window.dispatchEvent(pointer('pointermove', x)) })
    flushFrame()
    expect(countsFor('v3')[0]! - afterTwoFrames).toBe(1)

    const beforeUs = useEditorStore.getState().project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'v3')!.startUs
    act(() => { window.dispatchEvent(pointer('pointerup', 170)) })
    const afterUs = useEditorStore.getState().project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'v3')!.startUs
    expect(afterUs).toBeGreaterThan(beforeUs)
    expect(container.querySelectorAll('.timeline-clip.is-dragging')).toHaveLength(0)
  })

  it('does not re-render any clip when only the playhead moves during playback', () => {
    const before = new Map([...renders])
    act(() => { useEditorStore.setState({ playing: true }) })
    for (const us of [100_000, 200_000, 300_000, 400_000]) act(() => { useEditorStore.getState().setPlayhead(us) })
    expect(new Map([...renders])).toEqual(before)
    expect(container.querySelector('.playhead-hit-area')?.getAttribute('aria-label')).toContain('再生位置')
    act(() => { useEditorStore.setState({ playing: false }) })
  })
})
