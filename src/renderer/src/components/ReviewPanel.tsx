import { useEffect } from 'react'
import { Check, X } from 'lucide-react'
import { findSubtitleContext } from '../../../shared/project'
import type { ReviewRating } from '../../../shared/review/types'
import { reviewRatingForShortcut } from '../../../shared/review/shortcuts'
import { reviewProgress, useReviewStore } from '../review-store'
import { useEditorStore } from '../store'
import { Button, IconButton } from './Controls'

const isTypingTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'))
}

const ratingLabels: Array<{ rating: ReviewRating; key: string; label: string }> = [
  { rating: 'good', key: 'A', label: 'このままで良い' },
  { rating: 'acceptable', key: 'B', label: '少し違和感はあるが修正不要' },
  { rating: 'corrected', key: 'C', label: '修正した' },
  { rating: 'skip', key: 'D', label: '今回は判断を飛ばす' }
]

const captionText = (text: string | undefined): string => text?.replace(/\n/g, ' / ') || '（なし）'

export default function ReviewPanel(): React.JSX.Element | null {
  const project = useEditorStore((state) => state.project)
  const selectClip = useEditorStore((state) => state.selectClip)
  const setPlayhead = useEditorStore((state) => state.setPlayhead)
  const showNotice = useEditorStore((state) => state.showNotice)
  const review = useReviewStore()
  const targetId = review.targetIds[review.targetIndex]
  const target = targetId ? project.tracks.flatMap((track) => track.clips).find((clip): clip is Extract<typeof clip, { kind: 'subtitle' }> => clip.id === targetId && clip.kind === 'subtitle') : undefined
  const context = target ? findSubtitleContext(project, target.id) : {}
  const progress = reviewProgress(review)
  const currentDecision = targetId ? review.decisions[targetId] : undefined

  const syncTarget = (id: string | undefined): void => {
    if (!id) return
    const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === id && item.kind === 'subtitle')
    if (!clip || clip.kind !== 'subtitle') return
    selectClip(clip.id)
    setPlayhead(clip.startUs)
  }

  const persist = async (record: ReturnType<typeof review.decide>): Promise<void> => {
    if (!record) return
    try {
      if (window.spectra) {
        const result = await window.spectra.upsertExperimentalReviewRecord(record)
        useReviewStore.setState({ logPath: result.path })
      } else {
        const key = 'spectra-demo-review-log'
        const existing = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[]
        localStorage.setItem(key, JSON.stringify([...existing.filter((item) => (item as { target?: { captionId?: string } }).target?.captionId !== record.target.captionId), record]))
      }
    } catch (error) {
      showNotice(`レビュー記録を保存できませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const decide = (rating: ReviewRating): void => {
    const record = useReviewStore.getState().decide(project, rating)
    if (!record) return
    if (rating === 'corrected' && record.correction.primary === 'none') showNotice('変更は検出されませんでした。修正なしとして記録します。', 'warning')
    void persist(record)
    useReviewStore.getState().next(project)
  }

  useEffect(() => {
    if (review.enabled) syncTarget(targetId)
  }, [review.enabled, targetId, project, selectClip, setPlayhead])

  useEffect(() => {
    if (!review.enabled) return
    const keyboard = (event: KeyboardEvent): void => {
      const rating = reviewRatingForShortcut(true, isTypingTarget(event.target), event.key)
      if (!rating) return
      event.preventDefault()
      decide(rating)
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [review.enabled, project, showNotice])

  if (!review.enabled) return null

  return (
    <aside className="review-panel" data-review-panel aria-label="字幕レビュー">
      <div className="review-panel-header">
        <div><strong>字幕レビュー</strong><small>Review Mode ON</small></div>
        <IconButton label="Review Modeを終了" onClick={review.stop}><X size={15} /></IconButton>
      </div>
      <div className="review-progress"><strong>{Math.min(review.targetIndex + 1, progress.total)} / {progress.total}</strong><span>完了 {progress.reviewed}件 · 残り {Math.max(0, progress.total - progress.reviewed)}件</span></div>
      {review.completed ? (
        <div className="review-complete" role="status"><Check size={18} /><strong>レビュー完了</strong><span>良 {progress.good} · 可 {progress.acceptable} · 修正 {progress.corrected} · 保留 {progress.skipped}</span></div>
      ) : target ? (
        <>
          <div className="review-neighborhood">
            <div><small>前</small><span>{captionText(context.previous?.text)}</span></div>
            <div className="is-current"><small>現在</small><span>{captionText(target.text)}</span></div>
            <div><small>次</small><span>{captionText(context.next?.text)}</span></div>
          </div>
          <p className="review-baseline-note">編集後の最終状態を、開始時の字幕と比較します。</p>
          <div className="review-ratings" aria-label="評価">
            {ratingLabels.map(({ rating, key, label }) => <Button key={rating} data-review-rating={rating} onClick={() => decide(rating)}><b>{key}</b><span>{label}</span></Button>)}
          </div>
          {currentDecision && <div className="review-decision">今回の評価: {ratingLabels.find((item) => item.rating === currentDecision.rating)?.label}</div>}
          <div className="review-navigation"><Button className="subtle-button" onClick={() => useReviewStore.getState().previous(project)}>前へ</Button><Button className="subtle-button" onClick={() => useReviewStore.getState().next(project)}>次へ</Button></div>
        </>
      ) : <p className="review-empty">レビュー対象の字幕がありません。</p>}
      {review.logPath && <small className="review-log-path">記録先: {review.logPath}</small>}
    </aside>
  )
}
