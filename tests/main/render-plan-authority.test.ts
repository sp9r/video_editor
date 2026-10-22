import { describe, expect, it } from 'vitest'
import { buildAccurateFrameFilterGraph, buildAuthoritativeVideoGraph, buildRenderFilterGraph } from '../../src/main/ffmpeg/render-plan'
import type { RenderPlan } from '../../src/main/ffmpeg/render-plan'

const plan = {
  durationUs: 1_000_000,
  width: 320,
  height: 180,
  compositionWidth: 320,
  compositionHeight: 180,
  backgroundColor: '0x000000',
  frameRateNumerator: 30,
  frameRateDenominator: 1,
  sampleRate: 48_000,
  inputs: [],
  inputArgs: [],
  graphStatements: ['color=c=0x000000:s=320x180:r=30/1:d=1[canvas]', '[canvas]copy[composite]'],
  compositedVideoLabel: 'composite',
  audioOutputLabel: 'aout',
  filterGraph: '',
  ass: '[Script Info]\n',
  burnSubtitles: true,
  subtitleCueCount: 1,
  subtitleIds: ['subtitle-1'],
  srt: '1\n00:00:00,000 --> 00:00:01,000\n字幕\n',
  assFileName: 'captions.ass'
} satisfies RenderPlan

describe('authoritative render graph', () => {
  it('keeps subtitle composition shared by Final and Accurate Preview', () => {
    const authoritative = buildAuthoritativeVideoGraph(plan)
    const finalGraph = buildRenderFilterGraph(plan, 'libx264')
    const frameGraph = buildAccurateFrameFilterGraph(plan, 7)
    const shared = authoritative.statements.join(';\n')

    expect(finalGraph.startsWith(shared)).toBe(true)
    expect(frameGraph.startsWith(shared)).toBe(true)
    expect(finalGraph).toContain('[subtitled]scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=yuv420p[vout]')
    expect(frameGraph).toContain("[subtitled]select='eq(n\\,7)',setpts=PTS-STARTPTS,scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=yuv420p,scale=in_color_matrix=bt709:in_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=rgba[vout]")
  })

  it('allows a unique safe ASS filename for concurrent frame requests', () => {
    expect(buildAccurateFrameFilterGraph(plan, 0, 'frame-abc.ass')).toContain("ass=filename='frame-abc.ass'")
    expect(() => buildAccurateFrameFilterGraph(plan, 0, '../captions.ass')).toThrow(/safe workspace basename/u)
  })
})
