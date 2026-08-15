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
import { getSubtitleTemplate, getSubtitleTemplateSettings, SUBTITLE_TEMPLATES, type SubtitleTemplateDraft, type UserSubtitleTemplate } from '../../shared/subtitle-templates'
import type { EncoderReport, ProjectFile } from '../../shared/types'
import { BrandMark } from './components/Brand'
import { Button, IconButton } from './components/Controls'
import ExportDialog from './components/ExportDialog'
import Inspector from './components/Inspector'
import MediaBin from './components/MediaBin'
import Preview from './components/Preview'
import Timeline from './components/Timeline'
import ReviewPanel from './components/ReviewPanel'
import SubtitleTemplateManagerPanel from './components/SubtitleTemplateManagerPanel'
import SubtitleTemplatePreview from './components/SubtitleTemplatePreview'
import { useEditorStore } from './store'
import { useReviewStore } from './review-store'
import { autoCaptionControlState } from './action-state'

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
    selectAsset,
    addSubtitle,
    autoCaptionSelected,
    setUserSubtitleTemplates: setStoreUserSubtitleTemplates,
    setDefaultSubtitleTemplateId,
    setAutoCaptionSettingsSeed,
    defaultSubtitleTemplateId,
    cancelAutoCaption,
    autoCaptionJobId,
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
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false)
  const [autoCaptionEnabled, setAutoCaptionEnabled] = useState(true)
  const [userSubtitleTemplates, setUserSubtitleTemplates] = useState<UserSubtitleTemplate[]>([])
  const [lastUsedSubtitleTemplateId, setLastUsedSubtitleTemplateId] = useState('default')
  const [captionSettings, setCaptionSettings] = useState<AutoCaptionSettings>({
    language: 'ja', maxChars: 32, maxLines: 2, segmentationMode: 'auto',
    silenceCut: 'natural', accelerationMode: 'auto', subtitleTemplate: 'default'
  })
  const [captionSummary, setCaptionSummary] = useState<{ captionCount: number; rawWordCount: number; fallbackUsed: boolean } | null>(null)
  const reviewEnabled = useReviewStore((state) => state.enabled)

  useEffect(() => {
    setAutoCaptionSettingsSeed({
      maxChars: captionSettings.maxChars,
      maxLines: captionSettings.maxLines ?? 2,
      segmentationMode: captionSettings.segmentationMode
    })
  }, [captionSettings.maxChars, captionSettings.maxLines, captionSettings.segmentationMode, setAutoCaptionSettingsSeed])

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

  useEffect(() => {
    if (!window.spectra) return
    const api = window.spectra
    void Promise.all([api.loadSubtitleTemplates(), api.loadAppSettings()]).then(([catalog, appSettings]) => {
      setUserSubtitleTemplates(catalog.userTemplates)
      setStoreUserSubtitleTemplates(catalog.userTemplates)
      setDefaultSubtitleTemplateId(catalog.defaultTemplateId)
      const resolvedLastUsed = getSubtitleTemplate(appSettings.lastUsedSubtitleTemplateId, catalog.userTemplates)
        ? appSettings.lastUsedSubtitleTemplateId
        : 'default'
      setLastUsedSubtitleTemplateId(resolvedLastUsed)
      if (resolvedLastUsed !== appSettings.lastUsedSubtitleTemplateId) void api.setLastUsedSubtitleTemplateId(resolvedLastUsed)
      const settings = getSubtitleTemplateSettings(resolvedLastUsed, catalog.userTemplates)
      setCaptionSettings((current) => ({
        ...current,
        subtitleTemplate: resolvedLastUsed,
        maxChars: settings.maxChars,
        maxLines: settings.maxLines,
        segmentationMode: settings.segmentationMode
      }))
    }).catch(() => undefined)
  }, [setDefaultSubtitleTemplateId, setStoreUserSubtitleTemplates])

  useEffect(() => {
    if (!getSubtitleTemplate(lastUsedSubtitleTemplateId, userSubtitleTemplates)) {
      setLastUsedSubtitleTemplateId('default')
      if (window.spectra) void window.spectra.setLastUsedSubtitleTemplateId('default')
      const settings = getSubtitleTemplateSettings('default', userSubtitleTemplates)
      setCaptionSettings((current) => ({ ...current, subtitleTemplate: 'default', maxChars: settings.maxChars, maxLines: settings.maxLines, segmentationMode: settings.segmentationMode }))
    }
  }, [lastUsedSubtitleTemplateId, userSubtitleTemplates])

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
      const detail = (event as CustomEvent<{ project?: ProjectFile; timeUs?: number; selectClipId?: string; selectAssetId?: string }>).detail
      if (!detail?.project) return
      try {
        loadProject(detail.project)
        if (detail.selectClipId || detail.selectAssetId) window.setTimeout(() => {
          if (detail.selectClipId) selectClip(detail.selectClipId)
          if (detail.selectAssetId) selectAsset(detail.selectAssetId)
        }, 0)
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
  }, [loadProject, selectAsset, selectClip, setPlayhead, showNotice])

  useEffect(() => {
    if (!window.spectra) return
    let active = true
    const onProcessingSmoke = (event: Event): void => {
      const state = (event as CustomEvent<{ state?: string }>).detail?.state
      if (active && state) setCaptioning(state === 'running')
    }
    void window.spectra.getAppInfo().then((info) => {
      if (active && info.smokeMode) window.addEventListener('spectra:e2e-processing', onProcessingSmoke)
    }).catch(() => undefined)
    return () => {
      active = false
      window.removeEventListener('spectra:e2e-processing', onProcessingSmoke)
    }
  }, [])

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

  const selectedCaptionAsset = selectedCaptionClip && 'assetId' in selectedCaptionClip
    ? project.media.find((asset) => asset.id === selectedCaptionClip.assetId)
    : undefined
  const selectedSubtitleClip = selectedCaptionClip?.kind === 'subtitle' ? selectedCaptionClip : undefined
  const autoCaptionRunState = autoCaptionControlState({
    captioning,
    clipKind: selectedCaptionClip?.kind,
    assetOffline: selectedCaptionAsset?.offline,
    assetHasAudio: selectedCaptionAsset?.hasAudio
  })

  const selectedAutoCaptionTrack = selectedCaptionClip?.kind === 'subtitle' && selectedCaptionClip.sourceJobId
    ? project.tracks.find((track) => track.kind === 'subtitle' && track.clips.some((clip) => clip.id === selectedCaptionClip.id))
    : undefined
  const selectedAutoProcessingTemplate = getSubtitleTemplate(captionSettings.subtitleTemplate ?? 'default', userSubtitleTemplates)
  const selectedAutoProcessingTemplateSettings = getSubtitleTemplateSettings(captionSettings.subtitleTemplate ?? 'default', userSubtitleTemplates)
  const hasAutoProcessingOverrides = captionSettings.maxChars !== selectedAutoProcessingTemplateSettings.maxChars
    || (captionSettings.maxLines ?? 2) !== selectedAutoProcessingTemplateSettings.maxLines
    || captionSettings.segmentationMode !== selectedAutoProcessingTemplateSettings.segmentationMode

  const runAutoCaption = async (): Promise<void> => {
    setCaptionSummary(null)
    setCaptioning(true)
    try {
      const summary = await autoCaptionSelected(captionSettings)
      if (summary) {
        setCaptionSummary(summary)
        const usedTemplateId = captionSettings.subtitleTemplate ?? 'default'
        setLastUsedSubtitleTemplateId(usedTemplateId)
        if (window.spectra) void window.spectra.setLastUsedSubtitleTemplateId(usedTemplateId).catch(() => undefined)
      }
    } finally {
      setCaptioning(false)
    }
  }

  const selectedSubtitleTemplate = (): SubtitleTemplateDraft => {
    const selected = userSubtitleTemplates.find((template) => template.id === captionSettings.subtitleTemplate)
      ?? SUBTITLE_TEMPLATES.find((template) => template.id === captionSettings.subtitleTemplate)
    const settings = getSubtitleTemplateSettings(captionSettings.subtitleTemplate, userSubtitleTemplates)
    return {
      name: selected ? ('name' in selected ? selected.name : selected.label) : '新しい字幕テンプレート',
      style: settings.style,
      captionGeneration: {
        maxChars: captionSettings.maxChars ?? settings.maxChars,
        maxLines: captionSettings.maxLines ?? settings.maxLines,
        segmentationMode: captionSettings.segmentationMode ?? settings.segmentationMode,
        layoutConstraints: { maxWidthPercent: settings.layoutConstraints.maxWidthPercent }
      }
    }
  }

  const selectSubtitleTemplate = (id: string): void => {
    const settings = getSubtitleTemplateSettings(id, userSubtitleTemplates)
    setCaptionSettings((current) => ({
      ...current,
      subtitleTemplate: id,
      maxChars: settings.maxChars,
      maxLines: settings.maxLines,
      segmentationMode: settings.segmentationMode
    }))
  }

  const createUserSubtitleTemplate = async (duplicate: boolean): Promise<void> => {
    if (!window.spectra) {
      showNotice('字幕テンプレートの保存はElectron環境で利用できます。', 'warning')
      return
    }
    const draft = selectedSubtitleTemplate()
    const name = window.prompt('テンプレート名', duplicate ? `${draft.name} copy` : draft.name)
    if (!name?.trim()) return
    const input = { ...draft, name: name.trim() }
    try {
      const created = duplicate ? await window.spectra.duplicateSubtitleTemplate(input) : await window.spectra.createSubtitleTemplate(input)
      const next = [...userSubtitleTemplates.filter((template) => template.id !== created.id), created]
      setUserSubtitleTemplates(next)
      setStoreUserSubtitleTemplates(next)
      setCaptionSettings((current) => ({ ...current, subtitleTemplate: created.id, maxChars: created.captionGeneration.maxChars, maxLines: created.captionGeneration.maxLines, segmentationMode: created.captionGeneration.segmentationMode }))
    } catch {
      showNotice('字幕テンプレートを保存できませんでした。', 'error')
    }
  }

  const updateUserSubtitleTemplate = async (): Promise<void> => {
    if (!window.spectra) return
    const selected = userSubtitleTemplates.find((template) => template.id === captionSettings.subtitleTemplate)
    if (!selected) return
    try {
      const updated = await window.spectra.updateSubtitleTemplate(selected.id, selectedSubtitleTemplate())
      const next = userSubtitleTemplates.map((template) => template.id === updated.id ? updated : template)
      setUserSubtitleTemplates(next)
      setStoreUserSubtitleTemplates(next)
    } catch {
      showNotice('字幕テンプレートを更新できませんでした。', 'error')
    }
  }

  const deleteUserSubtitleTemplate = async (): Promise<void> => {
    if (!window.spectra) return
    const selected = userSubtitleTemplates.find((template) => template.id === captionSettings.subtitleTemplate)
    if (!selected || !window.confirm(`「${selected.name}」を削除しますか？`)) return
    try {
      if (!(await window.spectra.deleteSubtitleTemplate(selected.id))) return
      const next = userSubtitleTemplates.filter((template) => template.id !== selected.id)
      setUserSubtitleTemplates(next)
      setStoreUserSubtitleTemplates(next)
      const settings = getSubtitleTemplateSettings('default', next)
      setCaptionSettings((current) => ({ ...current, subtitleTemplate: 'default', maxChars: settings.maxChars, maxLines: settings.maxLines, segmentationMode: settings.segmentationMode }))
    } catch {
      showNotice('字幕テンプレートを削除できませんでした。', 'error')
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
          <IconButton label={past.length ? '元に戻す（Ctrl+Z）' : '元に戻す（変更履歴がありません）'} disabled={!past.length} onClick={undo}><Undo2 size={16} /></IconButton>
          <IconButton label={future.length ? 'やり直す（Ctrl+Shift+Z）' : 'やり直す（やり直せる変更がありません）'} disabled={!future.length} onClick={redo}><Redo2 size={16} /></IconButton>
          <Button className="save-button" disabled={saving} title={saving ? '保存中です' : 'プロジェクトを保存'} onClick={() => void save()}><Save size={15} />{saving ? '保存中…' : '保存'}</Button>
          <Button className="subtle-button" onClick={() => setTemplateManagerOpen(true)}>テンプレート</Button>
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
      {templateManagerOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTemplateManagerOpen(false) }}><SubtitleTemplateManagerPanel userTemplates={userSubtitleTemplates} defaultTemplateId={defaultSubtitleTemplateId} selectedSubtitle={selectedSubtitleClip} onTemplatesChange={(templates) => { setUserSubtitleTemplates(templates); setStoreUserSubtitleTemplates(templates) }} onDefaultChange={setDefaultSubtitleTemplateId} onClose={() => setTemplateManagerOpen(false)} /></div>}
      {appError && (
        <div className="error-banner" role="alert"><CircleAlert size={18} /><strong>画面でエラーが発生しました</strong><span>{appError}</span><button type="button" onClick={() => setAppError(null)}>閉じる</button></div>
      )}
      {captionDialogOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !captioning) setCaptionDialogOpen(false) }}>
          <section className="caption-dialog" role="dialog" aria-modal="true" aria-labelledby="auto-caption-title">
            <header className="dialog-header">
              <div className="dialog-title-icon"><Captions size={17} /></div>
              <div><span className="panel-eyebrow">AUTO PROCESSING</span><h2 id="auto-caption-title">自動処理</h2></div>
              <IconButton label={captioning ? '生成中は閉じられません（キャンセルを使用）' : '閉じる'} disabled={captioning} onClick={() => setCaptionDialogOpen(false)}><X size={15} /></IconButton>
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
                  <label className="field"><span className="field-label">字幕テンプレート</span><select disabled={captioning} value={captionSettings.subtitleTemplate ?? 'default'} onChange={(event) => selectSubtitleTemplate(event.target.value)}><optgroup label="組み込み（変更不可）">{SUBTITLE_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}</optgroup>{userSubtitleTemplates.length > 0 && <optgroup label="ユーザー">{userSubtitleTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</optgroup>}</select></label>
                  {selectedAutoProcessingTemplate && <div className="auto-template-preview"><SubtitleTemplatePreview style={selectedAutoProcessingTemplate.style} maxLines={selectedAutoProcessingTemplateSettings.maxLines} /><small>{'name' in selectedAutoProcessingTemplate ? selectedAutoProcessingTemplate.name : selectedAutoProcessingTemplate.label} · {selectedAutoProcessingTemplateSettings.maxChars}文字 / {selectedAutoProcessingTemplateSettings.maxLines}行</small></div>}
                  {hasAutoProcessingOverrides && <small className="field-hint template-override-note">個別設定を使用中です。template本体は変更されません。次回template選択時にtemplate値へ戻ります。</small>}
                  <div className="template-actions"><Button disabled={captioning} title={captioning ? '生成中は変更できません' : '現在の設定を新しいtemplateとして保存'} onClick={() => void createUserSubtitleTemplate(false)}>新規保存</Button><Button disabled={captioning} title={captioning ? '生成中は変更できません' : '現在の設定をtemplateとして複製'} onClick={() => void createUserSubtitleTemplate(true)}>複製</Button><Button disabled={captioning || !userSubtitleTemplates.some((template) => template.id === captionSettings.subtitleTemplate)} title={captioning ? '生成中は変更できません' : 'ユーザーtemplateを選択すると更新できます'} onClick={() => void updateUserSubtitleTemplate()}>更新</Button><Button disabled={captioning || !userSubtitleTemplates.some((template) => template.id === captionSettings.subtitleTemplate)} title={captioning ? '生成中は変更できません' : 'ユーザーtemplateを選択すると削除できます'} onClick={() => void deleteUserSubtitleTemplate()}>削除</Button></div>
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
                <Button disabled={captioning && !autoCaptionJobId} title={captioning && !autoCaptionJobId ? 'ジョブの開始を待っています' : captioning ? '自動処理をキャンセル' : 'ダイアログを閉じる'} onClick={() => { if (captioning) void cancelAutoCaption(); else setCaptionDialogOpen(false) }}>{captioning ? 'キャンセル' : 'キャンセル'}</Button>
                {!captioning && captionSummary ? <Button className="primary-button" onClick={() => setCaptionDialogOpen(false)}>閉じる</Button> : <Button className="primary-button" disabled={!autoCaptionEnabled || autoCaptionRunState.disabled} title={!autoCaptionEnabled ? '自動字幕をONにしてください' : autoCaptionRunState.label} onClick={() => void runAutoCaption()}>{captioning ? '実行中…' : '実行'}</Button>}
              </div>
            </footer>
          </section>
        </div>
      )}
      {exportOpen && <ExportDialog report={encoderReport} onClose={() => setExportOpen(false)} refreshEncoders={() => detectEncoders(true)} />}
    </main>
  )
}
