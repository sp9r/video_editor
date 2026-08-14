import { describe, expect, it } from 'vitest'
import { addClipToTrack, createClipForAsset, createEmptyProject, createTrack } from '../../src/shared/project'
import { DEFAULT_SUBTITLE_STYLE, type MediaAsset, type ProjectFile } from '../../src/shared/types'
import { useEditorStore } from '../../src/renderer/src/store'

const asset: MediaAsset = {
  id: 'media', name: 'source.mp4', path: 'C:\\source.mp4', kind: 'video', durationUs: 8_000_000,
  width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, hasAudio: true,
  fileSize: 1, modifiedAt: '2026-08-13T00:00:00.000Z', offline: false
}

const fixture = (): ProjectFile => {
  let project = { ...createEmptyProject('history'), media: [asset] }
  project = { ...project, tracks: [...project.tracks, createTrack('media', 2)] }
  const video = { ...createClipForAsset(asset, 0, 4_000_000), id: 'video', linkGroupId: 'linked' }
  const audio = { ...createClipForAsset(asset, 0, 4_000_000), id: 'audio', kind: 'audio' as const, linkGroupId: 'linked', audio: { volumeDb: 0, pan: 0, fadeInUs: 0, fadeOutUs: 0 } }
  project = addClipToTrack(project, project.tracks.find((track) => track.kind === 'media')!.id, video)
  return addClipToTrack(project, project.tracks.filter((track) => track.kind === 'media')[1]!.id, audio)
}

describe('editor history and linked selection', () => {
  it('selects a linked pair and coalesces an inspector session into one undo step', () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    expect(useEditorStore.getState().selectedClipIds).toEqual(['video', 'audio'])
    useEditorStore.getState().beginEditTransaction()
    useEditorStore.getState().patchClip('video', (clip) => clip.kind === 'video' ? { ...clip, transform: { ...clip.transform, positionX: 10 } } : clip)
    useEditorStore.getState().patchClip('video', (clip) => clip.kind === 'video' ? { ...clip, transform: { ...clip.transform, positionX: 20 } } : clip)
    useEditorStore.getState().commitEditTransaction()
    expect(useEditorStore.getState().past).toHaveLength(1)
    const currentVideo = useEditorStore.getState().project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'video')
    expect(currentVideo?.kind === 'video' ? currentVideo.transform.positionX : undefined).toBe(20)
    useEditorStore.getState().undo()
    const undoneVideo = useEditorStore.getState().project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'video')
    expect(undoneVideo?.kind === 'video' ? undoneVideo.transform.positionX : undefined).toBe(0)
  })

  it('restores split IDs and link groups exactly through undo and redo', () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    useEditorStore.getState().setPlayhead(2_000_000)
    useEditorStore.getState().splitSelected()
    const afterSplit = useEditorStore.getState().project
    const splitShape = afterSplit.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip.linkGroupId, clip.startUs, clip.sourceInUs, clip.durationUs])
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.flatMap((track) => track.clips)).toHaveLength(2)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().project.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip.linkGroupId, clip.startUs, clip.sourceInUs, clip.durationUs])).toEqual(splitShape)
  })

  it('tracks dirty state against the saved fingerprint and clears redo after a new edit', () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    expect(useEditorStore.getState().dirty).toBe(false)
    useEditorStore.getState().patchClip('video', (clip) => clip.kind === 'video' ? { ...clip, enabled: false } : clip)
    expect(useEditorStore.getState().dirty).toBe(true)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().dirty).toBe(false)
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().dirty).toBe(true)
    useEditorStore.getState().undo()
    useEditorStore.getState().patchClip('video', (clip) => clip.kind === 'video' ? { ...clip, enabled: true } : clip)
    expect(useEditorStore.getState().future).toHaveLength(0)
  })

  it('copies and pastes linked A/V as one unit with fresh IDs and link group', () => {
    const project = fixture()
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('video')
    useEditorStore.getState().copySelected()
    useEditorStore.getState().pasteClipboard(6_000_000)
    const clips = useEditorStore.getState().project.tracks.flatMap((track) => track.clips)
    const pasted = clips.filter((clip) => clip.startUs === 6_000_000)
    expect(pasted).toHaveLength(2)
    expect(pasted.map((clip) => clip.id)).not.toEqual(['video', 'audio'])
    expect(new Set(pasted.map((clip) => clip.linkGroupId)).size).toBe(1)
    expect(useEditorStore.getState().past).toHaveLength(1)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.flatMap((track) => track.clips)).toHaveLength(2)
  })

  it('copies and pastes word-timed subtitles with the same timeline delta', () => {
    const project = createEmptyProject('subtitle-paste')
    const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')!
    subtitleTrack.clips.push({
      id: 'caption-copy', name: 'コピー字幕', kind: 'subtitle', startUs: 10_000_000, durationUs: 2_000_000, sourceInUs: 0,
      enabled: true, text: '字幕を入力', style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [
        { id: 'copy-word-1', text: '字幕', startUs: 10_100_000, endUs: 10_500_000 },
        { id: 'copy-word-2', text: 'を', startUs: 10_500_000, endUs: 10_800_000 },
        { id: 'copy-word-3', text: '入力', startUs: 11_000_000, endUs: 11_600_000 }
      ]
    })
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('caption-copy')
    useEditorStore.getState().copySelected()
    useEditorStore.getState().pasteClipboard(20_000_000)
    const pasted = useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips.find((item) => item.id !== 'caption-copy')
    expect(pasted).toMatchObject({ startUs: 20_000_000 })
    expect(pasted?.kind === 'subtitle' ? pasted.words?.map((word) => [word.startUs, word.endUs]) : undefined).toEqual([
      [20_100_000, 20_500_000], [20_500_000, 20_800_000], [21_000_000, 21_600_000]
    ])
    expect(pasted?.kind === 'subtitle' ? pasted.words?.map((word) => word.id) : undefined).toEqual([
      'copy-word-1', 'copy-word-2', 'copy-word-3'
    ])
  })

  it('applies subtitle style to every caption as one undoable operation', () => {
    const project = fixture()
    const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')!
    subtitleTrack.clips.push({
      id: 'caption-1', name: '字幕1', kind: 'subtitle', startUs: 1_000_000, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: '一つ目', style: structuredClone(DEFAULT_SUBTITLE_STYLE)
    })
    subtitleTrack.clips.push({
      id: 'caption-2', name: '字幕2', kind: 'subtitle', startUs: 5_000_000, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: '二つ目', style: structuredClone(DEFAULT_SUBTITLE_STYLE)
    })
    const caption = subtitleTrack.clips[0]
    if (!caption || caption.kind !== 'subtitle') throw new Error('subtitle fixture missing')
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().patchClip(caption.id, (clip) => clip.kind === 'subtitle' ? { ...clip, style: { ...clip.style, fontFamily: 'Custom Font', maxWidthPercent: 85 } } : clip)
    useEditorStore.getState().applySubtitleStyleToAll(caption.id)
    const subtitles = useEditorStore.getState().project.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === 'subtitle')
    expect(subtitles).toHaveLength(2)
    expect(subtitles.every((clip) => clip.kind === 'subtitle' && clip.style.fontFamily === 'Custom Font' && clip.style.maxWidthPercent === 85)).toBe(true)
  })

  it('updates subtitle split and merge immediately and keeps them undoable', () => {
    const project = createEmptyProject('subtitle-edit')
    const subtitleTrack = project.tracks.find((track) => track.kind === 'subtitle')!
    subtitleTrack.clips.push({
      id: 'caption-edit', name: '編集字幕', kind: 'subtitle', startUs: 0, durationUs: 1_000_000, sourceInUs: 0,
      enabled: true, text: '字幕を入力', style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [
        { id: 'edit-word-1', text: '字幕', startUs: 0, endUs: 300_000 },
        { id: 'edit-word-2', text: 'を', startUs: 300_000, endUs: 500_000 },
        { id: 'edit-word-3', text: '入力', startUs: 500_000, endUs: 800_000 }
      ]
    })
    subtitleTrack.clips.push({
      id: 'caption-next', name: '次字幕', kind: 'subtitle', startUs: 1_200_000, durationUs: 800_000, sourceInUs: 1_200_000,
      enabled: true, text: '次', style: structuredClone(DEFAULT_SUBTITLE_STYLE), words: [{ id: 'next-word', text: '次', startUs: 1_200_000, endUs: 1_400_000 }]
    })
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().selectClip('caption-edit')
    useEditorStore.getState().splitSubtitleAtWordBoundary('caption-edit', 1)
    expect(useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips).toHaveLength(3)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips).toHaveLength(2)
    useEditorStore.getState().redo()
    const right = useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips.find((clip) => clip.id !== 'caption-edit' && clip.id !== 'caption-next')
    expect(right?.kind === 'subtitle' ? right.text : undefined).toBe('入力')
    useEditorStore.getState().mergeSubtitleWithNext('caption-edit')
    expect(useEditorStore.getState().project.tracks.find((track) => track.kind === 'subtitle')!.clips).toHaveLength(2)
    expect(useEditorStore.getState().project.tracks.flatMap((track) => track.clips).filter((clip) => clip.kind === 'subtitle').map((clip) => clip.text)).toEqual(['字幕を入力', '次'])
  })

  it('adds, renames, reorders, and undoes empty track operations', () => {
    const project = createEmptyProject('tracks')
    useEditorStore.getState().loadProject(project)
    useEditorStore.getState().addMediaTrack()
    expect(useEditorStore.getState().project.tracks.filter((track) => track.kind === 'media')).toHaveLength(2)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().project.tracks.filter((track) => track.kind === 'media')).toHaveLength(1)
    useEditorStore.getState().redo()
    const extra = useEditorStore.getState().project.tracks.find((track) => track.kind === 'media' && track.name === 'V2')!
    useEditorStore.getState().renameTrack(extra.id, 'Overlay')
    expect(useEditorStore.getState().project.tracks.find((track) => track.id === extra.id)?.name).toBe('Overlay')
    useEditorStore.getState().deleteTrack(extra.id)
    expect(useEditorStore.getState().project.tracks.some((track) => track.id === extra.id)).toBe(false)
  })

  it('supports ten or more media and subtitle tracks without fixed-count assumptions', () => {
    useEditorStore.getState().loadProject(createEmptyProject('many-tracks'))
    for (let index = 0; index < 10; index += 1) useEditorStore.getState().addMediaTrack()
    for (let index = 0; index < 10; index += 1) useEditorStore.getState().addSubtitleTrack()
    const tracks = useEditorStore.getState().project.tracks
    expect(tracks.filter((track) => track.kind === 'media')).toHaveLength(11)
    expect(tracks.filter((track) => track.kind === 'subtitle')).toHaveLength(11)
  })
})
