import { describe, expect, it } from 'vitest'
import { captureFullCorrectionBaseline, deriveFullCorrectionDiff, fullCorrectionProjectFingerprint, type FullCorrectionCaptionSnapshot, type FullCorrectionTrackSnapshot } from '../../src/shared/full-correction'
import type { AutoCaptionBaseline } from '../../src/shared/auto-caption-contract'
import { createEmptyProject } from '../../src/shared/project'
import { DEFAULT_SUBTITLE_STYLE, type TimelineTrack } from '../../src/shared/types'

const word = (id: string, text: string, startUs: number, endUs: number) => ({ id, text, startUs, endUs })
const caption = (id: string, text: string, startUs: number, words?: ReturnType<typeof word>, sourceCaptionId = id): FullCorrectionCaptionSnapshot => ({
  id,
  name: id,
  text,
  startUs,
  durationUs: 1_000_000,
  sourceInUs: 0,
  enabled: true,
  sourceCaptionId,
  sourceJobId: 'job-1',
  ...(words ? { words: [words] } : {}),
  wordsMatchText: Boolean(words) && words!.text === text
})
const snapshot = (captions: FullCorrectionCaptionSnapshot[]): FullCorrectionTrackSnapshot => ({ trackId: 'track-1', trackName: '自動字幕', captions })

describe('full correction whole-track diff', () => {
  it('classifies unchanged, split, merge, ownership move, text, delete and mixed', () => {
    const a = caption('a', '私', 0, word('w1', '私', 0, 500_000))
    const b = caption('b', 'は', 1_000_000, word('w2', 'は', 1_000_000, 1_500_000))
    expect(deriveFullCorrectionDiff(snapshot([a]), snapshot([a])).statistics.unchanged).toBe(1)

    const splitLeft = caption('a-left', '私', 0, word('w1', '私', 0, 500_000), 'a')
    const splitRight = caption('a-right', 'は', 500_000, word('w2', 'は', 500_000, 1_000_000), 'a')
    expect(deriveFullCorrectionDiff(snapshot([caption('a', '私は', 0, word('w1', '私は', 0, 1_000_000))]), snapshot([splitLeft, splitRight])).statistics.split).toBe(1)

    const merged = caption('merged', '私は', 0, word('w1', '私は', 0, 1_500_000), 'a')
    merged.words = [word('w1', '私', 0, 500_000), word('w2', 'は', 1_000_000, 1_500_000)]
    merged.wordsMatchText = true
    expect(deriveFullCorrectionDiff(snapshot([a, b]), snapshot([merged])).statistics.merge).toBe(1)

    const beforeMoveLeft = caption('a', '私', 0, word('w1', '私', 0, 500_000), 'a')
    const beforeMoveRight = caption('b', 'は歩く', 500_000, word('w2', 'は', 500_000, 750_000), 'b')
    beforeMoveRight.words = [word('w2', 'は', 500_000, 750_000), word('w3', '歩く', 750_000, 1_000_000)]
    beforeMoveRight.wordsMatchText = true
    const afterMoveLeft = caption('a', '私は', 0, word('w1', '私', 0, 500_000), 'a')
    afterMoveLeft.words = [word('w1', '私', 0, 500_000), word('w2', 'は', 500_000, 750_000)]
    afterMoveLeft.wordsMatchText = true
    const afterMoveRight = caption('b', '歩く', 750_000, word('w3', '歩く', 750_000, 1_000_000), 'b')
    expect(deriveFullCorrectionDiff(snapshot([beforeMoveLeft, beforeMoveRight]), snapshot([afterMoveLeft, afterMoveRight])).statistics.move).toBe(1)

    const edited = caption('a', '私たち', 0, word('w1', '私', 0, 500_000))
    edited.wordsMatchText = false
    expect(deriveFullCorrectionDiff(snapshot([a]), snapshot([edited])).statistics.text).toBe(1)
    expect(deriveFullCorrectionDiff(snapshot([a]), snapshot([{ ...a, startUs: 200_000 }])).statistics.timing).toBe(1)
    expect(deriveFullCorrectionDiff(snapshot([a]), snapshot([])).statistics.delete).toBe(1)
    const mixed = { ...a, text: '変更', startUs: 200_000 }
    expect(deriveFullCorrectionDiff(snapshot([a]), snapshot([mixed])).statistics.mixed).toBe(1)
  })

  it('keeps words-none and text-mismatch safe while retaining source identity', () => {
    const noWords = caption('a', '字幕', 0)
    const changed = { ...noWords, text: '修正' }
    const result = deriveFullCorrectionDiff(snapshot([noWords]), snapshot([changed]))
    expect(result.statistics.text).toBe(1)
    expect(result.eligibility.sourceIdentityAvailable).toBe(true)

    const mismatch = caption('a', '字幕', 0, word('w1', '別', 0, 500_000))
    mismatch.wordsMatchText = false
    const mismatchResult = deriveFullCorrectionDiff(snapshot([mismatch]), snapshot([{ ...mismatch, text: '修正' }]))
    expect(mismatchResult.statistics.text).toBe(1)
    expect(mismatchResult.eligibility.wordsAvailable).toBe(true)
  })
})

describe('full correction baseline truth', () => {
  it('reconstructs before text/timing from the immutable auto-caption baseline', () => {
    const project = createEmptyProject('baseline')
    const track = project.tracks.find((item) => item.kind === 'subtitle') as TimelineTrack
    const clip = {
      id: 'generated-clip', name: 'edited name', kind: 'subtitle' as const, startUs: 11_000_000, durationUs: 1_000_000, sourceInUs: 0, enabled: true,
      text: '編集後', style: structuredClone(DEFAULT_SUBTITLE_STYLE), sourceCaptionId: 'caption-1', sourceJobId: 'job-1',
      words: [word('word-1', '元', 11_000_000, 11_500_000)]
    }
    track.clips = [clip]
    const baseline: AutoCaptionBaseline = {
      version: 'experimental.auto-caption-baseline.v1', jobId: 'job-1', createdAt: 'now', projectFingerprint: 'fingerprint', mediaFingerprint: 'media',
      sourceClip: { clipId: 'video-1', assetId: 'asset-1', startUs: 10_000_000, sourceInUs: 20_000_000, durationUs: 2_000_000 },
      timelineMapping: { formula: 'timelineUs = clip.startUs + (sourceUs - clip.sourceInUs)', clipStartUs: 10_000_000, sourceInUs: 20_000_000 },
      rawWords: [word('word-1', '元', 21_000_000, 21_500_000)],
      captions: [{ id: 'caption-1', text: '元字幕', sourceWordIds: ['word-1'], startUs: 21_000_000, endUs: 22_000_000, textStatus: 'as_transcribed', provenance: 'caption_algorithm' }],
      settings: { language: 'ja', maxChars: 32, maxLines: 2, segmentationMode: 'auto' }, provider: 'fake', model: 'fake', diagnostics: [], fallback: { used: false }
    }
    const before = captureFullCorrectionBaseline(baseline, track)
    expect(before.captions[0]?.text).toBe('元字幕')
    expect(before.captions[0]?.startUs).toBe(11_000_000)
    expect(before.captions[0]?.words?.[0]?.startUs).toBe(11_000_000)
    expect(before.captions[0]?.id).toBe('generated-clip')
  })

  it('keeps the completed auto-edit timeline when silence compaction moved generated captions', () => {
    const project = createEmptyProject('silence baseline')
    const track = project.tracks.find((item) => item.kind === 'subtitle') as TimelineTrack
    track.clips = [{
      id: 'generated-after-cut', name: '字幕', kind: 'subtitle', startUs: 500_000, durationUs: 600_000, sourceInUs: 0, enabled: true,
      text: '編集前の表示', style: structuredClone(DEFAULT_SUBTITLE_STYLE), sourceCaptionId: 'caption-cut', sourceJobId: 'job-cut',
      words: [word('word-cut', '元', 500_000, 700_000)]
    }]
    const baseline: AutoCaptionBaseline = {
      version: 'experimental.auto-caption-baseline.v1', jobId: 'job-cut', createdAt: 'now', projectFingerprint: 'fingerprint', mediaFingerprint: 'media',
      sourceClip: { clipId: 'video-cut', assetId: 'asset-cut', startUs: 0, sourceInUs: 0, durationUs: 3_000_000 },
      timelineMapping: { formula: 'timelineUs = clip.startUs + (sourceUs - clip.sourceInUs)', clipStartUs: 0, sourceInUs: 0 },
      rawWords: [word('word-cut', '元', 2_000_000, 2_200_000)],
      captions: [{ id: 'caption-cut', text: '元字幕', sourceWordIds: ['word-cut'], startUs: 2_000_000, endUs: 2_600_000, textStatus: 'as_transcribed', provenance: 'caption_algorithm' }],
      settings: { language: 'ja', maxChars: 32, maxLines: 2, segmentationMode: 'auto' }, provider: 'fake', model: 'fake', diagnostics: [], fallback: { used: false }
    }
    const before = captureFullCorrectionBaseline(baseline, track)
    expect(before.captions[0]).toMatchObject({ id: 'generated-after-cut', text: '元字幕', startUs: 500_000, durationUs: 600_000 })
    expect(before.captions[0]?.words?.[0]).toMatchObject({ id: 'word-cut', text: '元', startUs: 500_000, endUs: 700_000 })
  })

  it('fingerprint contains no project or media paths', () => {
    const project = createEmptyProject('fingerprint')
    project.projectPath = 'C:\\secret\\project.spectra'
    project.media.push({ id: 'asset-1', name: 'source.mp4', path: 'C:\\secret\\source.mp4', relativePath: '..\\source.mp4', kind: 'video', durationUs: 1_000_000, hasAudio: true, fileSize: 1, modifiedAt: 'now', offline: false })
    const fingerprint = fullCorrectionProjectFingerprint(project)
    expect(fingerprint).not.toContain('secret')
    expect(fingerprint).not.toContain('relativePath')
    expect(fingerprint).not.toContain('projectPath')
  })
})
