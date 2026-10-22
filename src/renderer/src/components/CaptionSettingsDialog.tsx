import { useMemo, useState } from 'react'
import { Captions, X } from 'lucide-react'
import { captionLayoutHint } from '../../../shared/auto-caption-ui'
import { planCaptionResegment } from '../../../shared/caption-resegment'
import { MAX_SUBTITLE_MAX_LINES, normalizeSubtitleMaxLines } from '../../../shared/subtitle-layout'
import { getSubtitleTemplate, getSubtitleTemplateStyleForId, SUBTITLE_TEMPLATES } from '../../../shared/subtitle-templates'
import type { SubtitleClip, SubtitleStyle, SubtitleTrackLayoutSettings } from '../../../shared/types'
import { useEditorStore } from '../store'
import { Button, IconButton } from './Controls'

type Scope = 'track' | 'selection'
type StyleKey = 'fontFamily' | 'fontSize' | 'color' | 'outlineColor' | 'outlineWidth' | 'positionY' | 'bold'

const MODES: ReadonlyArray<{ value: SubtitleTrackLayoutSettings['segmentationMode']; label: string }> = [
  { value: 'rule', label: 'ルール' },
  { value: 'auto', label: '高品質（自動）' },
  { value: 'llm', label: 'LLM' }
]

/**
 * 「字幕設定を変更」: change the caption settings of captions that already
 * exist. Appearance-only changes are applied at once; changes to how captions
 * are split re-split the stored words (no audio, no Whisper). Everything is
 * one undo step. Hand-edited captions are kept as they are.
 */
export default function CaptionSettingsDialog(): React.JSX.Element | null {
  const trackId = useEditorStore((state) => state.captionSettingsDialogTrackId)
  if (!trackId) return null
  return <CaptionSettingsForm key={trackId} trackId={trackId} />
}

function CaptionSettingsForm({ trackId }: { trackId: string }): React.JSX.Element | null {
  const project = useEditorStore((state) => state.project)
  const selectedClipIds = useEditorStore((state) => state.selectedClipIds)
  const userTemplates = useEditorStore((state) => state.userSubtitleTemplates)
  const seed = useEditorStore((state) => state.autoCaptionSettingsSeed)
  const defaults = useEditorStore((state) => state.captionLayoutDefaults)
  const busy = useEditorStore((state) => state.captionSettingsBusy)
  const close = useEditorStore((state) => state.closeCaptionSettings)
  const apply = useEditorStore((state) => state.applyCaptionSettings)
  const track = project.tracks.find((candidate) => candidate.id === trackId && candidate.kind === 'subtitle')
  const clips = useMemo(() => (track?.clips ?? []).filter((clip): clip is SubtitleClip => clip.kind === 'subtitle').sort((a, b) => a.startUs - b.startUs), [track])
  const selectedInTrack = clips.filter((clip) => selectedClipIds.includes(clip.id))
  const [scope, setScope] = useState<Scope>(selectedInTrack.length > 0 ? 'selection' : 'track')
  const scopeClips = scope === 'selection' ? selectedInTrack : clips
  const reference = scopeClips[0] ?? clips[0]
  const stored = track?.captionLayout
  const [maxChars, setMaxChars] = useState(stored?.maxChars ?? defaults?.maxChars ?? seed.maxChars)
  const [maxWidthPercent, setMaxWidthPercent] = useState(stored?.maxWidthPercent ?? reference?.style.maxWidthPercent ?? 80)
  const [maxLines, setMaxLines] = useState(stored?.maxLines ?? normalizeSubtitleMaxLines(reference?.maxLines))
  const [mode, setMode] = useState<SubtitleTrackLayoutSettings['segmentationMode']>(stored?.segmentationMode ?? defaults?.segmentationMode ?? seed.segmentationMode)
  const [hidePunctuation, setHidePunctuation] = useState(stored?.hidePunctuation ?? defaults?.hidePunctuation ?? true)
  const [templateId, setTemplateId] = useState('')
  const baseStyle: SubtitleStyle | undefined = templateId ? getSubtitleTemplateStyleForId(templateId, userTemplates) : reference?.style
  const [styleEdits, setStyleEdits] = useState<Partial<Pick<SubtitleStyle, StyleKey>>>({})
  const style = { ...baseStyle, ...styleEdits } as SubtitleStyle
  const plan = useMemo(() => {
    if (!track) return null
    try {
      return planCaptionResegment(project, trackId, scope === 'selection' ? new Set(selectedInTrack.map((clip) => clip.id)) : undefined)
    } catch {
      return null
    }
  }, [project, trackId, scope, selectedInTrack, track])
  if (!track || !reference || !baseStyle) return null

  const patchStyle = <K extends StyleKey>(key: K, value: SubtitleStyle[K]): void => setStyleEdits((current) => ({ ...current, [key]: value }))
  const chooseTemplate = (id: string): void => {
    setTemplateId(id)
    setStyleEdits({})
    if (id) {
      const template = getSubtitleTemplate(id, userTemplates)
      if (template) setMaxWidthPercent(template.captionGeneration.layoutConstraints.maxWidthPercent)
    }
  }
  const submit = async (): Promise<void> => {
    const result = await apply({
      trackId,
      scope,
      language: 'ja',
      settings: { maxChars, maxLines, maxWidthPercent, segmentationMode: mode, hidePunctuation, ...(templateId ? { templateId } : track.captionLayout?.templateId ? { templateId: track.captionLayout.templateId } : {}) },
      ...(templateId ? { templateStyle: getSubtitleTemplateStyleForId(templateId, userTemplates) } : {}),
      stylePatch: styleEdits
    })
    if (result) close()
  }
  const hint = captionLayoutHint({ maxChars, maxLines, style, maxWidthPercent, sequenceWidth: project.sequence.width })
  const keptCount = plan?.keptClipIds.length ?? 0

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close() }}>
      <section className="caption-dialog" role="dialog" aria-modal="true" aria-labelledby="caption-settings-title" data-testid="caption-settings-dialog">
        <header className="dialog-header">
          <div className="dialog-title-icon"><Captions size={17} /></div>
          <div><span className="panel-eyebrow">CAPTION SETTINGS</span><h2 id="caption-settings-title">字幕設定を変更</h2></div>
          <IconButton label={busy ? '処理中は閉じられません' : '閉じる'} disabled={busy} onClick={close}><X size={15} /></IconButton>
        </header>
        <div className="caption-dialog-body">
          <label className="field"><span className="field-label">対象</span>
            <select disabled={busy} value={scope} onChange={(event) => setScope(event.target.value as Scope)} aria-label="設定を変える字幕の範囲">
              <option value="track">この字幕トラックのすべて（{clips.length}件）</option>
              <option value="selection" disabled={selectedInTrack.length === 0}>選択中の字幕（{selectedInTrack.length}件）</option>
            </select>
          </label>
          <label className="field"><span className="field-label">最大文字数</span><span className="number-input"><input disabled={busy} type="number" min={1} max={10000} value={maxChars} onChange={(event) => setMaxChars(Math.max(1, Math.min(10000, Number(event.target.value) || 32)))} /><span>文字</span></span></label>
          <label className="field"><span className="field-label">横幅の上限（%）</span><span className="number-input"><input disabled={busy} type="number" min={10} max={300} value={maxWidthPercent} onChange={(event) => setMaxWidthPercent(Math.max(10, Math.min(300, Number(event.target.value) || 80)))} aria-label="字幕の横幅の上限（動画幅に対する%）" /><span>%</span></span></label>
          <label className="field"><span className="field-label">最大行数</span><span className="number-input"><input disabled={busy} type="number" min={1} max={MAX_SUBTITLE_MAX_LINES} value={maxLines} onChange={(event) => setMaxLines(Math.max(1, Math.min(MAX_SUBTITLE_MAX_LINES, Number(event.target.value) || 2)))} /><span>行</span></span></label>
          <small className="field-hint caption-layout-hint" data-testid="caption-settings-hint">{hint}</small>
          <label className="check-field"><input disabled={busy} type="checkbox" checked={hidePunctuation} onChange={(event) => setHidePunctuation(event.target.checked)} />句読点（、。）を表示しない</label>
          <label className="field"><span className="field-label">区切り方式</span>
            <select disabled={busy} value={mode} onChange={(event) => setMode(event.target.value as SubtitleTrackLayoutSettings['segmentationMode'])}>
              {MODES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="field"><span className="field-label">テンプレート</span>
            <select disabled={busy} value={templateId} onChange={(event) => chooseTemplate(event.target.value)}>
              <option value="">現在の見た目のまま</option>
              <optgroup label="組み込み">{SUBTITLE_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}</optgroup>
              {userTemplates.length > 0 && <optgroup label="ユーザー">{userTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</optgroup>}
            </select>
          </label>
          <label className="field"><span className="field-label">フォント</span><input disabled={busy} value={style.fontFamily} onChange={(event) => patchStyle('fontFamily', event.target.value)} /></label>
          <label className="field"><span className="field-label">サイズ</span><span className="number-input"><input disabled={busy} type="number" min={8} max={240} value={style.fontSize} onChange={(event) => patchStyle('fontSize', Math.max(8, Math.min(240, Number(event.target.value) || 54)))} /><span>px</span></span></label>
          <label className="field"><span className="field-label">文字色</span><input disabled={busy} type="color" value={style.color} onChange={(event) => patchStyle('color', event.target.value)} /></label>
          <label className="field"><span className="field-label">縁取り色</span><input disabled={busy} type="color" value={style.outlineColor} onChange={(event) => patchStyle('outlineColor', event.target.value)} /></label>
          <label className="field"><span className="field-label">縁取り幅</span><span className="number-input"><input disabled={busy} type="number" min={0} max={20} value={style.outlineWidth} onChange={(event) => patchStyle('outlineWidth', Math.max(0, Math.min(20, Number(event.target.value) || 0)))} /><span>px</span></span></label>
          <label className="field"><span className="field-label">縦位置 Y</span><span className="number-input"><input disabled={busy} type="number" min={-100} max={200} value={style.positionY} onChange={(event) => patchStyle('positionY', Number(event.target.value) || 0)} /><span>%</span></span></label>
          <small className="field-hint">最大文字数・横幅・最大行数・区切り方式・フォントサイズを変えると、字幕を分け直します（保存済みの単語から作り直すため、音声の再認識はしません）。色や位置だけの変更はすぐ反映します。どちらも元に戻す操作1回で戻せます。</small>
          {keptCount > 0 && <small className="field-hint warning" role="status" data-testid="caption-settings-kept">手で編集した（または単語情報のない）字幕{keptCount}件は、分け直さずそのまま残します。折り返しだけ新しい設定になります。</small>}
          <div className="template-actions">
            <Button disabled={busy} onClick={close}>キャンセル</Button>
            <Button className="primary-button" disabled={busy} onClick={() => void submit()} data-testid="caption-settings-apply">{busy ? '分け直し中…' : `適用（${scopeClips.length}件）`}</Button>
          </div>
        </div>
      </section>
    </div>
  )
}
