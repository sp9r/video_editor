import { mapAutoCaptionSourceTimeToTimelineUs, type AutoCaptionBaseline } from './auto-caption-contract.js'
import type { ProjectFile, SubtitleClip, SubtitleEditUnit, SubtitleStyle, TimelineTrack } from './types.js'

export const FULL_CORRECTION_VERSION = 'experimental.full-correction.v1' as const

export type FullCorrectionType = 'unchanged' | 'split' | 'merge' | 'boundary_move' | 'text_edit' | 'delete' | 'timing_edit' | 'mixed'

export interface FullCorrectionWordSnapshot {
  id: string
  text: string
  startUs: number
  endUs: number
}

export interface FullCorrectionEditUnitSnapshot {
  id: string
  text: string
  parentSourceWordId: string
  startUs: number
  endUs: number
  timingProvenance: SubtitleEditUnit['timingProvenance']
}

export interface FullCorrectionCaptionSnapshot {
  id: string
  name: string
  text: string
  startUs: number
  durationUs: number
  sourceInUs: number
  enabled: boolean
  sourceCaptionId?: string
  sourceJobId?: string
  maxLines?: number
  style?: SubtitleStyle
  words?: FullCorrectionWordSnapshot[]
  editUnits?: FullCorrectionEditUnitSnapshot[]
  wordsMatchText: boolean
}

export interface FullCorrectionTrackSnapshot {
  trackId: string
  trackName: string
  captions: FullCorrectionCaptionSnapshot[]
}

export interface FullCorrectionDerivedCorrection {
  correctionId: string
  type: FullCorrectionType
  beforeCaptionIds: string[]
  afterCaptionIds: string[]
  sourceWordIds: string[]
  sourceEditUnitIds: string[]
  details?: string
}

export interface FullCorrectionStatistics {
  beforeCaptionCount: number
  afterCaptionCount: number
  unchanged: number
  split: number
  merge: number
  move: number
  text: number
  timing: number
  delete: number
  mixed: number
}

export interface FullCorrectionEligibility {
  eligible: boolean
  wordsAvailable: boolean
  sourceIdentityAvailable: boolean
  reason?: string
}

export interface FullCorrectionSession {
  version: typeof FULL_CORRECTION_VERSION
  status: 'active' | 'finished'
  sessionId: string
  projectId: string
  projectFingerprint: string
  autoCaptionJobId: string
  track: { id: string; name: string }
  before: FullCorrectionTrackSnapshot
  after?: FullCorrectionTrackSnapshot
  derivedCorrections?: FullCorrectionDerivedCorrection[]
  eligibility: FullCorrectionEligibility
  statistics: FullCorrectionStatistics
  createdAt: string
  finishedAt?: string
}

const clone = <T>(value: T): T => structuredClone(value)

const clipSnapshots = (track: TimelineTrack): FullCorrectionCaptionSnapshot[] => track.clips
  .filter((clip): clip is SubtitleClip => clip.kind === 'subtitle')
  .map((clip) => ({
    id: clip.id,
    name: clip.name,
    text: clip.text,
    startUs: clip.startUs,
    durationUs: clip.durationUs,
    sourceInUs: clip.sourceInUs,
    enabled: clip.enabled,
    ...(clip.sourceCaptionId ? { sourceCaptionId: clip.sourceCaptionId } : {}),
    ...(clip.sourceJobId ? { sourceJobId: clip.sourceJobId } : {}),
    ...(clip.maxLines === undefined ? {} : { maxLines: clip.maxLines }),
    style: clone(clip.style),
    ...(clip.words ? { words: clip.words.map((word) => clone(word)) } : {}),
    ...(clip.editUnits ? { editUnits: clip.editUnits.map((unit) => clone(unit)) } : {}),
    wordsMatchText: Boolean(clip.words?.length) && (clip.words ?? []).map((word) => word.text).join('') === clip.text
  }))
  .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))

export const captureFullCorrectionTrack = (project: ProjectFile, trackId: string): FullCorrectionTrackSnapshot => {
  const track = project.tracks.find((candidate) => candidate.id === trackId && candidate.kind === 'subtitle')
  if (!track) throw new Error('字幕トラックが見つかりません。')
  return { trackId: track.id, trackName: track.name, captions: clipSnapshots(track) }
}

const sourceWordsForCaption = (baseline: AutoCaptionBaseline, sourceWordIds: string[]): FullCorrectionWordSnapshot[] | undefined => {
  const words = new Map(baseline.rawWords.map((word) => [word.id, word]))
  const result = sourceWordIds.map((id) => words.get(id)).filter((word): word is NonNullable<typeof word> => Boolean(word)).map((word) => ({
    id: word.id,
    text: word.text,
    startUs: mapAutoCaptionSourceTimeToTimelineUs(baseline.sourceClip, word.startUs),
    endUs: mapAutoCaptionSourceTimeToTimelineUs(baseline.sourceClip, word.endUs)
  }))
  return result.length === sourceWordIds.length ? result : undefined
}

const matchingGeneratedClip = (track: TimelineTrack, sourceCaptionId: string): SubtitleClip | undefined => track.clips
  .filter((clip): clip is SubtitleClip => clip.kind === 'subtitle' && clip.sourceCaptionId === sourceCaptionId)
  .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))[0]

/** Reconstructs the immutable before snapshot from the worker baseline, never from edited text. */
export const captureFullCorrectionBaseline = (baseline: AutoCaptionBaseline, track: TimelineTrack): FullCorrectionTrackSnapshot => ({
  trackId: track.id,
  trackName: track.name,
  captions: baseline.captions.map((caption) => {
    const generated = matchingGeneratedClip(track, caption.id)
    const startUs = mapAutoCaptionSourceTimeToTimelineUs(baseline.sourceClip, caption.startUs)
    const endUs = mapAutoCaptionSourceTimeToTimelineUs(baseline.sourceClip, caption.endUs)
    const words = sourceWordsForCaption(baseline, caption.sourceWordIds)
    return {
      id: generated?.id ?? `${baseline.jobId}:baseline:${caption.id}`,
      name: generated?.name ?? caption.text.slice(0, 40),
      text: caption.text,
      startUs,
      durationUs: endUs - startUs,
      sourceInUs: generated?.sourceInUs ?? 0,
      enabled: generated?.enabled ?? true,
      ...(generated?.sourceCaptionId ? { sourceCaptionId: generated.sourceCaptionId } : { sourceCaptionId: caption.id }),
      sourceJobId: baseline.jobId,
      ...(generated?.maxLines === undefined ? {} : { maxLines: generated.maxLines }),
      ...(generated?.style ? { style: clone(generated.style) } : {}),
      ...(words ? { words } : {}),
      ...(generated?.editUnits ? { editUnits: generated.editUnits.map((unit) => clone(unit)) } : {}),
      wordsMatchText: Boolean(words?.length) && words!.map((word) => word.text).join('') === caption.text
    }
  }).sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id))
})

const sourceWordIds = (caption: FullCorrectionCaptionSnapshot): string[] => caption.words?.map((word) => word.id) ?? []
const sourceEditUnitIds = (caption: FullCorrectionCaptionSnapshot): string[] => caption.editUnits?.map((unit) => unit.id) ?? []
const shared = (left: string[], right: string[]): string[] => left.filter((id) => right.includes(id))
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
const textOf = (captions: FullCorrectionCaptionSnapshot[]): string => captions.map((caption) => caption.text).join('')

const connectedComponents = (before: FullCorrectionCaptionSnapshot[], after: FullCorrectionCaptionSnapshot[]): Array<{ before: FullCorrectionCaptionSnapshot[]; after: FullCorrectionCaptionSnapshot[] }> => {
  const links = new Map<string, Set<string>>()
  const addLink = (left: string, right: string): void => {
    const leftKey = `b:${left}`
    const rightKey = `a:${right}`
    if (!links.has(leftKey)) links.set(leftKey, new Set())
    if (!links.has(rightKey)) links.set(rightKey, new Set())
    links.get(leftKey)!.add(rightKey)
    links.get(rightKey)!.add(leftKey)
  }
  for (const left of before) {
    for (const right of after) {
      const wordMatch = shared(sourceWordIds(left), sourceWordIds(right)).length > 0
      const lineageMatch = Boolean(left.sourceCaptionId && right.sourceCaptionId && left.sourceCaptionId === right.sourceCaptionId)
      const idMatch = left.id === right.id
      if (wordMatch || lineageMatch || idMatch) addLink(left.id, right.id)
    }
  }
  const visited = new Set<string>()
  const components: Array<{ before: FullCorrectionCaptionSnapshot[]; after: FullCorrectionCaptionSnapshot[] }> = []
  const byBefore = new Map(before.map((caption) => [caption.id, caption]))
  const byAfter = new Map(after.map((caption) => [caption.id, caption]))
  const visit = (node: string, left: Set<string>, right: Set<string>): void => {
    if (visited.has(node)) return
    visited.add(node)
    if (node.startsWith('b:')) left.add(node.slice(2))
    else right.add(node.slice(2))
    for (const next of links.get(node) ?? []) visit(next, left, right)
  }
  for (const caption of before) {
    if (!links.has(`b:${caption.id}`)) components.push({ before: [caption], after: [] })
  }
  for (const caption of after) {
    if (!links.has(`a:${caption.id}`)) components.push({ before: [], after: [caption] })
  }
  for (const node of links.keys()) {
    if (visited.has(node)) continue
    const left = new Set<string>()
    const right = new Set<string>()
    visit(node, left, right)
    components.push({
      before: [...left].map((id) => byBefore.get(id)).filter((caption): caption is FullCorrectionCaptionSnapshot => Boolean(caption)),
      after: [...right].map((id) => byAfter.get(id)).filter((caption): caption is FullCorrectionCaptionSnapshot => Boolean(caption))
    })
  }
  return components.sort((left, right) => (left.before[0]?.startUs ?? left.after[0]?.startUs ?? 0) - (right.before[0]?.startUs ?? right.after[0]?.startUs ?? 0))
}

const ownershipChanged = (before: FullCorrectionCaptionSnapshot[], after: FullCorrectionCaptionSnapshot[]): boolean => {
  const beforeOwner = new Map<string, string>()
  const afterOwner = new Map<string, string>()
  before.forEach((caption) => sourceWordIds(caption).forEach((id) => beforeOwner.set(id, caption.id)))
  after.forEach((caption) => sourceWordIds(caption).forEach((id) => afterOwner.set(id, caption.id)))
  const ids = [...beforeOwner.keys()].filter((id) => afterOwner.has(id))
  return ids.length > 0 && ids.some((id) => beforeOwner.get(id) !== afterOwner.get(id))
}

const timingChanged = (before: FullCorrectionCaptionSnapshot[], after: FullCorrectionCaptionSnapshot[]): boolean => {
  const afterByLineage = new Map(after.map((caption) => [caption.sourceCaptionId ?? caption.id, caption]))
  return before.some((caption) => {
    const right = afterByLineage.get(caption.sourceCaptionId ?? caption.id)
    return Boolean(right && (caption.startUs !== right.startUs || caption.durationUs !== right.durationUs || caption.sourceInUs !== right.sourceInUs))
  }) || before.flatMap((caption) => caption.words ?? []).some((word) => {
    const right = after.flatMap((caption) => caption.words ?? []).find((candidate) => candidate.id === word.id)
    return Boolean(right && (right.startUs !== word.startUs || right.endUs !== word.endUs))
  })
}

export const deriveFullCorrectionDiff = (before: FullCorrectionTrackSnapshot, after: FullCorrectionTrackSnapshot): { derivedCorrections: FullCorrectionDerivedCorrection[]; statistics: FullCorrectionStatistics; eligibility: FullCorrectionEligibility } => {
  const components = connectedComponents(before.captions, after.captions)
  const derivedCorrections: FullCorrectionDerivedCorrection[] = components.map((component, index) => {
    const types: FullCorrectionType[] = []
    if (component.before.length === 0) types.push('mixed')
    else if (component.after.length === 0) types.push('delete')
    else {
      if (component.before.length === 1 && component.after.length > 1) types.push('split')
      if (component.before.length > 1 && component.after.length === 1) types.push('merge')
      if (component.before.length === component.after.length && ownershipChanged(component.before, component.after)) types.push('boundary_move')
      if (textOf(component.before) !== textOf(component.after)) types.push('text_edit')
      if (timingChanged(component.before, component.after) && !types.some((type) => type === 'split' || type === 'merge' || type === 'boundary_move')) types.push('timing_edit')
      if (!types.length && component.before.length === 1 && component.after.length === 1 && same(component.before[0], component.after[0])) types.push('unchanged')
      if (!types.length) types.push('mixed')
    }
    const type = types.length === 1 ? types[0]! : 'mixed'
    return {
      correctionId: `correction-${index + 1}`,
      type,
      beforeCaptionIds: component.before.map((caption) => caption.id),
      afterCaptionIds: component.after.map((caption) => caption.id),
      sourceWordIds: [...new Set([...component.before, ...component.after].flatMap(sourceWordIds))],
      sourceEditUnitIds: [...new Set([...component.before, ...component.after].flatMap(sourceEditUnitIds))],
      ...(types.length > 1 ? { details: types.join(',') } : {})
    }
  })
  const statistics: FullCorrectionStatistics = {
    beforeCaptionCount: before.captions.length,
    afterCaptionCount: after.captions.length,
    unchanged: derivedCorrections.filter((item) => item.type === 'unchanged').length,
    split: derivedCorrections.filter((item) => item.type === 'split').length,
    merge: derivedCorrections.filter((item) => item.type === 'merge').length,
    move: derivedCorrections.filter((item) => item.type === 'boundary_move').length,
    text: derivedCorrections.filter((item) => item.type === 'text_edit').length,
    timing: derivedCorrections.filter((item) => item.type === 'timing_edit').length,
    delete: derivedCorrections.filter((item) => item.type === 'delete').length,
    mixed: derivedCorrections.filter((item) => item.type === 'mixed').length
  }
  const wordsAvailable = before.captions.some((caption) => caption.words?.length) || after.captions.some((caption) => caption.words?.length)
  const sourceIdentityAvailable = [...before.captions, ...after.captions].some((caption) => Boolean(caption.sourceCaptionId || caption.words?.length || caption.editUnits?.length))
  return {
    derivedCorrections,
    statistics,
    eligibility: {
      eligible: before.trackId === after.trackId && sourceIdentityAvailable,
      wordsAvailable,
      sourceIdentityAvailable,
      ...(!sourceIdentityAvailable ? { reason: 'source caption/word/editUnit identity is unavailable' } : {})
    }
  }
}

export const fullCorrectionProjectFingerprint = (project: ProjectFile): string => {
  const copy = clone(project)
  copy.updatedAt = ''
  delete copy.projectPath
  delete copy.projectFormat
  copy.media = copy.media.map((asset) => {
    const { path: assetPath, relativePath: assetRelativePath, ...safe } = asset
    void assetPath
    void assetRelativePath
    return safe as typeof asset
  })
  return JSON.stringify(copy)
}
