import path from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { parseExperimentalReviewLog, serializeExperimentalReviewLog, upsertExperimentalReviewRecord } from '../shared/review/log'
import type { ExperimentalReviewRecord } from '../shared/review/types'

const reviewDirectory = (): string => path.join(app.getPath('userData'), 'review')
export const experimentalReviewLogPath = (): string => path.join(reviewDirectory(), 'experimental.phase3.5b1.json')

export const loadExperimentalReviewRecords = async (): Promise<ExperimentalReviewRecord[]> => {
  try {
    const raw = await readFile(experimentalReviewLogPath(), 'utf8')
    return parseExperimentalReviewLog(raw).records
  } catch {
    return []
  }
}

export const saveExperimentalReviewRecord = async (record: ExperimentalReviewRecord): Promise<{ path: string; records: ExperimentalReviewRecord[] }> => {
  const records = upsertExperimentalReviewRecord(await loadExperimentalReviewRecords(), record)
  const destination = experimentalReviewLogPath()
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  await mkdir(reviewDirectory(), { recursive: true })
  await writeFile(temporary, serializeExperimentalReviewLog(records), 'utf8')
  await rename(temporary, destination)
  return { path: destination, records }
}
