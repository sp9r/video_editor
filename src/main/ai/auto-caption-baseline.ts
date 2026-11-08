import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createAutoCaptionBaseline,
  parseAutoCaptionBaseline,
  type AutoCaptionBaseline,
  type AutoCaptionResult,
  type AutoCaptionSettings
} from '../../shared/auto-caption-contract.js'
import type { AutoCaptionBaselineLoadResult, ProjectFile, TimelineClip } from '../../shared/types.js'

const BASELINE_DIRECTORY = 'experimental.auto-caption-baseline.v1'
const MAX_BASELINE_BYTES = 64 * 1024 * 1024

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
}

const hashText = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`

export const fingerprintProject = (project: ProjectFile): string => hashText(stableJson(project))

export const fingerprintMedia = async (mediaPath: string): Promise<string> => {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(mediaPath)
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return `sha256:${hash.digest('hex')}`
}

export const baselineDirectory = (userDataPath: string): string => path.join(userDataPath, BASELINE_DIRECTORY)

export const saveAutoCaptionBaseline = async ({
  userDataPath,
  project,
  mediaPath,
  clip,
  result,
  settings
}: {
  userDataPath: string
  project: ProjectFile
  mediaPath: string
  clip: Extract<TimelineClip, { kind: 'video' | 'audio' }>
  result: AutoCaptionResult
  settings: AutoCaptionSettings
}): Promise<AutoCaptionBaseline> => {
  const media = await stat(mediaPath)
  if (!media.isFile()) throw new Error('自動字幕の素材fingerprintを作成できません。')
  const baseline = createAutoCaptionBaseline({
    result,
    jobId: result.jobId,
    createdAt: new Date().toISOString(),
    projectFingerprint: fingerprintProject(project),
    mediaFingerprint: await fingerprintMedia(mediaPath),
    sourceClip: {
      clipId: clip.id,
      assetId: clip.assetId,
      startUs: clip.startUs,
      sourceInUs: clip.sourceInUs,
      durationUs: clip.durationUs
    },
    settings
  })
  const directory = baselineDirectory(userDataPath)
  await mkdir(directory, { recursive: true })
  const target = path.join(directory, `${result.jobId}.json`)
  const temporary = path.join(directory, `.${result.jobId}.${process.pid}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  return baseline
}

export const loadAutoCaptionBaselines = async (userDataPath: string): Promise<AutoCaptionBaselineLoadResult> => {
  const directory = baselineDirectory(userDataPath)
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return { records: [], malformedCount: 0 }
  }
  const records: AutoCaptionBaseline[] = []
  let malformedCount = 0
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith('.json'))) {
    try {
      const filePath = path.join(directory, entry.name)
      const file = await stat(filePath)
      if (file.size <= 0 || file.size > MAX_BASELINE_BYTES) throw new Error('invalid size')
      records.push(parseAutoCaptionBaseline(JSON.parse(await readFile(filePath, 'utf8'))))
    } catch {
      malformedCount += 1
    }
  }
  records.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId))
  return { records, malformedCount }
}
