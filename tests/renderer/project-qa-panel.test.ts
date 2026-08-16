import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectQaPanel from '../../src/renderer/src/components/ProjectQaPanel'
import type { ProjectQaReport } from '../../src/shared/project-qa'

describe('ProjectQaPanel', () => {
  let root: Root | undefined

  afterEach(() => {
    root?.unmount()
    root = undefined
    document.body.replaceChildren()
  })

  it('shows read-only issues and navigates to a related timeline clip', async () => {
    const onNavigate = vi.fn()
    const report: ProjectQaReport = {
      issues: [{ severity: 'error', code: 'TIMELINE_INVALID_DURATION', message: 'clipの時間が不正です。', relatedClipId: 'clip-1', timelineUs: 2_000_000 }],
      errorCount: 1,
      warningCount: 0,
      infoCount: 0,
      canExport: false
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root?.render(createElement(ProjectQaPanel, { report, onClose: vi.fn(), onNavigate })) })
    expect(container.textContent).toContain('ERRORを解消してから書き出してください')
    const issueButton = container.querySelector('.qa-issue') as HTMLButtonElement
    expect(issueButton.disabled).toBe(false)
    await act(async () => { issueButton.click() })
    expect(onNavigate).toHaveBeenCalledWith(report.issues[0])
  })
})
