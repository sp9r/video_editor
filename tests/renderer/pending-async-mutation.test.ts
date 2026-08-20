import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../../src/shared/project'
import { createPendingAsyncMutation, markPendingAsyncMutationCancelRequested, markPendingAsyncMutationConflicted, pendingAsyncMutationMatchesCurrent } from '../../src/renderer/src/pending-async-mutation'

describe('PendingAsyncMutation', () => {
  it('captures renderer-only identity and accepts only the exact base state', () => {
    const project = createEmptyProject('pending')
    const pending = createPendingAsyncMutation({
      operationId: 'operation-1', kind: 'auto-caption', project, projectLoadVersion: 4,
      targetClipIds: ['clip-1'], settingsSnapshot: { maxChars: 32 }
    })
    expect(pending).toMatchObject({ operationId: 'operation-1', kind: 'auto-caption', baseProjectLoadVersion: 4, targetClipIds: ['clip-1'], state: 'running' })
    expect(pendingAsyncMutationMatchesCurrent(pending, project, 4)).toBe(true)
    expect(pendingAsyncMutationMatchesCurrent(pending, { ...project, name: 'changed' }, 4)).toBe(false)
    expect(pendingAsyncMutationMatchesCurrent(pending, project, 5)).toBe(false)
  })

  it('records conflict and cancellation without mutating the ProjectFile', () => {
    const project = createEmptyProject('pending')
    const pending = createPendingAsyncMutation({ operationId: 'operation-2', kind: 'silence-reapply', project, projectLoadVersion: 0, targetClipIds: [], settingsSnapshot: {} })
    expect(markPendingAsyncMutationConflicted(pending)).toMatchObject({ operationId: 'operation-2', state: 'conflicted', cancelRequested: true })
    expect(markPendingAsyncMutationCancelRequested(pending)).toMatchObject({ operationId: 'operation-2', state: 'cancel-requested', cancelRequested: true })
    expect(pending.state).toBe('running')
  })
})
