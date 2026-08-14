import { useEffect, useState } from 'react'
import { Captions, Image as ImageIcon, SlidersHorizontal, Volume2 } from 'lucide-react'
import type { AudioSettings, SubtitleClip, SubtitleStyle, TimelineClip, TransformSettings } from '../../../shared/types'
import { findClip, useEditorStore } from '../store'
import { Button, EmptyState, Field, NumberField, Section, SelectField } from './Controls'

const numberValue = (value: string, fallback = 0): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const FALLBACK_FONTS = ['Noto Sans JP', 'Yu Gothic UI', 'Meiryo', 'Arial', 'sans-serif']

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

function SubtitleEditor({ clip }: { clip: SubtitleClip }): React.JSX.Element {
  const { project, patchClip, selectClip, setPlayhead, splitSubtitleAtWordBoundary, mergeSubtitleWithPrevious, mergeSubtitleWithNext } = useEditorStore()
  const transaction = useEditTransaction()
  const [fontFamilies, setFontFamilies] = useState(FALLBACK_FONTS)
  useEffect(() => {
    if (!window.spectra) return
    void window.spectra.listFontFamilies().then((families) => {
      if (families.length) setFontFamilies([...new Set([...families, clip.style.fontFamily])])
    }).catch(() => undefined)
  }, [clip.style.fontFamily])
  const patchStyle = (values: Partial<SubtitleStyle>): void =>
    patchClip(clip.id, (current) => current.kind === 'subtitle' ? { ...current, style: { ...current.style, ...values } } : current)
  const captions = project.tracks
    .filter((track) => track.kind === 'subtitle')
    .flatMap((track) => track.clips.filter((item): item is SubtitleClip => item.kind === 'subtitle'))
    .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
  const captionIndex = captions.findIndex((item) => item.id === clip.id)
  const previous = captionIndex > 0 ? captions[captionIndex - 1] : undefined
  const next = captionIndex >= 0 ? captions[captionIndex + 1] : undefined
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
          <Button className="subtle-button" disabled={!previous} onClick={() => mergeSubtitleWithPrevious(clip.id)}>← 前の字幕と結合</Button>
          <Button className="subtle-button" disabled={!next} onClick={() => mergeSubtitleWithNext(clip.id)}>次の字幕と結合 →</Button>
        </div>
      </Section>
      <Section title="字幕テキスト">
        <Field label="本文" wide>
          <textarea {...transaction} value={clip.text} rows={4} onChange={(event) => patchClip(clip.id, (current) => current.kind === 'subtitle' ? { ...current, text: event.target.value } : current)} />
        </Field>
        {clip.words?.length ? (
          <Field label="単語境界" wide>
            <div className="subtitle-word-boundaries" aria-label="単語境界で分割">
              {clip.words.map((word, index) => (
                <span className="subtitle-word-boundary" key={word.id}>
                  <span className="subtitle-word-token" title={`${(word.startUs / 1_000_000).toFixed(2)}–${(word.endUs / 1_000_000).toFixed(2)}秒`}>{word.text}</span>
                  {index < clip.words!.length - 1 && <button type="button" aria-label={`「${word.text}」の後で分割`} onClick={() => splitSubtitleAtWordBoundary(clip.id, index)}>分割</button>}
                </span>
              ))}
            </div>
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
    </>
  )
}

export default function Inspector(): React.JSX.Element {
  const { project, selectedClipIds } = useEditorStore()
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
