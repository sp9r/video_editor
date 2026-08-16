import { useEffect, useState } from 'react'
import { deriveSubtitleTemplateGeneration, applySubtitleTemplateToClip } from '../../../shared/subtitle-template-seed'
import { getSubtitleTemplate, SUBTITLE_TEMPLATES, type SubtitleTemplateCaptionGeneration, type SubtitleTemplateDraft, type UserSubtitleTemplate } from '../../../shared/subtitle-templates'
import type { SubtitleClip, SubtitleStyle } from '../../../shared/types'
import { FALLBACK_FONT_FAMILIES } from '../../../shared/font-families'
import { Button } from './Controls'
import SubtitleTemplatePreview from './SubtitleTemplatePreview'
import { useEditorStore } from '../store'

type TemplateMode = 'view' | 'create'

interface SubtitleTemplateManagerPanelProps {
  userTemplates: UserSubtitleTemplate[]
  defaultTemplateId: string
  selectedSubtitle?: SubtitleClip
  onTemplatesChange: (templates: UserSubtitleTemplate[]) => void
  onDefaultChange: (id: string) => void
  onClose: () => void
}

const draftFrom = (template: { name: string; style: SubtitleStyle; captionGeneration: SubtitleTemplateCaptionGeneration }): SubtitleTemplateDraft => ({
  name: template.name,
  style: structuredClone(template.style),
  captionGeneration: structuredClone(template.captionGeneration)
})

const templateLabel = (template: ReturnType<typeof getSubtitleTemplate>): string => template && 'name' in template ? template.name : template?.label ?? '未選択'

const styleRows: Array<[keyof SubtitleStyle, string, (value: SubtitleStyle[keyof SubtitleStyle]) => string]> = [
  ['fontFamily', 'フォント', String], ['fontSize', 'サイズ', (value) => `${String(value)} px`], ['color', '文字色', String],
  ['outlineColor', '縁取り色', String], ['outlineWidth', '縁取り幅', (value) => `${String(value)} px`], ['shadowColor', '影色', String],
  ['shadowBlur', '影ぼかし', (value) => `${String(value)} px`], ['backgroundColor', '背景色', String],
  ['backgroundOpacity', '背景濃度', (value) => `${String(value)}`], ['bold', '太字', (value) => value ? '有効' : '無効'],
  ['italic', '斜体', (value) => value ? '有効' : '無効'], ['letterSpacing', '字間', (value) => `${String(value)} px`],
  ['lineHeight', '行間', String], ['alignment', '配置', String], ['positionX', '位置X', (value) => `${String(value)}%`],
  ['positionY', '位置Y', (value) => `${String(value)}%`], ['maxWidthPercent', '最大幅', (value) => `${String(value)}%`],
  ['animation', 'アニメーション', String], ['animationDurationUs', 'アニメーション時間', (value) => `${String(value)} µs`]
]

const PREVIEW_SAMPLE = '皆さんこんばんは\nアルマジロウです'

export const resolveFontFamilyOptions = (families: readonly string[], currentFamily?: string): string[] => [...new Set([
  ...(currentFamily ? [currentFamily] : []),
  ...families,
  ...FALLBACK_FONT_FAMILIES
].map((family) => family.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'ja'))

export default function SubtitleTemplateManagerPanel({
  userTemplates,
  defaultTemplateId,
  selectedSubtitle,
  onTemplatesChange,
  onDefaultChange,
  onClose
}: SubtitleTemplateManagerPanelProps): React.JSX.Element {
  const showNotice = useEditorStore((state) => state.showNotice)
  const patchClip = useEditorStore((state) => state.patchClip)
  const autoCaptionSettingsSeed = useEditorStore((state) => state.autoCaptionSettingsSeed)
  const [selectedId, setSelectedId] = useState(defaultTemplateId)
  const [mode, setMode] = useState<TemplateMode>('view')
  const [draft, setDraft] = useState<SubtitleTemplateDraft | null>(null)
  const [previewText, setPreviewText] = useState('')
  const [fontFamilies, setFontFamilies] = useState<string[]>([...FALLBACK_FONT_FAMILIES])
  const selected = getSubtitleTemplate(selectedId, userTemplates)
  const selectedUser = userTemplates.find((template) => template.id === selectedId)
  const canEdit = Boolean(selectedUser)
  const editable = mode === 'create' || canEdit

  useEffect(() => {
    let mounted = true
    if (!window.spectra) return () => { mounted = false }
    void window.spectra.listFontFamilies()
      .then((families) => {
        if (mounted) setFontFamilies(resolveFontFamilyOptions(families))
      })
      .catch(() => undefined)
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (getSubtitleTemplate(selectedId, userTemplates)) return
    setSelectedId(defaultTemplateId)
  }, [defaultTemplateId, selectedId, userTemplates])

  useEffect(() => {
    if (mode === 'view' && selected) setDraft(draftFrom({ name: templateLabel(selected), style: selected.style, captionGeneration: selected.captionGeneration }))
  }, [mode, selectedId, selected])

  const getApi = (): NonNullable<Window['spectra']> | null => {
    if (window.spectra) return window.spectra
    showNotice('テンプレートの保存・更新はElectron環境で利用できます。', 'warning')
    return null
  }

  const setCatalog = (templates: UserSubtitleTemplate[]): void => {
    onTemplatesChange(templates)
  }

  const beginCreate = (source: { name: string; style: SubtitleStyle; captionGeneration: SubtitleTemplateCaptionGeneration }, name = `${source.name} copy`): void => {
    setDraft({ ...draftFrom(source), name })
    setMode('create')
  }

  const createNew = (): void => {
    const source = SUBTITLE_TEMPLATES[0]
    if (source) beginCreate({ name: '新しい字幕テンプレート', style: source.style, captionGeneration: source.captionGeneration }, '新しい字幕テンプレート')
  }

  const createFromTimeline = async (): Promise<void> => {
    if (!selectedSubtitle) {
      showNotice('Timelineの字幕を1件選択してから作成してください。', 'warning')
      return
    }
    const api = getApi()
    if (!api) return
    let lineage: { maxChars?: number; maxLines?: number; segmentationMode?: 'auto' | 'rule' | 'llm' } | undefined
    if (selectedSubtitle.sourceJobId) {
      try {
        const baselines = await api.loadAutoCaptionBaselines()
        lineage = baselines.records.find((record) => record.jobId === selectedSubtitle.sourceJobId)?.settings
      } catch {
        // Current Auto Processing settings remain the safe fallback.
      }
    }
    const generation = deriveSubtitleTemplateGeneration({ clip: selectedSubtitle, currentSettings: autoCaptionSettingsSeed, lineage })
    beginCreate({ name: 'Timeline字幕テンプレート', style: selectedSubtitle.style, captionGeneration: generation })
  }

  const saveDraft = async (): Promise<void> => {
    const api = getApi()
    if (!api || !draft || !draft.name.trim()) {
      if (draft && !draft.name.trim()) showNotice('テンプレート名を入力してください。', 'warning')
      return
    }
    try {
      const created = await api.createSubtitleTemplate({ ...draft, name: draft.name.trim() })
      setCatalog([...userTemplates, created])
      setSelectedId(created.id)
      setMode('view')
      showNotice(`「${created.name}」を作成しました。`, 'success')
    } catch {
      showNotice('テンプレートを作成できませんでした。', 'error')
    }
  }

  const updateTemplate = async (): Promise<void> => {
    const api = getApi()
    if (!api || !selectedUser || !draft) return
    try {
      const updated = await api.updateSubtitleTemplate(selectedUser.id, { ...draft, name: draft.name.trim() })
      setCatalog(userTemplates.map((template) => template.id === updated.id ? updated : template))
      showNotice(`「${updated.name}」を更新しました。`, 'success')
    } catch {
      showNotice('テンプレートを更新できませんでした。', 'error')
    }
  }

  const renameTemplate = async (): Promise<void> => {
    await updateTemplate()
  }

  const duplicateTemplate = async (): Promise<void> => {
    const api = getApi()
    if (!api || !selected) return
    try {
      const created = await api.duplicateSubtitleTemplate(draftFrom({ name: templateLabel(selected), style: selected.style, captionGeneration: selected.captionGeneration }))
      setCatalog([...userTemplates, created])
      setSelectedId(created.id)
      showNotice(`「${created.name}」を複製しました。`, 'success')
    } catch {
      showNotice('テンプレートを複製できませんでした。', 'error')
    }
  }

  const deleteTemplate = async (): Promise<void> => {
    const api = getApi()
    if (!api || !selectedUser || !window.confirm(`「${selectedUser.name}」を削除しますか？\n現在のデフォルトの場合は「標準」へ戻ります。`)) return
    try {
      if (!(await api.deleteSubtitleTemplate(selectedUser.id))) return
      const next = userTemplates.filter((template) => template.id !== selectedUser.id)
      setCatalog(next)
      const nextDefault = defaultTemplateId === selectedUser.id ? 'default' : defaultTemplateId
      onDefaultChange(nextDefault)
      setSelectedId(nextDefault)
      showNotice(`「${selectedUser.name}」を削除しました。`, 'success')
    } catch {
      showNotice('テンプレートを削除できませんでした。', 'error')
    }
  }

  const setAsDefault = async (): Promise<void> => {
    const api = getApi()
    if (!api || !selected) return
    try {
      const catalog = await api.setDefaultSubtitleTemplate(selected.id)
      setCatalog(catalog.userTemplates)
      onDefaultChange(catalog.defaultTemplateId)
      showNotice(`「${templateLabel(selected)}」をデフォルトに設定しました。`, 'success')
    } catch {
      showNotice('デフォルトtemplateを設定できませんでした。', 'error')
    }
  }

  const applyTemplate = (): void => {
    if (!selected || !selectedSubtitle) {
      showNotice('適用先のTimeline字幕を1件選択してください。', 'warning')
      return
    }
    patchClip(selectedSubtitle.id, (current) => current.kind === 'subtitle' ? applySubtitleTemplateToClip(current, selected) : current)
    showNotice(`「${templateLabel(selected)}」を字幕へ適用しました。`, 'success')
  }

  const updateStyle = <K extends keyof SubtitleStyle>(key: K, value: SubtitleStyle[K]): void => {
    setDraft((current) => current ? { ...current, style: { ...current.style, [key]: value } } : current)
  }

  const updateNumberStyle = (key: keyof SubtitleStyle, value: string, minimum: number, maximum: number, step = 1): void => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    const rounded = step < 1 ? parsed : Math.round(parsed / step) * step
    updateStyle(key, Math.max(minimum, Math.min(maximum, rounded)) as SubtitleStyle[typeof key])
  }

  return (
    <div className="template-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="template-manager-title">
      <header className="dialog-header">
        <div><span className="panel-eyebrow">SUBTITLE TEMPLATES</span><h2 id="template-manager-title">字幕テンプレート管理</h2></div>
        <Button className="subtle-button" onClick={onClose}>閉じる</Button>
      </header>
      <div className="template-manager-body">
        <aside className="template-catalog" aria-label="字幕テンプレート一覧">
          <strong>組み込み（変更不可）</strong>
          {SUBTITLE_TEMPLATES.map((template) => <button type="button" className={selectedId === template.id ? 'is-selected' : ''} key={template.id} onClick={() => { setSelectedId(template.id); setMode('view') }}><span>{template.label}</span><small>組み込み</small></button>)}
          <strong>ユーザー</strong>
          {userTemplates.length ? userTemplates.map((template) => <button type="button" className={selectedId === template.id ? 'is-selected' : ''} key={template.id} onClick={() => { setSelectedId(template.id); setMode('view') }}><span>{template.name}</span><small>ユーザー</small></button>) : <small className="field-hint">まだありません</small>}
          <div className="template-actions"><Button className="primary-button" onClick={createNew}>新規作成</Button><Button className="subtle-button" disabled={!selectedSubtitle} title={selectedSubtitle ? '選択字幕から作成' : 'Timeline字幕を選択してください'} onClick={() => void createFromTimeline()}>Timeline字幕から作成</Button></div>
        </aside>
        <section className="template-detail" aria-label="字幕テンプレート詳細">
          {draft && selected ? (
            <>
              <div className="template-detail-heading"><div><span className="panel-eyebrow">{selectedUser ? 'USER TEMPLATE' : 'BUILT-IN TEMPLATE'}</span><h3>{templateLabel(selected)}</h3></div><span className={`template-badge ${selectedUser ? 'user' : 'builtin'}`}>{selectedUser ? 'ユーザー' : '組み込み'}</span></div>
              {mode === 'create' || canEdit ? <label className="field"><span className="field-label">名前</span><input value={draft.name} onChange={(event) => setDraft((current) => current ? { ...current, name: event.target.value } : current)} /></label> : <div className="template-readonly-name"><span>名前</span><strong>{draft.name}</strong></div>}
              <div className="template-detail-section"><strong>生成設定</strong><div className="field-grid"><label className="field"><span className="field-label">最大文字数</span><input type="number" min={1} max={10000} disabled={mode === 'view' && !canEdit} value={draft.captionGeneration.maxChars} onChange={(event) => setDraft((current) => current ? { ...current, captionGeneration: { ...current.captionGeneration, maxChars: Math.max(1, Math.min(10000, Number(event.target.value) || 1)) } } : current)} /></label><label className="field"><span className="field-label">最大行数</span><input type="number" min={1} max={16} disabled={mode === 'view' && !canEdit} value={draft.captionGeneration.maxLines} onChange={(event) => setDraft((current) => current ? { ...current, captionGeneration: { ...current.captionGeneration, maxLines: Math.max(1, Math.min(16, Number(event.target.value) || 1)) } } : current)} /></label></div><label className="field"><span className="field-label">品質 / 区切り</span><select disabled={mode === 'view' && !canEdit} value={draft.captionGeneration.segmentationMode} onChange={(event) => setDraft((current) => current ? { ...current, captionGeneration: { ...current.captionGeneration, segmentationMode: event.target.value as SubtitleTemplateCaptionGeneration['segmentationMode'] } } : current)}><option value="auto">高品質（自動）</option><option value="rule">ルール</option><option value="llm">LLM</option></select></label></div>
              <div className="template-detail-section"><strong>表示設定エディター</strong><div className="template-style-editor">
                <label className="field"><span className="field-label">フォント</span><select disabled={!editable} value={draft.style.fontFamily} onChange={(event) => updateStyle('fontFamily', event.target.value)}>{resolveFontFamilyOptions(fontFamilies, draft.style.fontFamily).map((family) => <option key={family} value={family}>{family}</option>)}</select></label>
                <label className="field"><span className="field-label">サイズ（px）</span><input disabled={!editable} type="number" min={1} max={10000} value={draft.style.fontSize} onChange={(event) => updateNumberStyle('fontSize', event.target.value, 1, 10000)} /></label>
                <label className="field"><span className="field-label">文字色</span><input disabled={!editable} value={draft.style.color} onChange={(event) => updateStyle('color', event.target.value)} /></label>
                <label className="field"><span className="field-label">縁取り色</span><input disabled={!editable} value={draft.style.outlineColor} onChange={(event) => updateStyle('outlineColor', event.target.value)} /></label>
                <label className="field"><span className="field-label">縁取り幅（px）</span><input disabled={!editable} type="number" min={0} max={1000} value={draft.style.outlineWidth} onChange={(event) => updateNumberStyle('outlineWidth', event.target.value, 0, 1000)} /></label>
                <label className="field"><span className="field-label">影色</span><input disabled={!editable} value={draft.style.shadowColor} onChange={(event) => updateStyle('shadowColor', event.target.value)} /></label>
                <label className="field"><span className="field-label">影ぼかし（px）</span><input disabled={!editable} type="number" min={0} max={1000} value={draft.style.shadowBlur} onChange={(event) => updateNumberStyle('shadowBlur', event.target.value, 0, 1000)} /></label>
                <label className="field"><span className="field-label">背景色</span><input disabled={!editable} value={draft.style.backgroundColor} onChange={(event) => updateStyle('backgroundColor', event.target.value)} /></label>
                <label className="field"><span className="field-label">背景濃度（0〜1）</span><input disabled={!editable} type="number" min={0} max={1} step={0.01} value={draft.style.backgroundOpacity} onChange={(event) => updateNumberStyle('backgroundOpacity', event.target.value, 0, 1, 0.01)} /></label>
                <label className="field"><span className="field-label">字間（px）</span><input disabled={!editable} type="number" min={-1000} max={1000} step={0.1} value={draft.style.letterSpacing} onChange={(event) => updateNumberStyle('letterSpacing', event.target.value, -1000, 1000, 0.1)} /></label>
                <label className="field"><span className="field-label">行間</span><input disabled={!editable} type="number" min={0.1} max={10} step={0.05} value={draft.style.lineHeight} onChange={(event) => updateNumberStyle('lineHeight', event.target.value, 0.1, 10, 0.05)} /></label>
                <label className="field"><span className="field-label">配置</span><select disabled={!editable} value={draft.style.alignment} onChange={(event) => updateStyle('alignment', event.target.value as SubtitleStyle['alignment'])}><option value="top">上</option><option value="middle">中央</option><option value="bottom">下</option></select></label>
                <label className="field"><span className="field-label">位置X（%）</span><input disabled={!editable} type="number" min={-1000} max={1000} step={0.1} value={draft.style.positionX} onChange={(event) => updateNumberStyle('positionX', event.target.value, -1000, 1000, 0.1)} /></label>
                <label className="field"><span className="field-label">位置Y（%）</span><input disabled={!editable} type="number" min={-1000} max={1000} step={0.1} value={draft.style.positionY} onChange={(event) => updateNumberStyle('positionY', event.target.value, -1000, 1000, 0.1)} /></label>
                <label className="field"><span className="field-label">最大幅（%）</span><input disabled={!editable} type="number" min={0.1} max={1000} step={0.1} value={draft.style.maxWidthPercent} onChange={(event) => { updateNumberStyle('maxWidthPercent', event.target.value, 0.1, 1000, 0.1); setDraft((current) => current ? { ...current, captionGeneration: { ...current.captionGeneration, layoutConstraints: { maxWidthPercent: Math.max(0.1, Math.min(1000, Number(event.target.value) || current.style.maxWidthPercent)) } } } : current) }} /></label>
                <label className="field"><span className="field-label">アニメーション</span><select disabled={!editable} value={draft.style.animation} onChange={(event) => updateStyle('animation', event.target.value as SubtitleStyle['animation'])}><option value="none">なし</option><option value="fade">フェード</option><option value="pop">ポップ</option><option value="slide-up">スライドアップ</option><option value="typewriter">タイプライター</option></select></label>
                <label className="field"><span className="field-label">アニメーション時間（µs）</span><input disabled={!editable} type="number" min={0} max={Number.MAX_SAFE_INTEGER} value={draft.style.animationDurationUs} onChange={(event) => updateNumberStyle('animationDurationUs', event.target.value, 0, Number.MAX_SAFE_INTEGER)} /></label>
                <label className="checkbox-field"><input disabled={!editable} type="checkbox" checked={draft.style.bold} onChange={(event) => updateStyle('bold', event.target.checked)} /><span>太字</span></label>
                <label className="checkbox-field"><input disabled={!editable} type="checkbox" checked={draft.style.italic} onChange={(event) => updateStyle('italic', event.target.checked)} /><span>斜体</span></label>
              </div></div>
              <div className="template-detail-section"><strong>プレビュー</strong><label className="field"><span className="field-label">プレビュー用テキスト（保存されません）</span><textarea rows={3} value={previewText} placeholder={PREVIEW_SAMPLE} onChange={(event) => setPreviewText(event.target.value)} /></label><SubtitleTemplatePreview style={draft.style} maxLines={draft.captionGeneration.maxLines} sampleText={previewText || PREVIEW_SAMPLE} /><div className="template-detail-grid">{styleRows.map(([key, label, format]) => <div key={key}><span>{label}</span><strong>{format(draft.style[key])}</strong></div>)}<div><span>最大幅制約</span><strong>{draft.captionGeneration.layoutConstraints.maxWidthPercent}%</strong></div></div></div>
              <div className="template-actions"><Button className="subtle-button" disabled={!selectedSubtitle} title={selectedSubtitle ? '選択中字幕へ適用' : 'Timeline字幕を選択してください'} onClick={applyTemplate}>適用</Button><Button className="subtle-button" onClick={() => void duplicateTemplate()}>複製 / built-inからuser copy</Button><Button className="subtle-button" disabled={!selectedUser} title={selectedUser ? '名前と内容を更新' : '組み込みtemplateは変更できません'} onClick={() => void renameTemplate()}>名前変更 / 内容更新</Button><Button className="subtle-button" disabled={!selectedUser} title={selectedUser ? '削除確認を表示' : '組み込みtemplateは削除できません'} onClick={() => void deleteTemplate()}>削除</Button><Button className="subtle-button" disabled={defaultTemplateId === selectedId} onClick={() => void setAsDefault()}>デフォルトに設定</Button>{mode === 'create' && <Button className="primary-button" onClick={() => void saveDraft()}>保存</Button>}</div>
              {mode === 'create' && <small className="field-hint">新規作成内容を確認して保存してください。machine固有GPU設定やSilence Cutはtemplateへ入りません。</small>}
            </>
          ) : <p className="field-hint">テンプレートを選択してください。</p>}
        </section>
      </div>
    </div>
  )
}
