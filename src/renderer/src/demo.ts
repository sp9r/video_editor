import { createClipForAsset, createEmptyProject, createTrack, makeId } from '../../shared/project'
import { DEFAULT_SUBTITLE_STYLE, type MediaAsset, type ProjectFile, type SubtitleClip } from '../../shared/types'

const now = new Date().toISOString()

const assets: MediaAsset[] = [
  {
    id: 'demo-city',
    name: '朝の街歩き.mp4',
    path: 'demo://city',
    kind: 'video',
    durationUs: 18_000_000,
    width: 3840,
    height: 2160,
    frameRate: { numerator: 30, denominator: 1 },
    hasAudio: true,
    fileSize: 184_000_000,
    modifiedAt: now,
    offline: false
  },
  {
    id: 'demo-cafe',
    name: 'カフェの手元.mp4',
    path: 'demo://cafe',
    kind: 'video',
    durationUs: 12_500_000,
    width: 1920,
    height: 1080,
    frameRate: { numerator: 30, denominator: 1 },
    hasAudio: true,
    fileSize: 92_000_000,
    modifiedAt: now,
    offline: false
  },
  {
    id: 'demo-title',
    name: 'チャンネルロゴ.png',
    path: 'demo://title',
    kind: 'image',
    durationUs: 0,
    width: 1200,
    height: 420,
    hasAudio: false,
    fileSize: 520_000,
    modifiedAt: now,
    offline: false
  },
  {
    id: 'demo-music',
    name: 'Morning Steps.wav',
    path: 'demo://music',
    kind: 'audio',
    durationUs: 42_000_000,
    sampleRate: 48_000,
    channels: 2,
    hasAudio: true,
    fileSize: 7_900_000,
    modifiedAt: now,
    offline: false
  },
  {
    id: 'demo-offline',
    name: 'インタビュー.mov',
    path: 'D:/素材/インタビュー.mov',
    kind: 'video',
    durationUs: 25_000_000,
    width: 1920,
    height: 1080,
    frameRate: { numerator: 30, denominator: 1 },
    hasAudio: true,
    fileSize: 240_000_000,
    modifiedAt: now,
    offline: true
  }
]

export const createDemoProject = (): ProjectFile => {
  const project = createEmptyProject('東京モーニング Vlog')
  project.tracks.splice(1, 0, createTrack('media', 2), createTrack('media', 3))
  project.media = assets
  const videoTrack = project.tracks.find((track) => track.name.startsWith('V1'))
  const overlayTrack = project.tracks.find((track) => track.name.startsWith('V2'))
  const audioTrack = project.tracks.find((track) => track.name.startsWith('V3'))
  const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')

  if (videoTrack) {
    const intro = createClipForAsset(assets[0]!, 0, 8_000_000)
    const cafe = createClipForAsset(assets[1]!, 8_000_000, 7_000_000)
    videoTrack.clips = [intro, cafe]
  }
  if (overlayTrack) {
    const logo = createClipForAsset(assets[2]!, 900_000, 4_400_000)
    if ('transform' in logo) {
      logo.transform.positionY = -220
      logo.transform.scale = 0.42
    }
    overlayTrack.clips = [logo]
  }
  if (audioTrack) {
    const music = createClipForAsset(assets[3]!, 0, 15_000_000)
    if ('audio' in music) {
      music.audio.volumeDb = -12
      music.audio.fadeInUs = 800_000
      music.audio.fadeOutUs = 1_200_000
    }
    audioTrack.clips = [music]
  }
  if (subtitleTrack) {
    const subtitle: SubtitleClip = {
      id: makeId('caption'),
      name: 'オープニング字幕',
      kind: 'subtitle',
      startUs: 1_300_000,
      durationUs: 3_500_000,
      sourceInUs: 0,
      enabled: true,
      text: '一日の始まりを、歩いて見つける。',
      style: { ...structuredClone(DEFAULT_SUBTITLE_STYLE), animation: 'slide-up' }
    }
    subtitleTrack.clips = [subtitle]
  }
  return project
}
