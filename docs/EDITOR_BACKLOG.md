# Editor Backlog

## Phase 4.9 subtitle parity scope

Preview and Final now share `SubtitleRenderSpec` for logical position, anchor, wrapping, font, core colors, outline, width, and animation metadata.

The following differences remain intentionally parity-limited because CSS and libass do not expose identical primitives:

- `lineHeight`: Preview uses CSS line-height; ASS uses libass's font metrics and does not receive an equivalent exact value.
- `shadowBlur` / shadow offset: Preview uses CSS text-shadow; ASS uses the libass shadow field, so blur and offset are approximate.
- background box and glyph antialiasing: CSS and libass may differ by several pixels.
- `typewriter` animation: ASS uses a safe fade-like fallback rather than grapheme-by-grapheme reveal.

These are not Phase 5 blockers while the supported P0/P1 subset remains geometrically consistent.

## P1 - correctness / performance

- GPU hardware encode: implementation exists, but actual-machine availability and failure reasons need further probe investigation. CPU fallback works, so this is not a Phase 5 blocker.
- Long-form Preview performance and viewport-aware media scheduling.
- Waveform disk cache and chunked multi-resolution storage.

## P2 - Timeline UX

### Ruler scrubbing

Current behavior: ruler click seeks, but dragging from an empty ruler position does not continuously scrub the playhead.

Expected behavior: ruler pointerdown seeks immediately, captures the pointer, updates continuously on pointermove, and releases on pointerup.

Phase 5 blocker: no.

### Wider timeline zoom

Current range is 28–220 px/sec. A future range around 5–1000 px/sec should support both long-form overview and sub-second editing while retaining cursor-anchored Ctrl/Cmd-wheel zoom.

Phase 5 blocker: no.

## P3 - polish

- Premiere/DaVinci-level micro-interactions and visual polish.
