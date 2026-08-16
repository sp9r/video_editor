import { useEffect, useState } from 'react'
import type { MediaAsset, TimelineClip } from '../../../shared/types'
import { previewDiagnosticStore } from '../preview-performance-diagnostics'

const cache = new Map<string, Promise<number[]>>()

export const peakCountForPixelWidth = (pixelWidth: number): number =>
  Math.min(4096, Math.max(16, Math.ceil(Math.max(16, pixelWidth) / 2)))

const waveformKey = (asset: MediaAsset, clip: TimelineClip, peakCount: number): string =>
  [asset.path, asset.fileSize, asset.modifiedAt, clip.sourceInUs, clip.durationUs, peakCount].join('|')

const loadPeaks = (asset: MediaAsset, clip: TimelineClip, peakCount: number): Promise<number[]> => {
  if (!window.spectra) return Promise.resolve([])
  const key = waveformKey(asset, clip, peakCount)
  const existing = cache.get(key)
  if (existing) {
    previewDiagnosticStore.recordWaveformRequest(true)
    return existing
  }
  previewDiagnosticStore.recordWaveformRequest(false)
  const request = window.spectra.getWaveformPeaks({
    mediaPath: asset.path,
    sourceInUs: clip.sourceInUs,
    durationUs: clip.durationUs,
    peakCount
  }).catch((error: unknown) => {
    cache.delete(key)
    throw error
  })
  cache.set(key, request)
  return request
}

export function Waveform({ asset, clip, peakCount }: { asset?: MediaAsset; clip: Extract<TimelineClip, { kind: 'video' | 'audio' }>; peakCount: number }): React.JSX.Element | null {
  const [peaks, setPeaks] = useState<number[] | null>(null)
  useEffect(() => {
    let active = true
    setPeaks(null)
    if (!asset || !asset.hasAudio || asset.offline) return () => { active = false }
    void loadPeaks(asset, clip, peakCount).then((next) => {
      if (active) setPeaks(next)
    }).catch((error: unknown) => {
      console.warn('[waveform] unable to load peaks', error)
      if (active) setPeaks([])
    })
    return () => { active = false }
  }, [asset, clip, peakCount])

  if (!peaks?.length) return null
  return (
    <span className="waveform" aria-label="音声波形">
      {peaks.map((peak, index) => <i key={index} style={{ height: `${Math.max(4, peak * 100)}%` }} />)}
    </span>
  )
}
