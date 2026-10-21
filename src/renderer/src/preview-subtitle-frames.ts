import { frameIndexForTime, timeUsForFrameIndex } from '../../shared/frame-time'
import { activeSubtitleClips, subtitleAnimatedAt, subtitleVisualStateKey } from '../../shared/subtitle-render'
import type { DesktopApi, ProjectFile } from '../../shared/types'
import { LatestSubtitleOverlayScheduler } from './subtitle-overlay-scheduler'

const MAX_RUN_FRAMES = 36
const PREFETCH_HORIZON_US = 3_000_000
const MAX_UPCOMING = 3
const MAX_CACHED_IMAGES = 160
const EAGER_DECODE_FRAMES = 6
const RETRY_AFTER_MS = 1_500

export type SubtitleWork =
  | { kind: 'single'; provides: string; frameIndex: number }
  | { kind: 'base'; provides: string; frameIndex: number }
  | { kind: 'sequence'; provides: string; frameIndex: number; frameCount: number }

/**
 * Identity of the image drawn for a frame: one per visual state while a cue
 * is static, one per frame while libass animates it.
 */
export const subtitleFrameKey = (project: ProjectFile, frameIndex: number): string => {
  const timeUs = timeUsForFrameIndex(frameIndex, project.sequence.frameRate)
  const state = subtitleVisualStateKey(project, timeUs)
  return subtitleAnimatedAt(project, timeUs) ? `${state}#${frameIndex}` : state
}

const baseKey = (project: ProjectFile, frameIndex: number): string =>
  `base:${subtitleVisualStateKey(project, timeUsForFrameIndex(frameIndex, project.sequence.frameRate))}`

const hasSubtitle = (project: ProjectFile, frameIndex: number): boolean =>
  activeSubtitleClips(project, timeUsForFrameIndex(frameIndex, project.sequence.frameRate)).length > 0

const workAt = (project: ProjectFile, frameIndex: number): SubtitleWork => {
  const fps = project.sequence.frameRate
  if (!subtitleAnimatedAt(project, timeUsForFrameIndex(frameIndex, fps))) {
    return { kind: 'single', provides: subtitleFrameKey(project, frameIndex), frameIndex }
  }
  let frameCount = 1
  while (frameCount < MAX_RUN_FRAMES && subtitleAnimatedAt(project, timeUsForFrameIndex(frameIndex + frameCount, fps))) frameCount += 1
  return { kind: 'sequence', provides: subtitleFrameKey(project, frameIndex), frameIndex, frameCount }
}

/**
 * Work needed to draw `frameIndex` exactly (first item), plus what the next
 * few seconds will need so cue changes and fades never wait for FFmpeg.
 */
export const planSubtitleWork = (project: ProjectFile, frameIndex: number): SubtitleWork[] => {
  const fps = project.sequence.frameRate
  const items: SubtitleWork[] = []
  const seen = new Set<string>()
  const add = (item: SubtitleWork): void => {
    if (seen.has(item.provides)) return
    seen.add(item.provides)
    items.push(item)
  }
  if (hasSubtitle(project, frameIndex)) {
    const current = workAt(project, frameIndex)
    add(current)
    // The un-animated image of the same cue stands in until exact frames arrive.
    if (current.kind === 'sequence') add({ kind: 'base', provides: baseKey(project, frameIndex), frameIndex })
  }
  const nowUs = timeUsForFrameIndex(frameIndex, fps)
  const horizonUs = nowUs + PREFETCH_HORIZON_US
  const candidates = new Set<number>()
  for (const track of project.tracks) {
    if (track.kind !== 'subtitle' || track.hidden || track.muted) continue
    for (const clip of track.clips) {
      if (clip.kind !== 'subtitle' || !clip.enabled || clip.durationUs <= 0) continue
      const animationUs = Math.max(0, clip.style.animationDurationUs)
      for (const boundary of [clip.startUs, clip.startUs + animationUs, clip.startUs + clip.durationUs - animationUs, clip.startUs + clip.durationUs]) {
        if (boundary <= nowUs || boundary > horizonUs) continue
        // First frame at or after the boundary.
        const frame = frameIndexForTime(boundary, fps)
        candidates.add(timeUsForFrameIndex(frame, fps) >= boundary ? frame : frame + 1)
      }
    }
  }
  let upcoming = 0
  for (const frame of [...candidates].sort((left, right) => left - right)) {
    if (upcoming >= MAX_UPCOMING) break
    if (frame <= frameIndex || !hasSubtitle(project, frame)) continue
    const before = items.length
    add(workAt(project, frame))
    if (items.length > before) upcoming += 1
  }
  return items
}

type OverlayApi = Pick<DesktopApi, 'renderSubtitleOverlay' | 'renderSubtitleOverlaySequence' | 'mediaUrl'>

/**
 * Exact libass images for the preview canvas. Images are keyed by content, so
 * a late result can never be drawn for a different cue or frame; when the
 * exact image is not ready yet the previous image of the same cue (or its
 * un-animated base image) is used instead.
 */
export class PreviewSubtitleFrames {
  readonly #images = new Map<string, HTMLImageElement>()
  readonly #requestedAt = new Map<string, number>()
  readonly #scheduler = new LatestSubtitleOverlayScheduler<void>(30)
  #last: { state: string; image: HTMLImageElement } | null = null
  #generation = 0

  constructor(
    private readonly api: OverlayApi,
    private readonly onChange: () => void,
    private readonly onRequest: (key: string) => void = () => undefined,
    private readonly onOutcome: (cacheHit: boolean) => void = () => undefined
  ) {}

  /** The image to draw for this frame, and whether it is the exact one. */
  imageFor(project: ProjectFile, frameIndex: number): { image: HTMLImageElement | null; exact: boolean } {
    if (!hasSubtitle(project, frameIndex)) return { image: null, exact: true }
    const key = subtitleFrameKey(project, frameIndex)
    const exact = this.#images.get(key)
    const state = subtitleVisualStateKey(project, timeUsForFrameIndex(frameIndex, project.sequence.frameRate))
    if (exact) {
      this.#last = { state, image: exact }
      return { image: exact, exact: true }
    }
    if (this.#last?.state === state) return { image: this.#last.image, exact: false }
    return { image: this.#images.get(baseKey(project, frameIndex)) ?? null, exact: false }
  }

  /** Request whatever `frameIndex` and the next seconds still lack. */
  ensure(project: ProjectFile, frameIndex: number): void {
    const now = performance.now()
    planSubtitleWork(project, frameIndex).forEach((work, index) => {
      if (this.#images.has(work.provides)) return
      const requested = this.#requestedAt.get(work.provides)
      if (requested !== undefined && now - requested < RETRY_AFTER_MS) return
      this.#requestedAt.set(work.provides, now)
      const generation = this.#generation
      const run = async (): Promise<void> => {
        this.onRequest(work.provides)
        const timeUs = timeUsForFrameIndex(work.frameIndex, project.sequence.frameRate)
        if (work.kind === 'sequence') {
          const result = await this.api.renderSubtitleOverlaySequence(project, work.frameIndex, work.frameCount)
          this.onOutcome(!result.ffmpegStarted)
          await Promise.all(result.frames.map((frame, order) => this.#store(`${subtitleFrameKey(project, frame.frameIndex)}`, frame.framePath, order < EAGER_DECODE_FRAMES, generation)))
        } else {
          const result = await this.api.renderSubtitleOverlay(project, timeUs, { animationMode: work.kind === 'base' ? 'base' : 'full' })
          this.onOutcome(result.cacheHit ?? !result.ffmpegStarted)
          await this.#store(work.provides, result.framePath, true, generation)
        }
      }
      const request = {
        key: work.provides,
        run,
        onCommit: () => this.onChange(),
        onError: () => { this.#requestedAt.delete(work.provides) }
      }
      if (index === 0) this.#scheduler.schedule(request)
      else this.#scheduler.schedulePrefetch(request)
    })
  }

  async #store(key: string, framePath: string, decode: boolean, generation: number): Promise<void> {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.src = this.api.mediaUrl(framePath)
    await (decode ? image.decode() : new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('subtitle frame failed to load'))
    }))
    if (generation !== this.#generation) return
    this.#images.set(key, image)
    while (this.#images.size > MAX_CACHED_IMAGES) {
      const oldest = this.#images.keys().next().value
      if (oldest === undefined) break
      this.#images.delete(oldest)
    }
    // A decoded frame can arrive after the scheduler moved on; still redraw.
    this.onChange()
  }

  /** Drop everything, e.g. when the canvas module is torn down. */
  dispose(): void {
    this.#generation += 1
    this.#scheduler.dispose()
    this.#images.clear()
    this.#requestedAt.clear()
    this.#last = null
  }
}
