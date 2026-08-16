import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Image as ImageIcon, LoaderCircle, X } from 'lucide-react'
import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH, validateThumbnailLayout, type ThumbnailFrameCandidate, type ThumbnailLayout } from '../../../shared/thumbnail'
import type { ProjectFile } from '../../../shared/types'
import { useEditorStore } from '../store'
import { Button, IconButton } from './Controls'

interface Props {
  project: ProjectFile
  onClose(): void
}

const DEFAULT_LAYOUT: ThumbnailLayout = {
  title: '動画タイトル', subtitle: '', fontFamily: 'Noto Sans JP', fontSize: 92, xPercent: 50, yPercent: 78,
  outlineWidth: 6, outlineColor: '#000000', backgroundColor: '#000000', backgroundOpacity: 0, shadowColor: '#000000', shadowBlur: 12
}

const drawText = (context: CanvasRenderingContext2D, text: string, x: number, y: number, layout: ThumbnailLayout, size: number): void => {
  if (!text) return
  context.font = `${size}px "${layout.fontFamily.replace(/"/gu, '')}"`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.lineJoin = 'round'
  context.shadowColor = layout.shadowColor
  context.shadowBlur = layout.shadowBlur
  context.shadowOffsetX = 0
  context.shadowOffsetY = 4
  if (layout.outlineWidth > 0) {
    context.strokeStyle = layout.outlineColor
    context.lineWidth = layout.outlineWidth * 2
    context.strokeText(text, x, y)
  }
  context.fillStyle = '#ffffff'
  context.fillText(text, x, y)
  context.shadowBlur = 0
  context.shadowOffsetY = 0
}

export default function ThumbnailWorkspace({ project, onClose }: Props): React.JSX.Element {
  const selectedClipIds = useEditorStore((state) => state.selectedClipIds)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [candidates, setCandidates] = useState<ThumbnailFrameCandidate[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [fonts, setFonts] = useState<string[]>([])
  const [layout, setLayout] = useState<ThumbnailLayout>(DEFAULT_LAYOUT)
  const [format, setFormat] = useState<'png' | 'jpeg'>('png')
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectedCandidate = useMemo(() => candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0], [candidates, selectedId])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    const selectedClipId = selectedClipIds[0]
    if (!window.spectra || !selectedClipId) {
      setLoading(false)
      setError('映像clipを選択してからサムネイルを開いてください。')
      return () => { active = false }
    }
    void Promise.all([window.spectra.extractThumbnailCandidates(project, selectedClipId), window.spectra.listFontFamilies()]).then(([frames, availableFonts]) => {
      if (!active) return
      setCandidates(frames)
      setSelectedId(frames[0]?.id ?? null)
      setFonts(availableFonts.length ? availableFonts : ['Noto Sans JP', 'Arial', 'sans-serif'])
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '候補フレームを作成できませんでした。') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [project, selectedClipIds])

  useEffect(() => {
    if (!selectedCandidate || !canvasRef.current) return
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.src = window.spectra?.mediaUrl(selectedCandidate.framePath) ?? ''
    image.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const context = canvas.getContext('2d')
      if (!context) return
      context.clearRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
      context.drawImage(image, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
      const x = THUMBNAIL_WIDTH * layout.xPercent / 100
      const y = THUMBNAIL_HEIGHT * layout.yPercent / 100
      if (layout.backgroundOpacity > 0) {
        const width = Math.min(THUMBNAIL_WIDTH - 40, Math.max(300, context.measureText(layout.title).width + 80))
        context.fillStyle = `rgba(0, 0, 0, ${layout.backgroundOpacity})`
        context.fillRect(x - width / 2, y - layout.fontSize, width, layout.fontSize * (layout.subtitle ? 2.2 : 1.35))
      }
      drawText(context, layout.title, x, y, layout, layout.fontSize)
      if (layout.subtitle) drawText(context, layout.subtitle, x, y + layout.fontSize * 1.12, layout, Math.max(18, Math.round(layout.fontSize * .48)))
    }
  }, [layout, selectedCandidate])

  const patchLayout = <K extends keyof ThumbnailLayout>(key: K, value: ThumbnailLayout[K]): void => setLayout((current) => ({ ...current, [key]: value }))

  const exportThumbnail = async (): Promise<void> => {
    const canvas = canvasRef.current
    if (!canvas || !selectedCandidate || !window.spectra) return
    setExporting(true)
    try {
      validateThumbnailLayout(layout)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, format === 'png' ? 'image/png' : 'image/jpeg', .92))
      if (!blob) throw new Error('画像データを作成できませんでした。')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const output = await window.spectra.exportThumbnail(bytes, format)
      if (output) setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'サムネイルを書き出せませんでした。')
    } finally {
      setExporting(false)
    }
  }

  return <div className="modal-backdrop thumbnail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="thumbnail-workspace" role="dialog" aria-modal="true" aria-labelledby="thumbnail-title">
      <header className="dialog-header"><div className="dialog-title-icon"><ImageIcon size={19} /></div><div><span className="panel-eyebrow">THUMBNAIL WORKSPACE</span><h2 id="thumbnail-title">サムネイル</h2></div><IconButton label="サムネイルを閉じる" onClick={onClose}><X size={18} /></IconButton></header>
      <div className="thumbnail-workspace-body">
        <div className="thumbnail-candidates"><strong>候補フレーム</strong>{loading ? <div className="thumbnail-loading"><LoaderCircle size={18} className="spin" />抽出中…</div> : error && !candidates.length ? <div className="thumbnail-error">{error}</div> : <div className="thumbnail-grid">{candidates.map((candidate) => <button type="button" key={candidate.id} className={candidate.id === selectedId ? 'is-selected' : ''} onClick={() => setSelectedId(candidate.id)}><img src={window.spectra?.mediaUrl(candidate.framePath)} alt={`${candidate.timeUs / 1_000_000}秒の候補`} /><small>{(candidate.timeUs / 1_000_000).toFixed(1)}秒</small></button>)}</div>}</div>
        <div className="thumbnail-preview-panel"><canvas ref={canvasRef} width={THUMBNAIL_WIDTH} height={THUMBNAIL_HEIGHT} className="thumbnail-canvas" aria-label="サムネイルプレビュー" /><div className="thumbnail-fields">
          <label><span>タイトル</span><input value={layout.title} onChange={(event) => patchLayout('title', event.target.value)} /></label>
          <label><span>サブタイトル（任意）</span><input value={layout.subtitle} onChange={(event) => patchLayout('subtitle', event.target.value)} /></label>
          <label><span>フォント</span><select value={layout.fontFamily} onChange={(event) => patchLayout('fontFamily', event.target.value)}>{(fonts.length ? fonts : ['Noto Sans JP', 'Arial', 'sans-serif']).map((font) => <option key={font} value={font}>{font}</option>)}</select></label>
          <label><span>サイズ</span><input type="number" min={12} max={300} value={layout.fontSize} onChange={(event) => patchLayout('fontSize', Math.max(12, Math.min(300, Number(event.target.value) || 92)))} /></label>
          <label><span>X位置</span><input type="number" min={0} max={100} value={layout.xPercent} onChange={(event) => patchLayout('xPercent', Math.max(0, Math.min(100, Number(event.target.value) || 0)))} /></label>
          <label><span>Y位置</span><input type="number" min={0} max={100} value={layout.yPercent} onChange={(event) => patchLayout('yPercent', Math.max(0, Math.min(100, Number(event.target.value) || 0)))} /></label>
          <label><span>縁取り幅</span><input type="number" min={0} max={40} value={layout.outlineWidth} onChange={(event) => patchLayout('outlineWidth', Math.max(0, Math.min(40, Number(event.target.value) || 0)))} /></label>
          <label><span>背景不透明度</span><input type="number" min={0} max={1} step={.05} value={layout.backgroundOpacity} onChange={(event) => patchLayout('backgroundOpacity', Math.max(0, Math.min(1, Number(event.target.value) || 0)))} /></label>
          <label><span>出力</span><select value={format} onChange={(event) => setFormat(event.target.value as 'png' | 'jpeg')}><option value="png">PNG</option><option value="jpeg">JPEG</option></select></label>
        </div></div>
      </div>
      {error && candidates.length > 0 && <div className="thumbnail-inline-error">{error}</div>}
      <footer className="dialog-footer"><span>{THUMBNAIL_WIDTH}×{THUMBNAIL_HEIGHT} · 元動画は変更されません。</span><Button className="primary-button" disabled={!selectedCandidate || loading || exporting} onClick={() => void exportThumbnail()}>{exporting ? '書き出し中…' : <><Check size={15} />書き出す</>}</Button></footer>
    </section>
  </div>
}
