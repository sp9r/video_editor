import { describe, expect, it, vi } from 'vitest'
import { PreviewAudioMixer, previewAudioChannelGains, previewAudioClipsForPlayback, previewAudioIsActive, previewAudioSourceTimeUs, previewAudioVolume, previewPlaybackTimeUs, syncPreviewMediaTime } from '../../src/renderer/src/preview-audio'
import type { PreviewPlan, PreviewPlanClip } from '../../src/shared/types'

const clip = (overrides: Partial<PreviewPlanClip> = {}): PreviewPlanClip => ({
  clipId: 'audio-1',
  kind: 'audio',
  startUs: 10_000_000,
  durationUs: 5_000_000,
  sourceInUs: 20_000_000,
  enabled: true,
  sourceMediaId: 'asset-1',
  volumeDb: -6,
  pan: 0,
  ...overrides
})

describe('Preview audio timeline mapping', () => {
  it('uses the decoded audio clock and holds the timeline during buffering and seek', () => {
    const item = clip()
    const plan = { audioClips: [item], videoClips: [] } as unknown as PreviewPlan
    const media = { currentTime: 20.04, readyState: 4, seeking: false, paused: false, ended: false }
    expect(previewPlaybackTimeUs(plan, 10_000_000, 500_000, () => media)).toBeCloseTo(10_040_000)
    expect(previewPlaybackTimeUs(plan, 10_000_000, 500_000, () => ({ ...media, readyState: 1 }))).toBe(10_000_000)
    expect(previewPlaybackTimeUs(plan, 10_000_000, 500_000, () => ({ ...media, seeking: true }))).toBe(10_000_000)
    expect(previewPlaybackTimeUs(plan, 10_000_000, 500_000, () => null)).toBe(10_000_000)
    expect(previewPlaybackTimeUs(plan, 14_990_000, 500_000, () => ({ ...media, currentTime: 25.1 }))).toBe(15_000_000)
    expect(previewPlaybackTimeUs(plan, 15_000_000, 500_000, () => media)).toBe(15_500_000)
  })

  it('uses video when audio is absent and a wall clock for images and empty gaps', () => {
    const plan = { audioClips: [], videoClips: [clip({ kind: 'video' })] } as unknown as PreviewPlan
    expect(previewPlaybackTimeUs(plan, 10_000_000, 500_000, (_, kind) => {
      expect(kind).toBe('video')
      return { currentTime: 20.05, readyState: 4, seeking: false, paused: false, ended: false }
    })).toBeCloseTo(10_050_000)
    expect(previewPlaybackTimeUs(plan, 10_000_000, 500_000, () => undefined)).toBe(10_500_000)
  })
  it('does not repeatedly abort a pending decoder seek, then catches up to the latest playhead', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    let time = 0
    const setter = vi.fn((value: number) => { time = value })
    const media = { readyState: 0, seeking: false, get currentTime() { return time }, set currentTime(value: number) { setter(value) } }
    syncPreviewMediaTime(media, 0.5)
    expect(setter).not.toHaveBeenCalled()
    media.readyState = 1
    syncPreviewMediaTime(media, 0.5)
    expect(setter).not.toHaveBeenCalled()
    media.readyState = 2
    syncPreviewMediaTime(media, 0.5)
    expect(setter).toHaveBeenLastCalledWith(0.5)
    media.seeking = true
    for (let frame = 0; frame < 60; frame++) syncPreviewMediaTime(media, 1 + frame / 60)
    expect(setter).toHaveBeenCalledOnce()
    media.seeking = false
    clock.mockReturnValue(600)
    syncPreviewMediaTime(media, 2)
    expect(setter).toHaveBeenLastCalledWith(2)
    // The seek-complete callback must not reissue the same target when the
    // decoder still reports its previous position.
    time = 0
    for (let event = 0; event < 20; event++) syncPreviewMediaTime(media, 2)
    expect(setter).toHaveBeenCalledTimes(2)
    clock.mockRestore()
  })
  it('maps play/pause seek and clip boundaries to the source interval', () => {
    const item = clip()
    expect(previewAudioIsActive(item, 9_999_999)).toBe(false)
    expect(previewAudioIsActive(item, 10_000_000)).toBe(true)
    expect(previewAudioSourceTimeUs(item, 10_000_000)).toBe(20_000_000)
    expect(previewAudioSourceTimeUs(item, 12_500_000)).toBe(22_500_000)
    expect(previewAudioIsActive(item, 15_000_000)).toBe(false)
  })

  it('preserves source mapping after split and trim', () => {
    const left = clip({ clipId: 'left', durationUs: 2_000_000 })
    const right = clip({ clipId: 'right', startUs: 12_000_000, sourceInUs: 22_000_000, durationUs: 3_000_000 })
    const trimmed = clip({ startUs: 11_000_000, sourceInUs: 21_000_000, durationUs: 2_000_000 })
    expect(previewAudioSourceTimeUs(left, 11_500_000)).toBe(21_500_000)
    expect(previewAudioSourceTimeUs(right, 12_000_000)).toBe(22_000_000)
    expect(previewAudioSourceTimeUs(trimmed, 12_000_000)).toBe(22_000_000)
  })

  it('clamps volume consistently with the editor audio model', () => {
    expect(previewAudioVolume(0)).toBe(1)
    expect(previewAudioVolume(-6)).toBeCloseTo(0.501187)
    expect(previewAudioVolume(-120)).toBeCloseTo(10 ** (-96 / 20))
    expect(previewAudioVolume(30)).toBeCloseTo(10 ** (24 / 20))
  })

  it('does not activate disabled clips', () => {
    expect(previewAudioIsActive(clip({ enabled: false }), 12_000_000)).toBe(false)
  })

  it('preserves positive gain, stereo pan attenuation and FFmpeg mono upmix levels', () => {
    expect(previewAudioChannelGains(clip({ volumeDb: 12, pan: 0.25 }))).toEqual([10 ** (12 / 20) * 0.75, 10 ** (12 / 20)])
    expect(previewAudioChannelGains(clip({ volumeDb: 0, pan: -1 }))).toEqual([1, 0])
    expect(previewAudioChannelGains(clip({ volumeDb: 0, pan: 0 }), 1)).toEqual([Math.SQRT1_2, Math.SQRT1_2])
  })

  it('uses Web Audio for amplification, schedules overlapping fades, and releases detached media', () => {
    const gains: Array<{ gain: { cancelScheduledValues: ReturnType<typeof vi.fn>; setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> } }> = []
    const nodes: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
    const node = () => {
      const result = { connect: vi.fn(), disconnect: vi.fn() }
      result.connect.mockImplementation((destination) => destination)
      nodes.push(result)
      return result
    }
    const context = {
      currentTime: 100, state: 'suspended', destination: {},
      createMediaElementSource: vi.fn(() => node()),
      createGain: () => {
        const result = { ...node(), gain: { cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() } }
        gains.push(result)
        return result
      },
      createChannelSplitter: () => node(), createChannelMerger: () => node(),
      resume: vi.fn(async () => undefined), close: vi.fn(async () => undefined)
    }
    const audio = document.createElement('audio')
    const pause = vi.spyOn(audio, 'pause').mockImplementation(() => undefined)
    const mixer = new PreviewAudioMixer(context as unknown as AudioContext)
    const item = clip({ volumeDb: 24, pan: 0.5, fadeInUs: 4_000_000, fadeOutUs: 4_000_000 })
    mixer.update(audio, item, 12_000_000, true)
    expect(audio.volume).toBe(1)
    expect(gains[2]?.gain.setValueAtTime).toHaveBeenLastCalledWith(10 ** (24 / 20) * 0.5, 100)
    expect(gains[3]?.gain.setValueAtTime).toHaveBeenLastCalledWith(10 ** (24 / 20), 100)
    expect(gains[0]?.gain.setValueAtTime).toHaveBeenLastCalledWith(0.5, 100)
    expect(gains[0]?.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, 102)
    expect(gains[1]?.gain.setValueAtTime).toHaveBeenLastCalledWith(0.75, 100)
    expect(gains[1]?.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 103)
    expect(context.resume).toHaveBeenCalled()
    mixer.release(audio)
    expect(pause).toHaveBeenCalledOnce()
    expect(nodes.every((item) => item.disconnect.mock.calls.length === 1)).toBe(true)
    // React may detach and reattach a ref to the same DOM element.
    mixer.update(audio, item, 13_000_000, false)
    expect(context.createMediaElementSource).toHaveBeenCalledOnce()
    mixer.dispose()
    expect(context.close).toHaveBeenCalledOnce()
  })

  it('keeps active mixes and only one next prefetch per source asset', () => {
    const clips = [
      clip({ clipId: 'cut-1', startUs: 0, durationUs: 2_000_000, sourceInUs: 0 }),
      clip({ clipId: 'cut-2', startUs: 2_000_000, durationUs: 2_000_000, sourceInUs: 2_000_000 }),
      clip({ clipId: 'cut-3', startUs: 4_000_000, durationUs: 2_000_000, sourceInUs: 4_000_000 }),
      clip({ clipId: 'other-track', startUs: 1_000_000, durationUs: 5_000_000, sourceMediaId: 'asset-2' })
    ]
    expect(previewAudioClipsForPlayback(clips, 2_500_000).map((item) => item.clipId)).toEqual(['other-track', 'cut-2', 'cut-3'])
  })

  it('does not retain an unbounded list of sequential clips', () => {
    const clips = Array.from({ length: 100 }, (_, index) => clip({ clipId: `cut-${index}`, startUs: index * 1_000_000, durationUs: 1_000_000, sourceInUs: index * 1_000_000 }))
    expect(previewAudioClipsForPlayback(clips, 50_500_000)).toHaveLength(2)
  })
})
