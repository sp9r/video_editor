import { timeUsForFrameIndex } from '../../shared/frame-time'
import type { DesktopApi, ProjectFile } from '../../shared/types'
import type { VisualClip } from '../../shared/render-order'
import { visualLayoutsAt, type VisualLayout } from '../../shared/visual-layout'
import { followPreviewClock } from './preview-audio'
import { fitSequenceToViewer, hitTestVisualLayouts, previewFrameIndex, previewSeekSeconds, timelineFrameForPresentedMedia } from './preview-geometry'
import { PreviewSubtitleFrames } from './preview-subtitle-frames'

type SourceElement = HTMLVideoElement | HTMLImageElement

interface Layer {
  clip: VisualClip
  layout: VisualLayout
  element: SourceElement | null
}

export interface CompositorInput {
  project: ProjectFile
  playheadUs: number
  playing: boolean
  /** Export-quality FFmpeg frame shown instead of the live composite. */
  exactImage: HTMLImageElement | null
}

export interface CompositorHooks {
  onPlaybackError: (assetName: string) => void
  onSubtitleRequest?: (key: string) => void
  onSubtitleOutcome?: (cacheHit: boolean) => void
  onDraw?: (frameIndex: number) => void
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number }) => void) => number
}

// A paused seek that has not landed yet keeps the previous picture on screen
// for at most this long, rather than flashing a half-updated composite.
const SEEK_HOLD_MS = 300
const SEEK_TOLERANCE_SECONDS = 1e-4

/**
 * One canvas draws what Final draws: the same layout numbers, the same frame
 * selection and libass subtitle images. Source media lives in hidden elements
 * that are only ever read through drawImage.
 */
export class PreviewCompositor {
  readonly #pool: Map<string, SourceElement[]> = new Map()
  readonly #claimed = new Map<string, SourceElement>()
  readonly #presented = new WeakMap<HTMLVideoElement, { mediaTime: number; at: number }>()
  readonly #seekTargets = new WeakMap<HTMLVideoElement, number>()
  readonly #seekStartedAt = new WeakMap<HTMLVideoElement, number>()
  readonly #subtitles: PreviewSubtitleFrames
  #input: CompositorInput | null = null
  #layers: Layer[] = []
  #frameIndex = 0
  #viewer = { width: 0, height: 0, dpr: 1 }
  #drawn = false
  #raf = 0
  #rafDelay = 0
  #disposed = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly api: Pick<DesktopApi, 'mediaUrl' | 'renderSubtitleOverlay' | 'renderSubtitleOverlaySequence'>,
    private readonly hooks: CompositorHooks
  ) {
    this.#subtitles = new PreviewSubtitleFrames(api, () => this.requestDraw(), hooks.onSubtitleRequest, hooks.onSubtitleOutcome)
  }

  get frameIndex(): number {
    return this.#frameIndex
  }

  /** The hidden video currently feeding this clip, if it has been set up. */
  videoForClip(clipId: string): HTMLVideoElement | null {
    const element = this.#claimed.get(clipId)
    return element instanceof HTMLVideoElement ? element : null
  }

  videos(): HTMLVideoElement[] {
    return [...this.#claimed.values()].filter((element): element is HTMLVideoElement => element instanceof HTMLVideoElement)
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.#viewer = { width: cssWidth, height: cssHeight, dpr: Math.max(1, dpr) }
    const width = Math.max(1, Math.round(cssWidth * this.#viewer.dpr))
    const height = Math.max(1, Math.round(cssHeight * this.#viewer.dpr))
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    this.#drawn = false
    this.requestDraw()
  }

  /** Sequence-pixel hit test for clicks on the canvas, in CSS pixels. */
  hitTest(cssX: number, cssY: number): string | null {
    const input = this.#input
    if (!input) return null
    const { scale, offsetX, offsetY } = fitSequenceToViewer(this.#viewer.width, this.#viewer.height, input.project.sequence.width, input.project.sequence.height)
    return hitTestVisualLayouts(this.#layers.map(({ clip, layout }) => ({ clipId: clip.id, layout })), (cssX - offsetX) / scale, (cssY - offsetY) / scale)
  }

  update(input: CompositorInput, fromFrameCallback = false): void {
    if (this.#disposed) return
    this.#input = input
    const { project } = input
    const fps = project.sequence.frameRate
    const clock = this.#clockPresentedFrame(project)
    this.#frameIndex = input.playing ? previewFrameIndex(input.playheadUs, fps, clock) : previewFrameIndex(input.playheadUs, fps, null)
    let layouts: ReturnType<typeof visualLayoutsAt> = []
    try {
      layouts = visualLayoutsAt(project, timeUsForFrameIndex(this.#frameIndex, fps))
    } catch {
      layouts = []
    }
    const wanted = new Set<SourceElement>()
    const claimed = new Map<string, SourceElement>()
    this.#layers = layouts.map(({ clip, asset, layout }) => {
      const element = asset && !asset.offline && (asset.kind === 'video' || asset.kind === 'image')
        ? this.#acquire(asset.id, asset.kind, this.api.mediaUrl(asset.path), wanted)
        : null
      if (element) {
        claimed.set(clip.id, element)
        if (element instanceof HTMLVideoElement) this.#drive(element, clip, asset?.name ?? clip.name, input, this.#frameIndex)
      }
      return { clip, layout, element }
    })
    this.#claimed.clear()
    for (const [clipId, element] of claimed) this.#claimed.set(clipId, element)
    for (const elements of this.#pool.values()) {
      for (const element of elements) if (!wanted.has(element) && element instanceof HTMLVideoElement && !element.paused) element.pause()
    }
    this.#prune(project)
    if (!input.exactImage) this.#subtitles.ensure(project, this.#frameIndex)
    // While a video clocks playback, its element holds the newest frame only
    // inside its own frame callback, so draw there to label the frame correctly.
    if (input.playing && clock !== null && !fromFrameCallback) return
    this.#draw()
  }

  requestDraw(frames = 1): void {
    if (this.#disposed) return
    this.#rafDelay = Math.max(this.#rafDelay, frames)
    if (this.#raf) return
    const tick = (): void => {
      this.#raf = 0
      if (this.#rafDelay > 1) {
        this.#rafDelay -= 1
        this.#raf = requestAnimationFrame(tick)
        return
      }
      this.#rafDelay = 0
      if (this.#input) this.update(this.#input)
    }
    this.#raf = requestAnimationFrame(tick)
  }

  dispose(): void {
    this.#disposed = true
    if (this.#raf) cancelAnimationFrame(this.#raf)
    this.#subtitles.dispose()
    for (const elements of this.#pool.values()) for (const element of elements) this.#release(element)
    this.#pool.clear()
    this.#claimed.clear()
  }

  #clockPresentedFrame(project: ProjectFile): number | null {
    const input = this.#input
    if (!input?.playing) return null
    for (const layer of this.#layers) {
      if (!(layer.element instanceof HTMLVideoElement)) continue
      const presented = this.#presented.get(layer.element)
      if (!presented || performance.now() - presented.at > 250 || layer.element.paused) continue
      return timelineFrameForPresentedMedia(layer.clip, presented.mediaTime, project.sequence.frameRate)
    }
    return null
  }

  #acquire(assetId: string, kind: 'video' | 'image', url: string, wanted: Set<SourceElement>): SourceElement {
    const elements = this.#pool.get(assetId) ?? []
    this.#pool.set(assetId, elements)
    let element = elements.find((candidate) => !wanted.has(candidate) && candidate.dataset.src === url)
    if (!element) {
      element = kind === 'video' ? this.#createVideo() : new Image()
      element.crossOrigin = 'anonymous'
      element.dataset.src = url
      element.src = url
      this.host.append(element)
      elements.push(element)
    }
    wanted.add(element)
    return element
  }

  #createVideo(): HTMLVideoElement {
    const video = document.createElement('video') as FrameCallbackVideo
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.disablePictureInPicture = true
    const redraw = (): void => this.requestDraw(2)
    for (const type of ['seeked', 'loadeddata', 'loadedmetadata', 'emptied']) video.addEventListener(type, redraw)
    video.addEventListener('error', () => this.hooks.onPlaybackError(video.dataset.assetName ?? 'メディア'))
    const watch = (): void => {
      video.requestVideoFrameCallback?.((_now, metadata) => {
        this.#presented.set(video, { mediaTime: metadata.mediaTime, at: performance.now() })
        if (this.#input?.playing) this.update(this.#input, true)
        else this.requestDraw()
        watch()
      })
    }
    watch()
    return video
  }

  #drive(video: HTMLVideoElement, clip: VisualClip, assetName: string, input: CompositorInput, frameIndex: number): void {
    video.dataset.assetName = assetName
    video.dataset.clipId = clip.id
    if (input.playing) {
      this.#seekTargets.delete(video)
      const expectedSeconds = (clip.sourceInUs + Math.max(0, input.playheadUs - clip.startUs)) / 1_000_000
      followPreviewClock(video, expectedSeconds, true)
      if (video.paused) void video.play().catch((error: unknown) => {
        if (video.error || (error instanceof DOMException && error.name === 'NotAllowedError')) this.hooks.onPlaybackError(assetName)
      })
      return
    }
    if (!video.paused) video.pause()
    if (video.playbackRate !== 1) video.playbackRate = 1
    const target = previewSeekSeconds(clip, frameIndex, input.project.sequence.frameRate)
    const previous = this.#seekTargets.get(video)
    if (previous === undefined || Math.abs(previous - target) > SEEK_TOLERANCE_SECONDS || (!video.seeking && Math.abs(video.currentTime - target) > 1e-3)) {
      this.#seekTargets.set(video, target)
      this.#seekStartedAt.set(video, performance.now())
      video.currentTime = target
    }
  }

  #ready(element: SourceElement): boolean {
    return element instanceof HTMLVideoElement
      ? element.readyState >= 2 && element.videoWidth > 0
      : element.complete && element.naturalWidth > 0
  }

  #prune(project: ProjectFile): void {
    const assets = new Set(project.media.map((asset) => asset.id))
    for (const [assetId, elements] of this.#pool) {
      if (assets.has(assetId)) continue
      for (const element of elements) this.#release(element)
      this.#pool.delete(assetId)
    }
  }

  #release(element: SourceElement): void {
    if (element instanceof HTMLVideoElement) {
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
    element.remove()
  }

  #seekPending(): boolean {
    const input = this.#input
    if (!input || input.playing) return false
    return this.#layers.some(({ element }) => element instanceof HTMLVideoElement
      && element.seeking
      && performance.now() - (this.#seekStartedAt.get(element) ?? 0) < SEEK_HOLD_MS)
  }

  #draw(): void {
    const input = this.#input
    const context = this.canvas.getContext('2d')
    if (!input || !context) return
    if (this.#drawn && !input.exactImage && this.#seekPending()) return
    const { project } = input
    const { width: viewerWidth, height: viewerHeight, dpr } = this.#viewer
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, this.canvas.width, this.canvas.height)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    const { scale, offsetX, offsetY } = fitSequenceToViewer(viewerWidth, viewerHeight, project.sequence.width, project.sequence.height)
    context.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr)
    context.fillStyle = project.sequence.backgroundColor
    context.fillRect(0, 0, project.sequence.width, project.sequence.height)
    if (input.exactImage) {
      if (input.exactImage.complete && input.exactImage.naturalWidth > 0) context.drawImage(input.exactImage, 0, 0, project.sequence.width, project.sequence.height)
      this.#drawn = true
      this.canvas.dataset.drawnFrame = String(this.#frameIndex)
      return
    }
    for (const { layout, element } of this.#layers) {
      if (!element || !this.#ready(element)) continue
      const { boxWidth, boxHeight, crop, sourceRect } = layout
      context.save()
      context.translate(layout.x + layout.rotatedWidth / 2, layout.y + layout.rotatedHeight / 2)
      context.rotate(layout.rotationRadians)
      context.globalAlpha = layout.opacity
      context.drawImage(
        element,
        sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height,
        -boxWidth / 2 + crop.left, -boxHeight / 2 + crop.top, boxWidth - crop.left - crop.right, boxHeight - crop.top - crop.bottom
      )
      context.restore()
    }
    const { image: subtitle, exact } = this.#subtitles.imageFor(project, this.#frameIndex)
    if (subtitle && subtitle.complete && subtitle.naturalWidth > 0) context.drawImage(subtitle, 0, 0, project.sequence.width, project.sequence.height)
    this.#drawn = true
    // Read by the E2E smoke to know when a frame is final.
    this.canvas.dataset.drawnFrame = String(this.#frameIndex)
    this.canvas.dataset.subtitleExact = exact ? 'true' : 'false'
    this.canvas.dataset.layersReady = this.#layers.every(({ element }) => !element || (this.#ready(element) && !(element instanceof HTMLVideoElement && element.seeking))) ? 'true' : 'false'
    this.hooks.onDraw?.(this.#frameIndex)
  }
}
