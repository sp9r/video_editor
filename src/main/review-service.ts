import path from 'node:path'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { app } from 'electron'
import { parseExperimentalReviewLog, serializeExperimentalReviewLog, upsertExperimentalReviewRecord } from '../shared/review/log'
import type { ExperimentalReviewRecord } from '../shared/review/types'

const reviewDirectory = (): string => path.join(app.getPath('userData'), 'review')
export const experimentalReviewLogPath = (): string => path.join(reviewDirectory(), 'experimental.phase3.5b1.json')

let writeSequence = Promise.resolve()
let temporarySequence = 0

const serializeWrite = async <T>(operation: () => Promise<T>): Promise<T> => {
  const current = writeSequence.then(operation, operation)
  writeSequence = current.then(() => undefined, () => undefined)
  return current
}

export const loadExperimentalReviewRecords = async (): Promise<ExperimentalReviewRecord[]> => {
  try {
    const raw = await readFile(experimentalReviewLogPath(), 'utf8')
    return parseExperimentalReviewLog(raw).records
  } catch {
    return []
  }
}

export const saveExperimentalReviewRecord = async (record: ExperimentalReviewRecord): Promise<{ path: string; records: ExperimentalReviewRecord[] }> => {
  return serializeWrite(async () => {
    // Reload inside the serialized section. The caller's previous snapshot is
    // never authoritative for an upsert.
    const records = upsertExperimentalReviewRecord(await loadExperimentalReviewRecords(), record)
    const destination = experimentalReviewLogPath()
    const temporary = `${destination}.${process.pid}.${Date.now()}.${++temporarySequence}.tmp`
    await mkdir(reviewDirectory(), { recursive: true })
    try {
      await writeFile(temporary, serializeExperimentalReviewLog(records), 'utf8')
      await rename(temporary, destination)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    return { path: destination, records }
  })
}
