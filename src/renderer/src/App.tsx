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
    autoCaptionSelected
  } = useEditorStore()
  const [workspace, setWorkspace] = useState<'edit' | 'audio' | 'captions'>('edit')
  const [exportOpen, setExportOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [recoveryStatus, setRecoveryStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [encoderReport, setEncoderReport] = useState<EncoderReport | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  const [captioning, setCaptioning] = useState(false)
  const reviewEnabled = useReviewStore((state) => state.enabled)

  useEffect(() => {
    useReviewStore.getState().stop()
    if (window.spectra) {
      void window.spectra.loadExperimentalReviewRecords().then((records) => useReviewStore.getState().hydrate(project, records)).catch(() => undefined)
    }
  }, [project.id])

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

  const runAutoCaption = async (): Promise<void> => {
    setCaptioning(true)
    try {
      await autoCaptionSelected()
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
          <Button disabled={captioning} onClick={() => void runAutoCaption()}><Captions size={15} />{captioning ? '文字起こし中…' : '自動字幕'}</Button>
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
      {exportOpen && <ExportDialog report={encoderReport} onClose={() => setExportOpen(false)} refreshEncoders={() => detectEncoders(true)} />}
    </main>
  )
}
