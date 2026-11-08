import { randomUUID } from 'node:crypto'
import { lstat, rename, rm } from 'node:fs/promises'

interface ExportOutputs {
  temporaryPath: string
  outputPath: string
  temporarySrtPath?: string
  sidecarPath?: string
}

interface PublishFileSystem {
  lstat: (path: string) => Promise<{ isFile: () => boolean }>
  rename: typeof rename
  rm: typeof rm
}

export class ExportPublishError extends AggregateError {
  constructor(error: unknown, rollbackErrors: unknown[]) {
    const reason = error instanceof Error ? error.message : String(error)
    super([error, ...rollbackErrors], `Export publish failed: ${reason}${rollbackErrors.length ? `; rollback failed: ${rollbackErrors.map((item) => item instanceof Error ? item.message : String(item)).join('; ')}` : ''}`, { cause: error })
    this.name = 'ExportPublishError'
  }
}

// The caller has already rendered and validated the partial output. Keep every
// previous file until all outputs have been promoted, so a failed sidecar cannot
// leave a new video paired with old subtitles.
export const publishExportOutputs = async (
  paths: ExportOutputs,
  fileSystem: PublishFileSystem = { lstat, rename, rm }
): Promise<void> => {
  if ((paths.temporarySrtPath === undefined) !== (paths.sidecarPath === undefined)) {
    throw new Error('Both temporarySrtPath and sidecarPath must be provided together')
  }
  const outputs = [
    { temporaryPath: paths.temporaryPath, outputPath: paths.outputPath },
    ...(paths.temporarySrtPath !== undefined && paths.sidecarPath !== undefined
      ? [{ temporaryPath: paths.temporarySrtPath, outputPath: paths.sidecarPath }] : [])
  ].map((item) => ({ ...item, backupPath: `${item.outputPath}.backup-${randomUUID()}`, backedUp: false, promoted: false }))

  try {
    for (const item of outputs) {
      try {
        const existing = await fileSystem.lstat(item.outputPath)
        if (!existing.isFile()) throw new Error(`Export destination is not a regular file: ${item.outputPath}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      await fileSystem.rename(item.outputPath, item.backupPath)
      item.backedUp = true
    }
    for (const item of outputs) {
      await fileSystem.rename(item.temporaryPath, item.outputPath)
      item.promoted = true
    }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const item of [...outputs].reverse()) {
      // Do not overwrite a backup when removing the new file fails.
      try {
        if (item.promoted) await fileSystem.rm(item.outputPath)
        if (item.backedUp) await fileSystem.rename(item.backupPath, item.outputPath)
      } catch (rollbackError) {
        const reason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        rollbackErrors.push(new Error(`Could not restore ${item.outputPath}${item.backedUp ? ` from ${item.backupPath}` : ''}: ${reason}`, { cause: rollbackError }))
      }
    }
    throw new ExportPublishError(error, rollbackErrors)
  }

  // Backup cleanup is after the commit point. Failure here must never trigger
  // rollback using backups that may already have been deleted.
  for (const item of outputs) {
    if (item.backedUp) await fileSystem.rm(item.backupPath, { force: true }).catch(() => undefined)
  }
}
