import { Check, CircleAlert, Info, TriangleAlert, X } from 'lucide-react'
import type { ProjectQaIssue, ProjectQaReport } from '../../../shared/project-qa'
import { Button, IconButton } from './Controls'

interface Props {
  report: ProjectQaReport
  onClose(): void
  onNavigate(issue: ProjectQaIssue): void
}

const severityLabel = (severity: ProjectQaIssue['severity']): string => severity === 'error' ? 'ERROR' : severity === 'warning' ? 'WARNING' : 'INFO'

export default function ProjectQaPanel({ report, onClose, onNavigate }: Props): React.JSX.Element {
  return (
    <section className="qa-dialog" role="dialog" aria-modal="true" aria-labelledby="project-qa-title">
      <header className="dialog-header">
        <div className="dialog-title-icon"><TriangleAlert size={19} /></div>
        <div><span className="panel-eyebrow">PROJECT QA</span><h2 id="project-qa-title">書き出し前QA</h2></div>
        <IconButton label="QAを閉じる" onClick={onClose}><X size={18} /></IconButton>
      </header>
      <div className="qa-dialog-body">
        <div className={`qa-summary ${report.canExport ? 'is-ok' : 'has-errors'}`} role="status">
          {report.canExport ? <Check size={17} /> : <CircleAlert size={17} />}
          <strong>{report.canExport ? '書き出し可能' : 'ERRORを解消してから書き出してください'}</strong>
          <span>error {report.errorCount} · warning {report.warningCount} · info {report.infoCount}</span>
        </div>
        {report.issues.length === 0 ? <div className="qa-empty"><Check size={18} />問題は見つかりませんでした。</div> : (
          <div className="qa-issues" aria-label="QA issue一覧">
            {report.issues.map((issue, index) => {
              const navigable = Boolean(issue.relatedClipId || issue.relatedMediaId || issue.timelineUs !== undefined)
              return <button type="button" className={`qa-issue severity-${issue.severity}`} key={`${issue.code}-${issue.relatedClipId ?? issue.relatedMediaId ?? index}`} onClick={() => navigable && onNavigate(issue)} disabled={!navigable}>
                <span className="qa-issue-icon">{issue.severity === 'error' ? <CircleAlert size={15} /> : issue.severity === 'warning' ? <TriangleAlert size={15} /> : <Info size={15} />}</span>
                <span className="qa-issue-content"><strong>{issue.code}</strong><span>{issue.message}</span><small>{severityLabel(issue.severity)}{issue.timelineUs !== undefined ? ` · ${(issue.timelineUs / 1_000_000).toFixed(2)}秒` : ''}{issue.relatedClipId ? ` · clip ${issue.relatedClipId}` : ''}{issue.relatedMediaId ? ` · media ${issue.relatedMediaId}` : ''}</small></span>
                {navigable && <span className="qa-issue-jump">移動</span>}
              </button>
            })}
          </div>
        )}
      </div>
      <footer className="dialog-footer"><span>QAはread-onlyです。Projectと履歴は変更しません。</span><Button className="primary-button" onClick={onClose}>閉じる</Button></footer>
    </section>
  )
}
