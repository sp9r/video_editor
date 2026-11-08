import {
  APP_VERSION,
  DEFAULT_SUBTITLE_STYLE,
  PROJECT_SCHEMA_VERSION,
  type ProjectFile
} from './types.js'

/** Exact user-provided Phase 4.11 subtitle style used by the visual harness. */
export const createSubtitleParityFixture = (): ProjectFile => ({
  schemaVersion: PROJECT_SCHEMA_VERSION,
  appVersion: APP_VERSION,
  id: 'subtitle-parity-fixture',
  name: 'Subtitle parity fixture',
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
  sequence: {
    width: 1920,
    height: 1080,
    frameRate: { numerator: 1, denominator: 1 },
    sampleRate: 48_000,
    backgroundColor: '#242a31'
  },
  media: [],
  tracks: [{
    id: 'subtitle-parity-track',
    name: 'C1',
    kind: 'subtitle',
    locked: false,
    muted: false,
    hidden: false,
    clips: [{
      id: 'subtitle-parity-clip',
      name: '字幕を入力',
      kind: 'subtitle',
      startUs: 0,
      durationUs: 1_000_000,
      sourceInUs: 0,
      enabled: true,
      text: '字幕を入力',
      style: {
        ...structuredClone(DEFAULT_SUBTITLE_STYLE),
        fontFamily: 'Noto Sans JP',
        fontSize: 123,
        color: '#ffffff',
        outlineColor: '#111318',
        outlineWidth: 14,
        shadowColor: '#ff0000',
        shadowBlur: 24,
        backgroundColor: '#000000',
        backgroundOpacity: 0.15,
        bold: true,
        alignment: 'bottom',
        positionX: 50,
        positionY: 86,
        maxWidthPercent: 80,
        animation: 'none',
        animationDurationUs: 0
      }
    }]
  }]
})
