# Auto Caption Vertical Slice

## Acceptance scope

Stage 9で受入した範囲は次です。

```text
video import
  → V/A timeline placement
  → one clip select
  → Auto Caption dialog
  → real faster-whisper
  → existing caption.py segmentation
  → one new subtitle track
  → SubtitleWord + SubtitleEditUnit
  → manual correction
  → Save/reopen
  → Full Correction summary / Review Mode
  → burned-subtitle render
```

## UI settings

日本語、自動判定、最大文字数32、最大行数2、高品質／ルール方式を指定できます。生成中は音声準備、文字起こし、字幕区切り、字幕配置を表示し、cancelできます。

## Project safety

成功したresultを全件validationした後だけ、新しい`自動字幕` trackへ一つのhistory transactionで適用します。既存subtitle trackを上書きしません。失敗、cancel、timeout、malformed resultではProjectを変更しません。

## Editing readiness

生成直後からRazor split、one-click merge、ownership boundary drag、discrete snap、Alt free scrub、Inspector text edit、Undo/Redo、Save/reopenが利用可能です。本文編集でword ownershipが成立しなくなった場合はword/editUnitを削除して本文だけを保持します。

## Not self-contained

このsliceは2repo間のlocal worker boundaryに依存します。video_editor単体で自動字幕まで動くportable配布物ではありません。worker discovery、Python、faster-whisper、Whisper model、FFmpegが必要です。

## Evidence

生成QA mediaは約103.24秒。受入時はlarge-v3、34 captions、311 raw words、fallback false、`NO_FINE_ACOUSTIC_ALIGNMENT`でした。final MP4はH.264/AAC、1920×1080、103.241秒で、焼き込み字幕frameを確認しています。
