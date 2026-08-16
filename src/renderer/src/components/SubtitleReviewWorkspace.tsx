import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, ClipboardList, X } from 'lucide-react'
import { formatTimecode } from '../../../shared/project'
import type { AutoCaptionBaseline } from '../../../shared/auto-caption-contract'
import type { ProjectFile, SubtitleClip } from '../../../shared/types'
import type { ReviewRating } from '../../../shared/review/types'
import type { ExperimentalReviewRecord } from '../../../shared/review/types'
import { buildLearningDataset, serializeLearningDatasetJsonl } from '../../../shared/learning-dataset'
import { subtitleReviewFilterLabel, subtitleReviewRatingForKey, subtitleReviewStatusLabel, filterSubtitleReviewIds, moveSubtitleReviewIndex, subtitleReviewProgress, type SubtitleReviewFilter } from '../subtitle-review-workspace'
import { useReviewStore } from '../review-store'
import { useEditorStore } from '../store'
import { Button, IconButton } from './Controls'

interface Props {
  project: ProjectFile
  baselines: readonly AutoCaptionBaseline[]
  onClose(): void
}

const captionsFor = (project: ProjectFile, ids: readonly string[]): SubtitleClip[] => {
  const wanted = new Set(ids)
  return project.tracks.flatMap((track) => track.clips).filter((clip): clip is SubtitleClip => clip.kind === 'subtitle' && wanted.has(clip.id)).sort((a, b) => a.startUs - b.startUs || a.id.localeCompare(b.id))
}

const ratingButton: Array<{ key: string; rating: ReviewRating; label: string }> = [
  { key: '1', rating: 'good', label: '良い' },
  { key: '2', rating: 'acceptable', label: '許容' },
  { key: '3', rating: 'corrected', label: '修正済み' },
  { key: '4', rating: 'skip', label: 'スキップ' }
]

const isTyping = (target: EventTarget | null): boolean => Boolean((target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]'))

export default function SubtitleReviewWorkspace({ project, baselines, onClose }: Props): React.JSX.Element {
  const selectedClipIds = useEditorStore((state) => state.selectedClipIds)
  const selectClip = useEditorStore((state) => state.selectClip)
  const setPlayhead = useEditorStore((state) => state.setPlayhead)
  const showNotice = useEditorStore((state) => state.showNotice)
  const review = useReviewStore()
  const [filter, setFilter] = useState<SubtitleReviewFilter>('all')
  const [datasetExporting, setDatasetExporting] = useState(false)
  const [datasetExportResult, setDatasetExportResult] = useState<{ exported: boolean; eligibleSamples: number; excludedSamples: number; malformedRecords: number } | null>(null)
  const fallbackIds = useMemo(() => new Set(captionsFor(project, review.targetIds).filter((clip) => {
    const job = baselines.find((baseline) => baseline.jobId === clip.sourceJobId)
    return Boolean(job?.fallback.used)
  }).map((clip) => clip.id)), [baselines, project, review.targetIds])
  const visibleIds = useMemo(() => filterSubtitleReviewIds(review.targetIds, filter, review.decisions, fallbackIds), [filter, fallbackIds, review.decisions, review.targetIds])
  const captions = useMemo(() => captionsFor(project, visibleIds), [project, visibleIds])
  const currentId = review.targetIds[review.targetIndex]
  const current = currentId ? captionsFor(project, [currentId])[0] : undefined
  const progress = subtitleReviewProgress(review.targetIds, review.decisions)
  const dataset = useMemo(() => buildLearningDataset(Object.values(review.decisions)), [review.decisions])

  const sync = (id: string | undefined): void => {
    if (!id) return
    const clip = captionsFor(project, [id])[0]
    if (!clip) return
    useReviewStore.getState().selectTarget(project, id)
    selectClip(clip.id)
    setPlayhead(clip.startUs)
  }

  const move = (direction: -1 | 1): void => sync(moveSubtitleReviewIndex(visibleIds, currentId, direction))

  const persist = async (record: ExperimentalReviewRecord | null): Promise<void> => {
    if (!record) return
    try {
      if (window.spectra) await window.spectra.upsertExperimentalReviewRecord(record)
      else localStorage.setItem(`spectra-review-${project.id}`, JSON.stringify(Object.values(useReviewStore.getState().decisions)))
    } catch (error) {
      showNotice(`レビュー記録を保存できませんでした: ${error instanceof Error ? error.message : '保存エラー'}`, 'error')
    }
  }

  const decide = (rating: ReviewRating): void => {
    const record = useReviewStore.getState().decide(project, rating)
    if (!record) return
    void persist(record)
    move(1)
  }

  const exportDataset = async (): Promise<void> => {
    setDatasetExporting(true)
    try {
      if (window.spectra) {
        setDatasetExportResult(await window.spectra.exportLearningDataset())
      } else {
        const jsonl = serializeLearningDatasetJsonl(dataset.samples)
        const link = document.createElement('a')
        link.href = URL.createObjectURL(new Blob([jsonl], { type: 'application/x-ndjson' }))
        link.download = 'spectra-learning-dataset.v1.jsonl'
        link.click()
        URL.revokeObjectURL(link.href)
        setDatasetExportResult({ exported: true, eligibleSamples: dataset.samples.length, excludedSamples: dataset.excludedSamples, malformedRecords: dataset.diagnostics.length })
      }
    } catch (error) {
      showNotice(`学習データを書き出せませんでした: ${error instanceof Error ? error.message : '書き出しエラー'}`, 'error')
    } finally {
      setDatasetExporting(false)
    }
  }

  useEffect(() => {
    const state = useReviewStore.getState()
    if (!state.enabled) {
      const selected = selectedClipIds.find((id) => captionsFor(project, [id]).length > 0)
      if (!state.start(project, selected)) showNotice('レビュー対象の字幕がありません。', 'warning')
    }
  }, [project, selectedClipIds, showNotice])

  useEffect(() => {
    if (!visibleIds.length) return
    if (!visibleIds.includes(currentId ?? '')) sync(visibleIds[0])
  }, [visibleIds, currentId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTyping(event.target)) return
      const rating = subtitleReviewRatingForKey(event.key)
      if (rating) { event.preventDefault(); decide(rating); return }
      if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'j') { event.preventDefault(); move(-1); return }
      if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'k') { event.preventDefault(); move(1) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return <div className="modal-backdrop subtitle-review-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="subtitle-review-workspace" role="dialog" aria-modal="true" aria-labelledby="subtitle-review-title">
      <header className="dialog-header">
        <div className="dialog-title-icon"><ClipboardList size={19} /></div>
        <div><span className="panel-eyebrow">REVIEW WORKSPACE</span><h2 id="subtitle-review-title">字幕レビュー</h2></div>
        <IconButton label="字幕レビューを閉じる" onClick={onClose}><X size={18} /></IconButton>
      </header>
      <div className="subtitle-review-summary" role="status"><strong>{progress.reviewed} / {progress.total}</strong><span>確認済み / 全字幕</span><span>{visibleIds.length}件表示 · {subtitleReviewFilterLabel(filter)}</span></div>
      <div className="subtitle-review-toolbar">
        <label>表示<select aria-label="レビュー表示フィルター" value={filter} onChange={(event) => setFilter(event.target.value as SubtitleReviewFilter)}><option value="all">全件</option><option value="pending">未確認のみ</option><option value="corrected">修正済みのみ</option><option value="fallback">fallback字幕のみ</option></select></label>
        <span className="subtitle-review-hint">1–4 評価 · J/K / ←→ 移動</span>
      </div>
      <div className="subtitle-review-dataset" aria-label="学習データ概要">
        <div><strong>学習データ</strong><span>適格 {dataset.samples.length}件 · 除外 {dataset.excludedSamples}件</span>{dataset.diagnostics.length > 0 && <small>不正record {dataset.diagnostics.length}件を除外</small>}</div>
        <span className="subtitle-review-dataset-categories">{Object.entries(dataset.correctionCategories).map(([category, count]) => `${category} ${count}`).join(' · ') || 'まだ評価済みrecordがありません'}</span>
        <Button className="subtle-button" disabled={datasetExporting} onClick={() => void exportDataset()}>{datasetExporting ? '書き出し中…' : '学習データを書き出す'}</Button>
        {datasetExportResult && <small className="subtitle-review-dataset-result">{datasetExportResult.exported ? `${datasetExportResult.eligibleSamples}件を書き出しました。` : 'ローカル集約datasetへ保存しました。ファイル書き出しはキャンセルされました。'}{datasetExportResult.malformedRecords ? ` 不正record ${datasetExportResult.malformedRecords}件を除外。` : ''}</small>}
      </div>
      <div className="subtitle-review-body">
        <div className="subtitle-review-list" role="list" aria-label="字幕レビュー一覧">
          {captions.map((clip, index) => <button type="button" role="listitem" className={`subtitle-review-row ${clip.id === currentId ? 'is-current' : ''}`} key={clip.id} onClick={() => sync(clip.id)}>
            <span className="subtitle-review-index">{review.targetIds.indexOf(clip.id) + 1}</span>
            <span className="subtitle-review-time">{formatTimecode(clip.startUs, project)}</span>
            <span className="subtitle-review-text">{clip.text || '（本文なし）'}</span>
            <span className={`subtitle-review-status status-${review.decisions[clip.id]?.rating ?? 'pending'}`}>{subtitleReviewStatusLabel(review.decisions[clip.id]?.rating)}</span>
            {index === 0 && clip.id === currentId && <span className="sr-only">現在選択中</span>}
          </button>)}
          {!captions.length && <div className="subtitle-review-empty">この条件の字幕はありません。</div>}
        </div>
        <div className="subtitle-review-current">
          {current ? <><small>現在の字幕 · {formatTimecode(current.startUs, project)}</small><strong>{current.text || '（本文なし）'}</strong><span>字幕を選択し、TimelineとInspectorで編集できます。</span><div className="subtitle-review-actions">{ratingButton.map(({ key, rating, label }) => <Button key={rating} onClick={() => decide(rating)}><b>{key}</b>{label}</Button>)}</div><div className="subtitle-review-nav"><Button className="subtle-button" onClick={() => move(-1)}><ChevronLeft size={15} />前へ</Button><Button className="subtle-button" onClick={() => move(1)}>次へ<ChevronRight size={15} /></Button></div></> : <div className="subtitle-review-empty"><Check size={18} />字幕を選択してください。</div>}
        </div>
      </div>
      <footer className="dialog-footer"><span>Review状態はProject本体とは別のreview logへ保存されます。</span><Button className="primary-button" onClick={onClose}>閉じる</Button></footer>
    </section>
  </div>
}
