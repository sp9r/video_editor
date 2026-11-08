# Stage 15 — Built-in Subtitle Templates

## Catalog

組み込みtemplateは3種類に限定する。すべてruntime immutableで、user templateへ複製してから変更する。

| ID | 表示名 | 用途 | 主なstyle |
| --- | --- | --- | --- |
| `default` | 標準 | 既存default互換 | Noto Sans JP、54px、白文字、標準outline |
| `high-contrast` | 白文字・黒縁 | 汎用YouTube | 白文字、黒outline、shadowなし |
| `minimal` | 大きめ強調 | 視認性重視 | 72px、太字、標準outline |

`minimal`は過去のbuilt-in IDとの互換性を維持するためIDを残し、表示名とstyleを現在の「大きめ強調」用途へ整理した。catalogを増やして派手なpresetを量産しない。

## QA

各built-inを1920×1080 sequenceへ適用し、`FfmpegService.renderSubtitleOverlay()`でFFmpeg/libass経路を実レンダリングする回帰テストを追加した。日本語2行のsampleを使い、visible pixel、白文字glyph、強調templateの相対的なglyph高さを確認する。

- `tests/main/ffmpeg-integration.test.ts`
- `tests/shared/subtitle-templates.test.ts`
- built-in catalogは3件、表示名、白文字・黒縁、大きめfont sizeを検証

Final renderとAccurate Previewは既存の共有Project Model／Render Plan／subtitle style経路を使用する。built-in専用のPreview hackやFinal専用style変換は追加していない。

## 変更方法

built-inはInspectorから直接更新・削除できない。userが「複製」または現在の字幕styleを「テンプレートとして保存」して作ったuser templateだけを変更できる。

