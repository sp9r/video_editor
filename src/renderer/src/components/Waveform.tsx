import { useEffect, useState } from 'react'
import type { MediaAsset, TimelineClip } from '../../../shared/types'

const PEAK_COUNT = 96
const cache = new Map<string, Promise<number[]>>()

const waveformKey = (asset: MediaAsset, clip: TimelineClip): string =>
  [asset.path, clip.sourceInUs, clip.durationUs, PEAK_COUNT].join('|')

const loadPeaks = (asset: MediaAsset, clip: TimelineClip): Promise<number[]> => {
  if (!window.spectra) return Promise.resolve([])
  const key = waveformKey(asset, clip)
  const existing = cache.get(key)
  if (existing) return existing
  const request = window.spectra.getWaveformPeaks({
    mediaPath: asset.path,
    sourceInUs: clip.sourceInUs,
    durationUs: clip.durationUs,
    peakCount: PEAK_COUNT
  }).catch((error: unknown) => {
    cache.delete(key)
    throw error
  })
  cache.set(key, request)
  return request
}

export function Waveform({ asset, clip }: { asset?: MediaAsset; clip: Extract<TimelineClip, { kind: 'video' | 'audio' }> }): React.JSX.Element | null {
  const [peaks, setPeaks] = useState<number[] | null>(null)
  useEffect(() => {
    let active = true
    setPeaks(null)
    if (!asset || !asset.hasAudio || asset.offline) return () => { active = false }
    void loadPeaks(asset, clip).then((next) => {
      if (active) setPeaks(next)
    }).catch((error: unknown) => {
      console.warn('[waveform] unable to load peaks', error)
      if (active) setPeaks([])
    })
    return () => { active = false }
  }, [asset, clip])

  if (!peaks?.length) return null
  return (
    <span className="waveform" aria-label="音声波形">
      {peaks.map((peak, index) => <i key={index} style={{ height: `${Math.max(4, peak * 100)}%` }} />)}
    </span>
  )
}
