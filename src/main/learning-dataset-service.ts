import path from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { app, dialog } from 'electron'
import { buildLearningDataset, serializeLearningDatasetJsonl, type LearningDatasetBuildResult, type LearningDatasetExportResult } from '../shared/learning-dataset'
import { loadExperimentalReviewRecords } from './review-service'

const datasetDirectory = (): string => path.join(app.getPath('userData'), 'learning')
export const learningDatasetAggregatePath = (): string => path.join(datasetDirectory(), 'experimental.learning-dataset.v1.jsonl')

const writeAtomic = async (destination: string, content: string): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, destination)
}

export const buildLearningDatasetForCurrentLog = async (): Promise<LearningDatasetBuildResult> => buildLearningDataset(await loadExperimentalReviewRecords())

export const exportLearningDataset = async (): Promise<LearningDatasetExportResult> => {
  const dataset = await buildLearningDatasetForCurrentLog()
  const jsonl = serializeLearningDatasetJsonl(dataset.samples)
  await writeAtomic(learningDatasetAggregatePath(), jsonl)
  const destination = await dialog.showSaveDialog({
    title: '学習データを書き出す',
    defaultPath: 'spectra-learning-dataset.v1.jsonl',
    filters: [{ name: 'JSONL', extensions: ['jsonl'] }]
  })
  const exported = !destination.canceled && Boolean(destination.filePath)
  if (exported && destination.filePath) await writeAtomic(destination.filePath, jsonl)
  return { eligibleSamples: dataset.samples.length, excludedSamples: dataset.excludedSamples, malformedRecords: dataset.diagnostics.length, correctionCategories: dataset.correctionCategories, exported }
}

export const readAggregatedLearningDataset = async (): Promise<string> => {
  try { return await readFile(learningDatasetAggregatePath(), 'utf8') } catch { return '' }
}
