import { app } from 'electron'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadAutoCaptionBaselines } from './ai/auto-caption-baseline.js'
import { captureFullCorrectionBaseline, captureFullCorrectionTrack, deriveFullCorrectionDiff, fullCorrectionProjectFingerprint, FULL_CORRECTION_VERSION, type FullCorrectionSession } from '../shared/full-correction.js'
import type { ProjectFile } from '../shared/types.js'

const DIRECTORY_NAME = 'experimental.full-correction.v1'
const MAX_SESSION_BYTES = 64 * 1024 * 1024
const forbiddenKeys = new Set(['path', 'relativePath', 'projectPath', 'mediaPath', 'sourcePath', 'credential', 'credentials', 'accessToken', 'refreshToken', 'clientSecret', 'token'])

const directory = (): string => path.join(app.getPath('userData'), DIRECTORY_NAME)

const assertPathFree = (value: unknown, label = 'full-correction session'): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPathFree(item, `${label}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) throw new Error(`${label}.${key} is not allowed`)
    assertPathFree(child, `${label}.${key}`)
  }
}

const parseSession = (input: unknown): FullCorrectionSession => {
  assertPathFree(input)
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('full-correction session must be an object')
  const value = input as Partial<FullCorrectionSession>
  if (value.version !== FULL_CORRECTION_VERSION) throw new Error('unsupported full-correction version')
  if (value.status !== 'active' && value.status !== 'finished') throw new Error('invalid full-correction status')
  if (typeof value.sessionId !== 'string' || typeof value.projectId !== 'string' || typeof value.projectFingerprint !== 'string' || typeof value.autoCaptionJobId !== 'string') throw new Error('invalid full-correction identity')
  if (!value.track || typeof value.track.id !== 'string' || typeof value.track.name !== 'string') throw new Error('invalid full-correction track')
  if (!value.before || !Array.isArray(value.before.captions) || value.before.trackId !== value.track.id) throw new Error('invalid full-correction before snapshot')
  if (!value.eligibility || typeof value.eligibility.eligible !== 'boolean' || typeof value.eligibility.wordsAvailable !== 'boolean' || typeof value.eligibility.sourceIdentityAvailable !== 'boolean') throw new Error('invalid full-correction eligibility')
  if (!value.statistics || !Number.isSafeInteger(value.statistics.beforeCaptionCount) || !Number.isSafeInteger(value.statistics.afterCaptionCount)) throw new Error('invalid full-correction statistics')
  if (typeof value.createdAt !== 'string') throw new Error('invalid full-correction createdAt')
  if (value.status === 'finished' && (!value.after || !value.derivedCorrections || !value.finishedAt)) throw new Error('finished full-correction session is incomplete')
  return structuredClone(value as FullCorrectionSession)
}

const renameAtomicallyWithWindowsRetry = async (temporary: string, target: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, target)
      return
    } catch (error) {
      const code = (error as { code?: string }).code
      if (!['EPERM', 'EBUSY'].includes(code ?? '') || attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}

const writeSession = async (session: FullCorrectionSession): Promise<void> => {
  const targetDirectory = directory()
  await mkdir(targetDirectory, { recursive: true })
  const target = path.join(targetDirectory, `${session.sessionId}.json`)
  const temporary = path.join(targetDirectory, `.${session.sessionId}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, 'utf8')
    await renameAtomicallyWithWindowsRetry(temporary, target)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

export const loadFullCorrectionSessions = async (): Promise<FullCorrectionSession[]> => {
  let entries
  try {
    entries = await readdir(directory(), { withFileTypes: true })
  } catch {
    return []
  }
  const sessions: FullCorrectionSession[] = []
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith('.json'))) {
    try {
      const filePath = path.join(directory(), entry.name)
      const file = await stat(filePath)
      if (file.size <= 0 || file.size > MAX_SESSION_BYTES) throw new Error('invalid session size')
      sessions.push(parseSession(JSON.parse(await readFile(filePath, 'utf8'))))
    } catch {
      // A malformed experimental session must not prevent the editor from opening.
    }
  }
  return sessions.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.sessionId.localeCompare(right.sessionId))
}

const selectedAutoCaptionJob = (project: ProjectFile, trackId: string): string => {
  const track = project.tracks.find((candidate) => candidate.id === trackId && candidate.kind === 'subtitle')
  if (!track) throw new Error('字幕トラックが見つかりません。')
  const jobs = new Set(track.clips.filter((clip) => clip.kind === 'subtitle').map((clip) => clip.sourceJobId).filter((job): job is string => Boolean(job)))
  if (jobs.size !== 1) throw new Error('自動字幕trackを選択してください。')
  return [...jobs][0]!
}

export const startFullCorrectionSession = async (project: ProjectFile, trackId: string): Promise<FullCorrectionSession> => {
  const jobId = selectedAutoCaptionJob(project, trackId)
  const existing = (await loadFullCorrectionSessions()).find((session) => session.status === 'active' && session.projectId === project.id && session.track.id === trackId && session.autoCaptionJobId === jobId)
  if (existing) return existing
  const track = project.tracks.find((candidate) => candidate.id === trackId && candidate.kind === 'subtitle')
  if (!track) throw new Error('字幕トラックが見つかりません。')
  const baseline = (await loadAutoCaptionBaselines(app.getPath('userData'))).records.find((record) => record.jobId === jobId)
  if (!baseline) throw new Error('自動字幕baselineが見つからないため、全文修正を開始できません。')
  const before = captureFullCorrectionBaseline(baseline, track)
  const session: FullCorrectionSession = {
    version: FULL_CORRECTION_VERSION,
    status: 'active',
    sessionId: `full-correction-${crypto.randomUUID()}`,
    projectId: project.id,
    projectFingerprint: fullCorrectionProjectFingerprint(project),
    autoCaptionJobId: jobId,
    track: { id: track.id, name: track.name },
    before,
    eligibility: { eligible: true, wordsAvailable: before.captions.some((caption) => Boolean(caption.words?.length)), sourceIdentityAvailable: true },
    statistics: { beforeCaptionCount: before.captions.length, afterCaptionCount: before.captions.length, unchanged: 0, split: 0, merge: 0, move: 0, text: 0, timing: 0, delete: 0, mixed: 0 },
    createdAt: new Date().toISOString()
  }
  await writeSession(session)
  return session
}

export const finishFullCorrectionSession = async (project: ProjectFile, sessionId: string): Promise<FullCorrectionSession> => {
  const session = (await loadFullCorrectionSessions()).find((candidate) => candidate.sessionId === sessionId)
  if (!session) throw new Error('全文修正セッションが見つかりません。')
  if (session.status === 'finished') return session
  if (session.projectId !== project.id) throw new Error('別のプロジェクトの全文修正セッションです。')
  const after = captureFullCorrectionTrack(project, session.track.id)
  const diff = deriveFullCorrectionDiff(session.before, after)
  const finished: FullCorrectionSession = {
    ...session,
    status: 'finished',
    after,
    derivedCorrections: diff.derivedCorrections,
    eligibility: diff.eligibility,
    statistics: diff.statistics,
    finishedAt: new Date().toISOString()
  }
  await writeSession(finished)
  return finished
}
