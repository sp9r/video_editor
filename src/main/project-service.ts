import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, dialog } from 'electron'
import { validateProject } from '../shared/project'
import { isEditProjectDocument, loadEditProject } from './standalone/edit-project'
import type { OpenProjectResult, ProjectFile, SaveProjectResult } from '../shared/types'

const PROJECT_EXTENSION = 'spectra'

const existsAsFile = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isFile()
  } catch {
    return false
  }
}

const writeJsonAtomically = async (target: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, target)
}

const projectForDisk = (project: ProjectFile, projectPath: string): ProjectFile => {
  const directory = path.dirname(projectPath)
  const diskProject = structuredClone(project)
  delete diskProject.projectPath
  delete diskProject.projectFormat
  diskProject.updatedAt = new Date().toISOString()
  diskProject.media = diskProject.media.map((asset) => ({
    ...asset,
    relativePath: path.relative(directory, asset.path)
  }))
  return diskProject
}

const hydrateProject = async (input: unknown, projectPath: string): Promise<{ project: ProjectFile; warnings: string[] }> => {
  const project = validateProject(input)
  const directory = path.dirname(projectPath)
  const warnings: string[] = []
  project.projectPath = projectPath
  project.media = await Promise.all(
    project.media.map(async (asset) => {
      const relativeCandidate = asset.relativePath ? path.resolve(directory, asset.relativePath) : null
      const candidates = [relativeCandidate, asset.path].filter((item): item is string => Boolean(item))
      const resolved = (await Promise.all(candidates.map(async (candidate) => ((await existsAsFile(candidate)) ? candidate : null))))
        .find((candidate): candidate is string => Boolean(candidate))
      if (!resolved) warnings.push(`素材が見つかりません: ${asset.name}`)
      return { ...asset, path: resolved ?? relativeCandidate ?? asset.path, offline: !resolved }
    })
  )
  return { project, warnings }
}

export const saveProject = async (project: ProjectFile, saveAs = false): Promise<SaveProjectResult> => {
  let projectPath = saveAs || project.projectFormat === 'edit_project_v1' ? undefined : project.projectPath
  if (!projectPath) {
    const response = await dialog.showSaveDialog({
      title: 'プロジェクトを保存',
      defaultPath: `${project.name}.${PROJECT_EXTENSION}`,
      filters: [{ name: 'Spectra / edit_project', extensions: [PROJECT_EXTENSION, 'json'] }]
    })
    if (response.canceled || !response.filePath) return { cancelled: true }
    projectPath = response.filePath.endsWith(`.${PROJECT_EXTENSION}`)
      ? response.filePath
      : `${response.filePath}.${PROJECT_EXTENSION}`
  }
  const diskProject = projectForDisk(project, projectPath)
  await writeJsonAtomically(projectPath, diskProject)
  const hydrated = await hydrateProject(diskProject, projectPath)
  return { cancelled: false, projectPath, project: hydrated.project }
}

export const openProject = async (): Promise<OpenProjectResult> => {
  const response = await dialog.showOpenDialog({
    title: 'プロジェクトを開く',
    properties: ['openFile'],
    filters: [{ name: 'Spectra / edit_project', extensions: [PROJECT_EXTENSION, 'json'] }]
  })
  const projectPath = response.filePaths[0]
  if (response.canceled || !projectPath) return { cancelled: true, warnings: [] }
  const source = await readFile(projectPath, 'utf8')
  const parsed: unknown = JSON.parse(source)
  if (isEditProjectDocument(parsed)) {
    const loaded = await loadEditProject(projectPath)
    return {
      cancelled: false,
      projectPath,
      project: loaded.project,
      warnings: [...loaded.diagnostics]
    }
  }
  const hydrated = await hydrateProject(parsed, projectPath)
  return { cancelled: false, projectPath, ...hydrated }
}

const recoveryPath = (): string => path.join(app.getPath('userData'), 'recovery', 'latest.spectra.autosave')

export const writeRecovery = async (project: ProjectFile): Promise<void> => {
  const target = recoveryPath()
  const directory = project.projectPath ? path.dirname(project.projectPath) : process.cwd()
  const recovery = structuredClone(project)
  recovery.media = recovery.media.map((asset) => ({ ...asset, relativePath: path.relative(directory, asset.path) }))
  await writeJsonAtomically(target, recovery)
}

export const loadRecovery = async (): Promise<ProjectFile | null> => {
  const target = recoveryPath()
  if (!(await existsAsFile(target))) return null
  try {
    const source = await readFile(target, 'utf8')
    return validateProject(JSON.parse(source) as unknown)
  } catch {
    return null
  }
}
