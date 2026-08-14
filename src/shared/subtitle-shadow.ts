const MAX_CANONICAL_SHADOW_BLUR = 20

/**
 * Shared semantic blur radius for the duplicate subtitle shadow glyph.
 * CSS and libass expose different blur primitives, so the value is a
 * conservative effective radius rather than a promise of pixel identity.
 */
export const canonicalShadowBlurRadius = (shadowBlurPx: number): number => {
  if (!Number.isFinite(shadowBlurPx) || shadowBlurPx <= 0) return 0
  return Math.min(MAX_CANONICAL_SHADOW_BLUR, Math.max(1, Math.round(shadowBlurPx / 2)))
}
