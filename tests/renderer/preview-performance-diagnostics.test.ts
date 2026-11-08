import { afterEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from '../../src/shared/project'
import { previewDiagnosticContext, PreviewDiagnosticSession, previewDiagnosticStore, type PreviewDiagnosticContext } from '../../src/renderer/src/preview-performance-diagnostics'

const context = (): PreviewDiagnosticContext => {
  const project = createEmptyProject('preview diagnostic')
  project.media = [{
    id: 'asset-secret',
    name: 'private-video.mp4',
    path: 'C:\\Users\\private\\private-video.mp4',
    kind: 'video',
    durationUs: 20_000_000,
    width: 1920,
    height: 1080,
    frameRate: { numerator: 30, denominator: 1 },
    hasAudio: true,
    fileSize: 100,
    modifiedAt: '2026-08-16T00:00:00.000Z',
    offline: false
  }]
  return previewDiagnosticContext(project, { cssWidth: 960, cssHeight: 540, viewportWidth: 1280, viewportHeight: 720 }, 0, false)
}

afterEach(() => {
  previewDiagnosticStore.stop(context())
})

describe('Preview performance diagnostics', () => {
  it('aggregates playback, renderer, cache, and subsystem counters without per-frame logs', () => {
    let time = 0
    const session = new PreviewDiagnosticSession(context(), {
      clock: () => time,
      heap: () => ({ used: 100 + time, total: 200 + time })
    })
    session.recordPlaybackState(true, 0)
    session.recordAnimationFrame(0, 0)
    session.recordAnimationFrame(16, 16_000)
    session.recordAnimationFrame(140, 140_000)
    session.recordStoreUpdate(true, true, true)
    session.recordSubtitleVisualState('cue-a')
    session.recordSubtitleOverlayRequest('cue-a')
    session.recordSubtitleOverlayOutcome(false)
    session.recordSubtitleOverlayRequest('cue-a')
    session.recordSubtitleOverlayOutcome(true)
    session.recordWaveformRequest(false)
    session.recordWaveformRequest(true)
    session.recordAccurateRequest()
    session.recordAccurateOutcome(false, true)
    session.recordVideoPlaybackQuality({ droppedVideoFrames: 2, totalVideoFrames: 30 })
    time = 200
    const report = session.stop({ ...context(), playheadUs: 200_000, playing: true })

    expect(report.durationMs).toBe(200)
    expect(report.playback.playingMs).toBe(200)
    expect(report.playback.playheadAdvanceUs).toBe(200_000)
    expect(report.playback.realtimeRatio).toBe(1)
    expect(report.playback.droppedFrames).toBe(2)
    expect(report.renderer.requestAnimationFrameCallbacks).toBe(3)
    expect(report.renderer.averageFrameIntervalMs).toBe(70)
    expect(report.renderer.longFramesOver50Ms).toBe(1)
    expect(report.renderer.longFramesOver100Ms).toBe(1)
    expect(report.react.playheadUpdates).toBe(1)
    expect(report.react.projectStoreUpdates).toBe(1)
    expect(report.subtitle.redundantSameSubtitleRequests).toBe(1)
    expect(report.subtitle.overlayCacheHits).toBe(1)
    expect(report.waveform.recalculationsDuringPlayback).toBe(1)
    expect(report.accuratePreview.ffmpegStartsDuringPlayback).toBe(1)
    expect(report.performance.jsHeapUsedBytes).toBe(300)
  })

  it('exposes start, active, and stopped states through the diagnostic store', () => {
    const initial = previewDiagnosticStore.getSnapshot()
    expect(initial.active).toBe(false)
    expect(previewDiagnosticStore.start(context())).toBe(true)
    expect(previewDiagnosticStore.getSnapshot().active).toBe(true)
    previewDiagnosticStore.recordAnimationFrame(16, 16_000)
    const report = previewDiagnosticStore.stop(context())
    expect(report?.schemaVersion).toBe('spectra.preview-performance-diagnostic.v1')
    expect(previewDiagnosticStore.getSnapshot().active).toBe(false)
    expect(previewDiagnosticStore.getSnapshot().report).toBe(report)
  })

  it('does not include media paths or subtitle text in the report', () => {
    const report = new PreviewDiagnosticSession(previewDiagnosticContext(createEmptyProject('字幕本文は秘密'), {
      cssWidth: 100,
      cssHeight: 100,
      viewportWidth: 100,
      viewportHeight: 100
    }, 0, false)).stop()
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('字幕本文は秘密')
    expect(serialized).not.toContain('private-video.mp4')
    expect(serialized).not.toContain('C:\\Users')
  })
})
