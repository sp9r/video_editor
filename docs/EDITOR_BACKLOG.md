# Editor Backlog

## Phase 4R - Preview architecture

- Fast PreviewはHTML video/imageの近似表示と、FFmpeg/libassのauthoritative subtitle PNG overlayを使用する。Accurate PreviewとFinalはFFmpeg/libassのauthoritative full frameを使用する。
- Accurate Previewの対応範囲は、現在のProject Model、visual transforms、layer order、字幕ASS、Final frame comparison fixtureで検証する。Chromium/libassのrasterization差は許容する。
- Accurate PreviewのPNG memory cacheは64件。大規模disk cache、GPU decode、HDR/color managementは未実装。
- Accurate frame extractionは1 requestにつきFFmpegを起動するため、長い連続seekの最適化や共有workerは将来検討する。

## Phase 4R.2 - Fast Preview semantic parity（Phase 4R.4で字幕経路を置換）

- Fast Preview subtitle DOMはbackground / duplicate shadow / sharp main glyphの3層。Final/Accurateのauthoritative rendererは引き続きFFmpeg/libass。
- `canonicalShadowBlurRadius()`をPreviewとASSで共有し、CSS shadowの過大表示を避ける。CSS/libassのrasterization、font fallback、exact blur shapeは許容差として残る。
- Fast側はfont-sizeだけへChromium/libassのfont metric calibration（Noto Sans JP 0.67、その他fallback 0.90）を適用する。stack container、outline、shadow、background、anchorはscaleしない。論理font size、wrap、positionはshared specのまま保持する。
- production smokeは実Project/PreviewからFast screenshotとAccurate screenshotを取得し、字幕・visual transform fixtureを検証する。実PNGからcenter、glyph width/height、shadow/background存在、video geometryを測定する。

## Phase 4R.4 - Authoritative Fast Subtitle Overlay

- 通常の`animation=none`字幕はCSS typographyをauthorityにせず、`renderSubtitleOverlay()`がFinalと同じ`generateAss(project)`を透明RGBA canvasへlibass描画する。
- FFmpeg `ass` filterの`alpha=1`を使用する。透明640x360 fixtureでcorner alpha=0、white glyph、outline、background、red shadow alphaをpixel検証する。
- Fast overlayはsequence全体PNGを`.fast-authoritative-subtitle-overlay`としてそのまま重ね、CSS側でfont-size、position、outline、shadow、backgroundを補正しない。paused Accurate frameはFast CSS fallbackより上位で表示する。
- cache keyはrenderer version、sequence width/height/fps、active subtitle visual state（ID、track order、text、全style）。mediaは不要で、最大64件のmemory/in-flight/disk bounded cacheとする。同一static cue中は同じPNGを再利用する。
- animated cueだけCSS fallbackを使用し、static overlay生成失敗・初回生成中・style変更中はCSSへ降格しない。`data-subtitle-renderer`はanimated fallbackとauthoritative overlayの診断用に残す。font別0.67/0.90 calibrationは通常字幕経路から廃止する。
- production smokeはFast overlay存在・自然サイズ・CSS fallback不使用、Accurate stale overlay、Final/Accurate regressionを確認する。

## Phase 4R.4.1 - Accuracy-first Subtitle Preview UX

- `animation=none`の字幕はstartup、cache miss、rendering中、slider burst、error時もlibass overlayだけを表示する。CSS typographyはstatic字幕のbackendにしない。
- 同一cueのstyle変更では最後に成功したauthoritative overlayを保持し、新overlay完成時にatomic swapする。cue変更・字幕なしでは旧cueを残さない。
- Inspector burstは40ms latest-only schedulerでcoalesceし、stale resultはcommitしない。次のstatic cueをprefetchし、boundaryではcache hitを即時利用する。
- animated subtitleのCSS表示はtemporary/non-authoritative debt。失敗時もstatic字幕へ自動fallbackせず、「字幕更新失敗」を診断表示する。

## Phase 4R.3 - Subtitle geometry/style semantic correction

- `transform: scale(0.67)`によるstack全体の縮小を廃止し、font-sizeだけへfamily別metric calibrationを適用する。outline width、shadow offset/blur、background box、anchor geometryはlogical spec値を直接使う。
- bundled libass実測ではBorderStyle 3の`BackColour`だけではboxが描画されず、`PrimaryColour`と正の`Outline`が必要だった。background eventはbackground色をPrimary/Outline/Backへ設定し、Outlineは`max(1, logical outlineWidth)`とする。main/shadow eventとの分離は維持する。
- bright-blue canvasのFinal A/Bでbackground opacity 0→0.15の差分を測定（9,516 pixels、234x76）。production Accurate screenshot A/Bでも1,102 pixels、76x25を検出する。
- `npm.cmd run subtitle:geometry`は実Project/Previewを使い、Noto Sans JP 54/123、Arial 64、top/middle/bottom、background on/offをFast/Accurate PNGで比較する。center、X/Y anchor、glyph width/height、outline、background A/Bを測定する。

## Phase 4.11 subtitle visual parity stabilization

- Canonical shadow offset is `(0px, 2px)` in `SubtitleRenderSpec`; blur controls softness only and no longer changes the shadow position.
- ASS applies the mapped blur only to the duplicate shadow event. The main glyph never receives `\\blur`.
- ASS background is a separate BorderStyle 3 event rendered before shadow and main glyph, so background cannot cover the shadow.
- Preview uses an outer max-width layout container and an inner text-sized background box. `maxWidth` is a wrapping limit, not an always-painted background rectangle.
- `npm.cmd run subtitle:parity` runs the exact 1920x1080 fixture through Electron Preview screenshot capture and FFmpeg/libass final frame generation. It reports normalized white glyph geometry, red shadow presence, and background geometry.

Remaining accepted differences are CSS/libass antialiasing, exact Gaussian blur shape, small background padding, and line-height metrics.

## Phase 4.10 subtitle Final style parity

Phase 4.10 fixes the major Final subtitle style regressions:

- the main glyph no longer receives a direct ASS `\\blur` derived from `shadowBlur`;
- background, shadow, and main glyph are represented by separate ASS style/event roles;
- the main event preserves text, font, size, position, wrapping, color, and outline when shadow/background changes;
- `SPECTRA_KEEP_EXPORT_DEBUG=1` retains `project-snapshot.json`, `captions.ass`, `render.ffgraph`, and `export-settings.json` for export diagnosis.

The shadow layer approximates CSS `text-shadow` with a duplicate event and bounded downward offset. ASS/libass does not provide a CSS-equivalent shadow blur primitive, so rasterization and blur softness remain parity-limited. The main glyph must remain sharp and readable.

## Phase 4.9 subtitle parity scope

Preview and Final now share `SubtitleRenderSpec` for logical position, anchor, wrapping, font, core colors, outline, width, and animation metadata.

The following differences remain intentionally parity-limited because CSS and libass do not expose identical primitives:

- `lineHeight`: Preview uses CSS line-height; ASS uses libass's font metrics and does not receive an equivalent exact value.
- `shadowBlur` / shadow softness: Preview uses CSS text-shadow; Final uses a separate ASS shadow event with bounded offset and no glyph `\\blur`, so softness is approximate.
- background box and glyph antialiasing: CSS and libass may differ by several pixels.
- `typewriter` animation: ASS uses a safe fade-like fallback rather than grapheme-by-grapheme reveal.

These are not Phase 5 blockers while the supported P0/P1 subset remains geometrically consistent.

## P1 - correctness / performance

- AUD-001 Preview audio: fixed independent audio contribution playback so Timeline playhead, pause/play, seek, split/trim boundaries, mute, and volume use the OS default output. Video elements remain muted to avoid double-mixing contract video/audio semantics. Browser media-load/playback failures still require environment-specific diagnosis if reproduced.

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
