import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  AudioLines,
  FileImage,
  Film,
  FolderOpen,
  Grid2X2,
  List,
  Plus,
  Search,
  Video
} from 'lucide-react'
import { makeId } from '../../../shared/project'
import { isMediaTrack, type MediaAsset, type ProbeResult } from '../../../shared/types'
import { useEditorStore } from '../store'
import { mediaAddControlState } from '../action-state'
import { EmptyState, IconButton } from './Controls'

const toAsset = (probe: ProbeResult): MediaAsset => ({
  ...probe,
  id: makeId('asset'),
  offline: Boolean(probe.error)
})

const formatDuration = (durationUs: number): string => {
  if (!durationUs) return '静止画'
  const seconds = Math.floor(durationUs / 1_000_000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

const kindLabel = (kind: MediaAsset['kind']): string => ({ video: '映像', audio: '音声', image: '画像' })[kind]

export default function MediaBin(): React.JSX.Element {
  const { project, selectedAssetId, selectAsset, addAssets, addAssetClip, playheadUs, relinkAsset, showNotice } = useEditorStore()
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [dragActive, setDragActive] = useState(false)
  const filtered = useMemo(
    () => project.media.filter((asset) => asset.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    [project.media, query]
  )

  const importMedia = async (): Promise<void> => {
    if (!window.spectra) {
      showNotice('デモ表示です。デスクトップ版ではここから動画・音声・画像を選べます。')
      return
    }
    try {
      const results = await window.spectra.pickMedia()
      const valid = results.filter((item) => !item.error).map(toAsset)
      if (valid.length) addAssets(valid)
      const failures = results.length - valid.length
      showNotice(`${valid.length}件の素材を読み込みました${failures ? `（${failures}件失敗）` : ''}。`, failures ? 'warning' : 'success')
    } catch (error) {
      showNotice(`素材を読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const dropFiles = async (files: FileList): Promise<void> => {
    setDragActive(false)
    if (!window.spectra) {
      showNotice(`${files.length}件を受け取りました。ブラウザデモでは実ファイルを読み込まず、画面操作だけ確認できます。`)
      return
    }
    try {
      const paths = Array.from(files).map((file) => window.spectra!.getPathForFile(file)).filter(Boolean)
      const results = await window.spectra.probeMedia(paths)
      const valid = results.filter((item) => !item.error).map(toAsset)
      addAssets(valid)
      showNotice(`${valid.length}件の素材を読み込みました。`, valid.length ? 'success' : 'warning')
    } catch (error) {
      showNotice(`ドロップした素材を読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const relink = async (asset: MediaAsset): Promise<void> => {
    if (!window.spectra) {
      showNotice('デスクトップ版では、ここから素材の場所を指定して再リンクできます。')
      return
    }
    try {
      const probe = await window.spectra.relinkMedia(asset.id, asset.name)
      if (!probe) return
      if (probe.error) {
        showNotice(`再リンク先を読み込めませんでした: ${probe.error}`, 'error')
        return
      }
      relinkAsset(asset.id, { ...toAsset(probe), id: asset.id, relativePath: undefined, offline: false })
      showNotice(`${asset.name} を再リンクしました。`, 'success')
    } catch (error) {
      showNotice(`素材を再リンクできませんでした: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  return (
    <section
      className={`panel media-bin ${dragActive ? 'is-drop-target' : ''}`}
      aria-label="メディア棚"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          setDragActive(true)
        }
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault()
          void dropFiles(event.dataTransfer.files)
        }
      }}
    >
      <header className="panel-header">
        <div>
          <span className="panel-eyebrow">PROJECT</span>
          <h2>メディア</h2>
        </div>
        <div className="panel-actions">
          <IconButton label="素材を読み込む" onClick={() => void importMedia()}><Plus size={16} /></IconButton>
        </div>
      </header>
      <div className="media-toolbar">
        <label className="search-box">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="素材を検索" aria-label="素材を検索" />
        </label>
        <div className="segmented compact">
          <IconButton label="グリッド表示" active={view === 'grid'} onClick={() => setView('grid')}><Grid2X2 size={14} /></IconButton>
          <IconButton label="リスト表示" active={view === 'list'} onClick={() => setView('list')}><List size={14} /></IconButton>
        </div>
      </div>
      <div className="bin-path"><FolderOpen size={14} /><span>すべての素材</span><span className="count-badge">{project.media.length}</span></div>
      {filtered.length ? (
        <div className={`media-items media-${view}`}>
          {filtered.map((asset, index) => (
            <article
              draggable={!asset.offline}
              key={asset.id}
              className={`media-item ${selectedAssetId === asset.id ? 'is-selected' : ''} ${asset.offline ? 'is-offline' : ''}`}
              onDragStart={(event) => {
                event.dataTransfer.setData('application/x-spectra-asset', asset.id)
                event.dataTransfer.effectAllowed = 'copy'
              }}
            >
              <button
                type="button"
                className="media-item-select"
                onClick={() => selectAsset(asset.id)}
                onDoubleClick={() => showNotice(asset.offline ? '「再リンク」で素材の場所を指定してください。' : `${asset.name} をソース表示しました。`, asset.offline ? 'warning' : 'info')}
              >
                <span className={`media-thumb media-thumb-${asset.kind} thumb-${index % 4}`}>
                  {asset.kind === 'video' && <Video size={28} />}
                  {asset.kind === 'image' && <FileImage size={28} />}
                  {asset.kind === 'audio' && <AudioLines size={30} />}
                  {asset.offline && <span className="offline-overlay"><AlertTriangle size={20} />オフライン</span>}
                  <span className="media-duration">{formatDuration(asset.durationUs)}</span>
                </span>
                <span className="media-meta">
                  <strong title={asset.name}>{asset.name}</strong>
                  <small>{kindLabel(asset.kind)}{asset.width ? ` · ${asset.width}×${asset.height}` : ''}</small>
                </span>
              </button>
              <button
                type="button"
                className="media-add-to-timeline"
                disabled={mediaAddControlState({ offline: asset.offline, hasMediaTrack: project.tracks.some(isMediaTrack) }).disabled}
                title={mediaAddControlState({ offline: asset.offline, hasMediaTrack: project.tracks.some(isMediaTrack) }).label}
                onClick={() => {
                  const track = project.tracks.find((candidate) => isMediaTrack(candidate))
                  if (track) addAssetClip(asset.id, track.id, playheadUs)
                }}
              >
                タイムラインへ追加
              </button>
              {asset.offline && <button type="button" className="relink-button" onClick={() => void relink(asset)}>再リンク</button>}
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Film size={28} />}
          title={project.media.length ? '一致する素材がありません' : '素材を追加しましょう'}
          text={project.media.length ? '検索語を変更してください。' : '動画・音声・画像をここへドロップできます。'}
          action={!project.media.length && <button type="button" className="text-button" onClick={() => void importMedia()}>ファイルを選ぶ</button>}
        />
      )}
      {dragActive && <div className="drop-overlay"><Plus size={26} /><strong>素材を読み込む</strong><span>ここへドロップ</span></div>}
    </section>
  )
}
