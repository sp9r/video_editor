import type { ProjectFile, TimelineClip } from '../../shared/types'
import { projectFingerprint } from '../../shared/project'

export type PendingAsyncMutationKind = 'auto-caption' | 'silence-reapply' | 'silence-threshold-update'
export type PendingAsyncMutationState = 'running' | 'cancel-requested' | 'conflicted'

export interface PendingAsyncMutation {
  operationId: string
  kind: PendingAsyncMutationKind
  baseProjectFingerprint: string
  baseProjectLoadVersion: number
  targetClipIds: string[]
  targetSignatures: Record<string, string>
  settingsSnapshot: unknown
  state: PendingAsyncMutationState
  cancelRequested: boolean
}

export interface PendingAsyncMutationStart {
  operationId: string
  kind: PendingAsyncMutationKind
  project: ProjectFile
  projectLoadVersion: number
  targetClipIds: string[]
  settingsSnapshot: unknown
}

const clipForId = (project: ProjectFile, id: string): TimelineClip | undefined => project.tracks
  .flatMap((track) => track.clips)
  .find((clip) => clip.id === id)

export const timelineClipSignature = (project: ProjectFile, id: string): string => {
  const clip = clipForId(project, id)
  return JSON.stringify(clip ?? null)
}

export const createPendingAsyncMutation = (input: PendingAsyncMutationStart): PendingAsyncMutation => ({
  operationId: input.operationId,
  kind: input.kind,
  baseProjectFingerprint: projectFingerprint(input.project),
  baseProjectLoadVersion: input.projectLoadVersion,
  targetClipIds: [...input.targetClipIds],
  targetSignatures: Object.fromEntries(input.targetClipIds.map((id) => [id, timelineClipSignature(input.project, id)])),
  settingsSnapshot: structuredClone(input.settingsSnapshot),
  state: 'running',
  cancelRequested: false
})

export const pendingAsyncMutationMatchesCurrent = (
  pending: PendingAsyncMutation,
  project: ProjectFile,
  projectLoadVersion: number,
  cancelRequested = false
): boolean => pending.state === 'running'
  && !pending.cancelRequested
  && !cancelRequested
  && pending.baseProjectLoadVersion === projectLoadVersion
  && pending.baseProjectFingerprint === projectFingerprint(project)
  && pending.targetClipIds.every((id) => pending.targetSignatures[id] === timelineClipSignature(project, id))

export const markPendingAsyncMutationConflicted = (pending: PendingAsyncMutation): PendingAsyncMutation => ({
  ...pending,
  state: 'conflicted',
  cancelRequested: true
})

export const markPendingAsyncMutationCancelRequested = (pending: PendingAsyncMutation): PendingAsyncMutation => ({
  ...pending,
  state: 'cancel-requested',
  cancelRequested: true
})
