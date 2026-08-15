import type { SubtitleClip, SubtitleEditUnit, SubtitleWord, TimeUs } from '../types'

const graphemeLength = (value: string): number => {
  try {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length
  } catch {
    return Array.from(value).length
  }
}

const segmentWord = (text: string): string[] => {
  if (!text) return []
  try {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'word' })
    const segments = [...segmenter.segment(text)].map((item) => item.segment)
    const merged: string[] = []
    for (const segment of segments) {
      if (!segment) continue
      // Keep punctuation/space with the preceding token where possible. This
      // prevents a split from creating a leading-space or punctuation-only cue.
      if (merged.length && !/\S/u.test(segment)) {
        merged[merged.length - 1] += segment
      } else if (merged.length && /^[。、，．！？!?、」』）】〉》〕］｝]/u.test(segment)) {
        merged[merged.length - 1] += segment
      } else {
        merged.push(segment)
      }
    }
    return merged.length ? merged : [text]
  } catch {
    return Array.from(text)
  }
}

const proportionalBoundaries = (word: SubtitleWord, unitTexts: string[]): TimeUs[] => {
  const duration = Math.max(0, word.endUs - word.startUs)
  const weights = unitTexts.map((text) => Math.max(1, graphemeLength(text)))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  return weights.slice(0, -1).reduce<TimeUs[]>((boundaries, _weight, index) => {
    const previous = boundaries.at(-1) ?? word.startUs
    const cumulativeWeight = weights.slice(0, index + 1).reduce((sum, item) => sum + item, 0)
    const boundary = word.startUs + Math.round(duration * cumulativeWeight / total)
    boundaries.push(Math.max(previous, Math.min(word.endUs, boundary)))
    return boundaries
  }, [])
}

const unitFor = (word: SubtitleWord, text: string, index: number, startUs: TimeUs, endUs: TimeUs, single: boolean): SubtitleEditUnit => ({
  id: `${word.id}:edit:${index}`,
  text,
  parentSourceWordId: word.id,
  startUs,
  endUs,
  timingProvenance: startUs === endUs ? 'point' : single ? 'source' : 'estimated'
})

/**
 * Derive deterministic, text-faithful editor units from source words.
 * Only a whole source word has source timing. Sub-word timing is proportional
 * fallback metadata and must not be presented as acoustic alignment truth.
 */
export const deriveSubtitleEditUnits = (words: readonly SubtitleWord[] | undefined): SubtitleEditUnit[] | undefined => {
  if (!words?.length) return undefined
  const result: SubtitleEditUnit[] = []
  for (const word of words) {
    const texts = segmentWord(word.text)
    const boundaries = proportionalBoundaries(word, texts)
    let startUs = word.startUs
    texts.forEach((text, index) => {
      const endUs = index === texts.length - 1 ? word.endUs : boundaries[index] ?? word.startUs
      result.push(unitFor(word, text, index, startUs, endUs, texts.length === 1))
      startUs = endUs
    })
  }
  return result
}

const textMatches = (clip: SubtitleClip, units: readonly SubtitleEditUnit[]): boolean => units.map((unit) => unit.text).join('') === clip.text

const unitsAreValid = (clip: SubtitleClip, units: readonly SubtitleEditUnit[]): boolean => {
  if (!units.length || !textMatches(clip, units)) return false
  const ids = new Set<string>()
  let previousEndUs = clip.startUs
  for (const unit of units) {
    if (ids.has(unit.id) || !unit.parentSourceWordId || !Number.isFinite(unit.startUs) || !Number.isFinite(unit.endUs) || unit.startUs < clip.startUs || unit.endUs < unit.startUs || unit.endUs > clip.startUs + clip.durationUs || unit.startUs < previousEndUs) return false
    if (unit.timingProvenance !== 'source' && unit.timingProvenance !== 'estimated' && unit.timingProvenance !== 'point') return false
    ids.add(unit.id)
    previousEndUs = unit.endUs
  }
  return true
}

/** Existing projects may have only contract/source words; derive lazily. */
export const subtitleEditUnits = (clip: SubtitleClip): SubtitleEditUnit[] | undefined => {
  if (clip.editUnits && unitsAreValid(clip, clip.editUnits)) return clip.editUnits.map((unit) => ({ ...unit }))
  // Legacy .spectra projects expose only source words. Keep those words as
  // atomic editor units until a project is explicitly migrated/imported; this
  // preserves old boundary indices and malformed-metadata diagnostics.
  return clip.words?.map((word) => ({
    id: `${word.id}:edit:0`,
    text: word.text,
    parentSourceWordId: word.id,
    startUs: word.startUs,
    endUs: word.endUs,
    timingProvenance: word.startUs === word.endUs ? 'point' : 'source'
  }))
}

export const subtitleEditUnitsMatchText = (clip: SubtitleClip): boolean => {
  const units = subtitleEditUnits(clip)
  return Boolean(units && textMatches(clip, units))
}

export const subtitleEditUnitBoundaryIsSourceWordBoundary = (left: SubtitleEditUnit, right: SubtitleEditUnit): boolean => left.parentSourceWordId !== right.parentSourceWordId

export const sourceWordIdsForEditUnits = (units: readonly SubtitleEditUnit[]): string[] => [...new Set(units.map((unit) => unit.parentSourceWordId))]
