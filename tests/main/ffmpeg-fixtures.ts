import { join } from 'node:path'
import {
  APP_VERSION,
  DEFAULT_AUDIO,
  DEFAULT_SUBTITLE_STYLE,
  DEFAULT_TRANSFORM,
  PROJECT_SCHEMA_VERSION,
  type ExportSettings,
  type ProjectFile
} from '../../src/shared/types.js'

export const makeProject = (): ProjectFile => ({
  schemaVersion: PROJECT_SCHEMA_VERSION,
  appVersion: APP_VERSION,
  id: 'project-test',
  name: 'テスト動画',
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
  sequence: {
    width: 1920,
    height: 1080,
    frameRate: { numerator: 30, denominator: 1 },
    sampleRate: 48_000,
    backgroundColor: '#102030'
  },
  media: [
    {
      id: 'asset-video',
      name: '映像 & テスト.mp4',
      path: join(process.cwd(), 'fixtures', '映像 & テスト.mp4'),
      kind: 'video',
      durationUs: 10_000_000,
      width: 1920,
      height: 1080,
      frameRate: { numerator: 30, denominator: 1 },
      sampleRate: 48_000,
      channels: 2,
      hasAudio: true,
      fileSize: 100,
      modifiedAt: '2026-08-12T00:00:00.000Z',
      offline: false
    },
    {
      id: 'asset-image',
      name: '画像.png',
      path: join(process.cwd(), 'fixtures', '画像.png'),
      kind: 'image',
      durationUs: 0,
      width: 800,
      height: 600,
      hasAudio: false,
      fileSize: 50,
      modifiedAt: '2026-08-12T00:00:00.000Z',
      offline: false
    }
  ],
  tracks: [
    {
      id: 'track-overlay',
      name: 'V2',
      kind: 'video',
      locked: false,
      muted: false,
      hidden: false,
      clips: [{
        id: 'clip-image',
        name: '画像',
        kind: 'image',
        assetId: 'asset-image',
        startUs: 2_000_000,
        durationUs: 3_000_000,
        sourceInUs: 0,
        enabled: true,
        transform: {
          ...structuredClone(DEFAULT_TRANSFORM),
          positionX: 120,
          positionY: -30,
          scale: 0.4,
          opacity: 0.75,
          crop: { left: 0.1, top: 0.05, right: 0.2, bottom: 0.1 }
        }
      }]
    },
    {
      id: 'track-main',
      name: 'V1',
      kind: 'video',
      locked: false,
      muted: false,
      hidden: false,
      clips: [{
        id: 'clip-video',
        name: '映像',
        kind: 'video',
        assetId: 'asset-video',
        startUs: 0,
        durationUs: 5_000_000,
        sourceInUs: 1_000_000,
        enabled: true,
        transform: structuredClone(DEFAULT_TRANSFORM),
        audio: { ...structuredClone(DEFAULT_AUDIO), volumeDb: -3, fadeInUs: 250_000 }
      }]
    },
    {
      id: 'track-subtitle',
      name: 'C1',
      kind: 'subtitle',
      locked: false,
      muted: false,
      hidden: false,
      clips: [{
        id: 'caption-1',
        name: '字幕',
        kind: 'subtitle',
        startUs: 1_250_000,
        durationUs: 2_500_000,
        sourceInUs: 0,
        enabled: true,
        text: '日本語 {字幕}\\line\n2行目',
        style: {
          ...structuredClone(DEFAULT_SUBTITLE_STYLE),
          animation: 'pop',
          animationDurationUs: 180_000,
          positionX: 48,
          positionY: 84
        }
      }]
    }
  ]
})

export const makeExportSettings = (outputPath: string): ExportSettings => ({
  outputPath,
  width: 1280,
  height: 720,
  frameRate: { numerator: 30, denominator: 1 },
  videoBitrate: 8_000_000,
  audioBitrate: 192_000,
  encoderMode: 'auto',
  burnSubtitles: true,
  exportSrt: true
})
