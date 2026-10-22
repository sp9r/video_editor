import { subtitleFrameImageIdentity, prepareSubtitleCues, type PreparedSubtitleCue } from '../../shared/subtitle-render'
import { frameTimeMs, subtitleAssWindow } from '../../shared/subtitle-timing'
import type { DesktopApi, ProjectFile } from '../../shared/types'

/** Frames of the plan nearest the playhead that are kept; the rest wait (and are re-planned on seek). */
const MAX_PLANNED_IMAGES = 1_200
const CONCURRENT_BATCHES = 2
/** Close to the playhead batches stay small so the image the viewer needs arrives first. */
const NEAR_BATCH = 6
const FAR_BATCH = 12
const NEAR_US = 3_000_000
const WARM_DECODE_US = 4_000_000
const MAX_DECODED_IMAGES = 40
const MAX_KNOWN_PATHS = 3_000
const RETRY_AFTER_MS = 1_500
const REPRIORITISE_US = 1_000_000

const PLAY_AHEAD_US = 6_000_000
const MAX_DECODES_PER_CALL = 2
const BUSY_AFTER_POINTER_MS = 300
const BUSY_AFTER_KEY_MS = 600

/** True while the user is dragging, scrubbing, scrolling or typing: background work waits. */
let busyUntil = 0
let pointerDown = false
let listening = false
const listenForInteraction = (): void => {
  if (listening || typeof window === 'undefined') return
  listening = true
  const touch = (ms: number) => (): void => { busyUntil = Math.max(busyUntil, performance.now() + ms) }
  window.addEventListener('pointerdown', () => { pointerDown = true }, { capture: true, passive: true })
  const release = (): void => { pointerDown = false; busyUntil = Math.max(busyUntil, performance.now() + BUSY_AFTER_POINTER_MS) }
  window.addEventListener('pointerup', release, { capture: true, passive: true })
  window.addEventListener('pointercancel', release, { capture: true, passive: true })
  window.addEventListener('keydown', touch(BUSY_AFTER_KEY_MS), { capture: true, passive: true })
  window.addEventListener('wheel', touch(BUSY_AFTER_POINTER_MS), { capture: true, passive: true })
}
const userBusy = (): boolean => pointerDown || performance.now() < busyUntil

export interface SubtitlePlanItem {
  /** Identity of the image (visual state plus animation phase). */
  key: string
  /** A frame that shows it; any such frame renders the same pixels. */
  frameIndex: number
}

/** Identity of the image drawn for a frame: one per visual state while a cue is static, one per phase while it animates. */
export const subtitleFrameKey = (project: ProjectFile, frameIndex: number): string =>
  subtitleFrameImageIdentity(project, frameIndex).image

/**
 * Every distinct image playback can need, in timeline order. The picture only
 * changes at a cue's first/last frame and while its intro/outro animation
 * runs, so those frames (plus the first settled frame) cover every look.
 */
export const buildSubtitlePrerenderPlan = (project: ProjectFile, prepared: readonly PreparedSubtitleCue[] = prepareSubtitleCues(project)): SubtitlePlanItem[] => {
  const fps = project.sequence.frameRate
  const frames = new Set<number>()
  for (const { clip, range, animationMs } of prepared) {
    const window = subtitleAssWindow(range, fps)
    frames.add(range.firstFrame)
    frames.add(range.endFrame)
    if (animationMs <= 0) continue
    let frame = range.firstFrame
    while (frame < range.endFrame && frameTimeMs(frame, fps) - window.startMs < animationMs) {
      frames.add(frame)
      frame += 1
    }
    // First settled frame after the intro.
    if (frame < range.endFrame) frames.add(frame)
    if (clip.style.animation === 'fade') {
      frame = range.endFrame - 1
      while (frame >= range.firstFrame && window.endMs - frameTimeMs(frame, fps) < animationMs) {
        frames.add(frame)
        frame -= 1
      }
    }
  }
  const items: SubtitlePlanItem[] = []
  const seen = new Set<string>()
  for (const frameIndex of [...frames].sort((left, right) => left - right)) {
    const identity = subtitleFrameImageIdentity(project, frameIndex, prepared)
    if (identity.cues.length === 0 || seen.has(identity.image)) continue
    seen.add(identity.image)
    items.push({ key: identity.image, frameIndex })
  }
  return items
}

type OverlayApi = Pick<DesktopApi, 'renderSubtitleFrames' | 'mediaUrl'>

interface Plan {
  project: ProjectFile
  clipLists: unknown[]
  items: SubtitlePlanItem[]
  prepared: PreparedSubtitleCue[]
}

/** Cheap structural identity of everything the plan depends on (immutable-update friendly). */
const planInputs = (project: ProjectFile): unknown[] => [
  project.sequence.width,
  project.sequence.height,
  project.sequence.frameRate.numerator,
  project.sequence.frameRate.denominator,
  ...project.tracks.flatMap((track) => track.kind === 'subtitle' ? [track.clips, track.hidden, track.muted] : [])
]

const sameInputs = (left: unknown[], right: unknown[]): boolean => left.length === right.length && left.every((value, index) => value === right[index])

/**
 * Exact libass images for the preview canvas. Every look of every cue is
 * rendered ahead of time in the background (a few FFmpeg processes, each
 * drawing a batch), nearest the playhead first, and decoded shortly before it
 * is needed. Images are keyed by content, so a late result can never be drawn
 * for a different cue; while the exact image is missing the previous image of
 * the same cue is shown instead, otherwise nothing.
 */
export class PreviewSubtitleFrames {
  readonly #paths = new Map<string, string>()
  readonly #decoded = new Map<string, { image: HTMLImageElement; frameIndex: number }>()
  readonly #decoding = new Set<string>()
  readonly #inFlight = new Set<string>()
  readonly #retryAt = new Map<string, number>()
  readonly #itemByKey = new Map<string, SubtitlePlanItem>()
  #plan: Plan | null = null
  #pending: SubtitlePlanItem[] = []
  #anchorFrame = 0
  #urgentKey: string | null = null
  #running = 0
  #last: { state: string; image: HTMLImageElement } | null = null
  #generation = 0
  #retryTimer: ReturnType<typeof setTimeout> | null = null
  #currentKey: string | null = null
  #pumpScheduled = false
  #playing = false
  #lastProject: ProjectFile | null = null

  constructor(
    private readonly api: OverlayApi,
    private readonly onChange: () => void,
    private readonly onRequest: (key: string) => void = () => undefined,
    private readonly onOutcome: (cacheHit: boolean) => void = () => undefined
  ) { listenForInteraction() }

  /** The image to draw for this frame, and whether it is the exact one. */
  imageFor(project: ProjectFile, frameIndex: number): { image: HTMLImageElement | null; exact: boolean } {
    const identity = subtitleFrameImageIdentity(project, frameIndex, this.#preparedFor(project))
    if (identity.cues.length === 0) return { image: null, exact: true }
    const exact = this.#decoded.get(identity.image)
    if (exact) {
      this.#last = { state: identity.state, image: exact.image }
      return { image: exact.image, exact: true }
    }
    const path = this.#paths.get(identity.image)
    if (path) this.#decode(identity.image, path, frameIndex)
    if (this.#last?.state === identity.state) return { image: this.#last.image, exact: false }
    return { image: null, exact: false }
  }

  /** How many of the planned images are rendered (diagnostics and smoke tests). */
  progress(): { planned: number; rendered: number } {
    const items = this.#plan?.items ?? []
    return { planned: items.length, rendered: items.filter((item) => this.#paths.has(item.key)).length }
  }

  /** Make sure `frameIndex` and everything around it is rendered or on its way. */
  ensure(project: ProjectFile, frameIndex: number, playing = false): void {
    this.#playing = playing
    this.#lastProject = project
    const plan = this.#planFor(project)
    const fps = project.sequence.frameRate
    const frameUs = (fps.denominator * 1_000_000) / fps.numerator
    const moved = Math.abs(frameIndex - this.#anchorFrame) * frameUs > REPRIORITISE_US
    if (moved || plan.rebuilt || this.#pending.length === 0) this.#anchorFrame = frameIndex
    if (moved || plan.rebuilt) this.#prioritise()
    // What the viewer needs right now goes first, even ahead of nearer-sorted work.
    const identity = subtitleFrameImageIdentity(project, frameIndex, plan.prepared)
    this.#currentKey = identity.cues.length > 0 ? identity.image : null
    if (identity.cues.length > 0 && !this.#paths.has(identity.image) && !this.#inFlight.has(identity.image)) {
      const now = performance.now()
      if ((this.#retryAt.get(identity.image) ?? 0) <= now) {
        this.#pending = this.#pending.filter((item) => item.key !== identity.image)
        this.#pending.unshift({ key: identity.image, frameIndex })
        this.#itemByKey.set(identity.image, { key: identity.image, frameIndex })
        this.#pump(project, frameUs, true)
      }
    }
    this.#pumpSoon()
    const nowPath = identity.cues.length > 0 ? this.#paths.get(identity.image) : undefined
    if (nowPath) this.#decode(identity.image, nowPath, frameIndex)
    this.#warmDecode(plan, frameIndex, frameUs)
  }

  #frameUs(project: ProjectFile): number {
    return (project.sequence.frameRate.denominator * 1_000_000) / project.sequence.frameRate.numerator
  }

  #preparedFor(project: ProjectFile): PreparedSubtitleCue[] {
    return this.#planFor(project).prepared
  }

  #planFor(project: ProjectFile): Plan & { rebuilt: boolean } {
    const inputs = planInputs(project)
    if (this.#plan && (this.#plan.project === project || sameInputs(this.#plan.clipLists, inputs))) {
      this.#plan.project = project
      return { ...this.#plan, rebuilt: false }
    }
    const prepared = prepareSubtitleCues(project)
    const items = buildSubtitlePrerenderPlan(project, prepared)
    this.#plan = { project, clipLists: inputs, items, prepared }
    this.#itemByKey.clear()
    for (const item of items) this.#itemByKey.set(item.key, item)
    this.#pending = items.filter((item) => !this.#paths.has(item.key) && !this.#inFlight.has(item.key))
    if (this.#paths.size > MAX_KNOWN_PATHS) {
      for (const key of [...this.#paths.keys()]) if (!this.#itemByKey.has(key)) this.#paths.delete(key)
    }
    return { ...this.#plan, rebuilt: true }
  }

  /** Nearest to the playhead first, looking ahead before behind; far work beyond the cap waits for a seek. */
  #prioritise(): void {
    const anchor = this.#anchorFrame
    const cost = (item: SubtitlePlanItem): number => item.frameIndex >= anchor ? item.frameIndex - anchor : (anchor - item.frameIndex) * 3
    const now = performance.now()
    this.#pending = this.#pending
      .filter((item) => !this.#paths.has(item.key) && !this.#inFlight.has(item.key) && (this.#retryAt.get(item.key) ?? 0) <= now)
      .sort((left, right) => cost(left) - cost(right))
      .slice(0, MAX_PLANNED_IMAGES)
  }

  #pump(project: ProjectFile, frameUs: number, urgent: boolean): void {
    // Other batches would only slow the image the viewer is waiting for.
    if (!urgent && this.#urgentKey !== null && this.#inFlight.has(this.#urgentKey)) return
    if (!urgent && userBusy()) { this.#pumpSoon(250); return }
    const limit = urgent ? CONCURRENT_BATCHES + 1 : CONCURRENT_BATCHES
    const horizon = this.#anchorFrame + Math.ceil(PLAY_AHEAD_US / frameUs)
    while (this.#running < limit && this.#pending.length > 0) {
      // While playing only what the next few seconds need is worth the CPU.
      if (!urgent && this.#playing && this.#pending[0] && this.#pending[0].frameIndex > horizon) break
      const head = this.#pending[0]
      if (!head) break
      const nearHead = Math.abs(head.frameIndex - this.#anchorFrame) * frameUs <= NEAR_US
      // The image on screen right now goes alone: one image is ready in ~0.4 s, a batch of six in ~0.8 s.
      const batch = this.#pending.splice(0, urgent ? 1 : nearHead ? NEAR_BATCH : FAR_BATCH)
      if (urgent) this.#urgentKey = head.key
      // Anything the playhead reaches within seconds jumps the FFmpeg queue ahead of thumbnails and waveforms.
      this.#dispatch(project, batch, urgent || nearHead)
      if (urgent) break
    }
  }


  /** Background batches start from a timer, never inside the frame that asked for them. */
  #pumpSoon(delayMs = 0): void {
    if (this.#pumpScheduled) return
    this.#pumpScheduled = true
    const run = (): void => {
      this.#pumpScheduled = false
      const project = this.#plan?.project ?? this.#lastProject
      if (project) this.#pump(project, this.#frameUs(project), false)
    }
    setTimeout(run, delayMs)
  }

  #dispatch(project: ProjectFile, batch: SubtitlePlanItem[], urgent = false): void {
    const unique = batch.filter((item, index) => !this.#paths.has(item.key) && !this.#inFlight.has(item.key) && batch.findIndex((other) => other.key === item.key) === index)
    if (unique.length === 0) return
    const generation = this.#generation
    this.#running += 1
    for (const item of unique) {
      this.#inFlight.add(item.key)
      this.onRequest(item.key)
    }
    void this.api.renderSubtitleFrames(project, unique.map((item) => item.frameIndex), urgent ? { urgent: true } : undefined)
      .then((result) => {
        if (generation !== this.#generation) return
        this.onOutcome(!result.ffmpegStarted)
        unique.forEach((item, order) => {
          const frame = result.frames[order]
          if (frame) this.#paths.set(item.key, frame.framePath)
        })
      })
      .catch(() => {
        if (generation !== this.#generation) return
        const retryAt = performance.now() + RETRY_AFTER_MS
        for (const item of unique) this.#retryAt.set(item.key, retryAt)
        this.#scheduleRetry()
      })
      .finally(() => {
        if (generation !== this.#generation) return
        this.#running -= 1
        for (const item of unique) this.#inFlight.delete(item.key)
        this.#pumpSoon()
        // Redraw only when this batch holds the image on screen, or when everything is done.
        const idle = this.#running === 0 && this.#pending.length === 0
        if (idle || (this.#currentKey !== null && unique.some((item) => item.key === this.#currentKey))) this.onChange()
      })
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== null) return
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      const known = new Set(this.#pending.map((item) => item.key))
      const now = performance.now()
      for (const [key, at] of this.#retryAt) {
        if (at > now) continue
        this.#retryAt.delete(key)
        const item = this.#itemByKey.get(key)
        if (item && !known.has(key) && !this.#paths.has(key)) this.#pending.push(item)
      }
      this.onChange()
    }, RETRY_AFTER_MS)
  }

  /** Decode the images of the next few seconds before they are drawn, and drop those far from the playhead. */
  #warmDecode(plan: Plan, frameIndex: number, frameUs: number): void {
    const until = frameIndex + Math.ceil(WARM_DECODE_US / frameUs)
    let decodesStarted = 0
    for (const item of plan.items) {
      if (item.frameIndex < frameIndex - 2 || item.frameIndex > until) continue
      const path = this.#paths.get(item.key)
      if (path && !this.#decoded.has(item.key) && !this.#decoding.has(item.key)) {
        if (userBusy() || decodesStarted >= MAX_DECODES_PER_CALL) continue
        decodesStarted += 1
        this.#decode(item.key, path, item.frameIndex)
      }
    }
    while (this.#decoded.size > MAX_DECODED_IMAGES) {
      let farthest: string | null = null
      let distance = -1
      for (const [key, entry] of this.#decoded) {
        const away = Math.abs(entry.frameIndex - frameIndex)
        if (away > distance) { distance = away; farthest = key }
      }
      if (farthest === null) break
      this.#decoded.delete(farthest)
    }
  }

  #decode(key: string, path: string, frameIndex: number): void {
    if (this.#decoded.has(key) || this.#decoding.has(key)) return
    this.#decoding.add(key)
    const generation = this.#generation
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.src = this.api.mediaUrl(path)
    void image.decode()
      .then(() => {
        if (generation !== this.#generation) return
        this.#decoded.set(key, { image, frameIndex })
        if (key === this.#currentKey) this.onChange()
      })
      .catch(() => {
        if (generation !== this.#generation) return
        // The file was evicted from the disk cache: render it again.
        this.#paths.delete(key)
        const item = this.#itemByKey.get(key)
        if (item && !this.#pending.some((pending) => pending.key === key)) this.#pending.unshift(item)
        this.onChange()
      })
      .finally(() => { this.#decoding.delete(key) })
  }

  /** Drop everything, e.g. when the canvas module is torn down. */
  dispose(): void {
    this.#generation += 1
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer)
    this.#retryTimer = null
    this.#paths.clear()
    this.#decoded.clear()
    this.#decoding.clear()
    this.#inFlight.clear()
    this.#retryAt.clear()
    this.#itemByKey.clear()
    this.#pending = []
    this.#plan = null
    this.#last = null
  }
}
