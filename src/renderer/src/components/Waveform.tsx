import { useEffect, useState } from 'react'
import type { MediaAsset, TimelineClip } from '../../../shared/types'

const PEAK_COUNT = 96
const cache = new Map<string, Promise<number[]>>()

const waveformKey = (asset: MediaAsset, clip: TimelineClip): string =>
  [asset.id, asset.path, clip.sourceInUs, clip.durationUs, PEAK_COUNT].join('|')

const decodePeaks = async (asset: MediaAsset, clip: TimelineClip): Promise<number[]> => {
  if (!window.spectra || asset.offline || !asset.hasAudio) return []
  const response = await fetch(window.spectra.mediaUrl(asset.path))
  if (!response.ok) throw new Error(`waveform media request failed: ${response.status}`)
  const data = await response.arrayBuffer()
  const AudioContextClass = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) return []
  const context = new AudioContextClass()
  try {
    const buffer = await context.decodeAudioData(data.slice(0))
    const start = Math.min(buffer.length, Math.max(0, Math.floor(clip.sourceInUs / 1_000_000 * buffer.sampleRate)))
    const end = Math.min(buffer.length, Math.max(start, Math.ceil((clip.sourceInUs + clip.durationUs) / 1_000_000 * buffer.sampleRate)))
    const span = Math.max(1, end - start)
    const peaks = Array.from({ length: PEAK_COUNT }, (_, index) => {
      const from = start + Math.floor(span * index / PEAK_COUNT)
      const to = Math.max(from + 1, start + Math.floor(span * (index + 1) / PEAK_COUNT))
      let peak = 0
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const samples = buffer.getChannelData(channel)
        for (let sample = from; sample < Math.min(to, end); sample += 1) peak = Math.max(peak, Math.abs(samples[sample] ?? 0))
      }
      return Math.min(1, peak)
    })
    return peaks
  } finally {
    await context.close()
  }
}

const loadPeaks = (asset: MediaAsset, clip: TimelineClip): Promise<number[]> => {
  const key = waveformKey(asset, clip)
  const existing = cache.get(key)
  if (existing) return existing
  const request = decodePeaks(asset, clip).catch((error) => {
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
    }).catch(() => {
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
