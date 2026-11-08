import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { buildSubtitleRenderSpec, subtitleAnchorTransform } from '../../../shared/subtitle-render'
import { canonicalShadowBlurRadius } from '../../../shared/subtitle-shadow'
import type { SubtitleClip, SubtitleStyle } from '../../../shared/types'

const PREVIEW_WIDTH = 1920
const PREVIEW_HEIGHT = 1080

interface SubtitleTemplatePreviewProps {
  style: SubtitleStyle
  maxLines: number
  sampleText?: string
  className?: string
  ariaLabel?: string
}

const previewClip = (style: SubtitleStyle, maxLines: number, text: string): SubtitleClip => ({
  id: 'subtitle-template-preview',
  name: 'subtitle-template-preview',
  kind: 'subtitle',
  startUs: 0,
  durationUs: 1_000_000,
  sourceInUs: 0,
  enabled: true,
  text,
  style: structuredClone(style),
  maxLines
})

/**
 * Template samples use the same canonical spec and layered CSS fallback as
 * animated/temporary Preview subtitles. Static production Preview and Final
 * remain authoritative libass renders; this component intentionally shows the
 * same geometry and style inputs in a compact 16:9 stage.
 */
export default function SubtitleTemplatePreview({
  style,
  maxLines,
  sampleText = '皆さんこんばんは\nアルマジロウです',
  className = '',
  ariaLabel = '字幕template sample preview'
}: SubtitleTemplatePreviewProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(0.16)
  const clip = useMemo(() => previewClip(style, maxLines, sampleText), [maxLines, sampleText, style])
  const spec = useMemo(() => buildSubtitleRenderSpec(clip, { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }), [clip])
  const textStyle: CSSProperties = {
    fontFamily: spec.fontFamily,
    fontSize: `${spec.fontSizePx}px`,
    fontWeight: spec.bold ? 700 : 400,
    fontStyle: spec.italic ? 'italic' : 'normal',
    letterSpacing: `${spec.letterSpacingPx}px`,
    lineHeight: spec.lineHeight,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere'
  }

  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const update = (): void => {
      const rect = element.getBoundingClientRect()
      setScale(Math.max(0.01, Math.min(rect.width / PREVIEW_WIDTH, rect.height / PREVIEW_HEIGHT)))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={stageRef} className={`subtitle-template-preview-stage ${className}`.trim()} role="img" aria-label={ariaLabel} title={spec.layoutDiagnostics.map((diagnostic) => diagnostic.message).join(' ') || undefined}>
      <div className="subtitle-template-preview-scene" style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, transform: `translate(-50%, -50%) scale(${scale})` }}>
        <div
          className={`preview-subtitle subtitle-${spec.animation} anchor-${spec.anchor}`}
          style={{
            left: `${spec.xPx}px`,
            top: `${spec.yPx}px`,
            width: `${spec.maxWidthPx}px`,
            animationDuration: `${Math.max(0, spec.animationDurationUs / 1_000)}ms`,
            transform: subtitleAnchorTransform(spec.anchor)
          }}
          >
            <span className="preview-subtitle-stack">
              <span className="preview-subtitle-text-box">
              {spec.backgroundOpacity > 0 && <span
              className="preview-subtitle-layer preview-subtitle-background"
              aria-hidden="true"
              style={{
                ...textStyle,
                color: 'transparent',
                WebkitTextStroke: '0 transparent',
                background: `color-mix(in srgb, ${spec.backgroundColor} ${spec.backgroundOpacity * 100}%, transparent)`
              }}
            >{spec.wrappedText}</span>}
            {spec.shadowColor && <span
              className="preview-subtitle-layer preview-subtitle-shadow"
              aria-hidden="true"
              style={{
                ...textStyle,
                color: spec.shadowColor,
                transform: `translate(${spec.shadowOffsetXPx}px, ${spec.shadowOffsetYPx}px)`,
                filter: canonicalShadowBlurRadius(spec.shadowBlurPx) > 0 ? `blur(${canonicalShadowBlurRadius(spec.shadowBlurPx)}px)` : undefined
              }}
            >{spec.wrappedText}</span>}
              <span
              className="preview-subtitle-layer preview-subtitle-main"
              style={{
                ...textStyle,
                color: spec.color,
                WebkitTextStroke: `${spec.outlineWidthPx}px ${spec.outlineColor}`,
                paintOrder: 'stroke fill'
              }}
              >{spec.wrappedText}</span>
              </span>
          </span>
        </div>
      </div>
    </div>
  )
}
