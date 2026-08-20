import { describe, expect, it } from 'vitest'
// Runtime smoke code is plain ESM so it can also be used by the production-like runner.
// @ts-expect-error no declaration file is needed for this test-only JavaScript module.
import { aggregateOwnedProcessSample, classifyOwnedProcess, descendantProcessIds } from '../../scripts/process-tree-metrics.mjs'

describe('owned Electron process-tree metrics', () => {
  const processes = [
    { pid: 10, parentPid: 1, name: 'electron.exe', commandLine: 'electron main', cpuSeconds: 1, workingSetBytes: 10 },
    { pid: 11, parentPid: 10, name: 'electron.exe', commandLine: '--type=renderer', cpuSeconds: 2, workingSetBytes: 20 },
    { pid: 12, parentPid: 10, name: 'ffmpeg.exe', commandLine: 'ffmpeg -i input', cpuSeconds: 3, workingSetBytes: 30 },
    { pid: 13, parentPid: 12, name: 'ffmpeg.exe', commandLine: 'ffmpeg helper', cpuSeconds: 4, workingSetBytes: 40 },
    { pid: 14, parentPid: 999, name: 'ffmpeg.exe', commandLine: 'unrelated ffmpeg', cpuSeconds: 50, workingSetBytes: 500 }
  ]

  it('includes descendants transitively and excludes unrelated ffmpeg', () => {
    expect([...descendantProcessIds(10, processes)]).toEqual([10, 11, 12, 13])
    const sample = aggregateOwnedProcessSample(10, processes)
    expect(sample.ffmpegProcessCount).toBe(2)
    expect(sample.cpuByRole.ffmpeg).toBe(7)
    expect(sample.cpuSeconds).toBe(10)
    expect(sample.workingSetBytes).toBe(100)
    expect(sample.workingSetBytesByRole.main + sample.workingSetBytesByRole.renderer + sample.workingSetBytesByRole.ffmpeg).toBe(sample.workingSetBytes)
  })

  it('classifies renderer, GPU, utility, and app-owned ffmpeg roles', () => {
    expect(classifyOwnedProcess({ pid: 2, commandLine: '--type=gpu-process', name: 'electron' }, 1)).toBe('gpu')
    expect(classifyOwnedProcess({ pid: 3, commandLine: '--type=utility --utility-sub-type=node.mojom.NodeService', name: 'electron' }, 1)).toBe('utility')
    expect(classifyOwnedProcess({ pid: 4, commandLine: 'ffmpeg -i x', name: 'ffmpeg' }, 1)).toBe('ffmpeg')
  })
})
