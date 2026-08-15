import { useCallback, useEffect, useState } from 'react'
import {
  AudioLines,
  Captions,
  Check,
  ChevronDown,
  CircleAlert,
  CloudOff,
  FilePlus2,
  FolderOpen,
  MonitorUp,
  Redo2,
  Save,
  Scissors,
  Undo2,
  X
} from 'lucide-react'
import { createEmptyProject } from '../../shared/project'
import type { AutoCaptionSettings } from '../../shared/auto-caption-contract'
import { SUBTITLE_TEMPLATES } from '../../shared/subtitle-templates'
import type { EncoderReport, ProjectFile } from '../../shared/types'
import { BrandMark } from './components/Brand'
import { Button, IconButton } from './components/Controls'
import ExportDialog from './components/ExportDialog'
import Inspector from './components/Inspector'
import MediaBin from './components/MediaBin'
import Preview from './components/Preview'
import Timeline from './components/Timeline'
import ReviewPanel from './components/ReviewPanel'
import { useEditorStore } from './store'
import { useReviewStore } from './review-store'

const isTypingTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'))
}

export default function App(): React.JSX.Element {
  const {
    project,
    selectedClipIds,
    past,
    future,
    dirty,
    notice,
    playing,
    playheadUs,
    snapping,
    loadProject,
    markSaved,
    undo,
    redo,
    setPlaying,
    setPlayhead,
    setTool,
    setSnapping,
    splitSelected,
    deleteSelected,
    showNotice,
    clearNotice,
    selectClip,
    addSubtitle,
    autoCaptionSelected,
    cancelAutoCaption,
    autoCaptionProgress,
    fullCorrectionSession,
    fullCorrectionResult,
    hydrateFullCorrectionSessions,
    startFullCorrection,
    finishFullCorrection,
    clearFullCorrectionResult
  } = useEditorStore()
  const [workspace, setWorkspace] = useState<'edit' | 'audio' | 'captions'>('edit')
  const [exportOpen, setExportOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [recoveryStatus, setRecoveryStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [encoderReport, setEncoderReport] = useState<EncoderReport | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  const [captioning, setCaptioning] = useState(false)
  const [captionDialogOpen, setCaptionDialogOpen] = useState(false)
  const [autoCaptionEnabled, setAutoCaptionEnabled] = useState(true)
  const [captionSettings, setCaptionSettings] = useState<AutoCaptionSettings>({
    language: 'ja', maxChars: 32, maxLines: 2, segmentationMode: 'auto',
    silenceCut: 'natural', accelerationMode: 'auto', subtitleTemplate: 'default'
  })
  const [captionSummary, setCaptionSummary] = useState<{ captionCount: number; rawWordCount: number; fallbackUsed: boolean } | null>(null)
  const reviewEnabled = useReviewStore((state) => state.enabled)

  useEffect(() => {
    useReviewStore.getState().stop()
    if (window.spectra) {
      void Promise.all([window.spectra.loadExperimentalReviewRecords(), window.spectra.loadFullCorrectionSessions()])
        .then(([records, sessions]) => {
          useReviewStore.getState().hydrate(project, records)
          hydrateFullCorrectionSessions(sessions)
        })
        .catch(() => undefined)
    }
  }, [hydrateFullCorrectionSessions, project.id])

  const save = useCallback(async (saveAs = false): Promise<void> => {
    if (!window.spectra) {
      localStorage.setItem('spectra-demo-project', JSON.stringify(useEditorStore.getState().project))
      markSaved()
      showNotice('ブラウザデモの状態をこのブラウザへ保存しました。', 'success')
      return
    }
    setSaving(true)
    try {
      const result = await window.spectra.saveProject(useEditorStore.getState().project, saveAs)
      if (!result.cancelled) {
        markSaved(result.project)
        showNotice(`プロジェクトを保存しました${result.projectPath ? `: ${result.projectPath}` : ''}`, 'success')
      }
    } catch (error) {
      showNotice(`保存できませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [markSaved, showNotice])

  const open = useCallback(async (): Promise<void> => {
    if (!window.spectra) {
      const saved = localStorage.getItem('spectra-demo-project')
      if (!saved) return showNotice('ブラウザへ保存されたデモプロジェクトはありません。')
      try {
        loadProject(JSON.parse(saved) as typeof project)
        showNotice('ブラウザへ保存したデモ状態を開きました。', 'success')
      } catch {
        showNotice('保存データを開けませんでした。', 'error')
      }
      return
    }
    try {
      const result = await window.spectra.openProject()
      if (!result.cancelled && result.project) {
        loadProject(result.project)
        showNotice(
          result.warnings.length ? `プロジェクトを開きました。${result.warnings.length}件の素材がオフラインです。` : 'プロジェクトを開きました。',
          result.warnings.length ? 'warning' : 'success'
        )
      }
    } catch (error) {
      showNotice(`プロジェクトを開けませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }, [loadProject, project, showNotice])

  const detectEncoders = useCallback(async (force = false): Promise<void> => {
    if (!window.spectra) return
    try {
      setEncoderReport(await window.spectra.detectEncoders(force))
    } catch (error) {
      showNotice(`エンコーダーを検出できませんでした: ${error instanceof Error ? error.message : String(error)}`, 'warning')
    }
  }, [showNotice])

  useEffect(() => {
    void detectEncoders()
    if (!window.spectra) return
    void Promise.all([window.spectra.getAppInfo(), window.spectra.loadRecovery()]).then(([info, recovery]) => {
      if (!info.smokeMode && recovery && window.confirm('前回の自動保存データがあります。復元しますか？')) {
        loadProject(recovery)
        showNotice('自動保存データを復元しました。', 'success')
      }
    }).catch(() => undefined)
  }, [detectEncoders, loadProject, showNotice])

  useEffect(() => {
    if (!window.spectra) return
    let active = true
    const onPreviewE2eProject = (event: Event): void => {
      const detail = (event as CustomEvent<{ project?: ProjectFile; timeUs?: number }>).detail
      if (!detail?.project) return
      try {
        loadProject(detail.project)
        if (Number.isFinite(detail.timeUs)) setPlayhead(detail.timeUs ?? 0)
      } catch (error) {
        showNotice(`E2Eプロジェクトを読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
    void window.spectra.getAppInfo().then((info) => {
      if (active && info.smokeMode) window.addEventListener('spectra:e2e-project', onPreviewE2eProject)
    }).catch(() => undefined)
    return () => {
      active = false
      window.removeEventListener('spectra:e2e-project', onPreviewE2eProject)
    }
  }, [loadProject, setPlayhead, showNotice])

  useEffect(() => {
    if (!dirty) return
    setRecoveryStatus('saving')
    const timer = window.setTimeout(() => {
      const latest = useEditorStore.getState().project
      const task = window.spectra
        ? window.spectra.writeRecovery(latest)
        : Promise.resolve(localStorage.setItem('spectra-demo-recovery', JSON.stringify(latest)))
      void task.then(() => setRecoveryStatus('saved')).catch(() => setRecoveryStatus('error'))
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [project, dirty])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(clearNotice, notice.tone === 'error' ? 7000 : 4200)
    return () => window.clearTimeout(timer)
  }, [notice, clearNotice])

  useEffect(() => {
    const onError = (event: ErrorEvent): void => setAppError(event.message)
    const onRejection = (event: PromiseRejectionEvent): void => setAppError(event.reason instanceof Error ? event.reason.message : String(event.reason))
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  useEffect(() => {
    const keyboard = (event: KeyboardEvent): void => {
      const typing = isTypingTarget(event.target)
      const command = event.ctrlKey || event.metaKey
      if (command && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault(); void save(event.shiftKey); return
      }
      if (command && event.key.toLocaleLowerCase() === 'o') {
        event.preventDefault(); void open(); return
      }
      if (typing) return
      if (useReviewStore.getState().enabled && ['a', 'b', 'c', 'd'].includes(event.key.toLocaleLowerCase())) return
      if (command && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault(); event.shiftKey ? redo() : undo(); return
      }
      if (command && event.key.toLocaleLowerCase() === 'y') {
        event.preventDefault(); redo(); return
      }
      if (command && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault(); splitSelected(); return
      }
      if (event.key === ' ') {
        event.preventDefault(); setPlaying(!useEditorStore.getState().playing); return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault(); deleteSelected(event.shiftKey); return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const direction = event.key === 'ArrowLeft' ? -1 : 1
        setPlayhead(Math.max(0, useEditorStore.getState().playheadUs + direction * 1_000_000 / 30))
        return
      }
      if (event.key.toLocaleLowerCase() === 'v') setTool('select')
      if (event.key.toLocaleLowerCase() === 'c') setTool('razor')
      if (event.key.toLocaleLowerCase() === 's') setSnapping(!useEditorStore.getState().snapping)
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [deleteSelected, open, redo, save, setPlayhead, setPlaying, setSnapping, setTool, splitSelected, undo])

  const chooseWorkspace = (next: typeof workspace): void => {
    setWorkspace(next)
    if (next === 'captions') {
      const caption = project.tracks.find((track) => track.kind === 'subtitle')?.clips[0]
      caption ? selectClip(caption.id) : addSubtitle()
    }
    if (next === 'audio') {
      const audio = project.tracks.flatMap((track) => track.clips).find((clip) => clip.kind === 'audio')
      if (audio) selectClip(audio.id)
    }
  }

  const hardwareEncoder = encoderReport?.capabilities.find((item) => item.hardware && item.available)

  const createNewProject = (): void => {
    if (dirty && !window.confirm('未保存の変更があります。新規プロジェクトへ切り替えますか？')) return
    loadProject(createEmptyProject())
    showNotice('新しいプロジェクトを作成しました。', 'success')
  }

  const selectedCaptionClip = selectedClipIds.length === 1
    ? project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipIds[0])
    : undefined

  const selectedAutoCaptionTrack = selectedCaptionClip?.kind === 'subtitle' && selectedCaptionClip.sourceJobId
    ? project.tracks.find((track) => track.kind === 'subtitle' && track.clips.some((clip) => clip.id === selectedCaptionClip.id))
    : undefined

  const runAutoCaption = async (): Promise<void> => {
    setCaptionSummary(null)
    setCaptioning(true)
    try {
      const summary = await autoCaptionSelected(captionSettings)
      if (summary) setCaptionSummary(summary)
    } finally {
      setCaptioning(false)
    }
  }

  return (
    <main className={`app-shell workspace-${workspace}`}>
      <header className="app-header">
        <BrandMark />
        <div className="project-menu">
          <button type="button" onClick={() => void open()} title={project.projectPath ?? 'デモプロジェクト'}>
            <strong>{project.name}</strong>
            <span>{dirty ? '未保存の変更' : '保存済み'} · {project.sequence.width}×{project.sequence.height}</span>
            <ChevronDown size={14} />
          </button>
        </div>
        <nav className="workspace-nav" aria-label="ワークスペース">
          <button type="button" className={workspace === 'edit' ? 'is-active' : ''} onClick={() => chooseWorkspace('edit')}><Scissors size={15} />編集</button>
          <button type="button" className={workspace === 'audio' ? 'is-active' : ''} onClick={() => chooseWorkspace('audio')}><AudioLines size={15} />音声</button>
          <button type="button" className={workspace === 'captions' ? 'is-active' : ''} onClick={() => chooseWorkspace('captions')}><Captions size={15} />字幕</button>
        </nav>
        <div className="header-actions">
          <IconButton label="新規プロジェクト" onClick={createNewProject}><FilePlus2 size={16} /></IconButton>
          <IconButton label="プロジェクトを開く（Ctrl+O）" onClick={() => void open()}><FolderOpen size={16} /></IconButton>
          <IconButton label="元に戻す（Ctrl+Z）" disabled={!past.length} onClick={undo}><Undo2 size={16} /></IconButton>
          <IconButton label="やり直す（Ctrl+Shift+Z）" disabled={!future.length} onClick={redo}><Redo2 size={16} /></IconButton>
          <Button className="save-button" disabled={saving} onClick={() => void save()}><Save size={15} />{saving ? '保存中…' : '保存'}</Button>
          <Button className={reviewEnabled ? 'review-toggle is-active' : 'review-toggle'} onClick={() => {
            if (reviewEnabled) useReviewStore.getState().stop()
            else if (!useReviewStore.getState().start(project, useEditorStore.getState().selectedClipIds[0])) showNotice('レビュー対象の字幕がありません。', 'warning')
          }}>レビュー {reviewEnabled ? 'ON' : 'OFF'}</Button>
          {(fullCorrectionSession || selectedAutoCaptionTrack) && <Button className={fullCorrectionSession ? 'review-toggle is-active' : 'review-toggle'} onClick={() => { void (fullCorrectionSession ? finishFullCorrection() : startFullCorrection()) }}>{fullCorrectionSession ? '修正完了' : '全文修正'}</Button>}
          <Button disabled={captioning} onClick={() => { setCaptionSummary(null); setCaptionDialogOpen(true) }}><Captions size={15} />自動処理</Button>
          <Button className="primary-button export-button" onClick={() => setExportOpen(true)}><MonitorUp size={16} />書き出す</Button>
        </div>
      </header>
      <div className="app-statusbar">
        <span className={`autosave-status status-${recoveryStatus}`}>{recoveryStatus === 'saving' ? '自動保存中…' : recoveryStatus === 'error' ? '自動保存に失敗' : <><Check size={12} />自動保存</>}</span>
        <span className="gpu-chip">{hardwareEncoder ? <><i />GPU: {hardwareEncoder.name}</> : <><CloudOff size={12} />CPUエンコード</>}</span>
        {!window.spectra && <span className="demo-badge">INTERACTIVE DEMO</span>}
        <span className="spacer" />
        <span>{playing ? '再生中' : '停止'} · {(playheadUs / 1_000_000).toFixed(1)}秒</span>
        <span>スナップ {snapping ? 'ON' : 'OFF'}</span>
      </div>
      <div className="editor-workspace">
        <MediaBin />
        <Preview />
        <Inspector />
        <Timeline />
      </div>
      <ReviewPanel />
      {fullCorrectionResult && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) clearFullCorrectionResult() }}>
          <section className="caption-dialog" role="dialog" aria-modal="true" aria-labelledby="full-correction-title">
            <header className="dialog-header"><div className="dialog-title-icon"><Check size={17} /></div><div><span className="panel-eyebrow">FULL CORRECTION</span><h2 id="full-correction-title">修正差分</h2></div><IconButton label="閉じる" onClick={clearFullCorrectionResult}><X size={15} /></IconButton></header>
            <div className="caption-dialog-body">
              <div className="caption-success" role="status">全文修正を保存しました。AI字幕baselineと現在のtrackを比較しています。</div>
              <div className="review-complete"><strong>{fullCorrectionResult.track.name}</strong><span>字幕数: {fullCorrectionResult.statistics.beforeCaptionCount}件 → {fullCorrectionResult.statistics.afterCaptionCount}件</span><span>変更なし {fullCorrectionResult.statistics.unchanged} · 分割 {fullCorrectionResult.statistics.split} · 結合 {fullCorrectionResult.statistics.merge} · 境界移動 {fullCorrectionResult.statistics.move}</span><span>本文 {fullCorrectionResult.statistics.text} · 時間 {fullCorrectionResult.statistics.timing} · 削除 {fullCorrectionResult.statistics.delete} · 複合 {fullCorrectionResult.statistics.mixed}</span></div>
              {!fullCorrectionResult.eligibility.eligible && <div className="caption-dialog-warning">差分は保存されましたが、学習用eligibilityは対象外です。{fullCorrectionResult.eligibility.reason ?? ''}</div>}
            </div>
            <footer className="dialog-footer"><span>既存Review Modeの評価記録とは別artifactです。</span><Button className="primary-button" onClick={clearFullCorrectionResult}>閉じる</Button></footer>
          </section>
        </div>
      )}
      {notice && (
        <div className={`toast toast-${notice.tone}`} role="status">
          {notice.tone === 'error' || notice.tone === 'warning' ? <CircleAlert size={17} /> : <Check size={17} />}
          <span>{notice.message}</span>
          <IconButton label="通知を閉じる" onClick={clearNotice}><X size={14} /></IconButton>
        </div>
      )}
      {appError && (
        <div className="error-banner" role="alert"><CircleAlert size={18} /><strong>画面でエラーが発生しました</strong><span>{appError}</span><button type="button" onClick={() => setAppError(null)}>閉じる</button></div>
      )}
      {captionDialogOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !captioning) setCaptionDialogOpen(false) }}>
          <section className="caption-dialog" role="dialog" aria-modal="true" aria-labelledby="auto-caption-title">
            <header className="dialog-header">
              <div className="dialog-title-icon"><Captions size={17} /></div>
              <div><span className="panel-eyebrow">AUTO PROCESSING</span><h2 id="auto-caption-title">自動処理</h2></div>
              <IconButton label="閉じる" disabled={captioning} onClick={() => setCaptionDialogOpen(false)}><X size={15} /></IconButton>
            </header>
            <div className="caption-dialog-body">
              {!selectedCaptionClip || (selectedCaptionClip.kind !== 'video' && selectedCaptionClip.kind !== 'audio') ? (
                <div className="caption-dialog-warning">動画または音声クリップを1つ選択してから生成してください。</div>
              ) : (
                <>
                  <div className="caption-target"><span>対象clip</span><strong>{selectedCaptionClip.name}</strong></div>
                  <label className="field"><span className="field-label">自動字幕</span><select disabled={captioning} value={autoCaptionEnabled ? 'on' : 'off'} onChange={(event) => setAutoCaptionEnabled(event.target.value === 'on')}><option value="on">ON</option><option value="off">OFF</option></select></label>
                  <label className="field"><span className="field-label">無音カット</span><select disabled={captioning} value={captionSettings.silenceCut ?? 'natural'} onChange={(event) => setCaptionSettings((current) => ({ ...current, silenceCut: event.target.value as AutoCaptionSettings['silenceCut'] }))}><option value="off">OFF</option><option value="natural">自然</option><option value="strong">強め</option></select></label>
                  <label className="field"><span className="field-label">処理デバイス</span><select disabled={captioning} value={captionSettings.accelerationMode ?? 'auto'} onChange={(event) => setCaptionSettings((current) => ({ ...current, accelerationMode: event.target.value as AutoCaptionSettings['accelerationMode'] }))}><option value="auto">自動（推奨）</option><option value="gpu">GPU優先</option><option value="cpu">CPU</option></select></label>
                  <label className="field"><span className="field-label">言語</span><select disabled={captioning} value={captionSettings.language} onChange={(event) => setCaptionSettings((current) => ({ ...current, language: event.target.value }))}><option value="ja">日本語</option><option value="auto">自動判定</option></select></label>
                  <label className="field"><span className="field-label">最大文字数</span><span className="number-input"><input disabled={captioning} type="number" min={1} max={10000} value={captionSettings.maxChars} onChange={(event) => setCaptionSettings((current) => ({ ...current, maxChars: Math.max(1, Math.min(10000, Number(event.target.value) || 32)) }))} /><span>文字</span></span></label>
                  <label className="field"><span className="field-label">最大行数</span><span className="number-input"><input disabled={captioning} type="number" min={1} max={16} value={captionSettings.maxLines ?? 2} onChange={(event) => setCaptionSettings((current) => ({ ...current, maxLines: Math.max(1, Math.min(16, Number(event.target.value) || 2)) }))} /><span>行</span></span></label>
                  <label className="field"><span className="field-label">字幕品質</span><select disabled={captioning} value={captionSettings.segmentationMode} onChange={(event) => setCaptionSettings((current) => ({ ...current, segmentationMode: event.target.value as AutoCaptionSettings['segmentationMode'] }))}><option value="auto">高品質</option><option value="rule">ルール</option></select></label>
                  <label className="field"><span className="field-label">字幕テンプレート</span><select disabled={captioning} value={captionSettings.subtitleTemplate ?? 'default'} onChange={(event) => setCaptionSettings((current) => ({ ...current, subtitleTemplate: event.target.value as AutoCaptionSettings['subtitleTemplate'] }))}>{SUBTITLE_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}</select></label>
                  {autoCaptionProgress && (
                    <div className={`caption-progress ${autoCaptionProgress.state === 'failed' ? 'stage-failed' : ''}`} aria-live="polite">
                      <div className="progress-heading"><strong>{autoCaptionProgress.state === 'preparing' ? '音声準備' : autoCaptionProgress.state === 'transcribing' ? '文字起こし' : autoCaptionProgress.state === 'silence_analyzing' ? '無音解析' : autoCaptionProgress.state === 'segmenting' ? '字幕区切り' : autoCaptionProgress.state === 'completed' ? '字幕配置' : '自動字幕'}</strong><span>{Math.round(autoCaptionProgress.ratio * 100)}%</span></div>
                      <div className="progress-track"><i style={{ width: `${Math.max(0, Math.min(100, autoCaptionProgress.ratio * 100))}%` }} /></div>
                      <small>{autoCaptionProgress.message}</small>
                    </div>
                  )}
                  {captionSummary && <div className="caption-success" role="status">字幕 {captionSummary.captionCount}件・raw word {captionSummary.rawWordCount}件を新規トラックへ配置しました。{captionSummary.fallbackUsed ? ' ルールfallbackを使用しています。' : ''}</div>}
                </>
              )}
            </div>
            <footer className="dialog-footer">
              <span>{captioning ? '生成中はプロジェクトを変更しません。' : autoCaptionEnabled ? '既存字幕は上書きされません。' : '自動字幕OFFでは実行できません。'}</span>
              <div>
                <Button disabled={captioning && !useEditorStore.getState().autoCaptionJobId} onClick={() => { if (captioning) void cancelAutoCaption(); else setCaptionDialogOpen(false) }}>{captioning ? 'キャンセル' : 'キャンセル'}</Button>
                {!captioning && captionSummary ? <Button className="primary-button" onClick={() => setCaptionDialogOpen(false)}>閉じる</Button> : <Button className="primary-button" disabled={captioning || !autoCaptionEnabled || !selectedCaptionClip || (selectedCaptionClip.kind !== 'video' && selectedCaptionClip.kind !== 'audio')} onClick={() => void runAutoCaption()}>{captioning ? '実行中…' : '実行'}</Button>}
              </div>
            </footer>
          </section>
        </div>
      )}
      {exportOpen && <ExportDialog report={encoderReport} onClose={() => setExportOpen(false)} refreshEncoders={() => detectEncoders(true)} />}
    </main>
  )
}
