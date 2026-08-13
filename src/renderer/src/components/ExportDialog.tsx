import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, Cpu, FolderOpen, Gauge, MonitorUp, TriangleAlert, X, Zap } from 'lucide-react'
import type { EncoderMode, EncoderReport, ExportProgress, ExportSettings } from '../../../shared/types'
import { useEditorStore } from '../store'
import { Button, Field, IconButton, NumberField, SelectField } from './Controls'

interface Props {
  report: EncoderReport | null
  onClose(): void
  refreshEncoders(): Promise<void>
}

const demoReport: EncoderReport = {
  ffmpegPath: null,
  ffmpegVersion: 'ブラウザデモ',
  platform: 'browser',
  selectedId: 'demo-hardware',
  checkedAt: new Date().toISOString(),
  capabilities: [
    { id: 'demo-hardware', name: 'NVIDIA NVENC（デモ）', codec: 'h264', vendor: 'nvidia', hardware: true, available: true },
    { id: 'libx264', name: 'CPU / libx264', codec: 'h264', vendor: 'cpu', hardware: false, available: true }
  ]
}

export default function ExportDialog({ report, onClose, refreshEncoders }: Props): React.JSX.Element {
  const { project, showNotice } = useEditorStore()
  const encoders = report ?? demoReport
  const [preset, setPreset] = useState('youtube-1080')
  const [width, setWidth] = useState(project.sequence.width)
  const [height, setHeight] = useState(project.sequence.height)
  const [videoBitrateMbps, setVideoBitrateMbps] = useState(12)
  const [audioBitrateKbps, setAudioBitrateKbps] = useState(320)
  const [encoderMode, setEncoderMode] = useState<EncoderMode>('auto')
  const [preferredEncoderId, setPreferredEncoderId] = useState(encoders.selectedId ?? '')
  const [burnSubtitles, setBurnSubtitles] = useState(true)
  const [exportSrt, setExportSrt] = useState(false)
  const [outputPath, setOutputPath] = useState(`${project.name}.mp4`)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [runningJobId, setRunningJobId] = useState<string | null>(null)
  const [mockTimer, setMockTimer] = useState<number | null>(null)

  const selectedEncoder = useMemo(
    () => encoders.capabilities.find((item) => item.id === preferredEncoderId) ?? encoders.capabilities.find((item) => item.available),
    [encoders, preferredEncoderId]
  )
  const hardwareAvailable = encoders.capabilities.some((item) => item.hardware && item.available)

  useEffect(() => {
    if (!window.spectra) return
    return window.spectra.onExportProgress((next) => {
      setProgress(next)
      if (['completed', 'cancelled', 'failed'].includes(next.stage)) setRunningJobId(null)
    })
  }, [])

  useEffect(() => () => {
    if (mockTimer !== null) window.clearInterval(mockTimer)
  }, [mockTimer])

  const applyPreset = (value: string): void => {
    setPreset(value)
    if (value === 'youtube-4k') {
      setWidth(3840); setHeight(2160); setVideoBitrateMbps(45)
    } else if (value === 'vertical') {
      setWidth(1080); setHeight(1920); setVideoBitrateMbps(10)
    } else {
      setWidth(1920); setHeight(1080); setVideoBitrateMbps(12)
    }
  }

  const choosePath = async (): Promise<void> => {
    if (!window.spectra) return showNotice('デモでは保存先ダイアログを開きません。')
    const result = await window.spectra.chooseExportPath(`${project.name}.mp4`)
    if (result) setOutputPath(result)
  }

  const start = async (): Promise<void> => {
    if (!outputPath) return showNotice('出力先を選択してください。', 'warning')
    const settings: ExportSettings = {
      outputPath,
      width,
      height,
      frameRate: project.sequence.frameRate,
      videoBitrate: Math.round(videoBitrateMbps * 1_000_000),
      audioBitrate: Math.round(audioBitrateKbps * 1000),
      encoderMode,
      preferredEncoderId: preferredEncoderId || undefined,
      burnSubtitles,
      exportSrt
    }
    if (window.spectra) {
      try {
        const result = await window.spectra.startExport(project, settings)
        if (!result.cancelled && result.jobId) {
          setRunningJobId(result.jobId)
          setProgress({ jobId: result.jobId, stage: 'queued', ratio: 0, encodedUs: 0, totalUs: 1, message: '書き出しを準備しています…' })
        }
      } catch (error) {
        showNotice(`書き出しを開始できませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
      return
    }
    const demoId = 'demo-export'
    setRunningJobId(demoId)
    setProgress({ jobId: demoId, stage: 'rendering', ratio: 0, encodedUs: 0, totalUs: 15_000_000, encoderId: selectedEncoder?.id, message: 'デモ書き出し中…' })
    let ratio = 0
    const timer = window.setInterval(() => {
      ratio += 0.025
      if (ratio >= 1) {
        window.clearInterval(timer)
        setMockTimer(null)
        setRunningJobId(null)
        setProgress({ jobId: demoId, stage: 'completed', ratio: 1, encodedUs: 15_000_000, totalUs: 15_000_000, encoderId: selectedEncoder?.id, message: 'デモ書き出しが完了しました。', outputPath })
      } else {
        setProgress((current) => current ? { ...current, ratio, encodedUs: ratio * current.totalUs } : current)
      }
    }, 80)
    setMockTimer(timer)
  }

  const cancel = async (): Promise<void> => {
    if (!runningJobId) return
    if (window.spectra) await window.spectra.cancelExport(runningJobId)
    if (mockTimer !== null) window.clearInterval(mockTimer)
    setMockTimer(null)
    setRunningJobId(null)
    setProgress((current) => current ? { ...current, stage: 'cancelled', message: '書き出しをキャンセルしました。' } : current)
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !runningJobId) onClose() }}>
      <section className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <header className="dialog-header">
          <div className="dialog-title-icon"><MonitorUp size={21} /></div>
          <div><span className="panel-eyebrow">DELIVER</span><h2 id="export-title">動画を書き出す</h2></div>
          <IconButton label="閉じる" disabled={Boolean(runningJobId)} onClick={onClose}><X size={18} /></IconButton>
        </header>
        <div className="dialog-body">
          <div className="export-settings">
            <div className="export-section">
              <h3><span>01</span>出力プリセット</h3>
              <SelectField label="用途" value={preset} onChange={(event) => applyPreset(event.target.value)}>
                <option value="youtube-1080">YouTube 1080p</option>
                <option value="youtube-4k">YouTube 4K</option>
                <option value="vertical">YouTube Shorts / 縦動画</option>
                <option value="custom">カスタム</option>
              </SelectField>
              <div className="field-grid export-dimensions">
                <NumberField label="幅" suffix="px" value={width} onChange={(event) => { setWidth(Number(event.target.value)); setPreset('custom') }} />
                <NumberField label="高さ" suffix="px" value={height} onChange={(event) => { setHeight(Number(event.target.value)); setPreset('custom') }} />
                <NumberField label="映像ビットレート" suffix="Mbps" min={1} max={180} value={videoBitrateMbps} onChange={(event) => setVideoBitrateMbps(Number(event.target.value))} />
                <NumberField label="音声ビットレート" suffix="kbps" min={64} max={512} value={audioBitrateKbps} onChange={(event) => setAudioBitrateKbps(Number(event.target.value))} />
              </div>
            </div>
            <div className="export-section">
              <h3><span>02</span>エンコーダー</h3>
              <div className={`hardware-status ${hardwareAvailable ? 'is-ready' : 'is-warning'}`}>
                {hardwareAvailable ? <Zap size={19} /> : <Cpu size={19} />}
                <div><strong>{hardwareAvailable ? 'GPUエンコード利用可能' : 'CPUエンコードを使用'}</strong><small>{hardwareAvailable ? '高速なハードウェア処理を優先します。' : '対応GPUがない場合もCPUで最後まで書き出せます。'}</small></div>
                <button type="button" onClick={() => void refreshEncoders()}>再検出</button>
              </div>
              <div className="encoder-modes">
                {([
                  ['auto', '自動（推奨）', 'GPUを優先し、失敗時はCPUへ切替'],
                  ['hardware', 'ハードウェア優先', 'GPUを優先し、失敗時はCPUへ切替'],
                  ['software', 'ソフトウェア', 'CPUで互換性を優先']
                ] as const).map(([value, title, detail]) => (
                  <button type="button" key={value} className={encoderMode === value ? 'is-selected' : ''} onClick={() => setEncoderMode(value)}>
                    <span>{encoderMode === value && <Check size={13} />}</span><strong>{title}</strong><small>{detail}</small>
                  </button>
                ))}
              </div>
              <SelectField label="優先エンコーダー" value={preferredEncoderId} onChange={(event) => setPreferredEncoderId(event.target.value)} disabled={encoderMode === 'software'}>
                {encoders.capabilities.map((encoder) => <option key={encoder.id} value={encoder.id} disabled={!encoder.available}>{encoder.name}{!encoder.available ? '（利用不可）' : ''}</option>)}
              </SelectField>
            </div>
            <div className="export-section">
              <h3><span>03</span>字幕と保存先</h3>
              <div className="check-list">
                <label><input type="checkbox" checked={burnSubtitles} onChange={(event) => setBurnSubtitles(event.target.checked)} /><span><strong>字幕を映像へ焼き込む</strong><small>設定したスタイルとアニメーションを反映</small></span></label>
                <label><input type="checkbox" checked={exportSrt} onChange={(event) => setExportSrt(event.target.checked)} /><span><strong>SRTファイルも出力</strong><small>外部字幕として再利用できます</small></span></label>
              </div>
              <Field label="保存先" wide>
                <div className="path-field"><input value={outputPath} onChange={(event) => setOutputPath(event.target.value)} /><IconButton label="保存先を選ぶ" onClick={() => void choosePath()}><FolderOpen size={16} /></IconButton></div>
              </Field>
            </div>
          </div>
          <aside className="export-summary">
            <div className="summary-preview"><span>{width}×{height}</span><i>MP4</i></div>
            <h3>{project.name}</h3>
            <dl><div><dt>形式</dt><dd>H.264 / AAC</dd></div><div><dt>フレームレート</dt><dd>{project.sequence.frameRate.numerator / project.sequence.frameRate.denominator} fps</dd></div><div><dt>処理</dt><dd>{encoderMode === 'software' ? 'CPU' : hardwareAvailable ? 'GPU優先（CPUフォールバック）' : 'CPU'}</dd></div><div><dt>推定サイズ</dt><dd>約 24 MB</dd></div></dl>
            {!window.spectra && <div className="demo-callout"><Gauge size={16} /><span>ブラウザデモでは進捗表示をシミュレーションします。</span></div>}
            {progress && (
              <div className={`export-progress stage-${progress.stage}`}>
                <div className="progress-heading">
                  {progress.stage === 'completed' ? <Check size={17} /> : progress.stage === 'failed' ? <TriangleAlert size={17} /> : <Gauge size={17} />}
                  <strong>{progress.message}</strong>
                </div>
                <div className="progress-track"><i style={{ width: `${Math.round(progress.ratio * 100)}%` }} /></div>
                <span>{Math.round(progress.ratio * 100)}%</span>
                {progress.fallbackReason && <small>CPUへ切替: {progress.fallbackReason}</small>}
              </div>
            )}
          </aside>
        </div>
        <footer className="dialog-footer">
          <span>{selectedEncoder?.hardware ? <Zap size={14} /> : <Cpu size={14} />}{selectedEncoder?.name ?? 'CPU / libx264'}</span>
          <div>
            {runningJobId ? <Button className="danger-button" onClick={() => void cancel()}>キャンセル</Button> : <Button className="secondary-button" onClick={onClose}>閉じる</Button>}
            <Button className="primary-button" disabled={Boolean(runningJobId)} onClick={() => void start()}>書き出しを開始<ChevronRight size={17} /></Button>
          </div>
        </footer>
      </section>
    </div>
  )
}
