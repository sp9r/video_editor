import { useEffect, useState } from 'react'
import { Captions, Image as ImageIcon, SlidersHorizontal, Volume2 } from 'lucide-react'
import { findSubtitleContext, subtitleWordsMatchText } from '../../../shared/project'
import { subtitleEditUnits } from '../../../shared/editing/edit-units'
import { DEFAULT_SUBTITLE_STYLE, type AudioSettings, type SubtitleClip, type SubtitleStyle, type TimelineClip, type TransformSettings } from '../../../shared/types'
import { FALLBACK_FONT_FAMILIES } from '../../../shared/font-families'
import { applySubtitleTemplateToClip, deriveSubtitleTemplateGeneration } from '../../../shared/subtitle-template-seed'
import type { SubtitleTemplateCaptionGeneration } from '../../../shared/subtitle-templates'
import { DEFAULT_SILENCE_REAPPLY_PROFILE, type SilenceReapplyProfile } from '../../../shared/silence-cut'
import { getSubtitleTemplate, SUBTITLE_TEMPLATES, type SubtitleTemplateDraft, type UserSubtitleTemplate } from '../../../shared/subtitle-templates'
import { findClip, useEditorStore } from '../store'
import { Button, EmptyState, Field, NumberField, Section, SelectField } from './Controls'
import SubtitleTemplatePreview from './SubtitleTemplatePreview'

const numberValue = (value: string, fallback = 0): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const hasTransform = (clip: TimelineClip): clip is Extract<TimelineClip, { kind: 'video' | 'image' }> =>
  clip.kind === 'video' || clip.kind === 'image'

const hasAudio = (clip: TimelineClip): clip is Extract<TimelineClip, { kind: 'video' | 'audio' }> =>
  clip.kind === 'video' || clip.kind === 'audio'

const useEditTransaction = (): { onFocus: () => void; onBlur: () => void } => {
  const begin = useEditorStore((state) => state.beginEditTransaction)
  const commit = useEditorStore((state) => state.commitEditTransaction)
  return { onFocus: begin, onBlur: commit }
}

function TransformEditor({ clip }: { clip: Extract<TimelineClip, { kind: 'video' | 'image' }> }): React.JSX.Element {
  const patchClip = useEditorStore((state) => state.patchClip)
  const transaction = useEditTransaction()
  const patch = (values: Partial<TransformSettings>): void =>
    patchClip(clip.id, (current) => (hasTransform(current) ? { ...current, transform: { ...current.transform, ...values } } : current))
  const crop = (key: keyof TransformSettings['crop'], percent: number): void =>
    patch({ crop: { ...clip.transform.crop, [key]: Math.min(0.49, Math.max(0, percent / 100)) } })
  return (
    <>
      <Section title="変形">
        <div className="field-grid">
          <NumberField {...transaction} label="位置 X" suffix="px" value={clip.transform.positionX} onChange={(event) => patch({ positionX: numberValue(event.target.value) })} />
          <NumberField {...transaction} label="位置 Y" suffix="px" value={clip.transform.positionY} onChange={(event) => patch({ positionY: numberValue(event.target.value) })} />
          <NumberField {...transaction} label="拡大率" suffix="%" min={1} max={800} value={Math.round(clip.transform.scale * 100)} onChange={(event) => patch({ scale: Math.max(0.01, numberValue(event.target.value, 100) / 100) })} />
          <NumberField {...transaction} label="回転" suffix="°" value={clip.transform.rotation} onChange={(event) => patch({ rotation: numberValue(event.target.value) })} />
          <NumberField {...transaction} label="不透明度" suffix="%" min={0} max={100} value={Math.round(clip.transform.opacity * 100)} onChange={(event) => patch({ opacity: Math.min(1, Math.max(0, numberValue(event.target.value) / 100)) })} />
        </div>
      </Section>
      <Section title="クロップ">
        <div className="field-grid">
          {(['left', 'right', 'top', 'bottom'] as const).map((key) => (
            <NumberField
              key={key}
              label={{ left: '左', right: '右', top: '上', bottom: '下' }[key]}
              suffix="%"
              min={0}
              max={49}
              step={0.1}
              value={Math.round(clip.transform.crop[key] * 1000) / 10}
              {...transaction}
              onChange={(event) => crop(key, numberValue(event.target.value))}
            />
          ))}
        </div>
      </Section>
    </>
  )
}

function AudioEditor({ clip }: { clip: Extract<TimelineClip, { kind: 'video' | 'audio' }> }): React.JSX.Element {
  const patchClip = useEditorStore((state) => state.patchClip)
  const transaction = useEditTransaction()
  const patch = (values: Partial<AudioSettings>): void =>
    patchClip(clip.id, (current) => (hasAudio(current) ? { ...current, audio: { ...current.audio, ...values } } : current))
  return (
    <Section title="音声">
      <div className="range-field">
        <span>音量</span>
        <input {...transaction} type="range" min={-60} max={12} step={0.5} value={clip.audio.volumeDb} onChange={(event) => patch({ volumeDb: numberValue(event.target.value) })} />
        <output>{clip.audio.volumeDb.toFixed(1)} dB</output>
      </div>
      <div className="field-grid">
        <NumberField {...transaction} label="パン" min={-100} max={100} value={clip.audio.pan} onChange={(event) => patch({ pan: numberValue(event.target.value) })} />
        <NumberField {...transaction} label="フェードイン" suffix="秒" min={0} step={0.1} value={clip.audio.fadeInUs / 1_000_000} onChange={(event) => patch({ fadeInUs: Math.max(0, numberValue(event.target.value) * 1_000_000) })} />
        <NumberField {...transaction} label="フェードアウト" suffix="秒" min={0} step={0.1} value={clip.audio.fadeOutUs / 1_000_000} onChange={(event) => patch({ fadeOutUs: Math.max(0, numberValue(event.target.value) * 1_000_000) })} />
      </div>
    </Section>
  )
}

function SubtitleTemplateManager({ clip }: { clip: SubtitleClip }): React.JSX.Element {
  const {
    project,
    userSubtitleTemplates,
    defaultSubtitleTemplateId,
    autoCaptionSettingsSeed,
    setUserSubtitleTemplates,
    setDefaultSubtitleTemplateId,
    patchClip,
    applySubtitleStyleToTrack,
    showNotice
  } = useEditorStore()
  const [templateId, setTemplateId] = useState(defaultSubtitleTemplateId)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveName, setSaveName] = useState('字幕テンプレート')
  const [saveGeneration, setSaveGeneration] = useState<Pick<SubtitleTemplateCaptionGeneration, 'maxChars' | 'maxLines' | 'segmentationMode'>>({ maxChars: 32, maxLines: 2, segmentationMode: 'auto' })
  const [saveSeedSource, setSaveSeedSource] = useState<'baseline' | 'current'>('current')
  useEffect(() => setTemplateId(defaultSubtitleTemplateId), [defaultSubtitleTemplateId])

  const selected = getSubtitleTemplate(templateId, userSubtitleTemplates)
  const selectedUser = userSubtitleTemplates.find((template) => template.id === templateId)
  const isUserTemplate = Boolean(selectedUser)
  const templateGenerationDefaults = (style: SubtitleStyle): SubtitleTemplateCaptionGeneration => ({
    maxChars: 32,
    maxLines: 2,
    segmentationMode: 'auto',
    layoutConstraints: { maxWidthPercent: style.maxWidthPercent }
  })
  const templateDraft = (name: string, style: SubtitleStyle, generation = templateGenerationDefaults(style)): SubtitleTemplateDraft => ({
    name,
    style: structuredClone(style),
    captionGeneration: structuredClone({
      ...generation,
      layoutConstraints: { maxWidthPercent: style.maxWidthPercent }
    })
  })
  const replaceCatalog = (catalog: { userTemplates: UserSubtitleTemplate[]; defaultTemplateId: string }): void => {
    setUserSubtitleTemplates(catalog.userTemplates)
    setDefaultSubtitleTemplateId(catalog.defaultTemplateId)
    setTemplateId(catalog.defaultTemplateId)
  }
  const getDesktopApi = (): NonNullable<Window['spectra']> | null => {
    const api = window.spectra
    if (api) return api
    showNotice('テンプレート管理はElectron環境で利用できます。', 'warning')
    return null
  }
  const applyTemplate = (): void => {
    if (!selected) return
    patchClip(clip.id, (current) => current.kind === 'subtitle' ? applySubtitleTemplateToClip(current, selected) : current)
    showNotice(`「${'name' in selected ? selected.name : selected.label}」を字幕へ適用しました。`, 'success')
  }
  const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle' && track.clips.some((candidate) => candidate.id === clip.id))
  const mixedStyle = Boolean(subtitleTrack?.clips.some((candidate) => candidate.kind === 'subtitle' && JSON.stringify(candidate.style) !== JSON.stringify(clip.style)))
  const openSaveDialog = async (): Promise<void> => {
    const api = getDesktopApi()
    if (!api) return
    let lineage: { maxChars?: number; maxLines?: number; segmentationMode?: 'auto' | 'rule' | 'llm' } | undefined
    if (clip.sourceJobId) {
      try {
        const baselines = await api.loadAutoCaptionBaselines()
        const baseline = baselines.records.find((record) => record.jobId === clip.sourceJobId)
        if (baseline) lineage = baseline.settings
      } catch {
        // A missing/malformed baseline falls back to the current Auto Processing settings.
      }
    }
    const generation = deriveSubtitleTemplateGeneration({ clip, currentSettings: autoCaptionSettingsSeed, lineage })
    setSaveName('字幕テンプレート')
    setSaveGeneration({ maxChars: generation.maxChars, maxLines: generation.maxLines, segmentationMode: generation.segmentationMode })
    setSaveSeedSource(lineage ? 'baseline' : 'current')
    setSaveDialogOpen(true)
  }
  const saveCurrentAsTemplate = async (): Promise<void> => {
    const api = getDesktopApi()
    if (!api) return
    const name = saveName.trim()
    if (!name) {
      showNotice('テンプレート名を入力してください。', 'warning')
      return
    }
    try {
      const created = await api.createSubtitleTemplate(templateDraft(name, clip.style, { ...saveGeneration, layoutConstraints: { maxWidthPercent: clip.style.maxWidthPercent } }))
      setUserSubtitleTemplates([...userSubtitleTemplates, created])
      setTemplateId(created.id)
      setSaveDialogOpen(false)
      showNotice(`「${created.name}」を保存しました。`, 'success')
    } catch {
      showNotice('テンプレートを保存できませんでした。', 'error')
    }
  }
  const duplicateTemplate = async (): Promise<void> => {
    const api = getDesktopApi()
    if (!api || !selected) return
    const name = window.prompt('複製後のテンプレート名', `${'name' in selected ? selected.name : selected.label} copy`)?.trim()
    if (!name) return
    try {
      const created = await api.duplicateSubtitleTemplate(templateDraft(name, selected.style, selected.captionGeneration))
      setUserSubtitleTemplates([...userSubtitleTemplates, created])
      setTemplateId(created.id)
      showNotice(`「${created.name}」を複製しました。`, 'success')
    } catch {
      showNotice('テンプレートを複製できませんでした。', 'error')
    }
  }
  const renameTemplate = async (): Promise<void> => {
    const api = getDesktopApi()
    if (!api || !selectedUser) return
    const name = window.prompt('新しいテンプレート名', selectedUser.name)?.trim()
    if (!name || name === selectedUser.name) return
    try {
      const updated = await api.updateSubtitleTemplate(selectedUser.id, templateDraft(name, selectedUser.style, selectedUser.captionGeneration))
      setUserSubtitleTemplates(userSubtitleTemplates.map((template) => template.id === updated.id ? updated : template))
      showNotice(`「${updated.name}」へ名前を変更しました。`, 'success')
    } catch {
      showNotice('テンプレート名を変更できませんでした。', 'error')
    }
  }
  const updateTemplate = async (): Promise<void> => {
    const api = getDesktopApi()
    if (!api || !selectedUser) return
    try {
      const updated = await api.updateSubtitleTemplate(selectedUser.id, templateDraft(selectedUser.name, clip.style, selectedUser.captionGeneration))
      setUserSubtitleTemplates(userSubtitleTemplates.map((template) => template.id === updated.id ? updated : template))
      showNotice(`「${updated.name}」を現在の字幕styleで更新しました。`, 'success')
    } catch {
      showNotice('テンプレートを更新できませんでした。', 'error')
    }
  }
  const deleteTemplate = async (): Promise<void> => {
    const api = getDesktopApi()
    if (!api || !selectedUser || !window.confirm(`「${selectedUser.name}」を削除しますか？`)) return
    try {
      if (!(await api.deleteSubtitleTemplate(selectedUser.id))) return
      const next = userSubtitleTemplates.filter((template) => template.id !== selectedUser.id)
      setUserSubtitleTemplates(next)
      setTemplateId(defaultSubtitleTemplateId === selectedUser.id ? 'default' : defaultSubtitleTemplateId)
      showNotice(`「${selectedUser.name}」を削除しました。`, 'success')
    } catch {
      showNotice('テンプレートを削除できませんでした。', 'error')
    }
  }
  const setAsDefault = async (): Promise<void> => {
    const api = getDesktopApi()
    if (!api || !selected) return
    try {
      const catalog = await api.setDefaultSubtitleTemplate(selected.id)
      replaceCatalog(catalog)
      showNotice(`「${'name' in selected ? selected.name : selected.label}」をデフォルトに設定しました。`, 'success')
    } catch {
      showNotice('デフォルトtemplateを設定できませんでした。', 'error')
    }
  }
  return (
    <Section title="字幕テンプレート">
      <div className="subtitle-template-manager">
        <select aria-label="字幕テンプレート" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
          <optgroup label="組み込み（変更不可）">{SUBTITLE_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}</optgroup>
          {userSubtitleTemplates.length > 0 && <optgroup label="ユーザー">{userSubtitleTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</optgroup>}
        </select>
        <SubtitleTemplatePreview style={selected?.style ?? DEFAULT_SUBTITLE_STYLE} maxLines={selected?.captionGeneration.maxLines ?? 2} />
        <div className="template-actions">
          <Button className="primary-button" onClick={() => void openSaveDialog()}>テンプレートとして保存</Button>
          <Button className="subtle-button" disabled={!selected} title={selected ? '選択中templateを字幕へ適用' : 'templateを選択してください'} onClick={applyTemplate}>適用</Button>
          <Button className="subtle-button" disabled={!selected} title={selected ? '選択中templateを複製' : 'templateを選択してください'} onClick={() => void duplicateTemplate()}>複製</Button>
          <Button className="subtle-button" disabled={!isUserTemplate} title={isUserTemplate ? 'ユーザーtemplateの名前を変更' : '組み込みtemplateは変更できません'} onClick={() => void renameTemplate()}>名前変更</Button>
          <Button className="subtle-button" disabled={!isUserTemplate} title={isUserTemplate ? 'ユーザーtemplateを更新' : 'ユーザーtemplateを選択してください'} onClick={() => void updateTemplate()}>更新</Button>
          <Button className="subtle-button" disabled={!isUserTemplate} title={isUserTemplate ? 'ユーザーtemplateを削除' : '組み込みtemplateは削除できません'} onClick={() => void deleteTemplate()}>削除</Button>
          <Button className="subtle-button" disabled={!selected || defaultSubtitleTemplateId === templateId} title={!selected ? 'templateを選択してください' : defaultSubtitleTemplateId === templateId ? 'すでにデフォルトです' : 'デフォルトtemplateに設定'} onClick={() => void setAsDefault()}>デフォルトに設定</Button>
        </div>
        <Button className="subtle-button" disabled={!selected} title={selected ? 'この字幕track全体へstyleを適用' : 'templateを選択してください'} onClick={() => {
          if (!selected) return
          applySubtitleStyleToTrack(clip.id, selected.style)
          showNotice(`この字幕track全体へ「${'name' in selected ? selected.name : selected.label}」を適用しました。`, 'success')
        }}>字幕track全体へ適用</Button>
        {saveDialogOpen && (
          <div className="template-save-panel" role="dialog" aria-label="字幕からテンプレートを保存">
            <h4>字幕からテンプレートを保存</h4>
            <label className="field"><span className="field-label">名前</span><input value={saveName} onChange={(event) => setSaveName(event.target.value)} /></label>
            <div className="field-grid">
              <label className="field"><span className="field-label">最大文字数</span><input type="number" min={1} max={10000} value={saveGeneration.maxChars} onChange={(event) => setSaveGeneration((current) => ({ ...current, maxChars: Math.max(1, Math.min(10000, Number(event.target.value) || 1)) }))} /></label>
              <label className="field"><span className="field-label">最大行数</span><input type="number" min={1} max={16} value={saveGeneration.maxLines} onChange={(event) => setSaveGeneration((current) => ({ ...current, maxLines: Math.max(1, Math.min(16, Number(event.target.value) || 1)) }))} /></label>
            </div>
            <label className="field"><span className="field-label">字幕品質</span><select value={saveGeneration.segmentationMode} onChange={(event) => setSaveGeneration((current) => ({ ...current, segmentationMode: event.target.value as SubtitleTemplateCaptionGeneration['segmentationMode'] }))}><option value="auto">高品質（自動）</option><option value="rule">ルール</option><option value="llm">LLM</option></select></label>
            <div className="template-style-summary"><strong>見た目</strong><span>{clip.style.fontFamily} / {clip.style.fontSize}px / {clip.style.bold ? '太字' : '標準'} / {clip.style.italic ? '斜体' : '標準'}</span><span>文字 {clip.style.color} · 縁取り {clip.style.outlineColor} {clip.style.outlineWidth}px · 幅 {clip.style.maxWidthPercent}%</span></div>
            <small className="field-hint">{saveSeedSource === 'baseline' ? 'この字幕の自動字幕baseline設定を初期値にしました。' : '対応baselineがないため、現在のAuto Processing設定を初期値にしました。本文の長さからは推測していません。'}</small>
            {mixedStyle && <div className="template-warning" role="alert">同じ字幕trackに異なるstyleがあります。保存には選択中の字幕styleを使用します。</div>}
            <div className="template-actions"><Button className="subtle-button" onClick={() => setSaveDialogOpen(false)}>キャンセル</Button><Button className="primary-button" onClick={() => void saveCurrentAsTemplate()}>保存</Button></div>
          </div>
        )}
        <small className="field-hint">{defaultSubtitleTemplateId === templateId ? '現在のデフォルト' : '選択中のtemplate'} · Finalと同じSubtitleStyleを使って表示します。</small>
      </div>
    </Section>
  )
}

function SubtitleEditor({ clip }: { clip: SubtitleClip }): React.JSX.Element {
  const { project, patchClip, selectClip, setPlayhead, splitSubtitleAtWordBoundary, mergeSubtitleWithPrevious, mergeSubtitleWithNext } = useEditorStore()
  const transaction = useEditTransaction()
  const [fontFamilies, setFontFamilies] = useState<string[]>([...FALLBACK_FONT_FAMILIES])
  useEffect(() => {
    if (!window.spectra) return
    void window.spectra.listFontFamilies().then((families) => {
      if (families.length) setFontFamilies([...new Set([...families, clip.style.fontFamily])])
    }).catch(() => undefined)
  }, [clip.style.fontFamily])
  const patchStyle = (values: Partial<SubtitleStyle>): void =>
    patchClip(clip.id, (current) => current.kind === 'subtitle' ? { ...current, style: { ...current.style, ...values } } : current)
  const { previous, next } = findSubtitleContext(project, clip.id)
  const wordsMatchText = subtitleWordsMatchText(clip)
  const editUnits = subtitleEditUnits(clip)
  const selectContext = (item: SubtitleClip): void => {
    selectClip(item.id)
    setPlayhead(item.startUs)
  }
  return (
    <>
      <Section title="字幕の流れ">
        <div className="subtitle-context" aria-label="前後の字幕">
          {previous && <button type="button" onClick={() => selectContext(previous)}><small>前</small><span>{previous.text}</span></button>}
          <button type="button" className="is-current" onClick={() => selectContext(clip)}><small>現在</small><span>{clip.text}</span></button>
          {next && <button type="button" onClick={() => selectContext(next)}><small>次</small><span>{next.text}</span></button>}
        </div>
        <div className="field-grid">
          <Button className="subtle-button" disabled={!previous} title={previous ? '前の字幕と結合' : '前の字幕がありません'} onClick={() => mergeSubtitleWithPrevious(clip.id)}>← 前の字幕と結合</Button>
          <Button className="subtle-button" disabled={!next} title={next ? '次の字幕と結合' : '次の字幕がありません'} onClick={() => mergeSubtitleWithNext(clip.id)}>次の字幕と結合 →</Button>
        </div>
      </Section>
      <Section title="字幕テキスト">
        <Field label="本文" wide>
          <textarea
            {...transaction}
            value={clip.text}
            rows={4}
            onChange={(event) => patchClip(clip.id, (current) => {
              if (current.kind !== 'subtitle') return current
              // Once the displayed text changes, the generated word/edit-unit
              // timing no longer proves ownership of the new text. Drop the
              // derived timing metadata instead of keeping a false mapping.
              return current.text === event.target.value
                ? current
                : { ...current, text: event.target.value, words: undefined, editUnits: undefined }
            })}
          />
        </Field>
        {clip.words?.length || editUnits?.length ? (
          <Field label="単語境界" wide>
            <div className="subtitle-word-boundaries" aria-label="単語境界で分割">
              {(editUnits ?? clip.words ?? []).map((unit, index, units) => (
                <span className="subtitle-word-boundary" key={unit.id}>
                  <span className="subtitle-word-token" title={`${(unit.startUs / 1_000_000).toFixed(2)}–${(unit.endUs / 1_000_000).toFixed(2)}秒`}>{unit.text}</span>
                  {index < units.length - 1 && <button type="button" disabled={!editUnits || !wordsMatchText} title={!editUnits ? '編集単位がありません' : !wordsMatchText ? '本文と単語情報が一致しないため分割できません' : 'この単語の後で分割'} aria-label={`「${unit.text}」の後で分割`} onClick={() => splitSubtitleAtWordBoundary(clip.id, index)}>分割</button>}
                </span>
              ))}
            </div>
            {editUnits?.some((unit) => unit.timingProvenance === 'estimated') && <p className="field-hint">日本語語塊から推定した編集境界です。音響的な単語alignmentではありません。</p>}
            {!wordsMatchText && <p className="field-hint warning">本文が編集されているため、現在の単語タイミングでは分割できません。</p>}
          </Field>
        ) : <p className="field-hint">単語タイミング情報がない字幕は、単語境界分割を利用できません。</p>}
      </Section>
      <Section title="文字スタイル">
        <Field label="フォント">
          <input {...transaction} list="subtitle-font-options" value={clip.style.fontFamily} onChange={(event) => patchStyle({ fontFamily: event.target.value })} />
          <datalist id="subtitle-font-options">{fontFamilies.map((family) => <option key={family} value={family} />)}</datalist>
        </Field>
        <div className="field-grid">
          <NumberField {...transaction} label="サイズ" suffix="px" min={8} max={240} value={clip.style.fontSize} onChange={(event) => patchStyle({ fontSize: numberValue(event.target.value, 54) })} />
          <NumberField {...transaction} label="字間" suffix="px" min={-5} max={30} step={0.5} value={clip.style.letterSpacing} onChange={(event) => patchStyle({ letterSpacing: numberValue(event.target.value) })} />
          <NumberField {...transaction} label="行間" min={0.6} max={3} step={0.05} value={clip.style.lineHeight} onChange={(event) => patchStyle({ lineHeight: numberValue(event.target.value, 1.15) })} />
        </div>
        <div className="toggle-row">
          <button type="button" className={clip.style.bold ? 'is-active' : ''} onClick={() => patchStyle({ bold: !clip.style.bold })}><strong>B</strong> 太字</button>
          <button type="button" className={clip.style.italic ? 'is-active' : ''} onClick={() => patchStyle({ italic: !clip.style.italic })}><em>I</em> 斜体</button>
        </div>
        <div className="color-grid">
          <Field label="文字色"><input type="color" value={clip.style.color} onChange={(event) => patchStyle({ color: event.target.value })} /></Field>
          <Field label="縁取り"><input type="color" value={clip.style.outlineColor} onChange={(event) => patchStyle({ outlineColor: event.target.value })} /></Field>
          <Field label="影"><input type="color" value={clip.style.shadowColor} onChange={(event) => patchStyle({ shadowColor: event.target.value })} /></Field>
          <Field label="背景"><input type="color" value={clip.style.backgroundColor} onChange={(event) => patchStyle({ backgroundColor: event.target.value })} /></Field>
        </div>
        <div className="field-grid">
          <NumberField label="縁取り幅" suffix="px" min={0} max={20} value={clip.style.outlineWidth} onChange={(event) => patchStyle({ outlineWidth: numberValue(event.target.value) })} />
          <NumberField label="影ぼかし" suffix="px" min={0} max={40} value={clip.style.shadowBlur} onChange={(event) => patchStyle({ shadowBlur: numberValue(event.target.value) })} />
          <NumberField label="背景濃度" suffix="%" min={0} max={100} value={Math.round(clip.style.backgroundOpacity * 100)} onChange={(event) => patchStyle({ backgroundOpacity: numberValue(event.target.value) / 100 })} />
          <NumberField label="字幕幅" suffix="%" min={10} max={300} value={clip.style.maxWidthPercent ?? 80} onChange={(event) => patchStyle({ maxWidthPercent: numberValue(event.target.value, 80) })} />
        </div>
        <Button className="subtle-button" onClick={() => useEditorStore.getState().applySubtitleStyleToAll(clip.id)}>この字幕のスタイルを全字幕へ適用</Button>
      </Section>
      <Section title="配置とアニメーション">
        <SelectField label="縦位置" value={clip.style.alignment} onChange={(event) => patchStyle({ alignment: event.target.value as SubtitleStyle['alignment'] })}>
          <option value="top">上</option><option value="middle">中央</option><option value="bottom">下</option>
        </SelectField>
        <div className="field-grid">
          <NumberField label="位置 X" suffix="%" min={-100} max={200} value={clip.style.positionX} onChange={(event) => patchStyle({ positionX: numberValue(event.target.value, 50) })} />
          <NumberField label="位置 Y" suffix="%" min={-100} max={200} value={clip.style.positionY} onChange={(event) => patchStyle({ positionY: numberValue(event.target.value, 86) })} />
        </div>
        <SelectField label="登場効果" value={clip.style.animation} onChange={(event) => patchStyle({ animation: event.target.value as SubtitleStyle['animation'] })}>
          <option value="none">なし</option><option value="fade">フェード</option><option value="pop">ポップ</option><option value="slide-up">下からスライド</option><option value="typewriter">タイプライター</option>
        </SelectField>
        <NumberField label="効果の長さ" suffix="秒" min={0.05} max={3} step={0.05} value={clip.style.animationDurationUs / 1_000_000} onChange={(event) => patchStyle({ animationDurationUs: numberValue(event.target.value) * 1_000_000 })} />
      </Section>
      <SubtitleTemplateManager clip={clip} />
    </>
  )
}

export default function Inspector(): React.JSX.Element {
  const { project, selectedClipIds } = useEditorStore()
  const silenceCutReapplyBusy = useEditorStore((state) => state.silenceCutReapplyBusy)
  const reapplySilenceCut = useEditorStore((state) => state.reapplySilenceCut)
  const cancelSilenceCutReapply = useEditorStore((state) => state.cancelSilenceCutReapply)
  const [silenceReapplyProfile, setSilenceReapplyProfile] = useState<SilenceReapplyProfile>(DEFAULT_SILENCE_REAPPLY_PROFILE)
  const transaction = useEditTransaction()
  const clip = findClip(project, selectedClipIds)
  return (
    <aside className="panel inspector" aria-label="インスペクタ">
      <header className="panel-header">
        <div><span className="panel-eyebrow">PROPERTIES</span><h2>インスペクタ</h2></div>
        <SlidersHorizontal size={17} />
      </header>
      {clip ? (
        <div className="inspector-content">
          <div className="selected-clip-heading">
            <span className={`clip-kind-dot kind-${clip.kind}`} />
            <div><strong>{clip.name}</strong><small>{clip.kind === 'subtitle' ? '字幕' : clip.kind === 'audio' ? '音声' : clip.kind === 'image' ? '画像' : '映像クリップ'}</small></div>
            {clip.kind === 'subtitle' ? <Captions size={18} /> : clip.kind === 'audio' ? <Volume2 size={18} /> : <ImageIcon size={18} />}
          </div>
          <Section title="クリップ">
            <label className="check-field"><input {...transaction} type="checkbox" checked={clip.enabled} onChange={(event) => useEditorStore.getState().patchClip(clip.id, (current) => ({ ...current, enabled: event.target.checked }))} />表示／再生を有効にする</label>
            <div className="field-grid">
              <NumberField {...transaction} label="開始" suffix="秒" min={0} step={0.1} value={(clip.startUs / 1_000_000).toFixed(2)} onChange={(event) => useEditorStore.getState().moveSelected(clip.id, project.tracks.find((track) => track.clips.some((item) => item.id === clip.id))?.id ?? '', numberValue(event.target.value) * 1_000_000)} />
              <NumberField {...transaction} label="長さ" suffix="秒" min={0.03} step={0.1} value={(clip.durationUs / 1_000_000).toFixed(2)} onChange={(event) => useEditorStore.getState().trim(clip.id, 'end', clip.startUs + Math.max(33_333, numberValue(event.target.value) * 1_000_000))} />
              {clip.kind === 'subtitle' && <NumberField {...transaction} label="終了" suffix="秒" min={0.03} step={0.1} value={((clip.startUs + clip.durationUs) / 1_000_000).toFixed(2)} onChange={(event) => useEditorStore.getState().trim(clip.id, 'end', Math.max(clip.startUs + 33_333, numberValue(event.target.value) * 1_000_000))} />}
            </div>
            {(clip.kind === 'video' || clip.kind === 'audio') && <div className="field-grid">
              <label className="field"><span className="field-label">無音カットprofile</span><select disabled={silenceCutReapplyBusy} value={silenceReapplyProfile} onChange={(event) => setSilenceReapplyProfile(event.target.value as SilenceReapplyProfile)}><option value="natural">自然</option><option value="strong">強め</option><option value="youtube">YouTubeジャンプカット</option></select></label>
              <Button
                className="subtle-button"
                disabled={silenceCutReapplyBusy}
                title="現在のsourceInUs・durationUsを対象にFFmpegの無音解析を明示的に再実行"
                onClick={() => void reapplySilenceCut(silenceReapplyProfile)}
              >{silenceCutReapplyBusy ? '無音解析中…' : '無音カットを再適用'}</Button>
              {silenceCutReapplyBusy && <Button className="subtle-button" onClick={() => void cancelSilenceCutReapply()}>キャンセル</Button>}
            </div>}
          </Section>
          {hasTransform(clip) && <TransformEditor clip={clip} />}
          {hasAudio(clip) && <AudioEditor clip={clip} />}
          {clip.kind === 'subtitle' && <SubtitleEditor clip={clip} />}
        </div>
      ) : (
        <EmptyState icon={<SlidersHorizontal size={27} />} title="クリップを選択" text="タイムラインのクリップを選ぶと、映像・音声・字幕を編集できます。" />
      )}
    </aside>
  )
}
