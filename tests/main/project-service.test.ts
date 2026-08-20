import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({ showSaveDialog: vi.fn(), getPath: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: electronMocks.getPath }, dialog: electronMocks }))

import { addClipToTrack, createClipForAsset, createEmptyProject } from '../../src/shared/project'
import { DEFAULT_SUBTITLE_STYLE } from '../../src/shared/types'
import { loadRecovery, saveProject, writeRecovery } from '../../src/main/project-service'
import type { MediaAsset } from '../../src/shared/types'

const sourceAsset = (path: string): MediaAsset => ({
  id: 'media', name: 'source.mp4', path, kind: 'video', durationUs: 4_000_000,
  width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, hasAudio: true,
  fileSize: 1, modifiedAt: '2026-08-13T00:00:00.000Z', offline: false
})

describe('manual project persistence boundary', () => {
  it('opens a contract model and saves a new .spectra without overwriting the contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-editor-save-as-'))
    try {
      const sourcePath = join(root, 'source.mp4')
      const contractPath = join(root, 'edit_project.json')
      const outputPath = join(root, 'manual', 'clip.spectra')
      await writeFile(sourcePath, 'source media')
      await writeFile(contractPath, '{"schema_version":"edit_project.v1"}\n')
      const originalHash = createHash('sha256').update(await readFile(contractPath)).digest('hex')
      electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: outputPath })

      let project = createEmptyProject('manual')
      const asset = sourceAsset(sourcePath)
      project = { ...project, projectPath: contractPath, projectFormat: 'edit_project_v1', opaqueContractMetadata: { source_run_id: 'run-1', opaque: { keep: true } }, media: [asset] }
      const clip = { ...createClipForAsset(asset, 0, 2_000_000), id: 'video', linkGroupId: 'link:video:audio', sourceAudioEnabled: false }
      project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, clip)
      const result = await saveProject(project)
      expect(result.cancelled).toBe(false)
      expect(result.projectPath).toBe(outputPath)
      expect(createHash('sha256').update(await readFile(contractPath)).digest('hex')).toBe(originalHash)
      const saved = JSON.parse(await readFile(outputPath, 'utf8')) as Record<string, unknown>
      const savedClip = (saved.tracks as Array<{ clips: Array<Record<string, unknown>> }>).flatMap((track) => track.clips).find((item) => item.id === 'video')
      expect(savedClip).toMatchObject({ linkGroupId: 'link:video:audio', sourceAudioEnabled: false })
      expect(saved.projectFormat).toBeUndefined()
      expect(saved.opaqueContractMetadata).toEqual({ source_run_id: 'run-1', opaque: { keep: true } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves imported subtitle words when saving .spectra', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-editor-save-words-'))
    try {
      const sourcePath = join(root, 'source.mp4')
      const outputPath = join(root, 'manual', 'clip.spectra')
      await writeFile(sourcePath, 'source media')
      electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: outputPath })
      let project = createEmptyProject('manual words')
      const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')!
      subtitleTrack.clips.push({
        id: 'caption', name: 'caption', kind: 'subtitle', startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0,
        enabled: true, text: 'AB', style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [
          { id: 'source-word:1', text: 'A', startUs: 1_000_000, endUs: 1_400_000 },
          { id: 'source-word:2', text: 'B', startUs: 1_400_000, endUs: 1_800_000 }
        ]
      })
      project = { ...project, projectPath: join(root, 'edit_project.json'), projectFormat: 'edit_project_v1' }
      const result = await saveProject(project)
      expect(result.cancelled).toBe(false)
      const saved = JSON.parse(await readFile(outputPath, 'utf8')) as { tracks: Array<{ clips: Array<{ id: string; words?: unknown[] }> }> }
      expect(saved.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'caption')?.words).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves recovery relative media against the original project directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-editor-recovery-'))
    try {
      const projectDirectory = join(root, 'project-a')
      const recoveryUserData = join(root, 'recovery-b')
      const projectPath = join(projectDirectory, 'clip.spectra')
      const sourcePath = join(projectDirectory, 'media', 'source.mp4')
      await mkdir(join(projectDirectory, 'media'), { recursive: true })
      await writeFile(sourcePath, 'source media', { encoding: 'utf8' })
      electronMocks.getPath.mockReturnValue(recoveryUserData)
      const project = { ...createEmptyProject('recovery'), projectPath, media: [sourceAsset(sourcePath)] }
      await writeRecovery(project)
      const recovered = await loadRecovery()
      expect(recovered?.recoveryProvenance?.originalProjectDirectory).toBe(projectDirectory)
      expect(recovered?.media[0]).toMatchObject({ path: sourcePath, relativePath: join('media', 'source.mp4'), offline: false })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps old recovery compatibility and marks unresolved fallback media offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-editor-old-recovery-'))
    try {
      const recoveryUserData = join(root, 'recovery-b')
      electronMocks.getPath.mockReturnValue(recoveryUserData)
      const project = { ...createEmptyProject('old recovery'), media: [{ ...sourceAsset('source.mp4'), relativePath: 'source.mp4' }] }
      const target = join(recoveryUserData, 'recovery', 'latest.spectra.autosave')
      await mkdir(join(recoveryUserData, 'recovery'), { recursive: true })
      await writeFile(target, `${JSON.stringify(project)}\n`)
      const recovered = await loadRecovery()
      expect(recovered?.media[0]?.offline).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
