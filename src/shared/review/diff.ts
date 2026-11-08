import type { CorrectionSummary, CorrectionType, ReviewCaptionSnapshot, ReviewNeighborhoodSnapshot } from './types'

const byId = (captions: ReviewCaptionSnapshot[]): Map<string, ReviewCaptionSnapshot> => new Map(captions.map((caption) => [caption.id, caption]))
const words = (caption: ReviewCaptionSnapshot): string[] => caption.words?.map((word) => word.id) ?? []
const text = (captions: ReviewCaptionSnapshot[]): string => captions.map((caption) => caption.text).join('')

const relevant = (snapshot: ReviewNeighborhoodSnapshot): ReviewCaptionSnapshot[] => {
  const ids = new Set(snapshot.targetCaptionIds)
  const wordIds = new Set(snapshot.targetWordIds)
  return snapshot.captions.filter((caption) => ids.has(caption.id) || caption.words?.some((word) => wordIds.has(word.id)))
}

const hasWords = (captions: ReviewCaptionSnapshot[]): boolean => captions.length > 0 && captions.every((caption) => Boolean(caption.words?.length) && caption.wordsMatchText)

const sameWordOwnership = (left: ReviewCaptionSnapshot[], right: ReviewCaptionSnapshot[]): boolean => {
  const leftOwners = new Map<string, number>()
  const rightOwners = new Map<string, number>()
  left.forEach((caption, index) => words(caption).forEach((wordId) => leftOwners.set(wordId, index)))
  right.forEach((caption, index) => words(caption).forEach((wordId) => rightOwners.set(wordId, index)))
  const ids = [...leftOwners.keys()].filter((id) => rightOwners.has(id))
  return ids.length > 0 && ids.every((id) => leftOwners.get(id) === rightOwners.get(id))
}

export const deriveCorrectionSummary = (baseline: ReviewNeighborhoodSnapshot, final: ReviewNeighborhoodSnapshot): CorrectionSummary => {
  const before = relevant(baseline)
  const after = relevant(final)
  const beforeById = byId(before)
  const afterById = byId(after)
  const changedCaptionIds = [...new Set([...before.map((caption) => caption.id), ...after.map((caption) => caption.id)].filter((id) => {
    const left = beforeById.get(id)
    const right = afterById.get(id)
    return !left || !right || JSON.stringify(left) !== JSON.stringify(right)
  }))]
  const changedWordIds = [...new Set([...before, ...after].flatMap((caption) => words(caption)))].filter((id) => {
    const left = before.flatMap((caption) => caption.words ?? []).find((word) => word.id === id)
    const right = after.flatMap((caption) => caption.words ?? []).find((word) => word.id === id)
    return JSON.stringify(left) !== JSON.stringify(right)
  })
  if (!before.length && !after.length) return { primary: 'none', types: ['none'], changedCaptionIds, changedWordIds }
  const types: CorrectionType[] = []
  if (before.length > 0 && after.length === 0) types.push('delete')
  if (before.length === 1 && after.length > 1) types.push('boundary_split')
  if (before.length > 1 && after.length === 1) types.push('boundary_merge')
  const baselineTargetText = text(before)
  const baselineNeighborText = baseline.captions.filter((caption) => !baseline.targetCaptionIds.includes(caption.id)).map((caption) => caption.text)
  const structuralMergeDetected = before.length === 1 && after.length === 1 && baselineNeighborText.some((neighbor) => neighbor && text(after).includes(`${baselineTargetText}${neighbor}`) || neighbor && text(after).includes(`${neighbor}${baselineTargetText}`))
  if (structuralMergeDetected) {
    types.push('boundary_merge')
  }
  if (before.length === after.length && before.length > 0 && !sameWordOwnership(before, after) && text(before) === text(after)) types.push('boundary_move')
  const mergeTextIsStructural = types.includes('boundary_merge') && baselineNeighborText.some((neighbor) => text(after) === `${baselineTargetText}${neighbor}` || text(after) === `${neighbor}${baselineTargetText}`)
  if (text(before) !== text(after) && !mergeTextIsStructural && !types.includes('delete')) types.push('text_edit')
  const timingChanged = before.some((caption) => {
    const right = afterById.get(caption.id)
    return right && (caption.startUs !== right.startUs || caption.durationUs !== right.durationUs || caption.sourceInUs !== right.sourceInUs)
  }) || changedWordIds.some((wordId) => {
    const left = before.flatMap((caption) => caption.words ?? []).find((word) => word.id === wordId)
    const right = after.flatMap((caption) => caption.words ?? []).find((word) => word.id === wordId)
    return left?.startUs !== right?.startUs || left?.endUs !== right?.endUs
  })
  if (timingChanged && !types.includes('boundary_split') && !types.includes('boundary_merge') && !types.includes('delete')) types.push('timing_edit')
  if (!types.length && changedCaptionIds.length === 0 && changedWordIds.length === 0) types.push('none')
  const primary: CorrectionType = types.length === 1 ? (types[0] ?? 'none') : 'mixed'
  return { primary, types, changedCaptionIds, changedWordIds }
}

export const deriveReviewEligibility = (baseline: ReviewNeighborhoodSnapshot, final: ReviewNeighborhoodSnapshot): Pick<CorrectionSummary, never> & { boundaryLearningEligible: boolean; textLearningEligible: boolean } => {
  const before = relevant(baseline)
  const after = relevant(final)
  const boundaryLearningEligible = hasWords(before) && hasWords(after) && before.length > 0 && after.length > 0
  const textLearningEligible = before.length > 0 && after.length > 0 && before.every((caption) => typeof caption.text === 'string') && after.every((caption) => typeof caption.text === 'string')
  return { boundaryLearningEligible, textLearningEligible }
}
